import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart' show TextSelection;

import '../../../shared/api/api_error.dart';
import '../data/studio_local_drafts.dart';
import '../data/studio_repository.dart';
import '../domain/manuscript_models.dart';
import 'studio_document.dart';

part 'studio_session_outline.dart';

/// What the save indicator says.
enum StudioSaveState {
  saved('Saved'),
  saving('Saving…'),
  savedOnDevice('Saved on this device'),
  retrying('Retrying…'),
  conflict('Needs your choice');

  const StudioSaveState(this.label);

  final String label;
}

/// How the author settled two versions of one chapter.
enum StudioConflictChoice { keepMine, useOther, keepBoth }

/// Two versions of one chapter: the server's, and the one on this device.
class StudioConflict {
  const StudioConflict({
    required this.server,
    required this.deviceTitle,
    required this.deviceMarkdown,
    required this.deviceNotes,
    required this.fromBuffer,
  });

  /// The copy another device saved.
  final ManuscriptChapter server;
  final String deviceTitle;
  final String deviceMarkdown;
  final String deviceNotes;

  /// True when this device's version is a crash buffer found on opening,
  /// rather than the text in the editor right now.
  final bool fromBuffer;
}

/// The screen's side of the session: the sheets and messages it cannot show
/// itself.
abstract interface class StudioSessionDelegate {
  /// Asks the author to settle [conflict]; null leaves it open.
  Future<StudioConflictChoice?> chooseConflictResolution(
    StudioConflict conflict,
  );

  void showStudioMessage(
    String message, {
    String? actionLabel,
    VoidCallback? onAction,
  });
}

class _Snapshot {
  const _Snapshot(this.title, this.markdown, this.notes, this.status);

  final String title;
  final String markdown;
  final String notes;
  final ManuscriptChapterStatus status;

  @override
  bool operator ==(Object other) =>
      other is _Snapshot &&
      other.title == title &&
      other.markdown == markdown &&
      other.notes == notes &&
      other.status == status;

  @override
  int get hashCode => Object.hash(title, markdown, notes, status);
}

/// Everything the Writing Studio screen knows about the book being written:
/// the outline, the open chapter, whether it is saved, and the words written
/// this sitting.
///
/// A [ChangeNotifier] owned by the screen's `State`, not a Riverpod provider:
/// it holds live editor objects — text controllers, focus nodes, undo
/// histories, the debounce and retry timers — that must be created with the
/// screen and disposed with it, never shared by two screens on the same book
/// and never outlive the route. Riverpod state wants immutable values and a
/// lifetime of its own; this is a mutable editing session. The repository and
/// the crash buffer still come from providers, so tests swap them there.
///
/// Saving: every edit restarts a [debounce]; blur, app pause, chapter switch
/// and leaving the screen save at once ([saveNow]). Each save first writes the
/// chapter's local buffer, then sends it with the revision it was edited from.
/// A save refused because another device saved first opens the three-way
/// choice; a network failure keeps the buffer, says "Saved on this device" and
/// retries on [retryDelays] while the screen is open.
class StudioSession extends ChangeNotifier {
  StudioSession({
    required this.projectId,
    required this._repository,
    required this._drafts,
    this.debounce = const Duration(milliseconds: 1200),
    this.retryDelays = const [
      Duration(seconds: 2),
      Duration(seconds: 5),
      Duration(seconds: 15),
      Duration(seconds: 30),
    ],
  });

  final String projectId;
  final Duration debounce;
  final List<Duration> retryDelays;
  final StudioRepository _repository;
  final StudioLocalDrafts _drafts;

  StudioSessionDelegate? delegate;

  // ---------------------------------------------------------------------------
  // What is loaded

  bool _loading = true;
  bool _switching = false;
  bool _addingChapter = false;
  Object? _loadError;
  Manuscript? _manuscript;
  ManuscriptChapter? _chapter;
  StudioDocument? _document;
  ManuscriptChapterConflict? _bookConflict;
  int _baseRevision = 0;
  String _notes = '';
  ManuscriptChapterStatus _status = ManuscriptChapterStatus.drafting;

  bool get loading => _loading;

  /// Another chapter is being opened.
  bool get switching => _switching;

  /// A chapter is being added; every "Add chapter" shows it and waits.
  bool get addingChapter => _addingChapter;
  Object? get loadError => _loadError;
  Manuscript? get manuscript => _manuscript;
  ManuscriptChapter? get chapter => _chapter;
  StudioDocument? get document => _document;
  String? get chapterId => _chapter?.id;
  int get baseRevision => _baseRevision;
  String get notes => _notes;
  ManuscriptChapterStatus get status => _status;

  /// The book's version of this chapter, when the book changed underneath
  /// unpublished edits (see `chapter_conflict_card.dart`).
  ManuscriptChapterConflict? get bookConflict => _bookConflict;

  /// 1-based position of the open chapter in the outline.
  int get chapterPosition {
    final id = chapterId;
    final chapters = _manuscript?.chapters ?? const [];
    final index = chapters.indexWhere((chapter) => chapter.id == id);
    return index < 0 ? 1 : index + 1;
  }

  int get chapterCount => _manuscript?.chapters.length ?? 1;

  /// The label of the top bar's primary action, or null when there is
  /// nothing to publish.
  String? get publishLabel {
    final manuscript = _manuscript;
    if (manuscript == null) return null;
    if (!manuscript.published) return 'Publish';
    return manuscript.hasUnpublishedChanges || _dirty ? 'Update book' : null;
  }

  // ---------------------------------------------------------------------------
  // Counts

  /// Words in the open chapter, live.
  final ValueNotifier<int> chapterWords = ValueNotifier(0);

  /// The text segment being typed in, for the toolbar.
  final ValueNotifier<StudioTextEntry?> focusedText = ValueNotifier(null);

  final Map<String, int> _baselines = {};
  final Map<String, int> _lastWords = {};

  /// Words written (or, negative, cut) since the screen opened, across every
  /// chapter visited.
  int get sessionWordDelta {
    var sum = 0;
    for (final entry in _baselines.entries) {
      final now = entry.key == chapterId
          ? chapterWords.value
          : _lastWords[entry.key] ?? entry.value;
      sum += now - entry.value;
    }
    return sum;
  }

  // ---------------------------------------------------------------------------
  // Save state

  _Snapshot? _saved;
  bool _dirty = false;
  bool _sending = false;
  bool _offline = false;
  int _retryAttempt = 0;
  Timer? _debounceTimer;
  Timer? _retryTimer;
  Future<bool>? _inFlight;
  StudioConflict? _conflict;
  bool _askingConflict = false;
  ManuscriptSaveCheckpoint? _retryCheckpoint;
  ManuscriptConflictResolution? _retryResolution;
  bool _disposed = false;

  /// Whether the editor holds anything the server has not confirmed.
  bool get dirty => _dirty;
  StudioConflict? get conflict => _conflict;

  StudioSaveState get saveState {
    if (_conflict != null) return StudioSaveState.conflict;
    if (_sending) {
      return _retryAttempt > 0
          ? StudioSaveState.retrying
          : StudioSaveState.saving;
    }
    if (_offline) return StudioSaveState.savedOnDevice;
    return _dirty ? StudioSaveState.saving : StudioSaveState.saved;
  }

  // ---------------------------------------------------------------------------
  // Opening

  /// Loads the book and opens [chapterId], or the chapter written in last.
  Future<void> start({String? chapterId}) async {
    _loading = true;
    _loadError = null;
    _notify();
    try {
      final manuscript = await _repository.getManuscript(projectId);
      if (_disposed) return;
      _manuscript = manuscript;
      final target = _initialChapter(manuscript, chapterId);
      if (target != null) await _open(target);
    } catch (error) {
      _loadError = error;
    }
    _loading = false;
    _notify();
  }

  /// [requested] may be a working-copy chapter id or, from the reader, the
  /// id of the book chapter it published as; anything else (a chapter since
  /// deleted) falls back to the chapter written in last.
  static String? _initialChapter(Manuscript manuscript, String? requested) {
    final chapters = manuscript.chapters;
    if (chapters.isEmpty) return null;
    final linked = requested == null
        ? null
        : manuscript.chapterForLink(requested);
    if (linked != null) return linked.id;
    var latest = chapters.first;
    for (final chapter in chapters.skip(1)) {
      if (chapter.updatedAt.isAfter(latest.updatedAt)) latest = chapter;
    }
    return latest.id;
  }

  /// Saves the open chapter, then opens [chapterId].
  Future<void> switchChapter(String chapterId) async {
    if (chapterId == this.chapterId || _switching) return;
    _switching = true;
    _notify();
    try {
      await flush();
      await _open(chapterId);
    } catch (error) {
      delegate?.showStudioMessage(userFacingError(error));
    }
    _switching = false;
    _notify();
  }

  Future<void> _open(String chapterId) async {
    final server = await _repository.getChapter(projectId, chapterId);
    StudioLocalDraft? buffer;
    try {
      buffer = await _drafts.read(projectId, chapterId);
    } catch (_) {
      buffer = null;
    }
    if (_disposed) return;
    _install(server);
    if (buffer != null) await _reconcileBuffer(server, buffer);
  }

  void _install(ManuscriptChapter server) {
    final previous = _document;
    final previousId = chapterId;
    if (previous != null && previousId != null) {
      _lastWords[previousId] = previous.words;
    }
    _debounceTimer?.cancel();
    _retryTimer?.cancel();
    _retryAttempt = 0;
    _offline = false;
    _conflict = null;
    _chapter = server;
    _bookConflict = server.conflict;
    _baseRevision = server.revision;
    _notes = server.notes;
    _status = server.status;
    focusedText.value = null;
    final document = StudioDocument(
      title: server.title,
      markdown: server.markdown,
      picture: _manuscript?.isPictureBook ?? false,
      onEdited: _onEdited,
      onFocusChanged: (entry) {
        focusedText.value = entry;
        // Leaving the text (for the title, a caption, a sheet) is a pause.
        if (entry == null) _saveOnBlur();
      },
    );
    document.titleFocus.addListener(() {
      if (!document.titleFocus.hasFocus) _saveOnBlur();
    });
    _document = document;
    _saved = _snapshot();
    _dirty = false;
    chapterWords.value = document.words;
    _baselines.putIfAbsent(server.id, () => document.words);
    if (previous != null) _disposeAfterFrame(previous);
    _notify();
  }

  /// A buffer left by an earlier sitting: restore it quietly when it was
  /// edited from the copy the server still has; ask when it was not.
  Future<void> _reconcileBuffer(
    ManuscriptChapter server,
    StudioLocalDraft buffer,
  ) async {
    final same =
        buffer.title == server.title &&
        buffer.markdown == server.markdown &&
        buffer.notes == server.notes;
    if (same) {
      await _deleteBuffer(server.id);
      return;
    }
    if (buffer.baseRevision == server.revision) {
      _notes = buffer.notes;
      if (buffer.status != null) _status = buffer.status!;
      _document!.replaceContent(title: buffer.title, markdown: buffer.markdown);
      await saveNow();
      return;
    }
    _conflict = StudioConflict(
      server: server,
      deviceTitle: buffer.title,
      deviceMarkdown: buffer.markdown,
      deviceNotes: buffer.notes,
      fromBuffer: true,
    );
    _notify();
    unawaited(_askConflict());
  }

  // ---------------------------------------------------------------------------
  // Editing

  _Snapshot _snapshot() {
    final document = _document;
    return _Snapshot(
      document?.title.text ?? '',
      document?.markdown ?? '',
      _notes,
      _status,
    );
  }

  void _onEdited() {
    final document = _document;
    if (document == null || _disposed) return;
    chapterWords.value = document.words;
    final dirty = _snapshot() != _saved;
    if (dirty != _dirty) {
      _dirty = dirty;
      _notify();
    }
    if (_dirty) _scheduleSave();
  }

  void _saveOnBlur() {
    if (_dirty && !_disposed) unawaited(saveNow());
  }

  void _scheduleSave() {
    _debounceTimer?.cancel();
    _debounceTimer = Timer(debounce, () => unawaited(saveNow()));
  }

  void setNotes(String notes) {
    if (notes == _notes) return;
    _notes = notes;
    _onEdited();
  }

  void setStatus(ManuscriptChapterStatus status) {
    if (status == _status) return;
    _status = status;
    _onEdited();
    unawaited(saveNow());
  }

  /// Saves whatever the server has not confirmed, and waits for it. False
  /// when it could not be confirmed (it is still on this device).
  Future<bool> flush() => saveNow();

  /// Saves now instead of after the debounce. [checkpoint] keeps a version of
  /// the text before this save; [resolveConflict] settles a book conflict.
  Future<bool> saveNow({
    ManuscriptSaveCheckpoint? checkpoint,
    ManuscriptConflictResolution? resolveConflict,
    bool force = false,
  }) async {
    _debounceTimer?.cancel();
    while (_inFlight != null) {
      await _inFlight;
    }
    if (_disposed || _document == null || _chapter == null) return true;
    if (_conflict != null) {
      // Nothing goes to the server until the author has chosen; the buffer
      // still keeps every word.
      await _writeBuffer(_snapshot());
      return false;
    }
    final needed =
        force || checkpoint != null || resolveConflict != null || _dirty;
    if (!needed) return true;
    final future = _send(checkpoint: checkpoint, resolve: resolveConflict);
    _inFlight = future;
    try {
      return await future;
    } finally {
      if (identical(_inFlight, future)) _inFlight = null;
    }
  }

  Future<bool> _send({
    ManuscriptSaveCheckpoint? checkpoint,
    ManuscriptConflictResolution? resolve,
  }) async {
    final chapter = _chapter!;
    final snapshot = _snapshot();
    final base = _baseRevision;
    _retryTimer?.cancel();
    await _writeBuffer(snapshot);
    _sending = true;
    _notify();
    try {
      final result = await _repository.saveChapter(
        projectId: projectId,
        chapterId: chapter.id,
        title: snapshot.title,
        markdown: snapshot.markdown,
        notes: snapshot.notes,
        status: snapshot.status,
        baseRevision: base,
        checkpoint: checkpoint,
        resolveConflict: resolve,
      );
      _sending = false;
      if (_disposed || _chapter?.id != chapter.id) return true;
      _baseRevision = result.chapter.revision;
      _saved = snapshot;
      _offline = false;
      _retryAttempt = 0;
      _retryCheckpoint = null;
      _retryResolution = null;
      if (resolve != null) _bookConflict = null;
      _updateOutline(result.chapter);
      _dirty = _snapshot() != _saved;
      if (_dirty) {
        // Newer keystrokes arrived while this was on the wire: the buffer
        // must say which revision they now build on, or a crash would read
        // our own save as another device's.
        await _writeBuffer(_snapshot());
        _scheduleSave();
      } else {
        await _deleteBuffer(chapter.id);
      }
      _notify();
      return true;
    } on ManuscriptChapterConflictException catch (error) {
      _sending = false;
      if (_disposed) return false;
      _offline = false;
      _retryAttempt = 0;
      final document = _document!;
      _conflict = StudioConflict(
        server: error.serverChapter,
        deviceTitle: document.title.text,
        deviceMarkdown: document.markdown,
        deviceNotes: _notes,
        fromBuffer: false,
      );
      _notify();
      unawaited(_askConflict());
      return false;
    } catch (error) {
      _sending = false;
      if (_disposed) return false;
      _offline = true;
      _retryCheckpoint = checkpoint;
      _retryResolution = resolve;
      if (_retryable(error)) {
        _scheduleRetry();
      } else {
        delegate?.showStudioMessage(userFacingError(error));
      }
      _notify();
      return false;
    }
  }

  void _scheduleRetry() {
    _retryTimer?.cancel();
    final delay = retryDelays[math.min(_retryAttempt, retryDelays.length - 1)];
    _retryAttempt++;
    _retryTimer = Timer(delay, () {
      unawaited(
        saveNow(
          force: true,
          checkpoint: _retryCheckpoint,
          resolveConflict: _retryResolution,
        ),
      );
    });
  }

  static bool _retryable(Object error) {
    if (error is! ApiException) return true;
    final status = error.statusCode;
    return error.code == 'NETWORK_ERROR' ||
        status == null ||
        status >= 500 ||
        status == 408 ||
        status == 429;
  }

  Future<void> _writeBuffer(_Snapshot snapshot) async {
    final chapter = _chapter;
    if (chapter == null) return;
    try {
      await _drafts.write(
        StudioLocalDraft(
          projectId: projectId,
          chapterId: chapter.id,
          baseRevision: _baseRevision,
          title: snapshot.title,
          markdown: snapshot.markdown,
          notes: snapshot.notes,
          status: snapshot.status,
          savedAt: DateTime.now().toUtc(),
        ),
      );
    } catch (_) {
      // A full disk must not stop the network save that follows.
    }
  }

  Future<void> _deleteBuffer(String chapterId) async {
    try {
      await _drafts.delete(projectId, chapterId);
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Conflicts

  /// Opens the three-way choice again (the indicator is tappable).
  Future<void> reopenConflict() => _askConflict();

  Future<void> _askConflict() async {
    final conflict = _conflict;
    final delegate = this.delegate;
    if (conflict == null || delegate == null || _askingConflict) return;
    _askingConflict = true;
    StudioConflictChoice? choice;
    try {
      choice = await delegate.chooseConflictResolution(conflict);
    } finally {
      _askingConflict = false;
    }
    if (choice == null || _disposed || !identical(conflict, _conflict)) return;
    await resolveConflict(choice);
  }

  /// Settles the open conflict.
  Future<void> resolveConflict(StudioConflictChoice choice) async {
    final conflict = _conflict;
    final document = _document;
    if (conflict == null || document == null) return;
    final server = conflict.server;
    switch (choice) {
      case StudioConflictChoice.keepMine:
        _conflict = null;
        _baseRevision = server.revision;
        _saved = _Snapshot(
          server.title,
          server.markdown,
          server.notes,
          server.status,
        );
        if (conflict.fromBuffer) {
          _notes = conflict.deviceNotes;
          document.replaceContent(
            title: conflict.deviceTitle,
            markdown: conflict.deviceMarkdown,
          );
        }
        _notify();
        await saveNow(force: true);
      case StudioConflictChoice.useOther:
        await _takeServerCopy(server);
      case StudioConflictChoice.keepBoth:
        final title = conflict.fromBuffer
            ? conflict.deviceTitle
            : document.title.text;
        final markdown = conflict.fromBuffer
            ? conflict.deviceMarkdown
            : document.markdown;
        final notes = conflict.fromBuffer ? conflict.deviceNotes : _notes;
        final copyTitle =
            '${title.trim().isEmpty ? 'Untitled chapter' : title.trim()} (copy)';
        try {
          final added = await _repository.addChapter(
            projectId: projectId,
            requestId: newStudioRequestId('studio-keep-both'),
            afterChapterId: server.id,
            title: copyTitle,
          );
          await _repository.saveChapter(
            projectId: projectId,
            chapterId: added.chapter.id,
            title: copyTitle,
            markdown: markdown,
            notes: notes,
            baseRevision: added.chapter.revision,
          );
          _manuscript = added.manuscript;
          await _refreshManuscriptQuietly();
        } catch (error) {
          delegate?.showStudioMessage(userFacingError(error));
          return;
        }
        await _takeServerCopy(server);
        delegate?.showStudioMessage(
          'This device’s version is now its own chapter, “$copyTitle”.',
        );
    }
  }

  Future<void> _takeServerCopy(ManuscriptChapter server) async {
    final document = _document;
    if (document == null) return;
    _conflict = null;
    _chapter = server;
    _bookConflict = server.conflict;
    _baseRevision = server.revision;
    _notes = server.notes;
    _status = server.status;
    document.replaceContent(title: server.title, markdown: server.markdown);
    _saved = _snapshot();
    _dirty = false;
    _offline = false;
    _debounceTimer?.cancel();
    await _deleteBuffer(server.id);
    _updateOutlineFromChapter(server);
    _notify();
  }

  /// Keeps the text as it is now in version history, before the writing
  /// assistant changes it.
  ///
  /// A checkpoint versions the text the server had *before* the save that
  /// carries it, so unsaved keystrokes go up first: then the version is
  /// exactly the text the author is looking at. False when the chapter is
  /// waiting on a conflict choice — nothing should change under that. Offline
  /// is not false: the buffer keeps every word and the checkpoint is retried
  /// with the save.
  Future<bool> checkpointBeforeAi() async {
    if (_dirty) await flush();
    if (_conflict != null || _disposed) return false;
    await saveNow(checkpoint: ManuscriptSaveCheckpoint.beforeAi, force: true);
    return _conflict == null && !_disposed;
  }

  /// Keeps the Studio's text over the book's version of this chapter.
  Future<void> keepMineOverBook() async {
    await saveNow(
      resolveConflict: ManuscriptConflictResolution.mine,
      force: true,
    );
  }

  /// Takes the book's version of this chapter into the Studio.
  Future<void> useBookVersion() async {
    final saved = await saveNow(
      resolveConflict: ManuscriptConflictResolution.book,
      force: true,
    );
    if (!saved) return;
    await reloadChapter();
  }

  /// Re-reads the open chapter from the server into the editor.
  Future<void> reloadChapter() async {
    final id = chapterId;
    if (id == null) return;
    try {
      final fresh = await _repository.getChapter(projectId, id);
      if (_disposed || chapterId != id) return;
      await _takeServerCopy(fresh);
    } catch (error) {
      delegate?.showStudioMessage(userFacingError(error));
    }
  }

  // ---------------------------------------------------------------------------
  // Versions, settings, publishing

  /// Puts a kept version back in the editor and saves it, keeping the text it
  /// replaces as a version of its own.
  Future<void> applyVersion(ManuscriptVersion version) async {
    final document = _document;
    if (document == null) return;
    document.replaceContent(title: version.title, markdown: version.markdown);
    await saveNow(checkpoint: ManuscriptSaveCheckpoint.restore, force: true);
  }

  /// A new copy of the book's settings and outline (after settings or a
  /// publish). A layout change re-lays the open chapter.
  void updateManuscript(Manuscript manuscript) {
    _manuscript = manuscript;
    _document?.isPictureLayout = manuscript.isPictureBook;
    _notify();
  }

  Future<void> reloadManuscript() async {
    try {
      final manuscript = await _repository.getManuscript(projectId);
      if (_disposed) return;
      updateManuscript(manuscript);
    } catch (error) {
      delegate?.showStudioMessage(userFacingError(error));
    }
  }

  Future<void> _refreshManuscriptQuietly() async {
    try {
      final manuscript = await _repository.getManuscript(projectId);
      if (!_disposed) _manuscript = manuscript;
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  void _disposeAfterFrame(StudioDocument document) {
    SchedulerBinding.instance
      ..addPostFrameCallback((_) => document.dispose())
      ..scheduleFrame();
  }

  @override
  void dispose() {
    _disposed = true;
    _debounceTimer?.cancel();
    _retryTimer?.cancel();
    _document?.dispose();
    chapterWords.dispose();
    focusedText.dispose();
    super.dispose();
  }
}

final _random = math.Random();

/// A request id the server can replay safely.
String newStudioRequestId(String prefix) =>
    '$prefix-${DateTime.now().microsecondsSinceEpoch}-'
    '${_random.nextInt(1 << 30)}';

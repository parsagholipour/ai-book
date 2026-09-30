import 'dart:async';

import 'package:flutter/widgets.dart';

import '../../../shared/api/api_error.dart';
import '../data/book_notes_repository.dart';
import '../domain/book_note.dart';

/// What the editor's bar says about the note.
enum BookNoteSaveState {
  /// A new note with nothing in it: there is nothing to save yet.
  draft('New note'),
  saving('Saving…'),
  saved('Saved'),

  /// The last save failed; tapping the indicator tries again.
  failed('Not saved');

  const BookNoteSaveState(this.label);

  final String label;
}

/// How leaving the editor went.
enum BookNoteLeave {
  /// Everything is on the server.
  saved,

  /// The note was empty: it was never created, or it has been deleted.
  removed,

  /// The last changes could not be saved; the writer has to choose.
  failed,
}

/// Something the editor has to tell the writer.
class BookNoteNotice {
  const BookNoteNotice(this.message, {this.openNote});

  final String message;

  /// A note the message is about, for an "Open" action.
  final BookNote? openNote;
}

/// One note being written: its text, its pin, and every save.
///
/// Saves are debounced and run one at a time, in order. A new note is only
/// created once there is something in it, with a request id kept across
/// retries so a create that did land is never made twice. A text save sends
/// the revision it started from; when another device saved first, the
/// server's copy comes into the editor and this device's words are saved as
/// a new note beside it, so nothing written is lost.
class BookNoteSession extends ChangeNotifier {
  BookNoteSession({
    required this.projectId,
    required this.repository,
    BookNote? note,
    this.debounce = const Duration(milliseconds: 800),
    this.onSaved,
    this.onRemoved,
    this.onNotice,
  }) : _note = note,
       _pinned = note?.pinned ?? false,
       title = TextEditingController(text: note?.title ?? ''),
       body = TextEditingController(text: note?.body ?? '') {
    _seenTitle = title.text;
    _seenBody = body.text;
    title.addListener(_edited);
    body.addListener(_edited);
  }

  final String projectId;
  final BookNotesRepository repository;
  final Duration debounce;

  /// A note reached the server, or changed there: lists should show it.
  final void Function(BookNote note)? onSaved;

  /// A note is gone from the server.
  final void Function(String noteId)? onRemoved;
  final void Function(BookNoteNotice notice)? onNotice;

  final TextEditingController title;
  final TextEditingController body;

  BookNote? _note;
  bool _pinned;
  String _createRequestId = newBookNoteRequestId();

  /// This device's words after a conflict, waiting to be saved as a new
  /// note. Retried by every save until it lands.
  ({String requestId, String title, String body})? _copy;

  late String _seenTitle;
  late String _seenBody;
  bool _replacing = false;
  Timer? _timer;
  int _busy = 0;
  Object? _failure;

  /// Set once the note is being deleted or discarded: nothing more is saved.
  bool _closed = false;
  bool _disposed = false;
  Future<void> _queue = Future<void>.value();

  /// The server's copy as this device last saw it, or null before the note
  /// has been created.
  BookNote? get note => _note;
  bool get pinned => _pinned;
  bool get isCreated => _note != null;
  bool get isBlank => title.text.trim().isEmpty && body.text.trim().isEmpty;

  /// Why the last save failed, while it stands.
  Object? get failure => _failure;

  bool get _textChanged {
    final note = _note;
    if (note == null) return !isBlank;
    return title.text != note.title || body.text != note.body;
  }

  bool get _needsWrite => !_closed && (_textChanged || _copy != null);

  BookNoteSaveState get saveState {
    if (_busy > 0) return BookNoteSaveState.saving;
    if (_failure != null) return BookNoteSaveState.failed;
    if (_needsWrite || _timer != null) return BookNoteSaveState.saving;
    return _note == null ? BookNoteSaveState.draft : BookNoteSaveState.saved;
  }

  /// Whether a back gesture can simply close the editor: nothing left to
  /// write, nothing failing, and no emptied note to delete.
  bool get canLeaveQuietly =>
      _busy == 0 &&
      _timer == null &&
      _failure == null &&
      !_needsWrite &&
      !(isCreated && isBlank);

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  void _notice(BookNoteNotice notice) => onNotice?.call(notice);

  void _edited() {
    if (_replacing) return;
    // Controllers also notify on a moved cursor; only text is a change.
    if (title.text == _seenTitle && body.text == _seenBody) return;
    _seenTitle = title.text;
    _seenBody = body.text;
    if (_closed) return;
    _timer?.cancel();
    _timer = Timer(debounce, () {
      _timer = null;
      unawaited(flush());
    });
    _notify();
  }

  /// Runs [task] after every write before it, so saves land in order and a
  /// pin never races a text save.
  Future<T> _enqueue<T>(Future<T> Function() task) {
    final run = _queue.then((_) => task());
    _queue = run.then<void>((_) {}, onError: (Object _) {});
    return run;
  }

  /// Saves everything now. False when a save failed.
  Future<bool> flush() async {
    _timer?.cancel();
    _timer = null;
    // Text typed while one write was on its way is written by the next; three
    // rounds is plenty for a flush that nobody is typing through.
    for (var round = 0; round < 3 && _needsWrite; round++) {
      if (!await _enqueue(_write)) return false;
    }
    await _enqueue(() async {});
    // A failure with nothing left to write (the text was put back) is over.
    if (!_needsWrite && _failure != null) {
      _failure = null;
      _notify();
    }
    return _failure == null && !_needsWrite;
  }

  /// "Not saved — tap to retry".
  void retry() => unawaited(flush());

  Future<bool> _write() async {
    if (!_needsWrite) return true;
    _busy += 1;
    _failure = null;
    _notify();
    try {
      await _writeOnce(recreateIfGone: true);
      return true;
    } catch (error) {
      _failure = error;
      if (error is ApiException && error.code == 'NOTE_LIMIT') {
        _notice(
          const BookNoteNotice(
            'This book already has $bookNotesPerBookLimit notes, the most it '
            'can hold. Delete one, then tap “Not saved” to try again.',
          ),
        );
      }
      return false;
    } finally {
      _busy -= 1;
      // Text typed while this write was on its way.
      if (_needsWrite && _failure == null && _timer == null && !_disposed) {
        _timer = Timer(debounce, () {
          _timer = null;
          unawaited(flush());
        });
      }
      _notify();
    }
  }

  Future<void> _writeOnce({required bool recreateIfGone}) async {
    await _saveCopy();
    final note = _note;
    final sentTitle = title.text;
    final sentBody = body.text;
    if (note == null) {
      if (sentTitle.trim().isEmpty && sentBody.trim().isEmpty) return;
      final BookNote created;
      try {
        created = await repository.createNote(
          projectId,
          requestId: _createRequestId,
          title: sentTitle,
          body: sentBody,
          pinned: _pinned,
        );
      } on ApiException catch (error) {
        // Whitespace the server trims to nothing: there is no note to make.
        if (error.code == 'EMPTY_NOTE') return;
        rethrow;
      }
      _note = created;
      onSaved?.call(created);
      // The pin was changed while the create was on its way.
      if (created.pinned != _pinned) unawaited(_enqueue(_syncPin));
      return;
    }
    if (sentTitle == note.title && sentBody == note.body) return;
    try {
      final saved = await repository.updateNote(
        projectId,
        note.id,
        title: sentTitle,
        body: sentBody,
        baseRevision: note.revision,
      );
      _note = saved;
      onSaved?.call(saved);
    } on BookNoteConflictException catch (conflict) {
      await _settleConflict(conflict.note);
    } on ApiException catch (error) {
      if (error.code != 'NOTE_NOT_FOUND' || !recreateIfGone) rethrow;
      // Deleted on another device. What is on this screen is still the
      // writer's, so it becomes a new note.
      _note = null;
      _createRequestId = newBookNoteRequestId();
      onRemoved?.call(note.id);
      await _writeOnce(recreateIfGone: false);
      _notice(
        const BookNoteNotice(
          'This note was deleted on another device, so what you wrote here '
          'was saved as a new note.',
        ),
      );
    }
  }

  /// Another device saved first: its copy comes into the editor, and what
  /// this device had is saved as a new note beside it.
  Future<void> _settleConflict(BookNote server) async {
    final mineTitle = title.text;
    final mineBody = body.text;
    _note = server;
    _pinned = server.pinned;
    if (!_disposed) _replaceText(server.title, server.body);
    onSaved?.call(server);
    final differs = mineTitle != server.title || mineBody != server.body;
    final blank = mineTitle.trim().isEmpty && mineBody.trim().isEmpty;
    if (!differs || blank) return;
    _copy = (
      requestId: newBookNoteRequestId(),
      title: bookNoteCopyTitle(mineTitle, mineBody),
      body: mineBody,
    );
    await _saveCopy();
  }

  Future<void> _saveCopy() async {
    final copy = _copy;
    if (copy == null) return;
    final created = await repository.createNote(
      projectId,
      requestId: copy.requestId,
      title: copy.title,
      body: copy.body,
    );
    _copy = null;
    onSaved?.call(created);
    _notice(
      BookNoteNotice(
        'This note was changed on another device, so that version is shown '
        'here. What you wrote is saved as “${created.displayTitle}”.',
        openNote: created,
      ),
    );
  }

  /// Puts [newTitle] and [newBody] in the editor without counting it as an
  /// edit.
  void _replaceText(String newTitle, String newBody) {
    _seenTitle = newTitle;
    _seenBody = newBody;
    // Between the two writes the fields hold half of each version, which the
    // listener would take for an edit.
    _replacing = true;
    try {
      title.value = TextEditingValue(
        text: newTitle,
        selection: TextSelection.collapsed(offset: newTitle.length),
      );
      body.value = TextEditingValue(
        text: newBody,
        selection: TextSelection.collapsed(offset: newBody.length),
      );
    } finally {
      _replacing = false;
    }
  }

  /// Pins or unpins the note. A note not created yet takes its pin with it
  /// when it is.
  Future<void> togglePinned() async {
    _pinned = !_pinned;
    _notify();
    if (_note == null && _busy == 0) return;
    await _enqueue(_syncPin);
  }

  Future<void> _syncPin() async {
    final note = _note;
    if (note == null || _closed || note.pinned == _pinned) return;
    final wanted = _pinned;
    _busy += 1;
    _notify();
    try {
      final updated = await repository.updateNote(
        projectId,
        note.id,
        pinned: wanted,
      );
      // Only the pin is taken: a newer revision in the answer is another
      // device's text, and adopting it would let the next save overwrite
      // that text without the conflict it should raise.
      _note = (_note ?? note).copyWith(pinned: updated.pinned);
      onSaved?.call(updated);
    } catch (error) {
      if (_pinned == wanted) _pinned = note.pinned;
      _notice(
        BookNoteNotice(
          wanted
              ? 'Could not pin this note. ${userFacingError(error)}'
              : 'Could not unpin this note. ${userFacingError(error)}',
        ),
      );
    } finally {
      _busy -= 1;
      _notify();
    }
  }

  /// Saves what is left before the editor closes. An empty note is never
  /// created, and one emptied here is deleted.
  Future<BookNoteLeave> close({
    Duration timeout = const Duration(seconds: 4),
  }) async {
    _timer?.cancel();
    _timer = null;
    if (isBlank && _copy == null) {
      _closed = true;
      try {
        await _enqueue(() async {
          final note = _note;
          if (note == null) return;
          await repository.deleteNote(projectId, note.id);
          _note = null;
          onRemoved?.call(note.id);
        }).timeout(timeout);
      } catch (_) {
        // The note keeps whatever it last saved; nothing written is lost.
      }
      return BookNoteLeave.removed;
    }
    final saved = await flush().timeout(timeout, onTimeout: () => false);
    return saved ? BookNoteLeave.saved : BookNoteLeave.failed;
  }

  /// The writer chose to leave without the changes that would not save.
  void discard() {
    _closed = true;
    _timer?.cancel();
    _timer = null;
  }

  /// Stops saving and waits for any save on its way, so the note deleted is
  /// the one the server has. Returns that note (null when it never reached
  /// the server) and the words on screen, for an Undo.
  Future<({BookNote? stored, BookNoteDraft draft})> prepareDelete() async {
    _timer?.cancel();
    _timer = null;
    _closed = true;
    final draft = (title: title.text, body: body.text, pinned: _pinned);
    await _enqueue(() async {});
    return (stored: _note, draft: draft);
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _timer = null;
    title.removeListener(_edited);
    body.removeListener(_edited);
    title.dispose();
    body.dispose();
    super.dispose();
  }
}

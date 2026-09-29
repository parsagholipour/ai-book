import 'dart:async';

import 'package:flutter/foundation.dart';

import '../data/studio_repository.dart';
import '../domain/assist_models.dart';
import 'studio_document.dart';

/// The notes a feedback or consistency check left, as the panel shows them.
class StudioNotesView {
  const StudioNotesView({
    required this.assistId,
    required this.kind,
    required this.notes,
    this.index = 0,
    this.chapterId,
  });

  final String assistId;
  final LongAssistKind kind;
  final List<AssistNote> notes;

  /// The note the panel is on.
  final int index;

  /// The chapter a feedback check read; null for the whole book.
  final String? chapterId;

  AssistNote get current => notes[index];

  StudioNotesView at(int next) => StudioNotesView(
    assistId: assistId,
    kind: kind,
    notes: notes,
    index: next.clamp(0, notes.length - 1),
    chapterId: chapterId,
  );
}

/// The writing assistant's background work for one open book: the assists
/// still working or waiting to be looked at (the AI inbox), the pictures
/// being drawn into the open chapter, and the notes panel.
///
/// Like the session, a [ChangeNotifier] the screen owns: it holds a timer and
/// live placeholder entries, which must go with the screen.
///
/// Polling: while any assist is working and the screen is in view, every
/// [pollInterval] each working assist is read again — through `getAssist`
/// when there are a few, through one `listOpenAssists` when there are many
/// (a picture book illustrated page by page), falling back to `getAssist`
/// only for the ones that left the open list (failed, dismissed, applied).
/// It stops as soon as nothing is working.
class StudioAiController extends ChangeNotifier {
  StudioAiController({
    required this.projectId,
    required this._repository,
    this.pollInterval = const Duration(seconds: 3),
  });

  final String projectId;
  final Duration pollInterval;
  final StudioRepository _repository;

  /// Called when an assist this screen watches stops working: it landed or
  /// failed.
  void Function(ManuscriptAssist assist)? onSettled;

  /// Newest first. Never holds dismissed or applied ones.
  final List<ManuscriptAssist> _assists = [];
  final Map<String, StudioAiPictureEntry> _pictures = {};
  final Set<String> _startedHere = {};
  final Map<String, int> _watchers = {};
  Timer? _timer;
  bool _visible = true;
  bool _ticking = false;
  bool _disposed = false;
  StudioNotesView? _notes;

  /// What the inbox lists: working, ready and failed assists.
  List<ManuscriptAssist> get inbox => List.unmodifiable(_assists);

  bool get hasWorking => _assists.any((assist) => assist.status.isWorking);

  /// What needs the author: results to look at and failures to read.
  int get attentionCount =>
      _assists.where((assist) => !assist.status.isWorking).length;

  StudioNotesView? get notes => _notes;

  ManuscriptAssist? assist(String id) {
    for (final assist in _assists) {
      if (assist.id == id) return assist;
    }
    return null;
  }

  StudioAiPictureEntry? pictureFor(String assistId) => _pictures[assistId];

  /// Whether this sitting started [assistId] (rather than finding it waiting).
  bool startedHere(String assistId) => _startedHere.contains(assistId);

  // ---------------------------------------------------------------------------

  /// Reads the book's open assists (on opening and on coming back to the
  /// app). Failures seen this sitting stay listed until they are removed.
  Future<void> refresh() async {
    try {
      final open = await _repository.listOpenAssists(projectId);
      if (_disposed) return;
      final known = {for (final assist in _assists) assist.id: assist};
      final fresh = {for (final assist in open) assist.id: assist};
      final kept = [
        for (final assist in _assists)
          if (!fresh.containsKey(assist.id) &&
              (assist.status == ManuscriptAssistStatus.failed ||
                  (assist.status.isWorking &&
                      _startedHere.contains(assist.id))))
            assist,
      ];
      _assists
        ..clear()
        ..addAll([...open, ...kept]);
      _sortNewestFirst();
      for (final assist in open) {
        final before = known[assist.id];
        if (before != null &&
            before.status.isWorking &&
            !assist.status.isWorking) {
          onSettled?.call(assist);
        }
      }
      _notify();
    } catch (_) {
      // The inbox is a convenience; the next poll or resume tries again.
    }
    _syncTimer();
  }

  /// Starts following an assist this screen just started, with the
  /// placeholder it is drawing into, if any.
  void track(ManuscriptAssist assist, {StudioAiPictureEntry? picture}) {
    _startedHere.add(assist.id);
    // A copy read by a poll is newer than the one the start answered with.
    final known = this.assist(assist.id);
    final current = known != null && !known.status.isWorking ? known : assist;
    if (picture != null) _pictures[assist.id] = picture;
    _put(current);
    _notify();
    _syncTimer();
    if (picture != null && !current.status.isWorking) {
      // It landed before its placeholder did: land it now.
      scheduleMicrotask(() {
        if (!_disposed) onSettled?.call(current);
      });
    }
  }

  /// Stops tying [assistId] to a placeholder (it landed, or went away).
  void releasePicture(String assistId) => _pictures.remove(assistId);

  /// A sheet is waiting on [assistId]; its result is the sheet's to show.
  void watch(String assistId) =>
      _watchers[assistId] = (_watchers[assistId] ?? 0) + 1;

  void unwatch(String assistId) {
    final count = (_watchers[assistId] ?? 1) - 1;
    if (count <= 0) {
      _watchers.remove(assistId);
    } else {
      _watchers[assistId] = count;
    }
  }

  bool isWatched(String assistId) => _watchers.containsKey(assistId);

  /// Paused or hidden: no polling until it is back.
  void setVisible(bool visible) {
    if (visible == _visible) return;
    _visible = visible;
    _syncTimer();
  }

  /// The author does not want this one: it leaves the inbox. A working one
  /// is stopped by the server when it is delivered.
  Future<void> dismiss(String assistId) async {
    final assist = this.assist(assistId);
    _drop(assistId);
    _notify();
    if (assist == null || assist.status == ManuscriptAssistStatus.failed) {
      return;
    }
    try {
      await _repository.dismissAssist(projectId, assistId);
    } catch (_) {
      // Still open on the server: it comes back on the next refresh.
    }
  }

  /// The author used the result.
  Future<void> markApplied(String assistId) async {
    _drop(assistId);
    _notify();
    try {
      await _repository.markAssistApplied(projectId, assistId);
    } catch (_) {
      // Still ready on the server: the inbox offers it again, which is the
      // safe side of a lost request.
    }
  }

  /// Forgets a failure the author has read.
  void forget(String assistId) {
    _drop(assistId);
    _notify();
  }

  // ---------------------------------------------------------------------------
  // The notes panel

  void showNotes(StudioNotesView view) {
    _notes = view;
    _notify();
  }

  void moveNote(int index) {
    final notes = _notes;
    if (notes == null) return;
    _notes = notes.at(index);
    _notify();
  }

  /// Closes the panel; the notes count as read.
  void closeNotes() {
    final notes = _notes;
    if (notes == null) return;
    _notes = null;
    _notify();
    unawaited(markApplied(notes.assistId));
  }

  // ---------------------------------------------------------------------------

  void _put(ManuscriptAssist assist) {
    final index = _assists.indexWhere((item) => item.id == assist.id);
    if (index >= 0) {
      _assists[index] = assist;
    } else {
      _assists.add(assist);
      _sortNewestFirst();
    }
  }

  void _drop(String assistId) {
    _assists.removeWhere((assist) => assist.id == assistId);
    _pictures.remove(assistId);
  }

  void _sortNewestFirst() =>
      _assists.sort((a, b) => b.createdAt.compareTo(a.createdAt));

  void _syncTimer() {
    final wanted = _visible && !_disposed && hasWorking;
    if (!wanted) {
      _timer?.cancel();
      _timer = null;
      return;
    }
    _timer ??= Timer(pollInterval, () {
      _timer = null;
      unawaited(_tick());
    });
  }

  Future<void> _tick() async {
    if (_ticking || _disposed || !_visible) return;
    _ticking = true;
    try {
      final working = _assists.where((a) => a.status.isWorking).toList();
      Map<String, ManuscriptAssist>? listed;
      if (working.length > 3) {
        final open = await _repository.listOpenAssists(projectId);
        listed = {for (final assist in open) assist.id: assist};
      }
      for (final before in working) {
        if (_disposed) return;
        final fresh =
            listed?[before.id] ??
            await _repository.getAssist(projectId, before.id);
        if (_disposed) return;
        if (assist(before.id) == null) continue; // dismissed meanwhile
        if (fresh.status == ManuscriptAssistStatus.dismissed ||
            fresh.status == ManuscriptAssistStatus.applied) {
          _drop(fresh.id);
        } else {
          _put(fresh);
        }
        if (!fresh.status.isWorking) onSettled?.call(fresh);
      }
    } catch (_) {
      // A missed poll is only a later one.
    } finally {
      _ticking = false;
      _notify();
      _syncTimer();
    }
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}

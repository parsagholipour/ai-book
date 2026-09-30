import 'dart:async';

import 'package:tomeza/features/notes/data/book_notes_repository.dart';
import 'package:tomeza/features/notes/domain/book_note.dart';
import 'package:tomeza/shared/api/api_error.dart';

/// One call the fake answered, with what was sent.
class FakeNoteCall {
  const FakeNoteCall(this.method, {this.noteId, this.data = const {}});

  final String method;
  final String? noteId;
  final Map<String, Object?> data;

  @override
  String toString() => '$method ${noteId ?? ''} $data';
}

/// An in-memory notes server for widget tests.
///
/// It keeps revisions, request-id replays, the per-book limit and the
/// conflict rule the way the real routes do, and records every call in
/// [calls].
class FakeBookNotesRepository implements BookNotesRepository {
  FakeBookNotesRepository({List<BookNote>? notes, this.limit = 200})
    : notes = [...?notes];

  final List<BookNote> notes;
  final int limit;
  final List<FakeNoteCall> calls = [];
  final Map<String, String> _byRequestId = {};
  int _sequence = 0;
  DateTime clock = DateTime.now().toUtc();

  /// Makes the next [listNotes] fail with this error.
  Object? listError;

  /// Makes every write fail with this error until cleared.
  Object? writeError;

  /// Makes the next [failWrites] writes fail as if the network were down.
  int failWrites = 0;

  /// Holds [listNotes] until the test completes it.
  Completer<void>? listGate;

  /// Holds every write until the test completes it.
  Completer<void>? writeGate;

  static const networkError = ApiException(
    code: 'NETWORK_ERROR',
    message: 'Check your connection and try again.',
  );

  List<FakeNoteCall> callsOf(String method) =>
      calls.where((call) => call.method == method).toList();

  BookNote? byId(String id) {
    for (final note in notes) {
      if (note.id == id) return note;
    }
    return null;
  }

  /// Another device saving [noteId]: the revision moves on.
  BookNote editElsewhere(String noteId, {String? title, String? body}) {
    final index = notes.indexWhere((note) => note.id == noteId);
    final note = notes[index];
    final edited = note.copyWith(
      title: title,
      body: body,
      revision: note.revision + 1,
      editedAt: _tick(),
    );
    notes[index] = edited;
    return edited;
  }

  DateTime _tick() {
    clock = clock.add(const Duration(seconds: 1));
    return clock;
  }

  Future<void> _write() async {
    final gate = writeGate;
    if (gate != null) await gate.future;
    final error = writeError;
    if (error != null) throw error;
    if (failWrites > 0) {
      failWrites -= 1;
      throw networkError;
    }
  }

  @override
  Future<List<BookNote>> listNotes(String projectId) async {
    calls.add(const FakeNoteCall('list'));
    final gate = listGate;
    if (gate != null) await gate.future;
    final error = listError;
    if (error != null) {
      listError = null;
      throw error;
    }
    return sortBookNotes(notes);
  }

  @override
  Future<BookNote> createNote(
    String projectId, {
    required String requestId,
    String title = '',
    String body = '',
    bool pinned = false,
  }) async {
    calls.add(
      FakeNoteCall(
        'create',
        data: {
          'requestId': requestId,
          'title': title,
          'body': body,
          'pinned': pinned,
        },
      ),
    );
    await _write();
    final replayed = _byRequestId[requestId];
    if (replayed != null && byId(replayed) != null) return byId(replayed)!;
    if (title.trim().isEmpty && body.trim().isEmpty) {
      throw const ApiException(
        code: 'EMPTY_NOTE',
        message: 'A note needs a title or some text.',
        statusCode: 400,
      );
    }
    if (notes.length >= limit) {
      throw const ApiException(
        code: 'NOTE_LIMIT',
        message: 'This book has the most notes it can hold.',
        statusCode: 409,
      );
    }
    _sequence += 1;
    final at = _tick();
    final note = BookNote(
      id: 'n-new-$_sequence',
      title: title,
      body: body,
      pinned: pinned,
      revision: 1,
      createdAt: at,
      editedAt: at,
    );
    notes.add(note);
    _byRequestId[requestId] = note.id;
    return note;
  }

  @override
  Future<BookNote> updateNote(
    String projectId,
    String noteId, {
    String? title,
    String? body,
    bool? pinned,
    int? baseRevision,
  }) async {
    calls.add(
      FakeNoteCall(
        'update',
        noteId: noteId,
        data: {
          'title': ?title,
          'body': ?body,
          'pinned': ?pinned,
          'baseRevision': ?baseRevision,
        },
      ),
    );
    await _write();
    final index = notes.indexWhere((note) => note.id == noteId);
    if (index < 0) {
      throw const ApiException(
        code: 'NOTE_NOT_FOUND',
        message: 'That note no longer exists.',
        statusCode: 404,
      );
    }
    var note = notes[index];
    if (title != null || body != null) {
      if (baseRevision != note.revision) {
        throw BookNoteConflictException(note);
      }
      final changed =
          (title != null && title != note.title) ||
          (body != null && body != note.body);
      if (changed) {
        note = note.copyWith(
          title: title,
          body: body,
          revision: note.revision + 1,
          editedAt: _tick(),
        );
      }
    }
    if (pinned != null) note = note.copyWith(pinned: pinned);
    notes[index] = note;
    return note;
  }

  @override
  Future<void> deleteNote(String projectId, String noteId) async {
    calls.add(FakeNoteCall('delete', noteId: noteId));
    await _write();
    notes.removeWhere((note) => note.id == noteId);
  }
}

/// A note edited [ago] before now.
BookNote fakeNote(
  String id, {
  String title = '',
  String body = '',
  bool pinned = false,
  int revision = 1,
  Duration ago = const Duration(hours: 1),
}) {
  final at = DateTime.now().toUtc().subtract(ago);
  return BookNote(
    id: id,
    title: title,
    body: body,
    pinned: pinned,
    revision: revision,
    createdAt: at.subtract(const Duration(days: 1)),
    editedAt: at,
  );
}

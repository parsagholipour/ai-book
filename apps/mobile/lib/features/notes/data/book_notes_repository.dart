import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../../../shared/api/api_error.dart';
import '../domain/book_note.dart';

/// A book's private notebook on the server — `/api/mobile/projects/:id/notes`.
/// See `.scratch/book-notes/spec.md`.
abstract interface class BookNotesRepository {
  /// Every note of the book, pinned first, then most recently edited.
  Future<List<BookNote>> listNotes(String projectId);

  /// Creates a note. A [requestId] the server has seen on this book answers
  /// the note it already made, so a retry keeps the same one. Throws
  /// `EMPTY_NOTE` for a blank note and `NOTE_LIMIT` for a full book.
  Future<BookNote> createNote(
    String projectId, {
    required String requestId,
    String title = '',
    String body = '',
    bool pinned = false,
  });

  /// Changes a note. A title or body change needs the [baseRevision] it was
  /// made from, and throws [BookNoteConflictException] when another device
  /// saved first. A pin alone needs none and leaves the revision alone.
  Future<BookNote> updateNote(
    String projectId,
    String noteId, {
    String? title,
    String? body,
    bool? pinned,
    int? baseRevision,
  });

  /// Deletes a note for good. A note (or book) that is already gone counts
  /// as deleted.
  Future<void> deleteNote(String projectId, String noteId);
}

class MobileBookNotesRepository implements BookNotesRepository {
  MobileBookNotesRepository({required this.apiClient});

  final ApiClient apiClient;

  String _base(String projectId) => '/api/mobile/projects/$projectId/notes';

  @override
  Future<List<BookNote>> listNotes(String projectId) async {
    final data = await apiClient.getMap(_base(projectId));
    return (data['notes'] as List<dynamic>? ?? const [])
        .map((item) => BookNote.fromJson(item as Map<String, dynamic>))
        .toList(growable: false);
  }

  @override
  Future<BookNote> createNote(
    String projectId, {
    required String requestId,
    String title = '',
    String body = '',
    bool pinned = false,
  }) async {
    final data = await apiClient.postMap(
      _base(projectId),
      data: {
        'requestId': requestId,
        'title': title,
        'body': body,
        'pinned': pinned,
      },
    );
    return _noteFrom(data);
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
    try {
      final response = await apiClient.patchJson(
        '${_base(projectId)}/$noteId',
        data: {
          'title': ?title,
          'body': ?body,
          'pinned': ?pinned,
          'baseRevision': ?baseRevision,
        },
      );
      return _noteFrom(response.data);
    } on ApiException catch (error) {
      // The server's copy rides inside the error, as a chapter's does.
      final server = error.details['note'];
      if (error.code == 'NOTE_CONFLICT' && server is Map<String, dynamic>) {
        throw BookNoteConflictException(BookNote.fromJson(server));
      }
      rethrow;
    }
  }

  @override
  Future<void> deleteNote(String projectId, String noteId) async {
    try {
      await apiClient.deleteJson('${_base(projectId)}/$noteId');
    } on ApiException catch (error) {
      // NOTE_NOT_FOUND, or PROJECT_NOT_FOUND for a book that is gone: either
      // way there is nothing left to delete.
      if (error.statusCode == 404 ||
          error.code == 'NOTE_NOT_FOUND' ||
          error.code == 'PROJECT_NOT_FOUND') {
        return;
      }
      rethrow;
    }
  }

  BookNote _noteFrom(Object? data) {
    final map = data as Map<String, dynamic>;
    return BookNote.fromJson(map['note'] as Map<String, dynamic>);
  }
}

final bookNotesRepositoryProvider = Provider<BookNotesRepository>((ref) {
  return MobileBookNotesRepository(apiClient: ref.watch(apiClientProvider));
});

/// One book's notes, in the server's order, kept current by every save made
/// on this device (through [BookNotesActions]) without fetching the list
/// again.
class BookNotesController extends AsyncNotifier<List<BookNote>> {
  BookNotesController(this.projectId);

  final String projectId;

  /// Saves and deletes made while the list was being fetched. The fetch may
  /// have been answered before they landed, so they are laid over it.
  final Map<String, BookNote?> _landedWhileLoading = {};
  bool _loading = false;

  @override
  Future<List<BookNote>> build() async {
    final repository = ref.watch(bookNotesRepositoryProvider);
    _loading = true;
    try {
      final fetched = await repository.listNotes(projectId);
      return sortBookNotes(_overlay(fetched));
    } finally {
      _loading = false;
      _landedWhileLoading.clear();
    }
  }

  List<BookNote> _overlay(List<BookNote> fetched) {
    if (_landedWhileLoading.isEmpty) return fetched;
    final byId = {for (final note in fetched) note.id: note};
    _landedWhileLoading.forEach((id, local) {
      final server = byId[id];
      if (local == null) {
        byId.remove(id);
      } else if (server == null || local.revision >= server.revision) {
        // A newer revision in the fetch came from another device; anything
        // else is this device's own save, which the fetch may predate.
        byId[id] = local;
      }
    });
    return byId.values.toList();
  }

  /// Shows [note] as saved: a new note joins the list, a changed one moves
  /// to where its pin and edit time put it.
  void upsert(BookNote note) {
    if (_loading) _landedWhileLoading[note.id] = note;
    final current = state.value;
    if (current == null) return;
    state = AsyncData(
      sortBookNotes([
        for (final other in current)
          if (other.id != note.id) other,
        note,
      ]),
    );
  }

  void remove(String noteId) {
    if (_loading) _landedWhileLoading[noteId] = null;
    final current = state.value;
    if (current == null) return;
    state = AsyncData([
      for (final note in current)
        if (note.id != noteId) note,
    ]);
  }
}

/// A book's notes, for the list, the book page and the Studio.
///
/// A failed fetch is not retried behind the reader's back: the list says so
/// with a Try again, and the book page's card must not keep calling a route
/// that is refusing it.
final bookNotesProvider = AsyncNotifierProvider.autoDispose
    .family<BookNotesController, List<BookNote>, String>(
      BookNotesController.new,
      retry: (_, _) => null,
    );

/// Writes to a book's notes that outlive the screen that started them — a
/// save landing after its editor closed, an Undo tapped on the page beneath —
/// and keep whichever list is showing in step.
class BookNotesActions {
  BookNotesActions(this._ref);

  final Ref _ref;

  BookNotesRepository get repository => _ref.read(bookNotesRepositoryProvider);

  /// Shows a note this device just saved in any list that is open.
  void saved(String projectId, BookNote note) {
    final provider = bookNotesProvider(projectId);
    if (_ref.exists(provider)) _ref.read(provider.notifier).upsert(note);
  }

  /// Takes a deleted note out of any list that is open.
  void removed(String projectId, String noteId) {
    final provider = bookNotesProvider(projectId);
    if (_ref.exists(provider)) _ref.read(provider.notifier).remove(noteId);
  }

  /// Pins or unpins [note] at once, and puts it back if the server refuses.
  Future<BookNote> setPinned(
    String projectId,
    BookNote note, {
    required bool pinned,
  }) async {
    saved(projectId, note.copyWith(pinned: pinned));
    try {
      final updated = await repository.updateNote(
        projectId,
        note.id,
        pinned: pinned,
      );
      saved(projectId, updated);
      return updated;
    } catch (_) {
      saved(projectId, note);
      rethrow;
    }
  }

  /// Deletes [note] at once, and puts it back if the server refuses.
  Future<void> delete(String projectId, BookNote note) async {
    removed(projectId, note.id);
    try {
      await repository.deleteNote(projectId, note.id);
    } catch (_) {
      saved(projectId, note);
      rethrow;
    }
  }

  /// Writes [draft] back as a new note — a delete's Undo. The server hard
  /// deletes, so what comes back is a new note with the same words.
  Future<BookNote> restore(
    String projectId,
    BookNoteDraft draft, {
    required String requestId,
  }) async {
    final created = await repository.createNote(
      projectId,
      requestId: requestId,
      title: draft.title,
      body: draft.body,
      pinned: draft.pinned,
    );
    saved(projectId, created);
    return created;
  }
}

final bookNotesActionsProvider = Provider<BookNotesActions>(
  BookNotesActions.new,
);

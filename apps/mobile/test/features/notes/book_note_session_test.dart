import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/notes/domain/book_note.dart';
import 'package:tomeza/features/notes/presentation/book_note_session.dart';

import 'fake_book_notes_repository.dart';

// The editor's save logic on its own. `testWidgets` is only here for its fake
// clock: `tester.pump(duration)` walks the debounce timers forward.

class _Harness {
  _Harness(this.repo, {BookNote? note}) {
    session = BookNoteSession(
      projectId: 'p1',
      repository: repo,
      note: note,
      onSaved: saved.add,
      onRemoved: removed.add,
      onNotice: notices.add,
    );
  }

  final FakeBookNotesRepository repo;
  late final BookNoteSession session;
  final saved = <BookNote>[];
  final removed = <String>[];
  final notices = <BookNoteNotice>[];
}

void main() {
  testWidgets('an empty new note is never created', (tester) async {
    final h = _Harness(FakeBookNotesRepository());
    expect(h.session.saveState, BookNoteSaveState.draft);

    h.session.body.text = '   \n  ';
    await tester.pump(const Duration(seconds: 2));
    expect(h.repo.callsOf('create'), isEmpty);
    expect(h.session.saveState, BookNoteSaveState.draft);

    expect(await h.session.close(), BookNoteLeave.removed);
    expect(h.repo.calls, isEmpty);
    h.session.dispose();
  });

  testWidgets('typing saves once, after the pause, as a create', (
    tester,
  ) async {
    final h = _Harness(FakeBookNotesRepository());
    h.session.title.text = 'Pl';
    await tester.pump(const Duration(milliseconds: 400));
    h.session.title.text = 'Plot';
    await tester.pump(const Duration(milliseconds: 500));
    // Still typing, as far as the debounce knows.
    expect(h.repo.callsOf('create'), isEmpty);
    expect(h.session.saveState, BookNoteSaveState.saving);

    await tester.pump(const Duration(milliseconds: 400));
    final create = h.repo.callsOf('create').single;
    expect(create.data['title'], 'Plot');
    expect(create.data['body'], '');
    expect(h.session.saveState, BookNoteSaveState.saved);
    expect(h.saved.single.title, 'Plot');

    // The next change is a PATCH from the revision the create answered.
    h.session.body.text = 'The storm.';
    await tester.pump(const Duration(seconds: 1));
    final update = h.repo.callsOf('update').single;
    expect(update.noteId, h.saved.first.id);
    expect(update.data, {
      'title': 'Plot',
      'body': 'The storm.',
      'baseRevision': 1,
    });
    expect(h.session.note!.revision, 2);
    h.session.dispose();
  });

  testWidgets('a failed create is retried with the same request id', (
    tester,
  ) async {
    final repo = FakeBookNotesRepository()..failWrites = 1;
    final h = _Harness(repo);
    h.session.body.text = 'An idea';
    await tester.pump(const Duration(seconds: 1));
    expect(h.session.saveState, BookNoteSaveState.failed);
    expect(repo.notes, isEmpty);

    h.session.retry();
    await tester.pump();
    final creates = repo.callsOf('create');
    expect(creates, hasLength(2));
    expect(creates[1].data['requestId'], creates[0].data['requestId']);
    expect(repo.notes, hasLength(1));
    expect(h.session.saveState, BookNoteSaveState.saved);
    h.session.dispose();
  });

  testWidgets('a pin on a new note rides its create; later ones patch the pin '
      'alone', (tester) async {
    final repo = FakeBookNotesRepository();
    final h = _Harness(repo);
    await h.session.togglePinned();
    expect(repo.calls, isEmpty);
    h.session.body.text = 'Pinned idea';
    await tester.pump(const Duration(seconds: 1));
    expect(repo.callsOf('create').single.data['pinned'], isTrue);

    await h.session.togglePinned();
    final update = repo.callsOf('update').single;
    expect(update.data, {'pinned': false});
    expect(repo.notes.single.pinned, isFalse);
    // A pin is not an edit.
    expect(repo.notes.single.revision, 1);
    h.session.dispose();
  });

  testWidgets('another device saved first: its copy comes in, and these '
      'words become a new note', (tester) async {
    final original = fakeNote('n1', title: 'Plot', body: 'Old', revision: 1);
    final repo = FakeBookNotesRepository(notes: [original]);
    final h = _Harness(repo, note: original);
    repo.editElsewhere('n1', body: 'Theirs');

    h.session.body.text = 'Mine';
    await tester.pump(const Duration(seconds: 1));

    // The editor holds the server's version now...
    expect(h.session.body.text, 'Theirs');
    expect(h.session.note!.revision, 2);
    // ...and nothing written here was lost.
    final copy = repo.notes.firstWhere((note) => note.id != 'n1');
    expect(copy.title, 'Plot (this device)');
    expect(copy.body, 'Mine');
    expect(h.notices.single.openNote?.id, copy.id);
    expect(h.session.saveState, BookNoteSaveState.saved);
    // Taking the server copy is not an edit to save back.
    await tester.pump(const Duration(seconds: 2));
    expect(repo.callsOf('update'), hasLength(1));
    h.session.dispose();
  });

  testWidgets('a note deleted elsewhere is saved again as a new one', (
    tester,
  ) async {
    final original = fakeNote('n1', title: 'Plot', body: 'Old');
    final repo = FakeBookNotesRepository(notes: [original]);
    final h = _Harness(repo, note: original);
    repo.notes.clear();

    h.session.body.text = 'Still mine';
    await tester.pump(const Duration(seconds: 1));

    expect(h.removed, ['n1']);
    expect(repo.notes.single.body, 'Still mine');
    expect(h.session.note!.id, repo.notes.single.id);
    expect(h.notices.single.message, contains('deleted on another device'));
    h.session.dispose();
  });

  testWidgets('leaving saves what the debounce had not yet', (tester) async {
    final original = fakeNote('n1', title: 'Plot', body: 'Old');
    final repo = FakeBookNotesRepository(notes: [original]);
    final h = _Harness(repo, note: original);
    h.session.body.text = 'New';
    expect(h.session.canLeaveQuietly, isFalse);

    expect(await h.session.close(), BookNoteLeave.saved);
    expect(repo.notes.single.body, 'New');
    h.session.dispose();
  });

  testWidgets('leaving while saves fail says so', (tester) async {
    final original = fakeNote('n1', title: 'Plot', body: 'Old');
    final repo = FakeBookNotesRepository(notes: [original])
      ..writeError = FakeBookNotesRepository.networkError;
    final h = _Harness(repo, note: original);
    h.session.body.text = 'New';

    expect(await h.session.close(), BookNoteLeave.failed);
    expect(h.session.saveState, BookNoteSaveState.failed);
    h.session.dispose();
  });

  testWidgets('a note emptied and left is deleted', (tester) async {
    final original = fakeNote('n1', title: 'Plot', body: 'Old');
    final repo = FakeBookNotesRepository(notes: [original]);
    final h = _Harness(repo, note: original);
    h.session.title.text = '';
    h.session.body.text = ' ';
    expect(h.session.canLeaveQuietly, isFalse);

    expect(await h.session.close(), BookNoteLeave.removed);
    expect(repo.callsOf('delete').single.noteId, 'n1');
    // The blank text was never saved over the note first.
    expect(repo.callsOf('update'), isEmpty);
    expect(h.removed, ['n1']);
    h.session.dispose();
  });

  testWidgets('delete waits for the create on its way and keeps the words', (
    tester,
  ) async {
    final repo = FakeBookNotesRepository();
    final h = _Harness(repo);
    h.session.body.text = 'Half a thought';
    await tester.pump(const Duration(seconds: 1));

    final taken = await h.session.prepareDelete();
    expect(taken.stored?.id, repo.notes.single.id);
    expect(taken.draft, (title: '', body: 'Half a thought', pinned: false));
    // Nothing more is saved once a delete has begun.
    h.session.body.text = 'more';
    await tester.pump(const Duration(seconds: 2));
    expect(repo.callsOf('update'), isEmpty);
    h.session.dispose();
  });
}

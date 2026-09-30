import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/notes/presentation/notes_location.dart';

import 'fake_book_notes_repository.dart';
import 'notes_test_harness.dart';

Finder get _title => find.byKey(const ValueKey('book-note-title'));
Finder get _body => find.byKey(const ValueKey('book-note-body'));

/// The system back gesture, which goes through the page's PopScope.
Future<void> _back(WidgetTester tester) async {
  final navigator = tester.state<NavigatorState>(find.byType(Navigator).last);
  await navigator.maybePop();
  await settle(tester);
}

void main() {
  testWidgets('a new note is created once it has words, and the list beneath '
      'shows it on the way back', (tester) async {
    final repo = FakeBookNotesRepository(
      notes: [fakeNote('a', title: 'Older')],
    );
    final app = NotesTestApp(repo: repo);
    await app.open(tester, bookNotesLocation(notesProjectId));
    await tester.tap(find.byKey(const ValueKey('book-notes-new')));
    await settle(tester);

    expect(find.text('New note'), findsOneWidget);
    await tester.enterText(_title, 'Harbour');
    await settle(tester, const Duration(milliseconds: 400));
    expect(repo.callsOf('create'), isEmpty);
    await letSave(tester);
    expect(repo.callsOf('create').single.data['title'], 'Harbour');
    expect(find.text('Saved'), findsOneWidget);

    await tester.enterText(_body, 'Ferries stop in winter.');
    await tester.tap(find.byTooltip('Back'));
    await settle(tester);

    // Saved on the way out, from the revision the create answered.
    final update = repo.callsOf('update').single;
    expect(update.data['baseRevision'], 1);
    expect(update.data['body'], 'Ferries stop in winter.');
    // Back on the list, which never fetched again.
    expect(find.text('Harbour'), findsOneWidget);
    expect(find.text('Ferries stop in winter.'), findsOneWidget);
    expect(repo.callsOf('list'), hasLength(1));
  });

  testWidgets('a new note left empty is never created', (tester) async {
    final repo = FakeBookNotesRepository();
    final app = NotesTestApp(repo: repo);
    await app.open(tester, newBookNoteLocation(notesProjectId));

    await tester.enterText(_body, '   ');
    await letSave(tester);
    await tester.tap(find.byTooltip('Back'));
    await settle(tester);

    expect(repo.calls, isEmpty);
    expect(find.text('home'), findsOneWidget);
  });

  testWidgets('an existing note saves with its base revision', (tester) async {
    final repo = FakeBookNotesRepository(
      notes: [fakeNote('n1', title: 'Plot', body: 'Old', revision: 3)],
    );
    final app = NotesTestApp(repo: repo);
    await app.open(tester, bookNoteLocation(notesProjectId, 'n1'));

    expect(find.text('Plot'), findsOneWidget);
    expect(find.text('Saved'), findsOneWidget);
    await tester.enterText(_body, 'New');
    await tester.pump();
    expect(find.text('Saving…'), findsOneWidget);
    await letSave(tester);

    expect(repo.callsOf('update').single.data, {
      'title': 'Plot',
      'body': 'New',
      'baseRevision': 3,
    });
    expect(find.text('Saved'), findsOneWidget);
  });

  testWidgets('leaving while a save fails asks before discarding', (
    tester,
  ) async {
    final repo = FakeBookNotesRepository(
      notes: [fakeNote('n1', title: 'Plot', body: 'Old')],
    )..writeError = FakeBookNotesRepository.networkError;
    final app = NotesTestApp(repo: repo);
    await app.open(tester, bookNoteLocation(notesProjectId, 'n1'));

    await tester.enterText(_body, 'Unsaved words');
    await letSave(tester);
    expect(find.text('Not saved — tap to retry'), findsOneWidget);

    await _back(tester);
    expect(find.text('Leave without saving?'), findsOneWidget);
    await tester.tap(find.text('Keep editing'));
    await settle(tester);
    expect(find.text('Unsaved words'), findsOneWidget);

    // The connection comes back: a tap on the indicator saves.
    repo.writeError = null;
    await tester.tap(find.byKey(const ValueKey('book-note-retry')));
    await settle(tester);
    expect(find.text('Saved'), findsOneWidget);
    expect(repo.notes.single.body, 'Unsaved words');
  });

  testWidgets('discarding leaves without the failed changes', (tester) async {
    final repo = FakeBookNotesRepository(
      notes: [fakeNote('n1', title: 'Plot', body: 'Old')],
    )..writeError = FakeBookNotesRepository.networkError;
    final app = NotesTestApp(repo: repo);
    await app.open(tester, bookNoteLocation(notesProjectId, 'n1'));

    await tester.enterText(_body, 'Unsaved words');
    await tester.tap(find.byTooltip('Back'));
    await settle(tester);
    await tester.tap(find.text('Discard'));
    await settle(tester);

    expect(find.text('home'), findsOneWidget);
    expect(repo.notes.single.body, 'Old');
  });

  testWidgets('a conflict takes the other device\'s copy and keeps these '
      'words as a new note', (tester) async {
    final repo = FakeBookNotesRepository(
      notes: [fakeNote('n1', title: 'Plot', body: 'Old')],
    );
    final app = NotesTestApp(repo: repo);
    await app.open(tester, bookNoteLocation(notesProjectId, 'n1'));
    repo.editElsewhere('n1', body: 'Theirs');

    await tester.enterText(_body, 'Mine');
    await letSave(tester);

    expect(find.text('Theirs'), findsOneWidget);
    expect(find.textContaining('changed on another device'), findsOneWidget);
    expect(find.textContaining('Plot (this device)'), findsOneWidget);
    expect(
      repo.notes.map((note) => note.body),
      containsAll(['Theirs', 'Mine']),
    );

    // Its Open action goes to the copy.
    await tester.tap(find.text('Open'));
    await settle(tester);
    expect(find.text('Plot (this device)'), findsOneWidget);
    expect(find.text('Mine'), findsOneWidget);
  });

  testWidgets('delete closes the note and offers Undo on the list', (
    tester,
  ) async {
    final repo = FakeBookNotesRepository(
      notes: [
        fakeNote('n1', title: 'Plot', body: 'Old'),
        fakeNote('n2', title: 'Other'),
      ],
    );
    final app = NotesTestApp(repo: repo);
    await app.open(tester, bookNotesLocation(notesProjectId));
    await tester.tap(find.text('Plot'));
    await settle(tester);

    // Typed and deleted before the save: Undo brings back what was on screen.
    await tester.enterText(_body, 'Newer words');
    await tester.tap(find.byKey(const ValueKey('book-note-more')));
    await settle(tester, const Duration(milliseconds: 400));
    await tester.tap(find.text('Delete note'));
    await settle(tester);

    expect(find.text('Other'), findsOneWidget);
    expect(find.text('Plot'), findsNothing);
    expect(repo.callsOf('delete').single.noteId, 'n1');
    expect(repo.callsOf('update'), isEmpty);

    await tester.tap(find.text('Undo'));
    await settle(tester);
    final restored = repo.callsOf('create').single.data;
    expect(restored['title'], 'Plot');
    expect(restored['body'], 'Newer words');
    expect(find.text('Plot'), findsOneWidget);
  });

  testWidgets('the pin in the bar pins the note', (tester) async {
    final repo = FakeBookNotesRepository(
      notes: [fakeNote('n1', title: 'Plot', body: 'Old')],
    );
    final app = NotesTestApp(repo: repo);
    await app.open(tester, bookNoteLocation(notesProjectId, 'n1'));

    await tester.tap(find.byTooltip('Pin note'));
    await settle(tester);
    expect(repo.callsOf('update').single.data, {'pinned': true});
    expect(find.byTooltip('Unpin note'), findsOneWidget);
  });

  testWidgets('a note that is gone says so and leads back to the list', (
    tester,
  ) async {
    final repo = FakeBookNotesRepository(notes: [fakeNote('n1', title: 'A')]);
    final app = NotesTestApp(repo: repo);
    await app.open(tester, bookNoteLocation(notesProjectId, 'missing'));

    expect(find.text('This note is gone'), findsOneWidget);
    await tester.tap(find.text('See all notes'));
    await settle(tester);
    expect(find.text('A'), findsOneWidget);
  });

  testWidgets('going to the background saves at once', (tester) async {
    final repo = FakeBookNotesRepository(
      notes: [fakeNote('n1', title: 'Plot', body: 'Old')],
    );
    final app = NotesTestApp(repo: repo);
    await app.open(tester, bookNoteLocation(notesProjectId, 'n1'));

    await tester.enterText(_body, 'Before the call');
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await tester.pump();
    expect(repo.notes.single.body, 'Before the call');
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  });
}

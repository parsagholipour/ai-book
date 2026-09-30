import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/notes/presentation/notes_location.dart';

import 'fake_book_notes_repository.dart';
import 'notes_test_harness.dart';

Future<void> _tall(WidgetTester tester) async {
  await tester.binding.setSurfaceSize(const Size(500, 2400));
  addTearDown(() => tester.binding.setSurfaceSize(null));
}

FakeBookNotesRepository _six() => FakeBookNotesRepository(
  notes: [
    fakeNote('a', title: 'Old pin', pinned: true, ago: const Duration(days: 5)),
    fakeNote('b', title: 'Fresh', ago: const Duration(minutes: 2)),
    fakeNote(
      'c',
      title: 'New pin',
      pinned: true,
      ago: const Duration(hours: 2),
    ),
    fakeNote(
      'd',
      body: 'Storm at dawn\nand then the letter',
      ago: const Duration(hours: 3),
    ),
    fakeNote(
      'e',
      title: 'Keeper logs',
      body: 'Wind every four hours',
      ago: const Duration(hours: 4),
    ),
    fakeNote('f', title: 'Ferry', ago: const Duration(days: 20)),
  ],
);

double _y(WidgetTester tester, String text) =>
    tester.getTopLeft(find.text(text)).dy;

void main() {
  testWidgets('pinned notes lead, then the rest by last edit', (tester) async {
    await _tall(tester);
    final app = NotesTestApp(repo: _six());
    await app.open(tester, bookNotesLocation(notesProjectId));

    expect(find.text('Pinned'), findsOneWidget);
    expect(find.text('Others'), findsOneWidget);
    final order = [
      'Pinned',
      'New pin',
      'Old pin',
      'Others',
      'Fresh',
      'Storm at dawn',
      'Keeper logs',
      'Ferry',
    ].map((text) => _y(tester, text)).toList();
    expect(order, [...order]..sort());
    // A note with no title shows its first line, and the rest as preview.
    expect(find.text('and then the letter'), findsOneWidget);
  });

  testWidgets('one group needs no headings, and a short list no search', (
    tester,
  ) async {
    final app = NotesTestApp(
      repo: FakeBookNotesRepository(
        notes: [
          fakeNote('a', title: 'One'),
          fakeNote('b', title: 'Two'),
        ],
      ),
    );
    await app.open(tester, bookNotesLocation(notesProjectId));
    expect(find.text('One'), findsOneWidget);
    expect(find.text('Pinned'), findsNothing);
    expect(find.text('Others'), findsNothing);
    expect(find.byKey(const ValueKey('book-notes-search')), findsNothing);
  });

  testWidgets('search narrows the list by title and body', (tester) async {
    await _tall(tester);
    final app = NotesTestApp(repo: _six());
    await app.open(tester, bookNotesLocation(notesProjectId));

    await tester.enterText(
      find.byKey(const ValueKey('book-notes-search')),
      'wind',
    );
    await tester.pump();
    expect(find.text('Keeper logs'), findsOneWidget);
    expect(find.text('Fresh'), findsNothing);
    expect(find.text('1 of 6 notes'), findsOneWidget);
    // Results are one list, not the pinned and the rest.
    expect(find.text('Pinned'), findsNothing);

    await tester.enterText(
      find.byKey(const ValueKey('book-notes-search')),
      'lighthouse',
    );
    await tester.pump();
    expect(find.text('No matching notes'), findsOneWidget);
    await tester.tap(find.text('Clear search'));
    await tester.pump();
    expect(find.text('Fresh'), findsOneWidget);
  });

  testWidgets('an empty notebook says what it is for and starts a note', (
    tester,
  ) async {
    final app = NotesTestApp(repo: FakeBookNotesRepository());
    await app.open(tester, bookNotesLocation(notesProjectId));

    expect(find.textContaining('Only you can see them.'), findsOneWidget);
    expect(
      find.textContaining(
        'Nothing here is printed in your book or sent to the AI.',
      ),
      findsOneWidget,
    );
    // The page's own button, not a floating one as well.
    expect(find.byKey(const ValueKey('book-notes-new')), findsNothing);

    await tester.tap(find.text('New note'));
    await settle(tester);
    expect(find.byKey(const ValueKey('book-note-body')), findsOneWidget);
    expect(find.text('New note'), findsOneWidget); // the bar's save state
  });

  testWidgets('a failed load shows why and tries again', (tester) async {
    final repo = _six()..listError = FakeBookNotesRepository.networkError;
    final app = NotesTestApp(repo: repo);
    await app.open(tester, bookNotesLocation(notesProjectId));

    expect(find.text('Could not load your notes'), findsOneWidget);
    expect(find.text('Fresh'), findsNothing);
    await tester.tap(find.text('Try again'));
    await settle(tester);
    expect(find.text('Fresh'), findsOneWidget);
    expect(repo.callsOf('list'), hasLength(2));
  });

  testWidgets('delete takes the note away and Undo writes it back', (
    tester,
  ) async {
    await _tall(tester);
    final repo = _six();
    final app = NotesTestApp(repo: repo);
    await app.open(tester, bookNotesLocation(notesProjectId));

    await tester.tap(find.byKey(const ValueKey('book-note-menu-c')));
    await settle(tester);
    await tester.tap(find.text('Delete'));
    await settle(tester);

    expect(find.text('New pin'), findsNothing);
    expect(repo.callsOf('delete').single.noteId, 'c');
    expect(find.text('Note deleted'), findsOneWidget);

    await tester.tap(find.text('Undo'));
    await settle(tester);
    final create = repo.callsOf('create').single;
    expect(create.data['title'], 'New pin');
    expect(create.data['pinned'], isTrue);
    expect(create.data['requestId'], isA<String>());
    // Back among the pinned, as a new note with the same words.
    expect(find.text('New pin'), findsOneWidget);
    expect(_y(tester, 'New pin'), lessThan(_y(tester, 'Others')));
  });

  testWidgets('a delete the server refuses puts the note back', (tester) async {
    await _tall(tester);
    final repo = _six()..writeError = FakeBookNotesRepository.networkError;
    final app = NotesTestApp(repo: repo);
    await app.open(tester, bookNotesLocation(notesProjectId));

    await tester.tap(find.byKey(const ValueKey('book-note-menu-b')));
    await settle(tester);
    await tester.tap(find.text('Delete'));
    await settle(tester);

    expect(find.text('Fresh'), findsOneWidget);
    expect(find.textContaining('Could not delete the note.'), findsOneWidget);
  });

  testWidgets('pinning from the menu moves a note to the top', (tester) async {
    await _tall(tester);
    final repo = _six();
    final app = NotesTestApp(repo: repo);
    await app.open(tester, bookNotesLocation(notesProjectId));

    await tester.tap(find.byKey(const ValueKey('book-note-menu-f')));
    await settle(tester);
    await tester.tap(find.text('Pin to top'));
    await settle(tester);

    expect(repo.callsOf('update').single.data, {'pinned': true});
    expect(_y(tester, 'Ferry'), lessThan(_y(tester, 'Others')));
  });

  testWidgets('holding a card opens the same menu', (tester) async {
    await _tall(tester);
    final app = NotesTestApp(repo: _six());
    await app.open(tester, bookNotesLocation(notesProjectId));

    await tester.longPress(find.text('Keeper logs'));
    await settle(tester);
    expect(find.text('Pin to top'), findsOneWidget);
    expect(find.text('Delete'), findsOneWidget);
  });

  testWidgets('the book title rides under the heading when it is loaded', (
    tester,
  ) async {
    final app = NotesTestApp(repo: _six(), withBookTitle: true);
    await app.open(tester, bookNotesLocation(notesProjectId));
    expect(find.byKey(const ValueKey('book-notes-book-title')), findsOneWidget);
    expect(find.text('The Lighthouse Letter'), findsOneWidget);
  });

  testWidgets('pulling down fetches again, and a failed pull keeps the notes', (
    tester,
  ) async {
    final repo = _six();
    final app = NotesTestApp(repo: repo);
    await app.open(tester, bookNotesLocation(notesProjectId));

    repo.notes.add(fakeNote('g', title: 'From the tablet'));
    await tester.fling(find.text('New pin'), const Offset(0, 400), 1000);
    await settle(tester, const Duration(seconds: 2));
    expect(repo.callsOf('list'), hasLength(2));
    expect(find.text('From the tablet'), findsOneWidget);

    repo.listError = FakeBookNotesRepository.networkError;
    await tester.fling(find.text('New pin'), const Offset(0, 400), 1000);
    await settle(tester, const Duration(seconds: 2));
    expect(
      find.textContaining('Could not refresh your notes.'),
      findsOneWidget,
    );
    expect(find.text('New pin'), findsOneWidget);
  });
}

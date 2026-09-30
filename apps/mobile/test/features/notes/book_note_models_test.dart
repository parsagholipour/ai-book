import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/notes/domain/book_note.dart';

import 'fake_book_notes_repository.dart';

void main() {
  group('BookNote.fromJson', () {
    test('reads the wire shape', () {
      final note = BookNote.fromJson({
        'id': 'n1',
        'title': 'Plot',
        'body': 'The storm.',
        'pinned': true,
        'revision': 4,
        'createdAt': '2026-09-01T10:00:00.000Z',
        'editedAt': '2026-09-02T11:30:00.000Z',
      });
      expect(note.id, 'n1');
      expect(note.title, 'Plot');
      expect(note.body, 'The storm.');
      expect(note.pinned, isTrue);
      expect(note.revision, 4);
      expect(note.createdAt, DateTime.utc(2026, 9, 1, 10));
      expect(note.editedAt, DateTime.utc(2026, 9, 2, 11, 30));
    });

    test('an untitled note is an empty title, and editedAt falls back', () {
      final note = BookNote.fromJson({
        'id': 'n2',
        'title': '',
        'body': 'Just a thought',
        'pinned': false,
        'revision': 1,
        'createdAt': '2026-09-01T10:00:00.000Z',
      });
      expect(note.title, '');
      expect(note.editedAt, note.createdAt);
      expect(note.draft, (title: '', body: 'Just a thought', pinned: false));
    });
  });

  group('what a note shows before it is opened', () {
    test('the title, else the first line, else "Untitled note"', () {
      expect(bookNoteDisplayTitle('  Plot  ', 'x'), 'Plot');
      expect(
        bookNoteDisplayTitle('', '\n\n  First line \nSecond'),
        'First line',
      );
      expect(bookNoteDisplayTitle(' ', '  \n '), untitledBookNote);
    });

    test('the preview skips the line that became the title', () {
      expect(bookNotePreview('', 'First\n\n\nSecond\nThird'), 'Second\nThird');
      expect(bookNotePreview('Title', 'First\n\n\nSecond'), 'First\nSecond');
      expect(bookNotePreview('', 'Only one line'), '');
    });

    test('a long body is cut for the card', () {
      final preview = bookNotePreview('T', 'word ' * 200);
      expect(preview.length, lessThanOrEqualTo(281));
      expect(preview, endsWith('…'));
    });
  });

  test('a conflict copy is named for this device and fits the limit', () {
    expect(bookNoteCopyTitle('Plot', 'x'), 'Plot (this device)');
    expect(bookNoteCopyTitle('', 'The storm\nmore'), 'The storm (this device)');
    final long = bookNoteCopyTitle('a' * 200, '');
    expect(long.length, bookNoteTitleLimit);
    expect(long, endsWith(' (this device)'));
  });

  group('lists', () {
    final pinnedOld = fakeNote(
      'p-old',
      pinned: true,
      ago: const Duration(days: 3),
    );
    final pinnedNew = fakeNote(
      'p-new',
      pinned: true,
      ago: const Duration(hours: 1),
    );
    final fresh = fakeNote('fresh', ago: const Duration(minutes: 1));
    final stale = fakeNote('stale', ago: const Duration(days: 9));

    test('sort pinned first, then most recently edited', () {
      final sorted = sortBookNotes([stale, pinnedOld, fresh, pinnedNew]);
      expect(sorted.map((note) => note.id), [
        'p-new',
        'p-old',
        'fresh',
        'stale',
      ]);
    });

    test('group splits the pinned from the rest, keeping order', () {
      final groups = groupBookNotes(
        sortBookNotes([stale, pinnedOld, fresh, pinnedNew]),
      );
      expect(groups.pinned.map((note) => note.id), ['p-new', 'p-old']);
      expect(groups.others.map((note) => note.id), ['fresh', 'stale']);
    });

    test('recent ignores the pin', () {
      expect(
        recentBookNotes([stale, pinnedOld, fresh, pinnedNew]).map((n) => n.id),
        ['fresh', 'p-new'],
      );
    });

    test('search matches every word in the title or body, any case', () {
      final notes = [
        fakeNote('a', title: 'Mara', body: 'Hums when she COOKS'),
        fakeNote('b', title: 'Timeline', body: 'the storm, 2011'),
        fakeNote('c', body: 'Mara and the storm'),
      ];
      expect(searchBookNotes(notes, '').length, 3);
      expect(searchBookNotes(notes, 'mara').map((n) => n.id), ['a', 'c']);
      expect(searchBookNotes(notes, 'Mara  storm').map((n) => n.id), ['c']);
      expect(searchBookNotes(notes, 'cooks').map((n) => n.id), ['a']);
      expect(searchBookNotes(notes, 'lighthouse'), isEmpty);
    });
  });

  test('request ids are fresh and within the server bounds', () {
    final a = newBookNoteRequestId();
    final b = newBookNoteRequestId();
    expect(a, isNot(b));
    expect(a.length, inInclusiveRange(8, 100));
  });
}

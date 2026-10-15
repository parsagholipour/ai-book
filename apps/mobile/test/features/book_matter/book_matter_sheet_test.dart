import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/book_matter/data/book_matter_repository.dart';
import 'package:tomeza/features/book_matter/domain/book_matter.dart';
import 'package:tomeza/features/book_matter/presentation/book_credits_card.dart';
import 'package:tomeza/features/book_matter/presentation/book_matter_sheet.dart';
import 'package:tomeza/features/book_matter/presentation/matter_form.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/shared/api/api_error.dart';

import 'fake_book_matter_repository.dart';

// A book's Title & credits: opened from its page, saved as a partial update,
// and answered with where the change will show.

/// What `PATCH …/book-matter` answers for an ISBN that fails its check digit.
const _invalidIsbn = ApiException(
  code: 'INVALID_ISBN',
  message:
      'That ISBN isn’t valid. Check its digits, or leave the ISBN field '
      'empty.',
  statusCode: 409,
  details: {'code': 'INVALID_ISBN'},
);

const _generated = BookMatter(
  authorName: 'Parsa',
  dedication: 'For Mum.',
  aboutAuthor: 'Parsa writes at night.',
  authorWebsite: 'parsa.dev',
);

Future<void> _open(
  WidgetTester tester,
  FakeBookMatterRepository repo, {
  List<Override> overrides = const [],
  Widget page = const SizedBox.shrink(),
}) async {
  await tester.binding.setSurfaceSize(const Size(420, 1800));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final navigator = GlobalKey<NavigatorState>();
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        bookMatterRepositoryProvider.overrideWithValue(repo),
        ...overrides,
      ],
      child: MaterialApp(
        navigatorKey: navigator,
        theme: buildTomezaLightTheme(),
        home: const Scaffold(body: Text('library')),
      ),
    ),
  );
  // The book page is opened from the library, as in the app: a pop that
  // misses the sheet has a page to take away.
  navigator.currentState!.push(
    MaterialPageRoute<void>(
      builder: (_) => Scaffold(
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              page,
              const BookCreditsCard(projectId: 'project-1'),
            ],
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('book-credits-open')));
  await tester.pumpAndSettle();
}

/// The book page's own reads of the book, counted: each one past the first
/// is the save's refresh reaching it.
class _BookReads {
  int status = 0;
  int detail = 0;

  List<Override> get overrides => [
    projectStatusProvider.overrideWith((ref, id) {
      status++;
      return const Stream<MobileProjectStatus>.empty();
    }),
    projectDetailProvider.overrideWith((ref, id) {
      detail++;
      return Completer<MobileProjectDetail>().future;
    }),
  ];

  /// Stands in for the book page, which watches both while it is open.
  Widget get page => Consumer(
    builder: (context, ref, _) {
      ref
        ..watch(projectStatusProvider('project-1'))
        ..watch(projectDetailProvider('project-1'));
      return const SizedBox.shrink();
    },
  );
}

/// Taps Save and leaves the save in flight: the button spins, so nothing
/// settles until [gate] opens.
Future<Completer<void>> _saveAndHold(
  WidgetTester tester,
  FakeBookMatterRepository repo,
) async {
  final gate = repo.writeGate = Completer<void>();
  final save = find.byKey(const ValueKey('matter-save'));
  await tester.ensureVisible(save);
  await tester.tap(save);
  await tester.pump();
  expect(repo.writes.single.method, 'PATCH matter');
  return gate;
}

/// A point on the page above the sheet: a tap there is the barrier's.
const _aboveTheSheet = Offset(20, 20);

/// Taps above the sheet, the way a reader dismisses it, and lets it go.
Future<void> _tapAway(WidgetTester tester) async {
  await tester.tapAt(_aboveTheSheet);
  await tester.pumpAndSettle();
  expect(find.byKey(const ValueKey('matter-save')), findsNothing);
}

/// The book page is the page on top, with no sheet over it.
void _expectBookPage() {
  expect(find.byType(BookMatterForm), findsNothing);
  expect(find.byKey(const ValueKey('book-credits-card')), findsOneWidget);
  expect(find.text('library'), findsNothing);
}

TextField _field(WidgetTester tester, String key) =>
    tester.widget<TextField>(find.byKey(ValueKey(key)));

Future<void> _type(WidgetTester tester, String key, String text) async {
  final field = find.byKey(ValueKey(key));
  await tester.ensureVisible(field);
  await tester.enterText(field, text);
  await tester.pump();
}

Future<void> _tap(WidgetTester tester, String key) async {
  final target = find.byKey(ValueKey(key));
  await tester.ensureVisible(target);
  await tester.tap(target);
  await tester.pumpAndSettle();
}

void main() {
  group('BookMatterSaved.message', () {
    String message(BookMatterReprint reprint, BookMatterCover cover) =>
        BookMatterSaved(
          bookMatter: const BookMatter(),
          reprint: reprint,
          cover: cover,
        ).message;

    test('a settled book is refreshed for free', () {
      expect(
        message(BookMatterReprint.queued, BookMatterCover.unchanged),
        'Saved. Your book’s files are being refreshed, at no charge.',
      );
      expect(
        message(BookMatterReprint.queued, BookMatterCover.retypeset),
        'Saved. Your book’s files and cover are being refreshed, at no '
        'charge.',
      );
    });

    test('a book being written takes it when it finishes', () {
      expect(
        message(BookMatterReprint.nextCompile, BookMatterCover.unchanged),
        'Saved. It will be in your book when it finishes.',
      );
    });

    test('an old AI cover says it keeps its old name', () {
      expect(
        message(BookMatterReprint.queued, BookMatterCover.keepsOldName),
        'Saved. Your book’s files are being refreshed, at no charge. Your '
        'cover was drawn before names could be re-set, so it keeps the old '
        'name.',
      );
    });

    test('the wire spellings', () {
      expect(
        BookMatterReprint.fromWire('next_compile'),
        BookMatterReprint.nextCompile,
      );
      expect(BookMatterReprint.fromWire('queued'), BookMatterReprint.queued);
      expect(BookMatterReprint.fromWire('none'), BookMatterReprint.none);
      expect(
        BookMatterCover.fromWire('keeps_old_name'),
        BookMatterCover.keepsOldName,
      );
      expect(BookMatterCover.fromWire('retypeset'), BookMatterCover.retypeset);
    });
  });

  group('an invalid ISBN', () {
    test('marks the ISBN field with the server’s sentence', () {
      final error = MatterSaveError.from(_invalidIsbn);
      expect(error.fields, {'isbn'});
      expect(error.unprintable, isFalse);
      expect(error.message, _invalidIsbn.message);
      expect(error.errorFor('isbn'), 'Change this to save.');
      expect(error.errorFor('imprint'), isNull);
    });

    test('after the sheet is gone, says what was wrong rather than calling '
        'it unprintable', () {
      expect(
        bookMatterNotSavedMessage(MatterSaveError.from(_invalidIsbn)),
        'Your Title & credits changes weren’t saved. That ISBN isn’t valid. '
        'Check its digits, or leave the ISBN field empty.',
      );
      expect(
        bookMatterNotSavedMessage(
          MatterSaveError.from(FakeBookMatterRepository.refusal(['isbn'])),
        ),
        'Your Title & credits changes weren’t saved. Some of it can’t be '
        'printed in a book.',
      );
    });
  });

  group('bookMatterChanges', () {
    test('a Studio book never sends the fields it does not offer', () {
      final update = bookMatterChanges(
        _generated,
        aboutAuthor: '',
        authorWebsite: 'parsa.dev',
        copyrightHolder: '',
        imprint: '',
        isbn: ' 978-0-00 ',
        allRightsReserved: false,
      );
      expect(update?.toJson(), {'isbn': '978-0-00', 'aboutAuthor': null});
    });
  });

  testWidgets('a generated book: prefilled with its copy, and only changes are '
      'sent', (tester) async {
    final repo = FakeBookMatterRepository(matter: _generated);
    await _open(tester, repo);

    expect(find.text('Title & credits'), findsWidgets);
    expect(_field(tester, 'matter-author').controller!.text, 'Parsa');
    expect(_field(tester, 'matter-dedication').controller!.text, 'For Mum.');
    expect(
      _field(tester, 'matter-about').controller!.text,
      'Parsa writes at night.',
    );
    expect(find.byKey(const ValueKey('matter-studio-note')), findsNothing);
    expect(find.byKey(const ValueKey('matter-credit-note')), findsNothing);

    await _type(tester, 'matter-author', 'P. Ravan');
    // Emptying About the author leaves the page out.
    await _type(tester, 'matter-about', '');
    await _tap(tester, 'matter-save');

    expect(repo.writes.single.method, 'PATCH matter');
    expect(repo.writes.single.projectId, 'project-1');
    expect(repo.writes.single.body, {
      'authorName': 'P. Ravan',
      'aboutAuthor': null,
    });
    // The sheet has gone, and says where the change will show.
    expect(find.byKey(const ValueKey('matter-save')), findsNothing);
    expect(
      find.text('Saved. Your book’s files are being refreshed, at no charge.'),
      findsOneWidget,
    );
  });

  testWidgets('a book still being written, with an old AI cover', (
    tester,
  ) async {
    final repo = FakeBookMatterRepository(
      matter: _generated,
      reprint: BookMatterReprint.nextCompile,
      cover: BookMatterCover.keepsOldName,
    );
    await _open(tester, repo);

    await _type(tester, 'matter-author', 'P. Ravan');
    await _tap(tester, 'matter-save');

    expect(
      find.text(
        'Saved. It will be in your book when it finishes. Your cover was '
        'drawn before names could be re-set, so it keeps the old name.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('a Studio book hides the name and dedication and says where '
      'they live', (tester) async {
    final repo = FakeBookMatterRepository(
      matter: const BookMatter(
        authorName: 'Parsa',
        dedication: 'For Mum.',
        studioOwned: true,
      ),
    );
    await _open(tester, repo);

    expect(find.byKey(const ValueKey('matter-author')), findsNothing);
    expect(find.byKey(const ValueKey('matter-dedication')), findsNothing);
    expect(
      find.text(
        'The author name and dedication are set in the Writing Studio’s book '
        'settings.',
      ),
      findsOneWidget,
    );

    await _type(tester, 'matter-about', 'Parsa writes at night.');
    await _tap(tester, 'matter-save');
    expect(repo.writes.single.body, {'aboutAuthor': 'Parsa writes at night.'});
  });

  testWidgets('publishing details: the holder defaults to the author, and the '
      'rights switch is sent', (tester) async {
    final repo = FakeBookMatterRepository(matter: _generated);
    await _open(tester, repo);

    expect(find.text('Copyright holder, imprint, ISBN'), findsOneWidget);
    await _tap(tester, 'matter-publishing-toggle');
    expect(_field(tester, 'matter-holder').decoration!.hintText, 'Parsa');

    await _type(tester, 'matter-isbn', '978-1-23');
    await _tap(tester, 'matter-rights');
    await _tap(tester, 'matter-save');
    expect(repo.writes.single.body, {
      'isbn': '978-1-23',
      'allRightsReserved': true,
    });
  });

  testWidgets('nothing changed closes the sheet without a request', (
    tester,
  ) async {
    final repo = FakeBookMatterRepository(matter: _generated);
    await _open(tester, repo);

    await _tap(tester, 'matter-save');
    expect(repo.writes, isEmpty);
    expect(find.byKey(const ValueKey('matter-save')), findsNothing);
  });

  testWidgets('a busy book and refused words keep the sheet open with the '
      'reason', (tester) async {
    final repo = FakeBookMatterRepository(matter: _generated)
      ..matterWriteError = FakeBookMatterRepository.busy;
    await _open(tester, repo);

    await _type(tester, 'matter-dedication', 'For Dad.');
    await _tap(tester, 'matter-save');
    expect(
      find.text(
        'This book is being changed right now. Try again once that finishes.',
      ),
      findsOneWidget,
    );

    // Refused in a field the closed section holds: the section opens on it.
    repo.matterWriteError = FakeBookMatterRepository.refusal(['isbn']);
    await _tap(tester, 'matter-save');
    expect(find.text('That can’t be printed in a book.'), findsOneWidget);
    expect(find.byKey(const ValueKey('matter-isbn')), findsOneWidget);
    expect(
      _field(tester, 'matter-isbn').decoration!.errorText,
      'Change this to save.',
    );
    expect(_field(tester, 'matter-dedication').controller!.text, 'For Dad.');
  });

  testWidgets('an ISBN the server refuses opens the publishing details on the '
      'marked field and keeps what was typed', (tester) async {
    final repo = FakeBookMatterRepository(matter: _generated)
      ..matterWriteError = _invalidIsbn;
    await _open(tester, repo);

    await _tap(tester, 'matter-publishing-toggle');
    await _type(tester, 'matter-isbn', 'ISBN hello');
    // Closed again, so the refusal is what opens it.
    await _tap(tester, 'matter-publishing-toggle');
    await _tap(tester, 'matter-save');

    expect(repo.writes.single.body, {'isbn': 'ISBN hello'});
    expect(find.text(_invalidIsbn.message), findsOneWidget);
    expect(
      _field(tester, 'matter-isbn').decoration!.errorText,
      'Change this to save.',
    );
    expect(_field(tester, 'matter-isbn').controller!.text, 'ISBN hello');
    expect(_field(tester, 'matter-author').decoration!.errorText, isNull);
  });

  testWidgets('a book whose credits cannot be read offers Try again', (
    tester,
  ) async {
    final repo = FakeBookMatterRepository(matter: _generated)
      ..matterReadError = FakeBookMatterRepository.busy;
    await _open(tester, repo);

    expect(find.text('Couldn’t load this book’s credits'), findsOneWidget);
    repo.matterReadError = null;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(_field(tester, 'matter-author').controller!.text, 'Parsa');
  });

  testWidgets('a save the sheet was tapped away from still refreshes the book, '
      'and the page says so', (tester) async {
    final repo = FakeBookMatterRepository(matter: _generated);
    final reads = _BookReads();
    await _open(tester, repo, overrides: reads.overrides, page: reads.page);
    expect((reads.status, reads.detail), (1, 1));

    await _type(tester, 'matter-author', 'P. Ravan');
    final gate = await _saveAndHold(tester, repo);
    await _tapAway(tester);

    gate.complete();
    await tester.pumpAndSettle();
    expect(repo.matter.authorName, 'P. Ravan');
    // The queued reprint reaches the page: its status stream is opened again.
    expect((reads.status, reads.detail), (2, 2));
    expect(
      find.text('Saved. Your book’s files are being refreshed, at no charge.'),
      findsOneWidget,
    );
  });

  testWidgets('a save refused after the sheet was tapped away says it was not '
      'saved', (tester) async {
    final repo = FakeBookMatterRepository(matter: _generated)
      ..matterWriteError = FakeBookMatterRepository.busy;
    await _open(tester, repo);

    await _type(tester, 'matter-dedication', 'For Dad.');
    final gate = await _saveAndHold(tester, repo);
    await _tapAway(tester);

    gate.complete();
    await tester.pumpAndSettle();
    expect(
      find.text(
        'Your Title & credits changes weren’t saved. This book is being '
        'changed right now. Try again once that finishes.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('limits and counters count what the server counts: an emoji is '
      'two', (tester) async {
    final repo = FakeBookMatterRepository(matter: const BookMatter());
    await _open(tester, repo);

    // 1000 characters, 2000 UTF-16 units: past About the author's 1500.
    await _type(tester, 'matter-about', '🦊' * 1000);
    expect(_field(tester, 'matter-about').controller!.text, '🦊' * 750);
    expect(find.text('1500/1500'), findsOneWidget);

    // A family is one character and eight units, and is never cut in half.
    await _type(tester, 'matter-about', 'Café 👨‍👩‍👧');
    expect(find.text('13/1500'), findsOneWidget);

    await _type(tester, 'matter-author', '${'a' * 115}👨‍👩‍👧');
    expect(_field(tester, 'matter-author').controller!.text, 'a' * 115);

    await _tap(tester, 'matter-save');
    expect(repo.writes.single.body, {
      'authorName': 'a' * 115,
      'aboutAuthor': 'Café 👨‍👩‍👧',
    });
  });

  testWidgets('a save that lands while the sheet is still sliding away leaves '
      'the book page where it is', (tester) async {
    final repo = FakeBookMatterRepository(matter: _generated);
    await _open(tester, repo);

    await _type(tester, 'matter-author', 'P. Ravan');
    final gate = await _saveAndHold(tester, repo);
    await tester.tapAt(_aboveTheSheet);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    // Mid-slide: the form is still built, but its route is not on top.
    expect(find.byType(BookMatterForm), findsOneWidget);

    gate.complete();
    await tester.pumpAndSettle();
    _expectBookPage();
    expect(repo.matter.authorName, 'P. Ravan');
    expect(
      find.text('Saved. Your book’s files are being refreshed, at no charge.'),
      findsOneWidget,
    );
  });

  testWidgets('a save refused while the sheet is still sliding away says it '
      'was not saved', (tester) async {
    final repo = FakeBookMatterRepository(matter: _generated)
      ..matterWriteError = FakeBookMatterRepository.busy;
    await _open(tester, repo);

    await _type(tester, 'matter-dedication', 'For Dad.');
    final gate = await _saveAndHold(tester, repo);
    await tester.tapAt(_aboveTheSheet);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byType(BookMatterForm), findsOneWidget);

    gate.complete();
    await tester.pumpAndSettle();
    _expectBookPage();
    expect(
      find.byKey(const ValueKey('book-matter-not-saved')),
      findsOneWidget,
    );
  });

  testWidgets('leaving with typed words asks first, every way out, and Keep '
      'editing keeps them', (tester) async {
    final repo = FakeBookMatterRepository(matter: _generated);
    await _open(tester, repo);
    await _type(tester, 'matter-dedication', 'For Dad.');

    final waysOut = <String, Future<void> Function()>{
      'a tap above the sheet': () => tester.tapAt(_aboveTheSheet),
      'Back': () => tester.binding.handlePopRoute(),
      'the close button': () => tester.tap(find.byTooltip('Close')),
    };
    for (final MapEntry(key: way, value: leave) in waysOut.entries) {
      await leave();
      await tester.pumpAndSettle();
      expect(find.text('Discard changes?'), findsOneWidget, reason: way);
      await tester.tap(find.text('Keep editing'));
      await tester.pumpAndSettle();
      expect(find.text('Discard changes?'), findsNothing, reason: way);
      expect(find.byType(BookMatterForm), findsOneWidget, reason: way);
      expect(
        _field(tester, 'matter-dedication').controller!.text,
        'For Dad.',
        reason: way,
      );
    }

    // A drag down does not take the sheet past the question.
    await tester.fling(
      find.descendant(
        of: find.byType(BottomSheet),
        matching: find.text('Title & credits'),
      ),
      const Offset(0, 900),
      2000,
    );
    await tester.pumpAndSettle();
    expect(find.byType(BookMatterForm), findsOneWidget);
    expect(_field(tester, 'matter-dedication').controller!.text, 'For Dad.');

    await tester.tap(find.byTooltip('Close'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Discard changes'));
    await tester.pumpAndSettle();
    _expectBookPage();
    expect(repo.writes, isEmpty);
  });

  testWidgets('with nothing changed, leaving does not ask', (tester) async {
    final repo = FakeBookMatterRepository(matter: _generated);
    await _open(tester, repo);

    await tester.tapAt(_aboveTheSheet);
    await tester.pumpAndSettle();
    expect(find.text('Discard changes?'), findsNothing);
    _expectBookPage();

    // Typed and put back is nothing changed, and a switch flipped back too.
    await tester.tap(find.byKey(const ValueKey('book-credits-open')));
    await tester.pumpAndSettle();
    await _type(tester, 'matter-author', 'P. Ravan');
    await _type(tester, 'matter-author', 'Parsa ');
    await _tap(tester, 'matter-publishing-toggle');
    await _tap(tester, 'matter-rights');
    await _tap(tester, 'matter-rights');
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('Discard changes?'), findsNothing);
    _expectBookPage();

    // A flipped switch alone is a change.
    await tester.tap(find.byKey(const ValueKey('book-credits-open')));
    await tester.pumpAndSettle();
    await _tap(tester, 'matter-publishing-toggle');
    await _tap(tester, 'matter-rights');
    await tester.tap(find.byTooltip('Close'));
    await tester.pumpAndSettle();
    expect(find.text('Discard changes?'), findsOneWidget);
    expect(repo.writes, isEmpty);
  });

  testWidgets('a pasted ISBN loses its label, fits, and saves', (tester) async {
    final repo = FakeBookMatterRepository(matter: _generated);
    await _open(tester, repo);

    await _tap(tester, 'matter-publishing-toggle');
    // 26 characters pasted; the field holds 24, and the label is not the
    // ISBN's — the copyright page prints "ISBN" itself.
    await _type(tester, 'matter-isbn', 'ISBN-13: 978-0-306-40615-7');
    expect(_field(tester, 'matter-isbn').controller!.text, '978-0-306-40615-7');

    await _tap(tester, 'matter-save');
    expect(repo.writes.single.body, {'isbn': '978-0-306-40615-7'});
    _expectBookPage();
  });
}

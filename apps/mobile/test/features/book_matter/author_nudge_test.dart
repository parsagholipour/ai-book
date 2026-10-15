import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/features/book_matter/data/book_matter_repository.dart';
import 'package:tomeza/features/book_matter/domain/author_profile.dart';
import 'package:tomeza/features/book_matter/domain/book_matter.dart';
import 'package:tomeza/features/book_matter/presentation/author_profile_screen.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_screen_body.dart';
import 'package:tomeza/features/studio/domain/manuscript_models.dart';
import 'package:tomeza/shared/api/api_client.dart';

import '../../projects/book_page_fixtures.dart';
import 'fake_book_matter_repository.dart';

// "Put your name on it": asked once, inline, on a generated book's page while
// it is written or once it is ready — and gone for good after either answer.

const _unanswered = AuthorProfile(suggestedPenName: 'Mira');

final _config = AppConfig(
  environment: AppEnvironment.local,
  apiBaseUrl: Uri.parse('http://localhost:4001'),
  privacyPolicyUrl: Uri.parse('https://example.com/privacy'),
  termsOfServiceUrl: Uri.parse('https://example.com/terms'),
  accountDeletionUrl: Uri.parse('https://example.com/delete'),
  supportEmail: 'support@example.com',
);

/// What the page is showing: the book, its live status, and which page it
/// is — a new [page] is the whole page built again from scratch.
typedef _Book = ({
  MobileProjectDetail project,
  MobileProjectStatus status,
  int page,
});

/// Pumps the book page and hands back what it shows, so a test can change
/// the book under the same page the way the status stream does.
Future<ValueNotifier<_Book>> _pumpPage(
  WidgetTester tester, {
  required FakeBookMatterRepository repo,
  MobileProjectDetail? project,
  MobileProjectStatus? status,
  _BookReads? reads,
}) async {
  final project0 = project ?? bookProject();
  final book = ValueNotifier<_Book>((
    project: project0,
    status: status ?? bookStatus(status: project0.status),
    page: 0,
  ));
  addTearDown(book.dispose);
  final revision = TextEditingController();
  addTearDown(revision.dispose);
  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (context, state) => Scaffold(
          body: ValueListenableBuilder<_Book>(
            valueListenable: book,
            builder: (context, shown, _) => BookScreenBody(
              key: ValueKey(shown.page),
              project: shown.project,
              status: shown.status,
              billing: creditsBilling,
              revisionController: revision,
              onRefresh: () async {},
              onOpen: (_) async {},
              onDownload: (_) async {},
              onOpenPaywall: (_) async {},
            ),
          ),
        ),
      ),
      GoRoute(
        path: authorProfileLocation,
        builder: (_, _) => const Scaffold(body: Text('author profile page')),
      ),
    ],
  );
  addTearDown(router.dispose);
  await tester.binding.setSurfaceSize(const Size(500, 2600));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        bookMatterRepositoryProvider.overrideWithValue(repo),
        appConfigProvider.overrideWithValue(_config),
        apiAuthHeadersProvider.overrideWith(
          (ref) async => const <String, String>{},
        ),
        ...?reads?.overrides,
      ],
      child: Consumer(
        builder: (context, ref, _) {
          if (reads != null) {
            ref
              ..watch(projectDetailProvider('project-1'))
              ..watch(projectsProvider)
              ..watch(projectStatusProvider('project-1'));
          }
          return MaterialApp.router(routerConfig: router);
        },
      ),
    ),
  );
  await _settle(tester);
  return book;
}

/// The screen's detail, library and status reads stay watched across a save.
/// A completed status stream can see a queued reprint only when reopened.
class _BookReads {
  int detail = 0;
  int library = 0;
  int status = 0;

  List<Override> get overrides => [
    projectDetailProvider.overrideWith((ref, id) async {
      detail++;
      return bookProject();
    }),
    projectsProvider.overrideWith((ref) async {
      library++;
      return const <MobileProjectSummary>[];
    }),
    projectStatusProvider.overrideWith((ref, id) {
      status++;
      return Stream.value(bookStatus());
    }),
  ];
}

/// A book being written keeps its progress card moving, so settling never
/// returns; these frames are long enough for everything else.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 200));
  }
}

final _card = find.byKey(const ValueKey('author-nudge-card'));

final _writing = (
  project: bookProject(status: 'generating'),
  status: bookStatus(status: 'generating', completed: 4),
);

String _text(WidgetTester tester, String key) =>
    tester.widget<TextField>(find.byKey(ValueKey(key))).controller!.text;

Future<void> _type(WidgetTester tester, String key, String text) async {
  final field = find.byKey(ValueKey(key));
  await tester.ensureVisible(field);
  await tester.enterText(field, text);
  await tester.pump();
}

bool _saveEnabled(WidgetTester tester) =>
    tester
        .widget<FilledButton>(
          find.descendant(
            of: find.byKey(const ValueKey('nudge-save')),
            matching: find.byWidgetPredicate((w) => w is FilledButton),
          ),
        )
        .onPressed !=
    null;

/// A book whose matter arrives only when the test says so.
class _SlowMatterRead extends FakeBookMatterRepository {
  _SlowMatterRead({super.profile, super.matter});

  final readGate = Completer<void>();

  @override
  Future<BookMatter> getBookMatter(String projectId) async {
    await readGate.future;
    return super.getBookMatter(projectId);
  }
}

/// A book whose first read of its matter — the card's — is held until the
/// test says so, and then answers with the matter as it was when asked.
/// Every later read (the Title & credits sheet's) answers at once.
class _FirstReadHeld extends FakeBookMatterRepository {
  _FirstReadHeld({super.profile, super.matter});

  final readGate = Completer<void>();
  var _reads = 0;

  @override
  Future<BookMatter> getBookMatter(String projectId) async {
    if (_reads++ > 0) return super.getBookMatter(projectId);
    final asked = await super.getBookMatter(projectId);
    await readGate.future;
    return asked;
  }
}

Future<void> _tap(WidgetTester tester, String key) async {
  final target = find.byKey(ValueKey(key));
  await tester.ensureVisible(target);
  await tester.tap(target);
  await _settle(tester);
}

/// Changes the book's byline and dedication in its Title & credits sheet, the
/// way a reader does with the card still on the page.
Future<void> _saveInSheet(
  WidgetTester tester, {
  required String author,
  required String dedication,
}) async {
  await _tap(tester, 'book-credits-open');
  expect(find.byKey(const ValueKey('matter-save')), findsOneWidget);
  await _type(tester, 'matter-author', author);
  await _type(tester, 'matter-dedication', dedication);
  await _tap(tester, 'matter-save');
  expect(find.byKey(const ValueKey('matter-save')), findsNothing);
}

void main() {
  testWidgets('a finished book with no pen name asks, offering the account '
      'name without filling it in', (tester) async {
    final repo = FakeBookMatterRepository(profile: _unanswered);
    await _pumpPage(tester, repo: repo);

    expect(_card, findsOneWidget);
    expect(find.text('Put your name on it'), findsOneWidget);
    expect(find.text('Use “Mira”'), findsOneWidget);
    final field = tester.widget<TextField>(
      find.byKey(const ValueKey('nudge-pen-name')),
    );
    expect(field.controller!.text, isEmpty);
    // Save waits for a name.
    expect(
      tester
          .widget<FilledButton>(
            find.descendant(
              of: find.byKey(const ValueKey('nudge-save')),
              matching: find.byWidgetPredicate((w) => w is FilledButton),
            ),
          )
          .onPressed,
      isNull,
    );
    expect(repo.writes, isEmpty);
  });

  testWidgets('a book being written asks too', (tester) async {
    final repo = FakeBookMatterRepository(profile: _unanswered);
    await _pumpPage(
      tester,
      repo: repo,
      project: bookProject(status: 'generating'),
      status: bookStatus(status: 'generating', completed: 4),
    );
    expect(_card, findsOneWidget);
  });

  testWidgets('a book finished under a review hold asks too', (tester) async {
    final repo = FakeBookMatterRepository(profile: _unanswered);
    await _pumpPage(
      tester,
      repo: repo,
      project: bookProject(status: 'review_required'),
      status: bookStatus(status: 'review_required'),
    );
    expect(_card, findsOneWidget);
  });

  testWidgets('it does not ask an author who answered, has a pen name, or '
      'whose profile could not be read', (tester) async {
    for (final repo in [
      FakeBookMatterRepository(
        profile: const AuthorProfile(setupPromptSeen: true),
      ),
      FakeBookMatterRepository(profile: const AuthorProfile(penName: 'Mira')),
      FakeBookMatterRepository(profile: _unanswered)
        ..profileReadError = FakeBookMatterRepository.busy,
    ]) {
      await _pumpPage(tester, repo: repo);
      expect(_card, findsNothing);
      // The book's own credits are always one tap away.
      expect(find.byKey(const ValueKey('book-credits-card')), findsOneWidget);
    }
  });

  testWidgets('it does not ask on an author\'s own book or one still being '
      'planned', (tester) async {
    final repo = FakeBookMatterRepository(profile: _unanswered);
    await _pumpPage(
      tester,
      repo: repo,
      project: bookProject(
        source: 'written',
        manuscript: const MobileManuscriptSummary(
          wordCount: 3200,
          chapterCount: 1,
          published: true,
          hasUnpublishedChanges: false,
        ),
      ),
    );
    expect(_card, findsNothing);

    await _pumpPage(
      tester,
      repo: repo,
      project: bookProject(
        status: 'planning',
        withPlan: false,
        exports: exportSet(available: false),
      ),
      status: bookStatus(
        status: 'planning',
        exports: exportSet(available: false),
      ),
    );
    expect(_card, findsNothing);
  });

  testWidgets('Save puts the name on this book and then on the profile, then '
      'the card goes and points at the bio', (tester) async {
    final repo = FakeBookMatterRepository(profile: _unanswered);
    await _pumpPage(tester, repo: repo);

    await _tap(tester, 'pen-name-suggestion');
    await _type(tester, 'nudge-dedication', ' For Leo. ');
    await _tap(tester, 'nudge-save');

    // The book first: it is the half that can refuse, and the profile write
    // is what marks the card answered for good.
    expect(repo.writes.map((call) => call.method), [
      'PATCH matter',
      'PUT profile',
    ]);
    expect(repo.writes.first.projectId, 'project-1');
    expect(repo.writes.first.body, {
      'authorName': 'Mira',
      'dedication': 'For Leo.',
    });
    expect(repo.writes.last.body, {'penName': 'Mira', 'setupPromptSeen': true});
    expect(_card, findsNothing);
    expect(
      find.text('“Mira” is on this book now, and on the ones you make next.'),
      findsOneWidget,
    );

    await tester.tap(find.text('Add a bio'));
    await _settle(tester);
    expect(find.text('author profile page'), findsOneWidget);
  });

  testWidgets('no dedication is sent when none was written', (tester) async {
    final repo = FakeBookMatterRepository(profile: _unanswered);
    await _pumpPage(tester, repo: repo);

    await _type(tester, 'nudge-pen-name', 'M. Quinn');
    await _tap(tester, 'nudge-save');

    expect(repo.writes.first.body, {'authorName': 'M. Quinn'});
  });

  testWidgets('a book that already has a byline starts the field from it, '
      'and Save keeps it without sending it back', (tester) async {
    // The creation chat's "write it under the name Sam Lee".
    final repo = FakeBookMatterRepository(
      profile: _unanswered,
      matter: const BookMatter(authorName: 'Sam Lee'),
    );
    await _pumpPage(tester, repo: repo);

    expect(_text(tester, 'nudge-pen-name'), 'Sam Lee');
    // The account name is not offered over a name the book already prints.
    expect(find.text('Use “Mira”'), findsNothing);
    expect(_saveEnabled(tester), isTrue);

    await _tap(tester, 'nudge-save');

    // Nothing for the book to take: the profile is the whole answer.
    expect(repo.writes.single.method, 'PUT profile');
    expect(repo.writes.single.body, {
      'penName': 'Sam Lee',
      'setupPromptSeen': true,
    });
    expect(repo.matter.authorName, 'Sam Lee');
    expect(_card, findsNothing);
    expect(
      find.text(
        '“Sam Lee” is on this book now, and on the ones you make next.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('a dedication still goes to a book whose byline is kept, without '
      'the name', (tester) async {
    final repo = FakeBookMatterRepository(
      profile: _unanswered,
      matter: const BookMatter(authorName: 'Sam Lee'),
    );
    await _pumpPage(tester, repo: repo);

    await _type(tester, 'nudge-dedication', 'For Leo.');
    await _tap(tester, 'nudge-save');

    expect(repo.writes.map((call) => call.method), [
      'PATCH matter',
      'PUT profile',
    ]);
    expect(repo.writes.first.body, {'dedication': 'For Leo.'});
    expect(repo.writes.last.body['penName'], 'Sam Lee');
  });

  testWidgets('a name typed over the book\'s byline replaces it', (
    tester,
  ) async {
    final repo = FakeBookMatterRepository(
      profile: _unanswered,
      matter: const BookMatter(authorName: 'Sam Lee'),
    );
    await _pumpPage(tester, repo: repo);

    await _type(tester, 'nudge-pen-name', 'M. Quinn');
    await _tap(tester, 'nudge-save');

    expect(repo.writes.first.body, {'authorName': 'M. Quinn'});
    expect(repo.matter.authorName, 'M. Quinn');
  });

  testWidgets('Save waits for the book\'s byline, and words typed meanwhile '
      'are not replaced by it', (tester) async {
    final repo = _SlowMatterRead(
      profile: _unanswered,
      matter: const BookMatter(authorName: 'Sam Lee'),
    );
    await _pumpPage(tester, repo: repo);

    expect(_card, findsOneWidget);
    expect(find.text('Use “Mira”'), findsNothing);
    await _type(tester, 'nudge-pen-name', 'M. Quinn');
    expect(_saveEnabled(tester), isFalse);

    repo.readGate.complete();
    await _settle(tester);
    expect(_text(tester, 'nudge-pen-name'), 'M. Quinn');
    expect(_saveEnabled(tester), isTrue);

    await _tap(tester, 'nudge-save');
    expect(repo.writes.first.body, {'authorName': 'M. Quinn'});
  });

  testWidgets('a book that already has a dedication starts the field from '
      'it, and Save leaves it alone', (tester) async {
    // Set by the book chat while the book was being written.
    final repo = FakeBookMatterRepository(
      profile: _unanswered,
      matter: const BookMatter(dedication: 'For Mum.'),
    );
    await _pumpPage(tester, repo: repo);

    expect(_text(tester, 'nudge-dedication'), 'For Mum.');
    await _type(tester, 'nudge-pen-name', 'M. Quinn');
    await _tap(tester, 'nudge-save');

    expect(repo.writes.first.body, {'authorName': 'M. Quinn'});
    expect(repo.matter.dedication, 'For Mum.');
    expect(_card, findsNothing);
  });

  testWidgets('a dedication the author changes in the card replaces the '
      'book\'s, and one they empty clears it', (tester) async {
    for (final (typed, sent) in [('For Leo.', 'For Leo.'), ('', null)]) {
      final repo = FakeBookMatterRepository(
        profile: _unanswered,
        matter: const BookMatter(authorName: 'Sam Lee', dedication: 'For Mum.'),
      );
      await _pumpPage(tester, repo: repo);

      await _type(tester, 'nudge-dedication', typed);
      await _tap(tester, 'nudge-save');

      expect(repo.writes.first.method, 'PATCH matter');
      expect(repo.writes.first.body, {'dedication': sent});
      expect(repo.matter.dedication, sent);
      expect(repo.matter.authorName, 'Sam Lee');
    }
  });

  testWidgets('a byline and dedication saved in Title & credits move the '
      'card\'s fields, and Save sends neither back', (tester) async {
    final repo = FakeBookMatterRepository(
      profile: _unanswered,
      matter: const BookMatter(authorName: 'Sam Lee', dedication: 'For Mum.'),
    );
    await _pumpPage(tester, repo: repo);
    expect(_text(tester, 'nudge-pen-name'), 'Sam Lee');

    await _saveInSheet(tester, author: 'Jo Park', dedication: 'For Ada.');

    expect(_text(tester, 'nudge-pen-name'), 'Jo Park');
    expect(_text(tester, 'nudge-dedication'), 'For Ada.');
    final sheetWrites = repo.writes.length;
    await _tap(tester, 'nudge-save');

    // The book already prints both: the profile is the whole answer, and
    // it takes the name the book prints now.
    expect(repo.writes.skip(sheetWrites).map((call) => call.method), [
      'PUT profile',
    ]);
    expect(repo.profile.penName, 'Jo Park');
    expect(repo.matter.authorName, 'Jo Park');
    expect(repo.matter.dedication, 'For Ada.');
    // The card's confirmation waits behind the sheet's.
    await tester.pump(const Duration(seconds: 5));
    await _settle(tester);
    expect(
      find.text(
        '“Jo Park” is on this book now, and on the ones you make next.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('words typed into the card stay when Title & credits saves, and '
      'only they are sent', (tester) async {
    final repo = FakeBookMatterRepository(
      profile: _unanswered,
      matter: const BookMatter(authorName: 'Sam Lee', dedication: 'For Mum.'),
    );
    await _pumpPage(tester, repo: repo);
    await _type(tester, 'nudge-pen-name', 'M. Quinn');

    await _saveInSheet(tester, author: 'Jo Park', dedication: 'For Ada.');

    expect(_text(tester, 'nudge-pen-name'), 'M. Quinn');
    expect(_text(tester, 'nudge-dedication'), 'For Ada.');
    await _tap(tester, 'nudge-save');

    expect(
      repo.writes.where((call) => call.method == 'PATCH matter').last.body,
      {'authorName': 'M. Quinn'},
    );
    expect(repo.matter.authorName, 'M. Quinn');
    expect(repo.matter.dedication, 'For Ada.');
  });

  testWidgets('a Title & credits save heard before the card\'s first read '
      'lands is not undone by it', (tester) async {
    final repo = _FirstReadHeld(
      profile: _unanswered,
      matter: const BookMatter(authorName: 'Sam Lee', dedication: 'For Mum.'),
    );
    await _pumpPage(tester, repo: repo);
    expect(_saveEnabled(tester), isFalse);

    await _saveInSheet(tester, author: 'Jo Park', dedication: 'For Ada.');
    expect(_text(tester, 'nudge-pen-name'), 'Jo Park');
    expect(_saveEnabled(tester), isTrue);

    // The card's read answers with the book as it was before the sheet.
    repo.readGate.complete();
    await _settle(tester);
    expect(_text(tester, 'nudge-pen-name'), 'Jo Park');
    expect(_text(tester, 'nudge-dedication'), 'For Ada.');

    final sheetWrites = repo.writes.length;
    await _tap(tester, 'nudge-save');
    expect(repo.writes.skip(sheetWrites).single.method, 'PUT profile');
    expect(repo.matter.authorName, 'Jo Park');
  });

  for (final reprint in BookMatterReprint.values) {
    testWidgets('a refused profile write still refreshes the saved book '
        '(${reprint.name}), and Save again only retries the profile', (
      tester,
    ) async {
      final repo = FakeBookMatterRepository(
        profile: _unanswered,
        reprint: reprint,
      )..profileWriteError = FakeBookMatterRepository.busy;
      final reads = _BookReads();
      await _pumpPage(tester, repo: repo, reads: reads);
      expect((reads.detail, reads.library, reads.status), (1, 1, 1));

      await _type(tester, 'nudge-pen-name', 'M. Quinn');
      await _type(tester, 'nudge-dedication', 'For Leo.');
      await _tap(tester, 'nudge-save');

      expect(_card, findsOneWidget);
      expect(repo.matter.authorName, 'M. Quinn');
      expect(repo.profile.setupPromptSeen, isFalse);
      final statusReads = reprint == BookMatterReprint.queued ? 2 : 1;
      expect((reads.detail, reads.library, reads.status), (2, 2, statusReads));

      repo.profileWriteError = null;
      await _tap(tester, 'nudge-save');
      expect(repo.writes.map((call) => call.method), [
        'PATCH matter',
        'PUT profile',
        'PUT profile',
      ]);
      expect((reads.detail, reads.library, reads.status), (2, 2, statusReads));
      expect(repo.profile.penName, 'M. Quinn');
      expect(_card, findsNothing);
    });
  }

  testWidgets('a book whose matter cannot be read is asked as one with no '
      'byline', (tester) async {
    final repo = FakeBookMatterRepository(profile: _unanswered)
      ..matterReadError = FakeBookMatterRepository.busy;
    await _pumpPage(tester, repo: repo);

    expect(_text(tester, 'nudge-pen-name'), isEmpty);
    expect(find.text('Use “Mira”'), findsOneWidget);
    await _tap(tester, 'pen-name-suggestion');
    await _tap(tester, 'nudge-save');

    expect(repo.writes.first.body, {'authorName': 'Mira'});
  });

  testWidgets('Not now answers the prompt and the card goes at once', (
    tester,
  ) async {
    final repo = FakeBookMatterRepository(profile: _unanswered);
    await _pumpPage(tester, repo: repo);

    await _tap(tester, 'nudge-not-now');

    expect(_card, findsNothing);
    expect(repo.writes.single.method, 'PUT profile');
    expect(repo.writes.single.body, {'setupPromptSeen': true});
    expect(repo.profile.setupPromptSeen, isTrue);
    expect(repo.profile.penName, isNull);
  });

  testWidgets('a book that cannot take the name keeps the card and says why', (
    tester,
  ) async {
    final repo = FakeBookMatterRepository(profile: _unanswered)
      ..matterWriteError = FakeBookMatterRepository.busy;
    await _pumpPage(tester, repo: repo);

    await _type(tester, 'nudge-pen-name', 'M. Quinn');
    await _tap(tester, 'nudge-save');

    expect(_card, findsOneWidget);
    expect(
      find.text(
        'This book is being changed right now. Try again once that finishes.',
      ),
      findsOneWidget,
    );
    // Nothing marked the card answered, so it is still asked next time too.
    expect(repo.profile.setupPromptSeen, isFalse);
    expect(repo.profile.penName, isNull);

    repo.matterWriteError = null;
    await _tap(tester, 'nudge-save');
    expect(_card, findsNothing);
    expect(repo.matter.authorName, 'M. Quinn');
  });

  testWidgets('words typed while the book is written are still there when it '
      'finishes', (tester) async {
    final repo = FakeBookMatterRepository(profile: _unanswered);
    final book = await _pumpPage(
      tester,
      repo: repo,
      project: _writing.project,
      status: _writing.status,
    );
    expect(find.byKey(const ValueKey('book-section-progress')), findsOneWidget);

    await _type(tester, 'nudge-pen-name', 'M. Quinn');
    await _type(tester, 'nudge-dedication', 'For Leo.');
    // The book finishes: the progress card above the nudge leaves the page.
    book.value = (project: bookProject(), status: bookStatus(), page: 0);
    await _settle(tester);

    expect(find.byKey(const ValueKey('book-section-progress')), findsNothing);
    expect(_card, findsOneWidget);
    expect(_text(tester, 'nudge-pen-name'), 'M. Quinn');
    expect(_text(tester, 'nudge-dedication'), 'For Leo.');
    expect(repo.writes, isEmpty);
  });

  testWidgets('a save that lands after the book finished takes the card '
      'away', (tester) async {
    final repo = FakeBookMatterRepository(profile: _unanswered);
    final book = await _pumpPage(
      tester,
      repo: repo,
      project: _writing.project,
      status: _writing.status,
    );
    await _type(tester, 'nudge-pen-name', 'M. Quinn');
    final gate = repo.writeGate = Completer<void>();
    await _tap(tester, 'nudge-save');
    expect(repo.writes.single.method, 'PATCH matter');

    book.value = (project: bookProject(), status: bookStatus(), page: 0);
    await _settle(tester);
    // Still saving, on the same card.
    expect(_card, findsOneWidget);
    expect(_text(tester, 'nudge-pen-name'), 'M. Quinn');

    gate.complete();
    await _settle(tester);
    expect(repo.writes.map((call) => call.method), [
      'PATCH matter',
      'PUT profile',
    ]);
    expect(_card, findsNothing);
    expect(
      find.text(
        '“M. Quinn” is on this book now, and on the ones you make next.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('a save whose card was built again meanwhile still answers the '
      'profile', (tester) async {
    final repo = FakeBookMatterRepository(profile: _unanswered);
    final book = await _pumpPage(tester, repo: repo);
    await _type(tester, 'nudge-pen-name', 'M. Quinn');
    final gate = repo.writeGate = Completer<void>();
    await _tap(tester, 'nudge-save');

    // The whole page is built again: the card the save started in is gone,
    // and the one on the page now knows nothing about it.
    book.value = (
      project: book.value.project,
      status: book.value.status,
      page: 1,
    );
    await _settle(tester);
    expect(_card, findsOneWidget);

    gate.complete();
    await _settle(tester);
    expect(repo.profile.setupPromptSeen, isTrue);
    expect(_card, findsNothing);
  });

  testWidgets('an emoji counts twice toward the name, as the server counts '
      'it', (tester) async {
    final repo = FakeBookMatterRepository(profile: _unanswered);
    await _pumpPage(tester, repo: repo);

    // 100 characters, 200 UTF-16 units: past the pen name's 120.
    await _type(tester, 'nudge-pen-name', '🦊' * 100);
    expect(_text(tester, 'nudge-pen-name'), '🦊' * 60);
    await _tap(tester, 'nudge-save');

    final sent = repo.writes.first.body['authorName']! as String;
    expect(sent.length, AuthorProfileLimits.penName);
    expect(repo.writes.last.body['penName'], sent);
  });
}

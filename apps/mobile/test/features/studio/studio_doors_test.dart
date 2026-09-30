import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/book_library.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_library_screen.dart';
import 'package:tomeza/features/projects/presentation/book_status.dart';
import 'package:tomeza/features/projects/presentation/chat_history_drawer.dart';
import 'package:tomeza/features/studio/domain/manuscript_models.dart';

import '../../projects/book_page_fixtures.dart';
import '../../projects/chat_history_drawer_harness.dart' as drawer;
import '../../projects/creation_chat_fakes.dart';
import '../../projects/creation_chat_harness.dart';

// The four quiet doors into "Write it yourself", and how a written book sits
// on the shelf before it is published.

const _sheetTitle = 'Write it yourself';

MobileProjectDetail _writtenDraft() => bookProject(
  status: 'draft',
  source: 'written',
  withPlan: false,
  pageCount: 0,
  exports: exportSet(available: false),
  statusLabel: 'Writing · 3,200 words',
  manuscript: const MobileManuscriptSummary(
    wordCount: 3200,
    chapterCount: 2,
    published: false,
    hasUnpublishedChanges: true,
  ),
);

Widget _library(List<MobileProjectSummary> projects) => ProviderScope(
  overrides: [
    projectsProvider.overrideWith((ref) async => projects),
    billingRepositoryProvider.overrideWithValue(drawer.FakeBillingRepository()),
  ],
  child: MaterialApp(
    theme: buildTomezaLightTheme(),
    home: const BookLibraryScreen(),
  ),
);

void main() {
  testWidgets('the chat welcome has one quiet line into the Studio', (
    tester,
  ) async {
    await tester.pumpWidget(app(creation: ScriptedCreationRepository()));
    await tester.pumpAndSettle();

    final link = find.byKey(const ValueKey('welcome-writing-studio'));
    expect(link, findsOneWidget);
    // A line, not a second button competing with the ideas.
    expect(find.widgetWithText(FilledButton, _sheetTitle), findsNothing);
    await tester.ensureVisible(link);
    await tester.tap(link);
    await tester.pumpAndSettle();

    expect(find.text(_sheetTitle), findsOneWidget);
    await tester.teardownScreen();
  });

  testWidgets('the attach sheet offers writing it yourself', (tester) async {
    await tester.pumpWidget(
      app(creation: ScriptedCreationRepository(), startFresh: true),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Attach a photo, document, or notes'));
    await tester.pumpAndSettle();
    expect(find.text('Import a finished manuscript'), findsNothing);
    final row = find.byKey(const ValueKey('attach-write-it-yourself'));
    await tester.ensureVisible(row);
    await tester.pumpAndSettle();
    await tester.tap(row);
    await tester.pumpAndSettle();

    expect(find.text(_sheetTitle), findsOneWidget);
    await tester.teardownScreen();
  });

  testWidgets('the drawer offers "or write it yourself" under New book', (
    tester,
  ) async {
    tester.view
      ..physicalSize = const Size(390, 844) * 3
      ..devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final scaffold = GlobalKey<ScaffoldState>();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          creationRepositoryProvider.overrideWithValue(
            drawer.FakeCreationRepository(const []),
          ),
          billingRepositoryProvider.overrideWithValue(
            drawer.FakeBillingRepository(),
          ),
          projectsProvider.overrideWith(
            (ref) async => const <MobileProjectSummary>[],
          ),
        ],
        child: MaterialApp(
          theme: buildTomezaLightTheme(),
          home: Scaffold(
            key: scaffold,
            drawer: const ChatHistoryDrawer(),
            body: const SizedBox(),
          ),
        ),
      ),
    );
    scaffold.currentState!.openDrawer();
    await tester.pumpAndSettle();

    final newBook = tester.getRect(find.text('New book'));
    final link = find.byKey(const ValueKey('drawer-write-it-yourself'));
    expect(tester.getRect(link).top, greaterThan(newBook.bottom));
    await tester.tap(link);
    await tester.pumpAndSettle();

    expect(scaffold.currentState!.isDrawerOpen, isFalse);
    expect(find.text(_sheetTitle), findsOneWidget);
  });

  testWidgets('a short screen keeps its rows for the chats', (tester) async {
    tester.view
      ..physicalSize = const Size(360, 600) * 3
      ..devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final scaffold = GlobalKey<ScaffoldState>();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          creationRepositoryProvider.overrideWithValue(
            drawer.FakeCreationRepository(const []),
          ),
          billingRepositoryProvider.overrideWithValue(
            drawer.FakeBillingRepository(),
          ),
          projectsProvider.overrideWith(
            (ref) async => const <MobileProjectSummary>[],
          ),
        ],
        child: MaterialApp(
          theme: buildTomezaLightTheme(),
          home: Scaffold(
            key: scaffold,
            drawer: const ChatHistoryDrawer(),
            body: const SizedBox(),
          ),
        ),
      ),
    );
    scaffold.currentState!.openDrawer();
    await tester.pumpAndSettle();

    expect(find.text('New book'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('drawer-write-it-yourself')),
      findsNothing,
    );
  });

  testWidgets('an empty library offers writing it yourself', (tester) async {
    await tester.pumpWidget(_library(const []));
    await tester.pumpAndSettle();

    expect(find.text('Import a manuscript'), findsNothing);
    await tester.tap(find.byKey(const ValueKey('library-write-it-yourself')));
    await tester.pumpAndSettle();

    // The button and the sheet share their words; the sheet is the one with
    // Start writing.
    expect(find.text(_sheetTitle), findsNWidgets(2));
    expect(find.byKey(const ValueKey('start-writing-button')), findsOneWidget);
  });

  test('a written book is a book from its first word', () {
    final draftIdea = bookProject(
      status: 'draft',
      withPlan: false,
      pageCount: 0,
    );
    final books = libraryBooks([draftIdea, _writtenDraft()]);
    expect(books, hasLength(1));
    expect(books.single.isWritten, isTrue);

    final status = bookStatusInfo(_writtenDraft());
    expect(status.kind, BookStatusKind.inProgress);
    // The shelf's short form; the library card spells out the server's label.
    expect(status.label, 'Writing');
    expect(status.progress, isNull);
  });

  testWidgets('the library card says the words, not a percentage or pages', (
    tester,
  ) async {
    await tester.pumpWidget(_library([_writtenDraft()]));
    await tester.pumpAndSettle();

    expect(find.text('Writing · 3,200 words'), findsOneWidget);
    expect(find.textContaining('0 pages'), findsNothing);
    expect(find.textContaining('%'), findsNothing);
    expect(find.byType(LinearProgressIndicator), findsNothing);
  });
}

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_cover.dart';
import 'package:tomeza/features/projects/presentation/book_shelf.dart';

void main() {
  testWidgets('shelf shows a cover per book, most recent first', (
    tester,
  ) async {
    await tester.pumpWidget(
      shelfTestApp([
        shelfProject(
          id: 'writing',
          title: 'Half Written',
          status: 'generating',
          hasPlan: true,
          progressPercent: 40,
          updatedAt: DateTime.utc(2026, 6, 20),
        ),
        shelfProject(
          id: 'done',
          title: 'Finished Book',
          status: 'complete',
          hasPlan: true,
          exportsReady: true,
          updatedAt: DateTime.utc(2026, 6, 10),
        ),
      ]),
    );
    await tester.pumpAndSettle();

    expect(find.text('Your books'), findsOneWidget);
    expect(find.byType(BookCover), findsNWidgets(2));
    expect(find.text('Ready'), findsOneWidget);
    expect(find.text('40% written'), findsOneWidget);

    // A book still being written is not pushed behind the finished one: the
    // shelf is ordered by what was touched last.
    final covers = tester.widgetList<BookCover>(find.byType(BookCover));
    expect(covers.first.title, 'Half Written');
    expect(covers.last.title, 'Finished Book');
  });

  testWidgets('ideas without a plan are not shelved as books', (tester) async {
    await tester.pumpWidget(
      shelfTestApp([
        shelfProject(id: 'idea', title: 'Just An Idea', status: 'draft'),
      ]),
    );
    await tester.pumpAndSettle();

    expect(find.text('Your books'), findsNothing);
    expect(find.byType(BookCover), findsNothing);
  });

  testWidgets('a book with no cover art still renders a cover', (tester) async {
    await tester.pumpWidget(
      shelfTestApp([
        shelfProject(
          id: 'no-art',
          title: 'Coverless Guide',
          status: 'complete',
          hasPlan: true,
          exportsReady: true,
        ),
      ]),
    );
    await tester.pumpAndSettle();

    expect(find.byType(BookCover), findsOneWidget);
    // The title is drawn on the placeholder art as well as the shelf label.
    expect(find.text('Coverless Guide'), findsNWidgets(2));
  });

  testWidgets('holding a finished book offers open and share per format', (
    tester,
  ) async {
    await tester.pumpWidget(
      shelfTestApp([
        shelfProject(
          id: 'done',
          title: 'Finished Book',
          status: 'complete',
          hasPlan: true,
          exportsReady: true,
          epubReady: true,
        ),
      ]),
    );
    await tester.pumpAndSettle();

    await tester.longPress(find.byType(BookCover));
    await tester.pumpAndSettle();

    expect(find.text('Go to chat'), findsOneWidget);
    expect(find.text('Open PDF'), findsOneWidget);
    expect(find.text('Open EPUB'), findsOneWidget);
    expect(find.text('Share PDF'), findsOneWidget);
    expect(find.text('Share EPUB'), findsOneWidget);
  });

  testWidgets('Go to chat opens the selected book chat', (tester) async {
    final router = GoRouter(
      initialLocation: '/',
      routes: [
        GoRoute(
          path: '/',
          builder: (context, state) =>
              const Scaffold(body: SizedBox(width: 400, child: BookShelf())),
        ),
        GoRoute(
          path: '/projects/:id/chat',
          builder: (context, state) =>
              Text('Chat for ${state.pathParameters['id']}'),
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          projectsProvider.overrideWith(
            (ref) async => [
              shelfProject(
                id: 'selected-book',
                title: 'Selected Book',
                status: 'generating',
                hasPlan: true,
                progressPercent: 40,
              ),
            ],
          ),
          billingProvider.overrideWith((ref) async => billingWith(900)),
        ],
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pumpAndSettle();

    await tester.longPress(find.byType(BookCover));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Go to chat'));
    await tester.pumpAndSettle();

    expect(find.text('Chat for selected-book'), findsOneWidget);
  });

  testWidgets('formats that are not compiled yet are held but disabled', (
    tester,
  ) async {
    await tester.pumpWidget(
      shelfTestApp([
        shelfProject(
          id: 'writing',
          title: 'Half Written',
          status: 'generating',
          hasPlan: true,
          progressPercent: 40,
        ),
      ]),
    );
    await tester.pumpAndSettle();

    await tester.longPress(find.byType(BookCover));
    await tester.pumpAndSettle();

    // Export entries do not change shape mid-generation, while chat stays
    // available so the user can continue working on the book.
    expect(find.text('Go to chat'), findsOneWidget);
    expect(find.text('Read in Tomeza — preparing'), findsOneWidget);
    expect(find.text('Open PDF — preparing'), findsOneWidget);
    expect(find.text('Open EPUB — preparing'), findsOneWidget);
    expect(find.text('Share PDF — preparing'), findsOneWidget);
    expect(find.text('Share EPUB — preparing'), findsOneWidget);

    // Every entry is inert until the export exists, so nothing in the menu
    // can be tapped into a dead end.
    expect(
      find.byWidgetPredicate((w) => w is PopupMenuItem && !w.enabled),
      findsNWidgets(5),
    );
    expect(
      find.byWidgetPredicate((w) => w is PopupMenuItem && w.enabled),
      findsOneWidget,
    );
  });

  testWidgets(
    'a ready but locked export only shows a lock when credits fall short',
    (tester) async {
      final lockedBook = shelfProject(
        id: 'locked',
        title: 'Locked Book',
        status: 'complete',
        hasPlan: true,
      ).copyWithLockedPdf();

      // Plenty of credits: the unlock is covered, so no lock is advertised.
      await tester.pumpWidget(shelfTestApp([lockedBook], credits: 900));
      await tester.pumpAndSettle();
      await tester.longPress(find.byType(BookCover));
      await tester.pumpAndSettle();

      expect(find.text('Open PDF'), findsOneWidget);
      expect(find.byIcon(Icons.lock_outline), findsNothing);
    },
  );

  testWidgets('a locked export shows a lock when credits are short', (
    tester,
  ) async {
    final lockedBook = shelfProject(
      id: 'locked',
      title: 'Locked Book',
      status: 'complete',
      hasPlan: true,
    ).copyWithLockedPdf();

    await tester.pumpWidget(shelfTestApp([lockedBook], credits: 10));
    await tester.pumpAndSettle();
    await tester.longPress(find.byType(BookCover));
    await tester.pumpAndSettle();

    // One lock each for Read, Open PDF and Share PDF — reading downloads
    // through the same entitlement-gated route as the other two.
    expect(find.byIcon(Icons.lock_outline), findsNWidgets(3));
  });

  testWidgets('reopening the shelf paints known books before refetching', (
    tester,
  ) async {
    final repository = _CountingProjectsRepository([
      shelfProject(
        id: 'done',
        title: 'Finished Book',
        status: 'complete',
        hasPlan: true,
        exportsReady: true,
      ),
    ]);
    // One list, so remounting updates the same ProviderScope instead of
    // building a fresh container and hiding the cache we are testing.
    final overrides = [
      projectsRepositoryProvider.overrideWithValue(repository),
      billingProvider.overrideWith((ref) async => billingWith(900)),
    ];
    Widget app({required bool shelfMounted}) => ProviderScope(
      overrides: overrides,
      child: MaterialApp(
        home: Scaffold(
          body: shelfMounted
              ? const SizedBox(width: 400, child: BookShelf())
              : const SizedBox.shrink(),
        ),
      ),
    );

    await tester.pumpWidget(app(shelfMounted: true));
    await tester.pumpAndSettle();
    expect(find.byType(BookCover), findsOneWidget);
    expect(repository.listCalls, 1);

    // Closing the drawer unmounts the shelf.
    await tester.pumpWidget(app(shelfMounted: false));
    await tester.pumpAndSettle();
    expect(find.byType(BookCover), findsNothing);

    // Reopening it must not blank out first: the cover is there on the very
    // first frame, before the refresh this mount kicks off comes back.
    await tester.pumpWidget(app(shelfMounted: true));
    expect(find.byType(BookCover), findsOneWidget);

    await tester.pumpAndSettle();
    expect(find.byType(BookCover), findsOneWidget);
    expect(repository.listCalls, 2);
  });
}

class _CountingProjectsRepository implements ProjectsRepository {
  _CountingProjectsRepository(this.projects);

  final List<MobileProjectSummary> projects;
  int listCalls = 0;

  @override
  Future<List<MobileProjectSummary>> listProjects() async {
    listCalls += 1;
    return projects;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    return super.noSuchMethod(invocation);
  }
}

Widget shelfTestApp(List<MobileProjectSummary> projects, {int credits = 900}) {
  return ProviderScope(
    overrides: [
      projectsProvider.overrideWith((ref) async => projects),
      billingProvider.overrideWith((ref) async => billingWith(credits)),
    ],
    child: const MaterialApp(
      home: Scaffold(body: SizedBox(width: 400, child: BookShelf())),
    ),
  );
}

MobileBilling billingWith(int available) {
  return MobileBilling(
    credits: CreditBalance(
      available: available,
      reserved: 0,
      lifetimeGranted: available,
      lifetimeSpent: 0,
    ),
    entitlements: const [],
    products: const [],
    creditCosts: const {},
  );
}

extension on MobileProjectSummary {
  /// A finished book whose PDF is compiled but not yet paid for.
  MobileProjectSummary copyWithLockedPdf() {
    return MobileProjectSummary(
      id: id,
      title: title,
      bookType: bookType,
      lengthPreset: lengthPreset,
      qualityPreset: qualityPreset,
      imagesEnabled: imagesEnabled,
      status: status,
      statusLabel: statusLabel,
      progressPercent: progressPercent,
      currentAction: currentAction,
      promptPreview: promptPreview,
      targetPages: targetPages,
      pageCount: pageCount,
      imageCount: imageCount,
      hasPlan: hasPlan,
      exports: MobileExportSet(
        pdf: MobileExportAvailability(
          format: 'pdf',
          available: true,
          unlocked: false,
          creditsRequired: 150,
          downloadUrl: exports.pdf.downloadUrl,
          filename: exports.pdf.filename,
          contentType: exports.pdf.contentType,
        ),
        epub: exports.epub,
      ),
      createdAt: createdAt,
      updatedAt: updatedAt,
    );
  }
}

MobileProjectSummary shelfProject({
  required String id,
  required String title,
  required String status,
  bool hasPlan = false,
  bool exportsReady = false,
  bool epubReady = false,
  int progressPercent = 0,
  DateTime? updatedAt,
}) {
  return MobileProjectSummary(
    id: id,
    title: title,
    bookType: 'workbook',
    lengthPreset: 'standard',
    qualityPreset: 'balanced',
    imagesEnabled: true,
    status: status,
    statusLabel: status,
    progressPercent: progressPercent,
    currentAction: status,
    promptPreview: 'A practical workbook.',
    targetPages: 18,
    pageCount: hasPlan ? 6 : 0,
    imageCount: 0,
    hasPlan: hasPlan,
    exports: shelfExports(ready: exportsReady, epubReady: epubReady),
    createdAt: DateTime.utc(2026, 6, 1),
    updatedAt: updatedAt ?? DateTime.utc(2026, 6, 1),
  );
}

MobileExportSet shelfExports({required bool ready, bool epubReady = false}) {
  return MobileExportSet(
    pdf: MobileExportAvailability(
      format: 'pdf',
      available: ready,
      unlocked: ready,
      creditsRequired: 150,
      downloadUrl: '/api/mobile/projects/p/export/pdf',
      filename: 'book.pdf',
      contentType: 'application/pdf',
    ),
    epub: MobileExportAvailability(
      format: 'epub',
      available: epubReady,
      unlocked: epubReady,
      creditsRequired: 150,
      downloadUrl: '/api/mobile/projects/p/export/epub',
      filename: 'book.epub',
      contentType: 'application/epub+zip',
    ),
  );
}

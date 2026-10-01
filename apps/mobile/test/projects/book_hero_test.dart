import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_stage.dart';
import 'package:tomeza/features/projects/presentation/book_hero.dart';
import 'package:tomeza/features/projects/presentation/project_export_panel.dart';

import 'book_page_fixtures.dart';

// The book page's hero, and the two cards a book that is not simply fine gets.

Future<void> _tall(WidgetTester tester) async {
  await tester.binding.setSurfaceSize(const Size(500, 2600));
  addTearDown(() => tester.binding.setSurfaceSize(null));
}

void main() {
  testWidgets('the planner\'s scaffolding never reaches the description', (
    tester,
  ) async {
    await _tall(tester);
    await tester.pumpWidget(
      bookPageApp(
        visited: [],
        project: bookProject(withPlan: false),
        status: bookStatus(),
      ),
    );
    await tester.pump();

    expect(find.textContaining('Book type choice'), findsNothing);
    expect(find.textContaining('Creation chat'), findsNothing);
    expect(find.textContaining('Assistant:'), findsNothing);
    expect(
      find.text(
        'A lighthouse keeper finds a bottle with a letter from her future self.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('Read, Listen, Edit and Export lead to their own places', (
    tester,
  ) async {
    await _tall(tester);
    const routes = {
      'Read': '/projects/project-1/read',
      'Listen': '/projects/project-1/listen',
      'Edit': '/projects/project-1/edit',
    };
    for (final entry in routes.entries) {
      final visited = <String>[];
      await tester.pumpWidget(
        bookPageApp(
          visited: visited,
          project: bookProject(),
          status: bookStatus(),
        ),
      );
      await tester.pump();
      await tester.tap(find.text(entry.key));
      await tester.pumpAndSettle();
      expect(visited, [entry.value], reason: entry.key);
    }
  });

  testWidgets('a book held for review reads and edits but does not listen', (
    tester,
  ) async {
    await _tall(tester);
    await tester.pumpWidget(
      bookPageApp(
        visited: [],
        project: bookProject(status: 'review_required'),
        status: bookStatus(status: 'review_required'),
      ),
    );
    await tester.pump();

    expect(find.text('Worth a look'), findsOneWidget);
    expect(find.text('Read'), findsOneWidget);
    expect(find.text('Edit'), findsOneWidget);
    expect(find.text('Listen'), findsNothing);
  });

  testWidgets('quality concerns fold to a count and open on demand', (
    tester,
  ) async {
    await _tall(tester);
    final visited = <String>[];
    await tester.pumpWidget(
      bookPageApp(
        visited: visited,
        project: bookProject(),
        status: bookStatus(quality: reviewQuality),
      ),
    );
    await tester.pump();

    expect(find.text('Review recommended'), findsOneWidget);
    expect(find.text('2 notes on the writing'), findsOneWidget);
    // Folded: the quoted concerns are not on the page.
    expect(find.text('Pages 4 and 9 end on the same image.'), findsNothing);

    await tester.tap(find.text('Review recommended'));
    await tester.pumpAndSettle();
    expect(find.text('Pages 4 and 9 end on the same image.'), findsOneWidget);

    await tester.tap(find.text('Review'));
    await tester.pumpAndSettle();
    expect(visited, ['/projects/project-1/edit?pageIndex=4']);
  });

  testWidgets('a stopped book says what happened and retries in one tap', (
    tester,
  ) async {
    await _tall(tester);
    var retried = 0;
    await tester.pumpWidget(
      bookPageApp(
        visited: [],
        project: bookProject(status: 'failed'),
        status: bookStatus(
          status: 'failed',
          failure: 'The writer timed out on page 5.',
          retry: true,
          completed: 4,
        ),
        onResume: () async => retried++,
      ),
    );
    await tester.pump();

    expect(find.text('Writing stopped'), findsOneWidget);
    expect(find.text('The writer timed out on page 5.'), findsOneWidget);
    expect(find.text('4 of 16 pages saved'), findsOneWidget);
    // The action is there, and it is not a second checklist.
    await tester.tap(find.text('Retry generation'));
    await tester.pump();
    expect(retried, 1);
  });

  testWidgets('a stopped book that cannot retry still offers the chat', (
    tester,
  ) async {
    await _tall(tester);
    final visited = <String>[];
    await tester.pumpWidget(
      bookPageApp(
        visited: visited,
        project: bookProject(status: 'failed', withPlan: false),
        status: bookStatus(status: 'failed', failure: 'Something broke.'),
      ),
    );
    await tester.pump();

    expect(find.text('Planning stopped'), findsOneWidget);
    expect(find.text('Retry generation'), findsNothing);
    await tester.tap(find.text('Ask in chat'));
    await tester.pumpAndSettle();
    expect(visited, ['/projects/project-1/chat']);
  });

  testWidgets('the hero and the cards hold at 2x text without overflow', (
    tester,
  ) async {
    await _tall(tester);
    await tester.pumpWidget(
      bookPageApp(
        visited: [],
        project: bookProject(),
        status: bookStatus(quality: reviewQuality),
        textScaler: const TextScaler.linear(2),
      ),
    );
    await tester.pump();
    await tester.tap(find.text('Export'));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.text('Read'), findsOneWidget);
  });

  test('the fact line names chapters, pages and the type once', () {
    final project = bookProject(pageCount: 16);
    expect(
      bookMetaLine(stage: BookStage.ready, project: project),
      '2 chapters · 16 pages · Short story',
    );
    // The plan under a plan review says all of it itself.
    expect(bookMetaLine(stage: BookStage.planReview, project: project), isNull);
  });

  test('an author\'s own book names no AI effort tier', () {
    // A Studio book read "1 chapter · 1 page · Balanced".
    final generated = bookProject(pageCount: 16, bookType: 'custom');
    final written = bookProject(
      pageCount: 16,
      bookType: 'custom',
      source: 'written',
    );
    expect(
      bookMetaLine(stage: BookStage.ready, project: generated),
      '2 chapters · 16 pages · Balanced',
    );
    expect(
      bookMetaLine(stage: BookStage.ready, project: written),
      '2 chapters · 16 pages',
    );
  });

  group('export rows', () {
    Widget panel(MobileExportSet exports, {VoidCallback? onRefresh}) {
      return MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: ProjectExportPanel(
              exports: exports,
              billing: creditsBilling,
              onRefresh: onRefresh,
              onOpen: (_) async {},
              onDownload: (_) async {},
              onOpenPaywall: (_) async {},
            ),
          ),
        ),
      );
    }

    testWidgets('a ready file says how big it is', (tester) async {
      await tester.pumpWidget(panel(exportSet(pdfBytes: 2410000)));
      expect(find.text('Ready · 2.4 MB'), findsOneWidget);
      expect(find.text('Ready · 612 KB'), findsOneWidget);
    });

    testWidgets('a file being prepared holds still and can be asked again', (
      tester,
    ) async {
      var refreshed = 0;
      await tester.pumpWidget(
        panel(exportSet(available: false), onRefresh: () => refreshed++),
      );
      // Settles: nothing here animates forever over a wait that may not end.
      await tester.pumpAndSettle();

      expect(find.text('Preparing…'), findsNWidgets(2));
      await tester.tap(find.text('Check again'));
      expect(refreshed, 1);
    });

    test('sizes read in KB below a megabyte and MB above', () {
      expect(formatExportSize(612000), '612 KB');
      expect(formatExportSize(2410000), '2.4 MB');
      expect(formatExportSize(48000000), '48 MB');
    });
  });
}

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/reader/data/reader_repository.dart';
import 'package:tomeza/features/reader/domain/reader_models.dart';
import 'package:tomeza/features/reader/presentation/book_reader_screen.dart';
import 'package:tomeza/features/reader/presentation/reader_app_bar.dart';
import 'package:tomeza/features/reader/presentation/reader_bottom_bar.dart';
import 'package:tomeza/features/reader/presentation/reader_document_loader.dart';
import 'package:tomeza/features/reader/presentation/reader_markup_toolbar.dart';
import 'package:tomeza/features/reader/presentation/reader_scroll_handle.dart';
import 'package:tomeza/features/reader/presentation/reader_view.dart';

import 'book_reader_test_support.dart';

/// The reader's chrome: the bars, what hides them, and what that costs the
/// page underneath.
///
/// Split from `book_reader_screen_test.dart`, which is about the document —
/// downloading it, telling one compile from the next, and keeping a place in
/// it. These are about the furniture around it.
void main() {
  testWidgets('the bars lie over the page and never resize it', (tester) async {
    // The whole point of the layout: pdfrx answers a view-size change by
    // keeping the same document point at the box's origin, so a box that grows
    // moves the paragraph being read. Here the box never changes and the bars
    // fade over it instead.
    viewerBoxes = [];
    final repository = FakeReaderRepository();
    final loader = ReaderDocumentLoader(
      repository: repository,
      projectId: 'project-1',
    );
    addTearDown(loader.dispose);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          readerRepositoryProvider.overrideWithValue(repository),
          readerViewerBuilderProvider.overrideWithValue(measuringViewer),
        ],
        child: MaterialApp(
          home: ReaderView(
            projectId: 'project-1',
            export: pdfExport(),
            loader: loader,
            status: statusWith(pdfExport()),
            onOpenPaywall: () {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(ReaderAppBar), findsOneWidget);
    expect(find.byType(ReaderBottomChrome), findsOneWidget);
    final beforeToggle = viewerBoxes.last;

    await chooseFromMenu(tester, 'Full screen');

    expect(viewerBoxes.toSet(), {
      beforeToggle,
    }, reason: 'the page was laid out in a different box');
  });

  testWidgets('the phone keeps its status bar, and the book stays off it', (
    tester,
  ) async {
    // Full screen puts *our* bars away. The strip the clock lives in is not
    // ours to take, and the book must never scroll under it.
    tester.view.padding = const FakeViewPadding(top: 60);
    addTearDown(tester.view.reset);

    final repository = FakeReaderRepository();
    await pumpReader(tester, repository: repository, export: pdfExport());
    await tester.pumpAndSettle();

    double pageTop() => tester.getTopLeft(find.byType(ReaderScrollHandle)).dy;
    final withBars = pageTop();
    expect(withBars, greaterThanOrEqualTo(60 / tester.view.devicePixelRatio));

    await chooseFromMenu(tester, 'Full screen');

    expect(
      pageTop(),
      withBars,
      reason: 'the page starts below the status bar either way',
    );
  });

  testWidgets('full screen leaves a way back, and it goes back', (
    tester,
  ) async {
    // The menu is behind the bar full screen just hid, so the way out has to be
    // on the page — and it is the same control either way round.
    final repository = FakeReaderRepository();

    await pumpReader(tester, repository: repository, export: pdfExport());
    await tester.pumpAndSettle();

    // Hidden, not removed: a bar that slid off the top is still in the tree so
    // it can slide back. `excluding` is what says it is really gone — reachable
    // by neither a finger nor a screen reader.
    bool barsHidden() => tester
        .widget<ExcludeSemantics>(
          find
              .ancestor(
                of: find.byType(ReaderBottomChrome),
                matching: find.byType(ExcludeSemantics),
              )
              .first,
        )
        .excluding;

    expect(barsHidden(), isFalse);

    await chooseFromMenu(tester, 'Full screen');
    expect(barsHidden(), isTrue);

    await tester.tap(find.byTooltip('Exit full screen'));
    await tester.pumpAndSettle();

    expect(barsHidden(), isFalse);
    expect(find.byTooltip('Exit full screen'), findsNothing);
  });

  testWidgets(
    'a tap between the pages hides the bars, and another shows them',
    (tester) async {
      // The per-page overlay only covers the sheets. The gap between them, and
      // the blank paper at either end, used to swallow a tap that everywhere
      // else in the book puts the bars away. The background layer is that tap
      // owner, and the stub has no pages, so a tap on the viewer *is* a tap
      // between them.
      await pumpReader(
        tester,
        repository: FakeReaderRepository(),
        export: pdfExport(),
      );
      await tester.pumpAndSettle();

      bool barsHidden() => tester
          .widget<ExcludeSemantics>(
            find
                .ancestor(
                  of: find.byType(ReaderBottomChrome),
                  matching: find.byType(ExcludeSemantics),
                )
                .first,
          )
          .excluding;

      expect(barsHidden(), isFalse);

      await tester.tap(find.byKey(const Key('reader-background-tap')));
      await tester.pumpAndSettle();
      expect(barsHidden(), isTrue);

      await tester.tap(find.byKey(const Key('reader-background-tap')));
      await tester.pumpAndSettle();
      expect(barsHidden(), isFalse);
    },
  );

  testWidgets('keeps a way out when there is nothing behind the book', (
    tester,
  ) async {
    final repository = FakeReaderRepository()..gate = Completer<void>();

    await pumpReader(tester, repository: repository, export: pdfExport());
    await tester.pump();

    // While the book is still downloading…
    expect(find.byTooltip('Close'), findsOneWidget);

    repository.gate!.complete();
    await tester.pumpAndSettle();

    // …and once it is being read.
    expect(find.byTooltip('Close'), findsOneWidget);
  });

  testWidgets('keeps the bar to three actions and the rest in the menu', (
    tester,
  ) async {
    // The point of the overflow: a reading screen that spends a third of its
    // width on buttons is a screen about its buttons.
    await pumpReader(
      tester,
      repository: FakeReaderRepository(),
      export: pdfExport(),
    );
    await tester.pumpAndSettle();

    expect(find.byTooltip('Search this book'), findsOneWidget);
    expect(find.byTooltip('Mark up this book'), findsOneWidget);
    expect(find.byTooltip('More'), findsOneWidget);
    // Contents and Bookmark live in the bottom bar now, within reach of a
    // thumb; the top bar must not grow a second copy of either.
    for (final tooltip in const ['Contents', 'Bookmark', 'Saved places']) {
      expect(
        find.descendant(
          of: find.byType(ReaderAppBar),
          matching: find.byTooltip(tooltip),
        ),
        findsNothing,
        reason: '"$tooltip" belongs below, not in the top bar',
      );
    }
    expect(
      find.descendant(
        of: find.byType(ReaderBottomChrome),
        matching: find.byTooltip('Contents'),
      ),
      findsOneWidget,
    );

    await tester.tap(find.byTooltip('More'));
    await tester.pumpAndSettle();

    for (final label in const [
      'Contents',
      'Bookmark this page',
      'Saved places',
      'My markup',
      'Share my notes',
      'Appearance',
      'Full screen',
    ]) {
      expect(find.text(label), findsOneWidget, reason: 'missing "$label"');
    }
  });

  testWidgets('opens the tool tray and takes it away again', (tester) async {
    final repository = FakeReaderRepository()
      ..state = const ReaderState(revision: 1, lastPage: 3);

    await pumpReader(tester, repository: repository, export: pdfExport());
    await tester.pumpAndSettle();

    expect(find.byType(ReaderMarkupToolbar), findsNothing);

    await tester.tap(find.byTooltip('Mark up this book'));
    await tester.pumpAndSettle();

    expect(find.byType(ReaderMarkupToolbar), findsOneWidget);
    // Nothing is chosen yet, so selecting text still highlights.
    expect(
      find.text('Pick a tool, or select text to highlight it.'),
      findsOneWidget,
    );

    await tester.tap(find.text('Pen'));
    await tester.pumpAndSettle();
    expect(
      find.text('Draw with one finger. Two fingers still move the page.'),
      findsOneWidget,
    );

    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    expect(find.byType(ReaderMarkupToolbar), findsNothing);
  });

  testWidgets(
    'cover-skip chrome follows the open PDF, not a newly published map',
    (tester) async {
      // Stay on the old file, show the update banner, do not jump. Cover-skip
      // is stamped on the open file when it is downloaded, so a newly
      // published map cannot change the numbers on screen — version-2 footers
      // already skip the cover, and falling back to physical would label
      // sheet 2 "Page 2" while the footer still says "Page 1".
      final repository = FakeReaderRepository();
      final loader = ReaderDocumentLoader(
        repository: repository,
        projectId: 'project-1',
      );
      addTearDown(loader.dispose);

      Future<void> pump({
        required int offeredRevision,
        required String status,
      }) async {
        final export = pdfExport(revision: offeredRevision);
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              readerRepositoryProvider.overrideWithValue(repository),
              readerViewerBuilderProvider.overrideWithValue(stubViewer),
            ],
            child: MaterialApp(
              home: ReaderView(
                projectId: 'project-1',
                export: export,
                loader: loader,
                status: statusWith(export, status: status, hasCoverPage: true),
                onOpenPaywall: () {},
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
      }

      bool chromeSkipsCover() {
        return tester
                .widget<ReaderBottomChrome>(find.byType(ReaderBottomChrome))
                .hasCoverPage &&
            tester
                .widget<ReaderScrollHandle>(find.byType(ReaderScrollHandle))
                .hasCoverPage;
      }

      await pump(offeredRevision: 1, status: 'complete');
      expect(chromeSkipsCover(), isTrue);

      await pump(offeredRevision: 2, status: 'editing');
      expect(
        chromeSkipsCover(),
        isTrue,
        reason:
            'EDITING keeps the previous map, which still describes this file',
      );

      await pump(offeredRevision: 2, status: 'complete');
      expect(
        chromeSkipsCover(),
        isTrue,
        reason:
            'the open file already skips the cover; publish must not reset it',
      );
    },
  );

  testWidgets(
    'a still-open version-1 PDF keeps physical numbers after a version-2 publish',
    (tester) async {
      final repository = FakeReaderRepository();
      final loader = ReaderDocumentLoader(
        repository: repository,
        projectId: 'project-1',
      );
      addTearDown(loader.dispose);

      Future<void> pump({
        required int offeredRevision,
        required String status,
        required bool hasCoverPage,
      }) async {
        final export = pdfExport(revision: offeredRevision);
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              readerRepositoryProvider.overrideWithValue(repository),
              readerViewerBuilderProvider.overrideWithValue(stubViewer),
            ],
            child: MaterialApp(
              home: ReaderView(
                projectId: 'project-1',
                export: export,
                loader: loader,
                status: statusWith(
                  export,
                  status: status,
                  hasCoverPage: hasCoverPage,
                ),
                onOpenPaywall: () {},
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
      }

      await pump(offeredRevision: 1, status: 'complete', hasCoverPage: false);
      expect(
        tester
            .widget<ReaderBottomChrome>(find.byType(ReaderBottomChrome))
            .hasCoverPage,
        isFalse,
      );

      await pump(offeredRevision: 2, status: 'complete', hasCoverPage: true);
      expect(
        tester
            .widget<ReaderBottomChrome>(find.byType(ReaderBottomChrome))
            .hasCoverPage,
        isFalse,
        reason: 'version-1 footers still number the cover',
      );
    },
  );

  testWidgets('same-revision map digest cannot renumber different open bytes', (
    tester,
  ) async {
    final repository = FakeReaderRepository();
    final loader = ReaderDocumentLoader(
      repository: repository,
      projectId: 'project-1',
    );
    addTearDown(loader.dispose);
    final export = pdfExport(revision: 1);
    await loader.load(export);

    Future<void> pump(String mapDigest) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            readerRepositoryProvider.overrideWithValue(repository),
            readerViewerBuilderProvider.overrideWithValue(stubViewer),
          ],
          child: MaterialApp(
            home: ReaderView(
              projectId: 'project-1',
              export: export,
              loader: loader,
              status: statusWith(
                export,
                hasCoverPage: true,
                pageMapDigest: mapDigest,
              ),
              onOpenPaywall: () {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    await pump('same-revision-repair');
    expect(loader.document?.hasCoverPage, isNull);
    expect(
      tester
          .widget<ReaderBottomChrome>(find.byType(ReaderBottomChrome))
          .hasCoverPage,
      isFalse,
      reason: 'revision equality cannot stand in for byte identity',
    );

    await pump('pdf-digest-1');
    expect(loader.document?.hasCoverPage, isTrue);
  });

  testWidgets('an absent map flag stamps nothing, so a later one still lands', (
    tester,
  ) async {
    // Status carries no flag while no map describes the compile being offered.
    // That is not "the cover is numbered": a stamp can never be overwritten, so
    // writing false from an absent flag would hold physical numbers on the book
    // for as long as it stays open, however the map lands afterwards.
    final repository = FakeReaderRepository();
    final loader = ReaderDocumentLoader(
      repository: repository,
      projectId: 'project-1',
    );
    addTearDown(loader.dispose);

    Future<void> pump({bool? hasCoverPage}) async {
      final export = pdfExport(revision: 1);
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            readerRepositoryProvider.overrideWithValue(repository),
            readerViewerBuilderProvider.overrideWithValue(stubViewer),
          ],
          child: MaterialApp(
            home: ReaderView(
              projectId: 'project-1',
              export: export,
              loader: loader,
              status: statusWith(export, hasCoverPage: hasCoverPage),
              onOpenPaywall: () {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    await pump();
    expect(
      loader.document?.hasCoverPage,
      isNull,
      reason: 'nothing described this file yet',
    );
    expect(
      tester
          .widget<ReaderBottomChrome>(find.byType(ReaderBottomChrome))
          .hasCoverPage,
      isFalse,
      reason: 'unstamped shows physical numbers, matching chat not translating',
    );

    await pump(hasCoverPage: true);
    expect(
      tester
          .widget<ReaderBottomChrome>(find.byType(ReaderBottomChrome))
          .hasCoverPage,
      isTrue,
      reason: 'the map for this very compile arrived; the footer skips sheet 1',
    );
  });
}

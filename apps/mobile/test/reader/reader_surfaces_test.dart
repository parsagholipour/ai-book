import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pdfrx/pdfrx.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/reader/data/reader_repository.dart';
import 'package:tomeza/features/reader/domain/reader_models.dart';
import 'package:tomeza/features/reader/domain/reader_settings.dart';
import 'package:tomeza/features/reader/presentation/book_reader_screen.dart';
import 'package:tomeza/features/reader/presentation/reader_annotation_painter.dart';
import 'package:tomeza/features/reader/presentation/reader_annotation_controller.dart';
import 'package:tomeza/features/reader/presentation/reader_app_bar.dart';
import 'package:tomeza/features/reader/presentation/reader_appearance_sheet.dart';
import 'package:tomeza/features/reader/presentation/reader_bookmarks_sheet.dart';
import 'package:tomeza/features/reader/presentation/reader_coach.dart';
import 'package:tomeza/features/reader/presentation/reader_document_loader.dart';
import 'package:tomeza/features/reader/presentation/reader_markup_toolbar.dart';
import 'package:tomeza/features/reader/presentation/reader_opening_state.dart';
import 'package:tomeza/features/reader/presentation/reader_outline.dart';
import 'package:tomeza/features/reader/presentation/reader_page_badge.dart';
import 'package:tomeza/features/reader/presentation/reader_search_bar.dart';
import 'package:tomeza/features/reader/presentation/reader_view.dart';

import 'book_reader_test_support.dart';

/// The surfaces around the page: search, the page badge, the sheets, the tray,
/// the opening screen and the first-open hint. The page itself is stubbed, as
/// everywhere in this directory.

class _Range implements PdfPageTextRange {
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _Searcher implements PdfTextSearcher {
  _Searcher({
    this.count = 0,
    this.current,
    this.running,
  });

  int count;
  int? current;
  bool searching = false;

  /// What the searcher is actually running — null until its debounce ends.
  Pattern? running;
  final visited = <int>[];

  @override
  List<PdfPageTextRange> get matches => List.filled(count, _Range());
  @override
  int? get currentIndex => current;
  @override
  bool get isSearching => searching;
  @override
  Pattern? get pattern => running;
  @override
  double? get searchProgress => null;
  @override
  VoidCallback addListener(VoidCallback listener) => () {};
  @override
  void removeListener(VoidCallback listener) {}
  @override
  void resetTextSearch() {
    count = 0;
    running = null;
  }

  @override
  void startTextSearch(
    Pattern pattern, {
    bool caseInsensitive = true,
    bool goToFirstMatch = true,
    bool searchImmediately = false,
  }) {}
  @override
  Future<int> goToMatchOfIndex(int index) async {
    visited.add(index);
    current = index;
    return index;
  }

  @override
  Future<int> goToNextMatch() async => -1;
  @override
  Future<int> goToPrevMatch() async => -1;
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Future<void> _pumpSearch(WidgetTester tester, _Searcher searcher) {
  return tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: ReaderSearchBar(searcher: searcher, onClose: () {}),
      ),
    ),
  );
}

class _MemoryCoachStore implements ReaderCoachStore {
  _MemoryCoachStore({this.seen = false});

  bool seen;

  @override
  Future<bool> hasSeen(ReaderCoachTip tip) async => seen;

  @override
  Future<void> markSeen(ReaderCoachTip tip) async => seen = true;
}

Future<void> _pumpReader(
  WidgetTester tester, {
  required FakeReaderRepository repository,
  required ReaderDocumentLoader loader,
  required MobileExportAvailability export,
  ReaderCoachStore? coach,
}) {
  return tester.pumpWidget(
    ProviderScope(
      overrides: [
        readerRepositoryProvider.overrideWithValue(repository),
        readerViewerBuilderProvider.overrideWithValue(stubViewer),
        readerCoachStoreProvider.overrideWithValue(
          coach ?? _MemoryCoachStore(seen: true),
        ),
      ],
      child: MaterialApp(
        home: ReaderView(
          projectId: 'project-1',
          export: export,
          loader: loader,
          status: statusWith(export),
          onOpenPaywall: () {},
        ),
      ),
    ),
  );
}

void main() {
  group('search bar', () {
    testWidgets('says what search is before anything is typed', (tester) async {
      await _pumpSearch(tester, _Searcher());
      expect(
        find.text('Search runs on your phone, so it works offline.'),
        findsOneWidget,
      );
    });

    testWidgets('is not "No matches" while the searcher is still debouncing', (
      tester,
    ) async {
      // The searcher waits half a second after a keystroke before it starts,
      // and through it that looks exactly like a search that found nothing.
      final searcher = _Searcher(running: 'riv');
      await _pumpSearch(tester, searcher);

      await tester.enterText(find.byType(TextField), 'river');
      await tester.pump();

      expect(find.text('Searching…'), findsOneWidget);
      expect(find.textContaining('No matches'), findsNothing);
    });

    testWidgets('names what it looked for when there is nothing', (
      tester,
    ) async {
      final searcher = _Searcher(running: 'zebra');
      await _pumpSearch(tester, searcher);

      await tester.enterText(find.byType(TextField), 'zebra');
      await tester.pump();

      expect(find.textContaining('No matches for “zebra”'), findsOneWidget);
    });

    testWidgets('counts the hits and wraps past the last one', (tester) async {
      final searcher = _Searcher(count: 3, current: 2, running: 'river');
      await _pumpSearch(tester, searcher);
      await tester.enterText(find.byType(TextField), 'river');
      await tester.pump();

      expect(find.textContaining('3 of 3'), findsOneWidget);

      await tester.tap(find.byTooltip('Next match'));
      await tester.pump();
      expect(searcher.visited, [0], reason: 'past the last hit is the first');

      await tester.tap(find.byTooltip('Previous match'));
      await tester.pump();
      expect(searcher.visited, [0, 2], reason: 'before the first is the last');
    });

    testWidgets('clearing the field resets the search', (tester) async {
      final searcher = _Searcher(count: 2, current: 0, running: 'river');
      await _pumpSearch(tester, searcher);
      await tester.enterText(find.byType(TextField), 'river');
      await tester.pump();

      await tester.tap(find.byTooltip('Clear search'));
      await tester.pump();

      expect(searcher.count, 0);
      expect(find.byTooltip('Clear search'), findsNothing);
    });
  });

  group('page badge', () {
    Future<void> pumpBadge(
      WidgetTester tester, {
      required bool visible,
      int page = 12,
      int count = 48,
      bool cover = false,
      String? chapter,
      VoidCallback? onTap,
    }) {
      return tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: ReaderPageBadge(
                visible: visible,
                currentPage: page,
                pageCount: count,
                hasCoverPage: cover,
                chapterTitle: chapter,
                onTap: onTap ?? () {},
              ),
            ),
          ),
        ),
      );
    }

    testWidgets('gives the place and the chapter, and brings the bars back', (
      tester,
    ) async {
      var taps = 0;
      await pumpBadge(
        tester,
        visible: true,
        chapter: 'The Harbour',
        onTap: () => taps++,
      );
      await tester.pump(ReaderPageBadge.restAfter);

      expect(find.text('12 / 48'), findsOneWidget);
      expect(find.text('The Harbour'), findsOneWidget);

      await tester.tap(find.byTooltip('Show controls'));
      expect(taps, 1);
    });

    testWidgets('skips the cover in the numbers it prints', (tester) async {
      await pumpBadge(tester, visible: true, page: 1, cover: true);
      expect(find.text('Cover'), findsOneWidget);

      await pumpBadge(tester, visible: true, page: 2, cover: true);
      await tester.pump();
      expect(find.text('1 / 47'), findsOneWidget);
    });

    testWidgets('takes no taps and no semantics while the bars are up', (
      tester,
    ) async {
      await pumpBadge(tester, visible: false);
      final ignore = tester.widget<IgnorePointer>(
        find
            .descendant(
              of: find.byType(ReaderPageBadge),
              matching: find.byType(IgnorePointer),
            )
            .first,
      );
      expect(ignore.ignoring, isTrue);
    });
  });

  group('outline sheet', () {
    const entries = [
      ReaderOutlineEntry(title: 'Foreword', depth: 0, pageNumber: 2),
      ReaderOutlineEntry(title: 'The Harbour', depth: 0, pageNumber: 4),
      ReaderOutlineEntry(title: 'Lanterns', depth: 1, pageNumber: 7),
      ReaderOutlineEntry(title: 'Afterword', depth: 0, pageNumber: 19),
    ];

    test('the current entry is the last one at or before the page', () {
      expect(readerOutlineCurrentIndex(entries, 1), -1);
      expect(readerOutlineCurrentIndex(entries, 4), 1);
      expect(readerOutlineCurrentIndex(entries, 9), 2);
      expect(readerOutlineCurrentIndex(entries, 40), 3);
    });

    testWidgets('marks where the reader is and says how far is left', (
      tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ReaderOutlineSheet(
              entries: entries,
              currentPage: 9,
              pageCount: 20,
              onSelect: (_) {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Page 9 of 20 · 11 pages left'), findsOneWidget);
      final semantics = tester.getSemantics(find.text('Lanterns'));
      expect(semantics, isSemantics(isSelected: true));
    });

    testWidgets('goes to a page by the number the footer prints', (
      tester,
    ) async {
      final jumped = <int>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ReaderOutlineSheet(
              entries: const [],
              currentPage: 1,
              pageCount: 20,
              hasCoverPage: true,
              onSelect: jumped.add,
            ),
          ),
        ),
      );

      expect(find.text('No chapter list yet'), findsOneWidget);
      await tester.enterText(find.byType(TextField), '5');
      await tester.tap(find.text('Go'));
      await tester.pump();

      // Printed page 5 of a book whose sheet 1 is the cover is sheet 6.
      expect(jumped, [6]);

      await tester.enterText(find.byType(TextField), '400');
      await tester.tap(find.text('Go'));
      await tester.pump();
      expect(jumped.last, 20, reason: 'past the end lands on the last page');
    });
  });

  group('bookmarks sheet', () {
    testWidgets('removes in place, offers the way back, and can add', (
      tester,
    ) async {
      final removed = <int>[];
      final restored = <int>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ReaderBookmarksSheet(
              state: ReaderState(
                lastPage: 7,
                bookmarks: [
                  ReaderBookmark(
                    page: 3,
                    createdAt: DateTime.utc(2026),
                    revision: 1,
                  ),
                ],
              ),
              currentRevision: 1,
              chapterFor: (page) => page == 3 ? 'The Harbour' : null,
              onSelect: (_) {},
              onRemove: (bookmark) => removed.add(bookmark.page),
              onRestore: (bookmark) => restored.add(bookmark.page),
              onAddCurrent: () => ReaderBookmark(
                page: 7,
                createdAt: DateTime.utc(2026),
                revision: 1,
              ),
            ),
          ),
        ),
      );

      expect(find.text('The Harbour'), findsOneWidget);
      await tester.tap(find.text('Bookmark page 7'));
      await tester.pump();
      expect(find.text('Page 7'), findsOneWidget);
      expect(find.text('Bookmark page 7'), findsNothing);

      await tester.tap(find.byTooltip('Remove bookmark').first);
      await tester.pump();
      expect(removed, [3]);
      expect(find.text('Page 3'), findsNothing);
      expect(find.text('Bookmark removed'), findsOneWidget);

      await tester.tap(find.text('Undo'));
      await tester.pump();
      expect(restored, [3]);
      expect(find.text('Page 3'), findsOneWidget);
    });

    testWidgets('an empty list says what to do and offers to do it', (
      tester,
    ) async {
      var added = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ReaderBookmarksSheet(
              state: const ReaderState(),
              currentRevision: 1,
              onSelect: (_) {},
              onRemove: (_) {},
              onAddCurrent: () {
                added++;
                return ReaderBookmark(
                  page: 1,
                  createdAt: DateTime.utc(2026),
                  revision: 1,
                );
              },
            ),
          ),
        ),
      );

      expect(find.text('No bookmarks yet'), findsOneWidget);
      await tester.tap(find.text('Bookmark this page'));
      await tester.pump();
      expect(added, 1);
      expect(find.text('Page 1'), findsOneWidget);
    });
  });

  group('markup tray', () {
    testWidgets('shows all four tools at once, and names the colour', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(320, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final chosen = <ReaderTool>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            bottomNavigationBar: ReaderMarkupToolbar(
              tool: ReaderTool.pen,
              settings: const ReaderSettings(inkColorIndex: 4),
              palette: readerMarkupPalette(onDarkPage: false),
              canUndo: false,
              onToolChanged: chosen.add,
              onColorChanged: (_) {},
              onWidthChanged: (_) {},
              onUndo: () {},
              onDone: () {},
            ),
          ),
        ),
      );

      for (final label in const ['Pen', 'Eraser', 'Note', 'Text']) {
        final rect = tester.getRect(find.text(label));
        expect(
          rect.right,
          lessThanOrEqualTo(320),
          reason: '$label is on screen',
        );
      }
      expect(find.text('Ink'), findsOneWidget);
      expect(tester.takeException(), isNull);

      await tester.tap(find.text('Note'));
      await tester.tap(find.text('Pen'));
      expect(chosen, [ReaderTool.note, ReaderTool.none]);
    });
  });

  group('opening screen', () {
    testWidgets('says the step it is on and the numbers behind the bar', (
      tester,
    ) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: ReaderOpeningState(
              title: 'The Race',
              headline: 'Downloading your book',
              progress: 0.5,
              receivedBytes: 2 * 1024 * 1024,
              totalBytes: 4 * 1024 * 1024,
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 500));

      expect(find.text('The Race'), findsOneWidget);
      expect(find.text('Downloading your book'), findsOneWidget);
      expect(find.text('50%  ·  2.0 MB of 4.0 MB'), findsOneWidget);
    });
  });

  group('appearance sheet', () {
    testWidgets('previews the chosen paper and reports the choice', (
      tester,
    ) async {
      ReaderSettings? changed;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ReaderAppearanceSheet(
              settings: const ReaderSettings(),
              onChanged: (settings) => changed = settings,
            ),
          ),
        ),
      );

      for (final tint in ReaderPageTint.values) {
        expect(find.text(tint.label), findsOneWidget);
      }
      expect(find.text('Off'), findsOneWidget);
      await tester.tap(find.text('Night'));
      expect(changed?.tint, ReaderPageTint.night);
    });
  });

  group('reader', () {
    testWidgets('titles the book without the filename hyphens', (tester) async {
      expect(
        readerTitleFromFilename('The-Secret-Garden.pdf'),
        'The Secret Garden',
      );
      expect(readerTitleFromFilename('a_book.PDF'), 'a book');
      expect(readerTitleFromFilename(''), '');
    });

    testWidgets('the update notice stays up with the bars put away', (
      tester,
    ) async {
      final repository = FakeReaderRepository();
      final loader = ReaderDocumentLoader(
        repository: repository,
        projectId: 'project-1',
      );
      addTearDown(loader.dispose);
      await loader.load(pdfExport());

      await _pumpReader(
        tester,
        repository: repository,
        loader: loader,
        export: pdfExport(revision: 2),
      );
      await tester.pumpAndSettle();
      expect(
        find.text('Your edits are in. Reload to see them.'),
        findsOneWidget,
      );

      await tester.tap(find.byKey(const Key('reader-background-tap')));
      await tester.pumpAndSettle();

      expect(find.byType(ReaderAppBar), findsOneWidget);
      expect(
        find.text('Your edits are in. Reload to see them.'),
        findsOneWidget,
      );
      // Still something a finger can reach: it moved up into the space the bar
      // left rather than being hidden with it.
      final top = tester
          .getTopLeft(find.text('Your edits are in. Reload to see them.'))
          .dy;
      expect(top, lessThan(80));
      await tester.tap(find.text('Reload'));
      await tester.pumpAndSettle();
      expect(repository.downloadedRevisions, [1, 2]);
    });

    testWidgets('the chrome holds together at twice the text size', (
      tester,
    ) async {
      final repository = FakeReaderRepository();
      final loader = ReaderDocumentLoader(
        repository: repository,
        projectId: 'project-1',
      );
      addTearDown(loader.dispose);
      final export = pdfExport();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            readerRepositoryProvider.overrideWithValue(repository),
            readerViewerBuilderProvider.overrideWithValue(stubViewer),
            readerCoachStoreProvider.overrideWithValue(_MemoryCoachStore()),
          ],
          child: MaterialApp(
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(
                context,
              ).copyWith(textScaler: const TextScaler.linear(2)),
              child: child!,
            ),
            home: ReaderView(
              projectId: 'project-1',
              export: export,
              loader: loader,
              status: statusWith(export),
              onOpenPaywall: () {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // The hint, the bars and the update card all lay out without overflow.
      expect(find.text('Tap the page to hide the controls'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('the first-open hint shows once and is remembered', (
      tester,
    ) async {
      final store = _MemoryCoachStore();
      final repository = FakeReaderRepository();
      final loader = ReaderDocumentLoader(
        repository: repository,
        projectId: 'project-1',
      );
      addTearDown(loader.dispose);

      await _pumpReader(
        tester,
        repository: repository,
        loader: loader,
        export: pdfExport(),
        coach: store,
      );
      await tester.pumpAndSettle();

      expect(find.text('Tap the page to hide the controls'), findsOneWidget);

      await tester.tap(find.text('Got it'));
      await tester.pumpAndSettle();

      expect(find.text('Tap the page to hide the controls'), findsNothing);
      expect(store.seen, isTrue);
    });

    testWidgets('a reader who has seen the hint is not shown it again', (
      tester,
    ) async {
      final repository = FakeReaderRepository();
      final loader = ReaderDocumentLoader(
        repository: repository,
        projectId: 'project-1',
      );
      addTearDown(loader.dispose);

      await _pumpReader(
        tester,
        repository: repository,
        loader: loader,
        export: pdfExport(),
        coach: _MemoryCoachStore(seen: true),
      );
      await tester.pumpAndSettle();

      expect(find.text('Tap the page to hide the controls'), findsNothing);
    });

    testWidgets('putting the controls away is what the hint teaches', (
      tester,
    ) async {
      final store = _MemoryCoachStore();
      final repository = FakeReaderRepository();
      final loader = ReaderDocumentLoader(
        repository: repository,
        projectId: 'project-1',
      );
      addTearDown(loader.dispose);

      await _pumpReader(
        tester,
        repository: repository,
        loader: loader,
        export: pdfExport(),
        coach: store,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('reader-background-tap')));
      await tester.pumpAndSettle();

      expect(store.seen, isTrue);
      await tester.tap(find.byTooltip('Show controls'));
      await tester.pumpAndSettle();
      expect(find.text('Tap the page to hide the controls'), findsNothing);
    });
  });
}

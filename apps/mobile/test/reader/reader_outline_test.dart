import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/reader/domain/reader_models.dart';
import 'package:tomeza/features/reader/presentation/reader_bookmarks_sheet.dart';
import 'package:tomeza/features/reader/presentation/reader_outline.dart';

List<ReaderOutlineEntry> destinations(List<int> pages) => [
  for (final page in pages)
    ReaderOutlineEntry(title: 'Page $page', depth: 0, pageNumber: page),
];

void main() {
  group('namedReaderOutline', () {
    test('gives recovered destinations their chapter titles', () {
      final named = namedReaderOutline(destinations([3, 5, 6]), const [
        'First Steps into the Unknown',
        'The Roots and Branches',
        'The Spirits',
      ]);

      expect(named.map((entry) => entry.title), [
        'First Steps into the Unknown',
        'The Roots and Branches',
        'The Spirits',
      ]);
      expect(named.map((entry) => entry.pageNumber), [3, 5, 6]);
    });

    test('keeps the page numbers when the two lists disagree', () {
      // A mismatch means the links and the plan are not the same sequence, so
      // pairing them would attach the wrong title to a chapter.
      final named = namedReaderOutline(destinations([3, 5, 6]), const [
        'Only One Chapter',
      ]);

      expect(named.map((entry) => entry.title), ['Page 3', 'Page 5', 'Page 6']);
    });

    test('does nothing without chapter titles', () {
      expect(namedReaderOutline(destinations([3]), const []).single.title, 'Page 3');
      expect(namedReaderOutline(const [], const ['A']), isEmpty);
    });
  });

  group('outlineEntryForPage', () {
    const outline = [
      ReaderOutlineEntry(title: 'The Harbour', depth: 0, pageNumber: 4),
      ReaderOutlineEntry(title: 'A morning walk', depth: 1, pageNumber: 6),
      ReaderOutlineEntry(title: 'The Lighthouse', depth: 0, pageNumber: 11),
    ];

    test('names the chapter the reader is in', () {
      expect(outlineEntryForPage(outline, 4)?.title, 'The Harbour');
      expect(outlineEntryForPage(outline, 9)?.title, 'The Harbour');
      expect(outlineEntryForPage(outline, 11)?.title, 'The Lighthouse');
      expect(outlineEntryForPage(outline, 40)?.title, 'The Lighthouse');
    });

    test('ignores the page headings between chapters', () {
      // The compiler bookmarks chapter *and* page headings, so a flat scan
      // would report "A morning walk" as the chapter from page 6 on.
      expect(outlineEntryForPage(outline, 7)?.title, 'The Harbour');
    });

    test('says nothing before the first chapter or without an outline', () {
      // The cover and the contents page are in no chapter, and books compiled
      // before bookmarks were emitted have no outline at all.
      expect(outlineEntryForPage(outline, 2), isNull);
      expect(outlineEntryForPage(const [], 5), isNull);
      expect(
        outlineEntryForPage(const [
          ReaderOutlineEntry(title: 'Unplaceable', depth: 0),
        ], 5),
        isNull,
      );
    });
  });

  group('printed Contents labels', () {
    test('skip the cover on a recovered Page N title', () {
      // Recovery stores the physical title. Chrome can flip hasCoverPage after
      // the outline is built (post-publish fallback); both columns convert
      // from pageNumber, so they cannot disagree the way a baked printed
      // label would — "Page 2" with trailing 3.
      const entry = ReaderOutlineEntry(
        title: 'Page 3',
        depth: 0,
        pageNumber: 3,
      );
      expect(entry.displayedTitle(hasCoverPage: true), 'Page 2');
      expect(entry.displayedPageText(hasCoverPage: true), '2');
      expect(entry.displayedTitle(hasCoverPage: false), 'Page 3');
      expect(entry.displayedPageText(hasCoverPage: false), '3');
    });

    test('leave a chapter title alone and only convert the trailing number', () {
      const entry = ReaderOutlineEntry(
        title: 'Chapter One',
        depth: 0,
        pageNumber: 3,
      );
      expect(entry.displayedTitle(hasCoverPage: true), 'Chapter One');
      expect(entry.displayedPageText(hasCoverPage: true), '2');
    });

    test('names the cover instead of printing 1', () {
      const entry = ReaderOutlineEntry(
        title: 'Cover',
        depth: 0,
        pageNumber: 1,
      );
      expect(entry.displayedPageText(hasCoverPage: true), 'Cover');
    });
  });

  group('Contents sheet', () {
    testWidgets('trails printed numbers and still jumps to the physical sheet', (
      tester,
    ) async {
      final jumped = <int>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ReaderOutlineSheet(
              entries: const [
                ReaderOutlineEntry(
                  title: 'Chapter One',
                  depth: 0,
                  pageNumber: 3,
                ),
              ],
              currentPage: 3,
              hasCoverPage: true,
              onSelect: jumped.add,
            ),
          ),
        ),
      );

      expect(find.text('Chapter One'), findsOneWidget);
      expect(find.text('2'), findsOneWidget);
      expect(find.text('3'), findsNothing);

      await tester.tap(find.text('Chapter One'));
      expect(jumped, [3]);
    });

    testWidgets(
      'converts a recovered physical title with the trailing number',
      (tester) async {
        Future<void> pump({required bool hasCoverPage}) {
          return tester.pumpWidget(
            MaterialApp(
              home: Scaffold(
                body: ReaderOutlineSheet(
                  entries: const [
                    ReaderOutlineEntry(
                      title: 'Page 3',
                      depth: 0,
                      pageNumber: 3,
                    ),
                  ],
                  currentPage: 3,
                  hasCoverPage: hasCoverPage,
                  onSelect: (_) {},
                ),
              ),
            ),
          );
        }

        await pump(hasCoverPage: true);
        expect(find.text('Page 2'), findsOneWidget);
        expect(find.text('2'), findsOneWidget);
        expect(find.text('Page 3'), findsNothing);

        await pump(hasCoverPage: false);
        expect(find.text('Page 3'), findsOneWidget);
        expect(find.text('3'), findsOneWidget);
        expect(find.text('Page 2'), findsNothing);
      },
    );
  });

  group('Bookmarks sheet', () {
    testWidgets('labels a saved place with the printed number', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ReaderBookmarksSheet(
              state: ReaderState(
                bookmarks: [
                  ReaderBookmark(
                    page: 3,
                    createdAt: DateTime.utc(2026),
                    revision: 1,
                  ),
                ],
              ),
              currentRevision: 1,
              hasCoverPage: true,
              onSelect: (_) {},
              onRemove: (_) {},
            ),
          ),
        ),
      );

      expect(find.text('Page 2'), findsOneWidget);
      expect(find.text('Page 3'), findsNothing);
    });
  });
}

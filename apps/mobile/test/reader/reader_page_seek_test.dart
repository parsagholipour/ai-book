import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/reader/domain/reader_page_locator.dart';
import 'package:tomeza/features/reader/domain/reader_page_seek.dart';

import 'reader_page_locator_test.dart' show bookWith, harbourPages;

/// A rendered book: front matter with nothing to match, then two book pages per
/// physical page, which is roughly how a compiled book paginates.
class _RenderedBook {
  _RenderedBook({required this.frontMatter, required this.perPage});

  final List<String> frontMatter;
  final int perPage;
  final loaded = <int>[];

  int get pageCount =>
      frontMatter.length + (harbourPages.length / perPage).ceil();

  Future<String?> loadText(int pdfPageNumber) async {
    loaded.add(pdfPageNumber);
    if (pdfPageNumber <= frontMatter.length) {
      return frontMatter[pdfPageNumber - 1];
    }
    final start = (pdfPageNumber - frontMatter.length - 1) * perPage;
    return harbourPages.skip(start).take(perPage).join('\n\n');
  }
}

void main() {
  group('findPdfPageForBookPage', () {
    late ReaderPageLocator locator;

    setUp(() => locator = ReaderPageLocator(bookWith(harbourPages)));

    test('finds the rendered page a book page was printed on', () async {
      final rendered = _RenderedBook(
        frontMatter: const ['Cover', 'Contents'],
        perPage: 2,
      );

      // Book pages 5 and 6 are printed together on the third body page.
      expect(
        await findPdfPageForBookPage(
          bookPageIndex: 5,
          pdfPageCount: rendered.pageCount,
          locator: locator,
          loadPageText: rendered.loadText,
        ),
        5,
      );
      expect(
        await findPdfPageForBookPage(
          bookPageIndex: 10,
          pdfPageCount: rendered.pageCount,
          locator: locator,
          loadPageText: rendered.loadText,
        ),
        7,
      );
    });

    test('bisects instead of reading the whole book', () async {
      // Extraction is the expensive part, and a reader waiting to be taken to a
      // page should not pay for every page before it.
      final rendered = _RenderedBook(frontMatter: const [], perPage: 1);

      await findPdfPageForBookPage(
        bookPageIndex: 9,
        pdfPageCount: rendered.pageCount,
        locator: locator,
        loadPageText: rendered.loadText,
      );

      expect(rendered.loaded.length, lessThan(rendered.pageCount));
    });

    test('walks past front matter that cannot be placed', () async {
      // The cover and contents have no prose to match, so a bisection landing
      // on them learns nothing. It has to keep looking rather than give up.
      final rendered = _RenderedBook(
        frontMatter: const ['Cover', 'Contents', '', 'Dedication'],
        perPage: 1,
      );

      expect(
        await findPdfPageForBookPage(
          bookPageIndex: 1,
          pdfPageCount: rendered.pageCount,
          locator: locator,
          loadPageText: rendered.loadText,
        ),
        5,
      );
    });

    test('returns null when no page can be placed at all', () async {
      expect(
        await findPdfPageForBookPage(
          bookPageIndex: 3,
          pdfPageCount: 4,
          locator: locator,
          loadPageText: (_) async => 'Cover',
        ),
        isNull,
      );
    });

    test('returns null for an empty document rather than page zero', () async {
      expect(
        await findPdfPageForBookPage(
          bookPageIndex: 1,
          pdfPageCount: 0,
          locator: locator,
          loadPageText: (_) async => null,
        ),
        isNull,
      );
    });

    test('lands on the nearest placeable page for an unprinted index', () async {
      // A page whose text never made it into the PDF still has to leave the
      // reader somewhere sensible instead of at the front of the book.
      final rendered = _RenderedBook(frontMatter: const [], perPage: 1);

      final page = await findPdfPageForBookPage(
        bookPageIndex: 99,
        pdfPageCount: rendered.pageCount,
        locator: locator,
        loadPageText: rendered.loadText,
      );

      expect(page, rendered.pageCount);
    });
  });
}

import 'reader_page_locator.dart';

/// Extracted text for a rendered PDF page, or null when it cannot be read.
typedef ReaderPageTextLoader = Future<String?> Function(int pdfPageNumber);

/// Finds the rendered page that shows a given book page.
///
/// This is [ReaderPageLocator] run backwards. The forward direction answers
/// "which book page is this passage from"; opening the book at page 7 needs the
/// opposite, and the PDF holds no such index — `generateBookPdf` renders the
/// whole book as one flow and lets Chrome paginate it.
///
/// Book pages appear in order, so the rendered pages are searched by bisection
/// against [ReaderPageLocator.spanForPageText]. Only about log2(n) pages have
/// their text extracted, which matters because extraction is the expensive part.
///
/// Pages that cannot be placed — the cover, the contents, a full-page
/// illustration — return a null span. Rather than give up, the probe walks
/// outward from the midpoint to the nearest page that can be placed, because
/// unplaceable pages cluster at the front of a book and a bisection that treated
/// them as failures would never get past them.
///
/// Null means "could not be found", and the caller should leave the reader where
/// it was rather than guess.
Future<int?> findPdfPageForBookPage({
  required int bookPageIndex,
  required int pdfPageCount,
  required ReaderPageLocator locator,
  required ReaderPageTextLoader loadPageText,
}) async {
  if (pdfPageCount < 1) {
    return null;
  }

  var low = 1;
  var high = pdfPageCount;
  // The best page seen so far: the one whose span sits closest to the target
  // without containing it. A book page that fell entirely inside a rendered
  // page's unmatched region still lands the reader on the right spread.
  int? nearest;
  var nearestDistance = 1 << 30;

  while (low <= high) {
    final probe = await _placeableNear(
      middle: low + ((high - low) ~/ 2),
      low: low,
      high: high,
      locator: locator,
      loadPageText: loadPageText,
    );
    if (probe == null) {
      return nearest;
    }

    final span = probe.span;
    if (span.contains(bookPageIndex)) {
      return probe.pdfPageNumber;
    }

    final distance = bookPageIndex < span.first
        ? span.first - bookPageIndex
        : bookPageIndex - span.last;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = probe.pdfPageNumber;
    }

    if (span.last < bookPageIndex) {
      low = probe.pdfPageNumber + 1;
    } else {
      high = probe.pdfPageNumber - 1;
    }
  }
  return nearest;
}

class _PlacedPage {
  const _PlacedPage({required this.pdfPageNumber, required this.span});

  final int pdfPageNumber;
  final ReaderPageSpan span;
}

/// The page nearest [middle], within [low]..[high], whose text places it.
Future<_PlacedPage?> _placeableNear({
  required int middle,
  required int low,
  required int high,
  required ReaderPageLocator locator,
  required ReaderPageTextLoader loadPageText,
}) async {
  for (var offset = 0; offset <= high - low; offset += 1) {
    for (final candidate in {middle + offset, middle - offset}) {
      if (candidate < low || candidate > high) {
        continue;
      }
      final text = await loadPageText(candidate);
      if (text == null) {
        continue;
      }
      // The anchors, not the widened span: overlapping spans would make several
      // rendered pages claim the target and the first one found would win.
      final span = locator.anchorSpanForPage(
        pdfPageNumber: candidate,
        pageText: text,
      );
      if (span != null) {
        return _PlacedPage(pdfPageNumber: candidate, span: span);
      }
    }
  }
  return null;
}

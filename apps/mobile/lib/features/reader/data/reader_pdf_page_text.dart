import 'package:pdfrx/pdfrx.dart';

import '../domain/reader_annotation_geometry.dart';
import '../domain/reader_reanchor.dart';

/// Adapts a rendered PDF page to the text-and-rectangles view re-anchoring
/// works against.
///
/// This is the only place that knows the two coordinate systems differ. PDF
/// rectangles have their origin at the bottom-left of the page and are measured
/// in points; `toRect` flips and scales them, and dividing through by the page
/// size leaves the fractions the reader stores.
class PdfReanchorPage implements ReanchorPage {
  PdfReanchorPage({required this.page, required this.text});

  final PdfPage page;
  final PdfPageText text;

  @override
  String get fullText => text.fullText;

  @override
  List<NormRect> rectsForRange(int start, int end) {
    final clampedStart = start.clamp(0, text.fullText.length);
    final clampedEnd = end.clamp(clampedStart, text.fullText.length);
    if (clampedEnd <= clampedStart) {
      return const [];
    }
    final range = PdfPageTextRange(
      pageText: text,
      start: clampedStart,
      end: clampedEnd,
    );
    return [
      // One rectangle per fragment, which is how a run wrapped over several
      // lines ends up highlighted line by line rather than as one block
      // swallowing the margins between them.
      for (final fragment in range.enumerateFragmentBoundingRects())
        normRectFromPdfRect(fragment.bounds, page),
    ];
  }
}

/// A [ReanchorPageLoader] backed by a live document.
ReanchorPageLoader pdfReanchorLoader(PdfDocument document) {
  return (pageNumber) async {
    if (pageNumber < 1 || pageNumber > document.pages.length) {
      return null;
    }
    final page = document.pages[pageNumber - 1];
    try {
      // The structured form, not the raw text: only fragments carry the
      // per-line bounding boxes a highlight needs.
      return PdfReanchorPage(page: page, text: await page.loadStructuredText());
    } catch (_) {
      // A page whose text cannot be extracted is skipped rather than failing
      // the whole pass — the rest of the book's markup still moves.
      return null;
    }
  };
}

/// The part of a selection that falls on one page.
class ReaderSelectionSpan {
  const ReaderSelectionSpan({
    required this.page,
    required this.rects,
    required this.text,
  });

  /// The PDF page number.
  final int page;

  /// One rectangle per line the selection covers on that page.
  final List<NormRect> rects;

  /// The selected text on that page, collapsed to single spaces.
  final String text;
}

/// Splits a selection into the pages it covers.
///
/// A passage dragged over a page break is one selection but has to become one
/// piece of markup per page: the rectangles are measured against a page, and a
/// highlight spanning a break has to keep both halves when the book is
/// recompiled and they end up further apart.
List<ReaderSelectionSpan> readerSelectionSpans(
  List<PdfPageTextRange> ranges,
  PdfDocument document,
) {
  final rectsByPage = <int, List<NormRect>>{};
  final textByPage = <int, StringBuffer>{};

  for (final range in ranges) {
    final pageNumber = range.pageNumber;
    if (pageNumber < 1 || pageNumber > document.pages.length) {
      continue;
    }
    final page = document.pages[pageNumber - 1];
    for (final fragment in range.enumerateFragmentBoundingRects()) {
      (rectsByPage[pageNumber] ??= []).add(
        normRectFromPdfRect(fragment.bounds, page),
      );
    }
    final buffer = textByPage[pageNumber] ??= StringBuffer();
    if (buffer.isNotEmpty) buffer.write(' ');
    buffer.write(range.text);
  }

  final pages = rectsByPage.keys.toList()..sort();
  return [
    for (final page in pages)
      ReaderSelectionSpan(
        page: page,
        rects: rectsByPage[page] ?? const [],
        text: (textByPage[page]?.toString() ?? '')
            .replaceAll(RegExp(r'\s+'), ' ')
            .trim(),
      ),
  ];
}

/// Converts a rectangle in PDF page coordinates into page fractions.
NormRect normRectFromPdfRect(PdfRect rect, PdfPage page) {
  if (page.width <= 0 || page.height <= 0) {
    return const NormRect(0, 0, 0, 0);
  }
  // A null `scaledPageSize` leaves the values in page points, with the vertical
  // flip already applied.
  final flipped = rect.toRect(page: page);
  return NormRect(
    flipped.left / page.width,
    flipped.top / page.height,
    flipped.width / page.width,
    flipped.height / page.height,
  );
}

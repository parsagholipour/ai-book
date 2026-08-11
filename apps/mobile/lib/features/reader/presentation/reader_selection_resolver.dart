import 'package:pdfrx/pdfrx.dart';

import '../data/reader_pdf_page_text.dart';
import '../data/reader_repository.dart';
import '../domain/reader_models.dart';
import '../domain/reader_page_locator.dart';

/// A selection, and everything worked out about it so far.
class ReaderResolvedSelection {
  const ReaderResolvedSelection({required this.selection, required this.spans});

  final ReaderSelection selection;

  /// One entry per PDF page the selection covers, with the rectangles markup
  /// would be drawn from.
  final List<ReaderSelectionSpan> spans;
}

/// The selection as it can be known without touching the book — instantly.
///
/// The bar has to open the moment text is selected; placing the passage needs
/// the book's Markdown and takes a beat. So this comes first and
/// [placeReaderSelection] follows, and `placed` is what tells the two apart:
/// until it is set, a null page means "still looking" rather than "could not
/// be found".
ReaderResolvedSelection? previewReaderSelection(
  List<PdfPageTextRange> ranges,
  PdfDocument? document,
) {
  if (ranges.isEmpty) {
    return null;
  }
  final collapsed = ranges
      .map((range) => range.text)
      .join(' ')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  if (collapsed.isEmpty) {
    return null;
  }
  return ReaderResolvedSelection(
    selection: ReaderSelection(
      text: collapsed,
      pdfPageNumber: ranges.first.pageNumber,
    ),
    // The rectangles are captured now, while the selection exists, so tapping
    // a colour is a paint and not another round trip into the PDF.
    spans: document == null ? const [] : readerSelectionSpans(ranges, document),
  );
}

/// Resolves a passage to the book page an edit should name.
///
/// The rendered page is placed first, from text the reader never touched, so a
/// passage that recurs elsewhere in the book resolves to the copy on screen
/// rather than the earliest one. Only then is the passage itself looked for,
/// and only inside that window.
///
/// Failure is never fatal: without the book's text the passage simply carries
/// no page, every action still works, and the ones that name a page fall back
/// to letting the server find the quote.
Future<ReaderResolvedSelection> placeReaderSelection({
  required ReaderResolvedSelection preview,
  required List<PdfPageTextRange> ranges,
  required ReaderRepository repository,
  required String projectId,
  required int? revision,
}) async {
  final selection = preview.selection;
  ReaderResolvedSelection settled({int? bookPageIndex}) {
    return ReaderResolvedSelection(
      selection: ReaderSelection(
        text: selection.text,
        pdfPageNumber: selection.pdfPageNumber,
        bookPageIndex: bookPageIndex,
        placed: true,
      ),
      spans: preview.spans,
    );
  }

  // Without the exact current compile there is no honest book to load a
  // locator from. The selection still supports local copy/share, but it must
  // not be placed against whichever manuscript happens to be current.
  if (revision == null) {
    return settled();
  }

  try {
    final locator = await repository.pageLocator(
      projectId: projectId,
      revision: revision,
    );
    final first = ranges.first;
    final span = locator.spanForPage(
      pdfPageNumber: first.pageNumber,
      pageText: first.pageText.fullText,
    );
    // `contextWindow` reads offsets into `first`'s page text, so the end has to
    // come from the last range still on that page — a selection dragged over a
    // page break ends in a different page's coordinates.
    final lastOnFirstPage = ranges.lastWhere(
      (range) => range.pageNumber == first.pageNumber,
      orElse: () => first,
    );
    final context = ReaderPageLocator.contextWindow(
      first.pageText.fullText,
      first.start,
      lastOnFirstPage.end,
    );
    final bookPage =
        locator.locate(selection.text, within: span) ??
        locator.locate(context, within: span) ??
        // The window did not hold the answer, so it was the wrong window.
        // Searching the whole book is what this did before spans existed and is
        // still better than naming no page at all.
        locator.locate(selection.text) ??
        locator.locate(context);
    return settled(bookPageIndex: bookPage);
  } catch (_) {
    return settled();
  }
}

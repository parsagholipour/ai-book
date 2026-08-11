import 'package:pdfrx/pdfrx.dart';

import '../data/reader_repository.dart';
import '../domain/reader_page_seek.dart';

/// Moving between the two numbering schemes a reader is looking at.
///
/// `generateBookPdf` renders the whole book as one HTML flow and lets Chrome
/// paginate it, so nothing in the file separates one `Page` from the next: a
/// rendered page number is not a `Page.index`, in either direction. Both
/// crossings go through the locator, which probes the rendered text against the
/// book's own — and both are best-effort. A page that cannot be placed answers
/// null rather than throwing, because every caller here is doing something the
/// reader can still manage without: opening at a remembered page, or telling a
/// character how far the reader has got.

/// The rendered page holding [bookPageIndex], or null when it cannot be placed.
Future<int?> readerPdfPageForBookPage({
  required PdfDocument document,
  required ReaderRepository repository,
  required String projectId,
  required int? revision,
  required int bookPageIndex,
}) async {
  if (revision == null) return null;
  try {
    final locator = await repository.pageLocator(
      projectId: projectId,
      revision: revision,
    );
    return await findPdfPageForBookPage(
      bookPageIndex: bookPageIndex,
      pdfPageCount: document.pages.length,
      locator: locator,
      loadPageText: (pageNumber) => _pageText(document, pageNumber),
    );
  } catch (_) {
    // The book's text could not be loaded or matched.
    return null;
  }
}

/// The `Page.index` the rendered page [pdfPageNumber] belongs to, or null when
/// it belongs to none — the cover and the contents page have no book page.
Future<int?> readerBookPageForPdfPage({
  required PdfDocument document,
  required ReaderRepository repository,
  required String projectId,
  required int? revision,
  required int pdfPageNumber,
}) async {
  if (revision == null) return null;
  try {
    final locator = await repository.pageLocator(
      projectId: projectId,
      revision: revision,
    );
    final text = await _pageText(document, pdfPageNumber);
    if (text == null) {
      return null;
    }
    // The unwidened span: the ±1 margin that keeps a *selection* inside a page
    // range would here name a page the reader has not reached.
    return locator
        .anchorSpanForPage(pdfPageNumber: pdfPageNumber, pageText: text)
        ?.first;
  } catch (_) {
    return null;
  }
}

Future<String?> _pageText(PdfDocument document, int pageNumber) async {
  if (pageNumber < 1 || pageNumber > document.pages.length) {
    return null;
  }
  try {
    return (await document.pages[pageNumber - 1].loadStructuredText()).fullText;
  } catch (_) {
    return null;
  }
}

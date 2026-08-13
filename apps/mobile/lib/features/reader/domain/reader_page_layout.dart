import 'dart:ui';

/// Where the pages of a book sit in the scroll, and the blank space that
/// brackets them.
///
/// Kept as plain geometry so it can be exercised without PDFium; the viewer's
/// adapter is a two-line wrapper in `reader_view.dart`.
class ReaderPageGeometry {
  const ReaderPageGeometry({required this.rects, required this.documentSize});

  /// One rectangle per page, in document coordinates.
  final List<Rect> rects;

  final Size documentSize;
}

/// The gap between one sheet of paper and the next, in screen pixels.
///
/// Vertical only: the page still fills the width, so this is the one place the
/// book is allowed to stop short of the screen. Without it a long book reads as
/// a single unbroken column and there is no telling where a page ends — which
/// matters here, because the reader's own page number is counting them.
const readerPageGapPixels = 14.0;

/// Lays the book out as one column, each page the full width of the scroll,
/// with just enough blank space at each end to clear the bars lying over it.
///
/// pdfrx's own layout adds `params.margin` around and between the pages; this
/// one deliberately adds neither. The page is the whole width of the viewer at
/// the scale it opens at, which is also as far out as it can be zoomed, and a
/// gutter would mean the book never quite fills the screen.
///
/// The bars lie *over* the page, so without the end space the first line of the
/// book and the last line of it can never be seen while they are showing: the
/// scroll stops exactly where the page does, with the bar still on top of it.
///
/// [topBar] and [bottomBar] are those bars' heights in **screen pixels**, and
/// [viewportWidth] is what converts them: the page fills the width, so the
/// scale the book is read at is `viewportWidth / pageWidth`, and dividing
/// through by it turns a bar into the document-space gap that exactly covers
/// it. That equality holds at the reading scale, which is also the minimum
/// zoom — so the space is never less than the bar it has to clear, and grows
/// with the page when the reader zooms in.
ReaderPageGeometry readerPageGeometry(
  List<Size> pageSizes, {
  required double viewportWidth,
  required double topBar,
  required double bottomBar,
}) {
  if (pageSizes.isEmpty) {
    return const ReaderPageGeometry(rects: [], documentSize: Size.zero);
  }
  var width = 0.0;
  for (final size in pageSizes) {
    if (size.width > width) width = size.width;
  }
  // One document unit is this many screen pixels short of one, at the scale the
  // book is read at. A viewport that has not been measured yet would divide by
  // zero; it is laid out again the moment it has.
  final perPixel = viewportWidth > 0 ? width / viewportWidth : 0.0;

  final gap = readerPageGapPixels * perPixel;

  final rects = <Rect>[];
  var y = topBar * perPixel;
  for (final size in pageSizes) {
    // Centred, which only matters for a book whose pages are not all one size.
    rects.add(
      Rect.fromLTWH((width - size.width) / 2, y, size.width, size.height),
    );
    y += size.height + gap;
  }
  return ReaderPageGeometry(
    rects: rects,
    // The gap after the last page is not one — that end belongs to the bar.
    documentSize: Size(width, y - gap + bottomBar * perPixel),
  );
}

/// Whether [point] in document space sits on a sheet of paper.
///
/// False is the gap between two pages, the blank paper that clears the bars at
/// either end, or the side gutter of a mixed-size book. Those have no page
/// overlay, so a tap there has to be owned by the viewer rather than by a page.
bool readerDocumentPointIsOnPage(Offset point, List<Rect> pageRects) {
  for (final rect in pageRects) {
    if (rect.contains(point)) return true;
  }
  return false;
}

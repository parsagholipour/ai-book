import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/reader/domain/reader_page_layout.dart';

/// A4 at 72dpi, which is what the compiler renders.
const _a4 = Size(595, 842);

/// A phone-shaped viewport, and bars the size the reader's really are.
const _viewportWidth = 400.0;
const _topBar = 56.0;
const _bottomBar = 88.0;

ReaderPageGeometry layout(
  List<Size> pages, {
  double viewportWidth = _viewportWidth,
}) {
  return readerPageGeometry(
    pages,
    viewportWidth: viewportWidth,
    topBar: _topBar,
    bottomBar: _bottomBar,
  );
}

/// What one document unit is worth on screen at the scale the book is read at.
double zoomFor(ReaderPageGeometry geometry, [double width = _viewportWidth]) {
  return width / geometry.documentSize.width;
}

void main() {
  test('a page is the whole width of the scroll', () async {
    final geometry = layout(const [_a4, _a4, _a4]);

    expect(geometry.documentSize.width, _a4.width);
    for (final rect in geometry.rects) {
      expect(rect.left, 0, reason: 'no gutter down the sides');
      expect(rect.width, _a4.width);
    }
  });

  test('the space before the book is exactly the top bar', () {
    final geometry = layout(const [_a4, _a4]);

    expect(geometry.rects.first.top * zoomFor(geometry), closeTo(_topBar, 1e-9));
  });

  test('the space after it is exactly the bottom bar', () {
    final geometry = layout(const [_a4, _a4]);
    final trailing = geometry.documentSize.height - geometry.rects.last.bottom;

    expect(trailing * zoomFor(geometry), closeTo(_bottomBar, 1e-9));
  });

  test('it stays exact on a viewport of any width', () {
    // The conversion is the zoom, and the zoom is the viewport over the page.
    for (final width in const [320.0, 400.0, 768.0, 1024.0]) {
      final geometry = layout(const [_a4], viewportWidth: width);
      final zoom = zoomFor(geometry, width);

      expect(
        geometry.rects.first.top * zoom,
        closeTo(_topBar, 1e-9),
        reason: 'top bar on a $width-wide viewport',
      );
      expect(
        (geometry.documentSize.height - geometry.rects.last.bottom) * zoom,
        closeTo(_bottomBar, 1e-9),
        reason: 'bottom bar on a $width-wide viewport',
      );
    }
  });

  test('one sheet of paper is clearly separated from the next', () {
    final geometry = layout(const [_a4, _a4, _a4]);
    final zoom = zoomFor(geometry);

    for (var i = 1; i < geometry.rects.length; i++) {
      final gap = geometry.rects[i].top - geometry.rects[i - 1].bottom;
      expect(
        gap * zoom,
        closeTo(readerPageGapPixels, 1e-9),
        reason: 'the gap above page ${i + 1}, in screen pixels',
      );
    }
  });

  test('the gap after the last page is the bar, not a gap and a bar', () {
    final one = layout(const [_a4]);
    final two = layout(const [_a4, _a4]);

    // Two pages are exactly one page, one gap and one page taller.
    final gap = readerPageGapPixels * (_a4.width / _viewportWidth);
    expect(
      two.documentSize.height,
      closeTo(one.documentSize.height + _a4.height + gap, 1e-9),
    );
  });

  test('a book of mixed page sizes is centred on the widest', () {
    const wide = Size(800, 600);
    final geometry = layout(const [wide, _a4]);

    expect(geometry.documentSize.width, 800);
    expect(geometry.rects.first.left, 0);
    expect(geometry.rects.last.left, (800 - 595) / 2);
  });

  test('a document with no pages lays out as nothing', () {
    final geometry = layout(const []);

    expect(geometry.rects, isEmpty);
    expect(geometry.documentSize, Size.zero);
  });

  test('a viewport that has not been measured yet does not divide by zero', () {
    final geometry = layout(const [_a4], viewportWidth: 0);

    expect(geometry.rects.single.top, 0);
    expect(geometry.documentSize.height, _a4.height);
  });
}

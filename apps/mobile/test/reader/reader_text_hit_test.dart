import 'package:flutter_test/flutter_test.dart';
import 'package:pdfrx/pdfrx.dart';
import 'package:tomeza/features/reader/domain/reader_text_hit.dart';

/// A page of type, laid out the way pdfrx's own formatter lays one out: one
/// fragment per word, one more for each run of spaces between them, and one
/// character box per character.
///
/// Coordinates are PDF page coordinates, so the origin is bottom-left and `top`
/// is the larger number. Every glyph is [_charWidth] wide and [_lineHeight]
/// tall, which is enough for the only thing these tests ask: which character a
/// point lands on.
PdfPageText _pageOfLines(List<String> lines, {int pageNumber = 1}) {
  final buffer = StringBuffer();
  final charRects = <PdfRect>[];
  final fragments = <PdfPageTextFragment>[];
  final text = PdfPageText(
    pageNumber: pageNumber,
    // Built first because the field is final; the two lists below are filled
    // afterwards through the references handed over here, exactly as the
    // formatter does it.
    fullText: lines.join(),
    charRects: charRects,
    fragments: fragments,
  );

  var top = _firstLineTop;
  for (final line in lines) {
    var left = 0.0;
    var runStart = buffer.length;
    var runIsSpace = line.isNotEmpty && line[0] == ' ';

    void closeRun() {
      final length = buffer.length - runStart;
      if (length == 0) return;
      final rects = charRects.sublist(runStart, runStart + length);
      fragments.add(
        PdfPageTextFragment(
          pageText: text,
          index: runStart,
          length: length,
          charRects: rects,
          bounds: rects.reduce((a, b) => a.merge(b)),
          direction: PdfTextDirection.ltr,
        ),
      );
    }

    for (final char in line.split('')) {
      final isSpace = char == ' ';
      if (isSpace != runIsSpace) {
        closeRun();
        runStart = buffer.length;
        runIsSpace = isSpace;
      }
      buffer.write(char);
      charRects.add(
        PdfRect(left, top, left + _charWidth, top - _lineHeight),
      );
      left += _charWidth;
    }
    closeRun();
    top -= _lineHeight + _lineGap;
  }
  return text;
}

const _charWidth = 10.0;
const _lineHeight = 12.0;
const _lineGap = 6.0;
const _firstLineTop = 200.0;

/// A page whose lines are placed by hand, for the geometry `_pageOfLines`
/// cannot express: bands that overlap one another, and lines that do not
/// arrive top to bottom.
///
/// Each entry is one pdfrx line — one fragment, one band — and every character
/// on it takes the line's own top and bottom, which is what the formatter does
/// (`PdfRect(r.left, bounds.top, r.right, bounds.bottom)` in
/// `PdfTextFormatter.addWord`).
PdfPageText _pageOfBands(
  List<({String text, double left, double top, double bottom})> lines, {
  int pageNumber = 1,
}) {
  final charRects = <PdfRect>[];
  final fragments = <PdfPageTextFragment>[];
  final text = PdfPageText(
    pageNumber: pageNumber,
    fullText: lines.map((line) => line.text).join(),
    charRects: charRects,
    fragments: fragments,
  );
  for (final line in lines) {
    final start = charRects.length;
    var left = line.left;
    for (var i = 0; i < line.text.length; i++) {
      charRects.add(PdfRect(left, line.top, left + _charWidth, line.bottom));
      left += _charWidth;
    }
    final rects = charRects.sublist(start, charRects.length);
    fragments.add(
      PdfPageTextFragment(
        pageText: text,
        index: start,
        length: line.text.length,
        charRects: rects,
        bounds: rects.reduce((a, b) => a.merge(b)),
        direction: PdfTextDirection.ltr,
      ),
    );
  }
  return text;
}

/// The middle of the character at [index] on the page.
PdfPoint _centreOf(PdfPageText text, int index) => text.charRects[index].center;

void main() {
  group('readerCharIndexAt', () {
    final page = _pageOfLines(['one two', 'three']);

    test('picks the character the point is inside', () {
      // 'w' of "two" is index 5.
      expect(readerCharIndexAt(page, _centreOf(page, 5)), 5);
    });

    test('picks the space between two words', () {
      expect(readerCharIndexAt(page, _centreOf(page, 3)), 3);
    });

    test('picks the nearest character just off the end of a line', () {
      // Past the last glyph of "one two" but within the margin: the finger is
      // in the right-hand margin, which is where a reader drags to take a whole
      // line.
      final last = page.charRects[6];
      expect(
        readerCharIndexAt(page, PdfPoint(last.right + 4, last.center.y)),
        6,
      );
    });

    test('answers nothing for a point that is nowhere near the type', () {
      expect(readerCharIndexAt(page, const PdfPoint(400, 400)), isNull);
    });

    test('honours the margin rather than reaching for the furthest glyph', () {
      final last = page.charRects[6];
      expect(
        readerCharIndexAt(
          page,
          PdfPoint(last.right + 40, last.center.y),
          margin: 8,
        ),
        isNull,
      );
    });

    test('resolves a point between two lines to the nearer one', () {
      // Halfway into the gap under the first line.
      final gap = _firstLineTop - _lineHeight - _lineGap / 2;
      expect(readerCharIndexAt(page, PdfPoint(_charWidth / 2, gap)), 0);
    });

    test('declines a press in the middle of a picture, footer and all', () {
      // The sheet a full-page illustration prints on is not a sheet with no
      // text on it: every numbered page the book renders carries "Page n" in
      // its bottom margin, and only the cover and the title page opt out.
      // Coordinates are PDF ones, so that footer is the low Y and the picture
      // is everything above it — which is where the finger is. The press has
      // to come back with nothing, because `_anchorNear` starts a selection
      // from whatever this answers: an index here fires the haptic and opens
      // the action bar over the page number.
      final illustrated = _pageOfLines(['Page 12']);
      expect(readerCharIndexAt(illustrated, const PdfPoint(300, 500)), isNull);
    });
  });

  group('readerDragCharIndexAt', () {
    final page = _pageOfLines(['one two', 'three']);

    test('takes the same answer as the press wherever the margin has one', () {
      // The fast path is the press's, character for character — a drag that is
      // already on a glyph must not pick a different one from the press that
      // started it.
      expect(readerDragCharIndexAt(page, _centreOf(page, 5)), 5);
      expect(
        readerDragCharIndexAt(page, _centreOf(page, 5)),
        readerCharIndexAt(page, _centreOf(page, 5)),
      );
    });

    test('reaches past the end of a line the press would have refused', () {
      // A finger run well off the right-hand end of "one two". Stopping a word
      // short of the line it is plainly reaching for reads as the selection
      // being broken, so the drag takes 'o' (index 6) where the press takes
      // nothing.
      final last = page.charRects[6];
      final beyond = PdfPoint(last.right + 40, last.center.y);
      expect(readerDragCharIndexAt(page, beyond), 6);
      expect(readerCharIndexAt(page, beyond), isNull);
    });

    test(
      'drops through to a short line below rather than lingering on a '
      'longer line above',
      () {
        // "three" is five characters wide (50 points); "one two" above it
        // reaches to 70. A point past "three"'s last glyph but still under
        // "one two" is exactly a drag reaching for a short final line — a
        // book's last line, more often than not — and it must land on
        // "three", not freeze on the longer line it is still under.
        final threeBottom =
            _firstLineTop - _lineHeight - _lineGap - _lineHeight;
        final y = threeBottom + _lineHeight / 2;
        expect(readerDragCharIndexAt(page, PdfPoint(60, y)), 11);
      },
    );

    test('reaches down for a line a band or so under the finger', () {
      // Fifteen points below the last line's baseline box, which is more than
      // the margin and comfortably inside the line's own height times the
      // reach. This is the finger held below the end of the type waiting for
      // the page to slide.
      final below = _firstLineTop - 2 * _lineHeight - _lineGap - 15;
      expect(readerDragCharIndexAt(page, PdfPoint(_charWidth / 2, below)), 7);
    });

    test('stops rather than crossing a picture to reach the footer', () {
      // The other half of the reach: unbounded, this is the drag that parks in
      // the middle of an illustration and swallows every line between the
      // finger and the page number at the bottom of the sheet. `extendTo`
      // wants null here so the selection stands still at the last word the
      // finger actually passed.
      final illustrated = _pageOfLines(['Page 12']);
      expect(
        readerDragCharIndexAt(illustrated, const PdfPoint(300, 500)),
        isNull,
      );
      expect(readerDragCharIndexAt(page, const PdfPoint(400, 400)), isNull);
    });

    test('keeps to the line it chose when a staggered band overlaps it', () {
      // A markdown table. Cells wrap to different depths and are aligned as
      // blocks, so the next column's line lands staggered half a line off and
      // the two bands overlap — [614.41, 624.21] against [605.48, 616.00] in a
      // shipped book, the same shape as the round numbers here.
      final table = _pageOfBands([
        (text: 'first', left: 0, top: 100, bottom: 90),
        (text: 'second', left: 70, top: 91, bottom: 81),
      ]);
      // Fifty points past "first" and nine above "second": too far from either
      // for the press, so the drag falls through to the line search, where the
      // nearest band is "first"'s — the point is inside it.
      const point = PdfPoint(100, 100);
      expect(readerCharIndexAt(table, point), isNull);
      // The last character of "first". Not one of "second", which spans the
      // point's X and so wins outright at horizontal distance 0 the moment its
      // band is allowed into the candidate set — carrying the selection across
      // everything between the two lines.
      expect(readerDragCharIndexAt(table, point), 4);
    });

    test('settles two bands holding the finger by the nearer middle', () {
      // The staggered table again, with the finger in the strip where the two
      // bands overlap: both hold the point's Y, so both are equally near. The
      // band whose middle is nearer wins, rather than the one pdfrx emitted
      // first — emission order on a table page is not top to bottom.
      final table = _pageOfBands([
        (text: 'above', left: 0, top: 100, bottom: 90),
        (text: 'below', left: 0, top: 96, bottom: 86),
      ]);
      const point = PdfPoint(300, 92);
      expect(readerCharIndexAt(table, point), isNull);
      // "below" runs 5..9, and its middle (91) is a point from the finger
      // where "above"'s (95) is three.
      expect(readerDragCharIndexAt(table, point), 9);
    });
  });

  group('readerWordAt', () {
    final page = _pageOfLines(['one two']);

    test('takes the whole word around a character in it', () {
      expect(readerWordAt(page, 5), (start: 4, end: 6));
    });

    test('takes the first word from its first character', () {
      expect(readerWordAt(page, 0), (start: 0, end: 2));
    });

    test('answers nothing past the end of the text', () {
      expect(readerWordAt(page, 99), isNull);
    });

    test('takes the gap itself, which is what a drag should stop on', () {
      // The space between "one" and "two" is index 3. A finger dragging along
      // the line and resting there has reached "one" and not yet "two".
      expect(readerWordAt(page, 3), (start: 3, end: 3));
    });
  });

  group('readerAnchorWordAt', () {
    final page = _pageOfLines(['one two']);

    test('a press on a word takes that word', () {
      expect(readerAnchorWordAt(page, 5), (start: 4, end: 6));
    });

    test('a press in the gap takes the word after it, never the gap', () {
      // Anchoring to whitespace is worse than anchoring to nothing: the passage
      // collapses to an empty string and the action bar never opens, so the
      // press reads as having done nothing at all.
      expect(readerAnchorWordAt(page, 3), (start: 4, end: 6));
    });

    test('a press past the last word falls back to the word before it', () {
      final trailing = _pageOfLines(['one ']);
      expect(readerAnchorWordAt(trailing, 3), (start: 0, end: 2));
    });

    test('answers nothing on a page with no words at all', () {
      expect(readerAnchorWordAt(_pageOfLines(['   ']), 1), isNull);
    });
  });

  group('readerDragSelection', () {
    const anchorStart = ReaderTextHit(1, 4);
    const anchorEnd = ReaderTextHit(1, 6);

    ({ReaderTextHit start, ReaderTextHit end}) dragTo(
      ReaderTextHit start,
      ReaderTextHit end,
    ) {
      return readerDragSelection(
        anchorStart: anchorStart,
        anchorEnd: anchorEnd,
        movingStart: start,
        movingEnd: end,
      );
    }

    test('dragging forward keeps the anchor word and moves the far end', () {
      expect(
        dragTo(const ReaderTextHit(1, 8), const ReaderTextHit(1, 12)),
        (start: anchorStart, end: const ReaderTextHit(1, 12)),
      );
    });

    test('dragging back keeps the anchor word and moves the near end', () {
      expect(
        dragTo(const ReaderTextHit(1, 0), const ReaderTextHit(1, 2)),
        (start: const ReaderTextHit(1, 0), end: anchorEnd),
      );
    });

    test('a finger back over the starting word leaves that word selected', () {
      expect(
        dragTo(anchorStart, anchorEnd),
        (start: anchorStart, end: anchorEnd),
      );
    });

    test('reaching the next page extends forward', () {
      expect(
        dragTo(const ReaderTextHit(2, 0), const ReaderTextHit(2, 3)),
        (start: anchorStart, end: const ReaderTextHit(2, 3)),
      );
    });

    test('reaching the page before extends backward', () {
      expect(
        dragTo(const ReaderTextHit(1, 900), const ReaderTextHit(1, 904)),
        (start: anchorStart, end: const ReaderTextHit(1, 904)),
      );
      // The same indexes on an earlier page are behind the anchor, not ahead of
      // it: a hit is ordered by page first.
      expect(
        readerDragSelection(
          anchorStart: const ReaderTextHit(3, 4),
          anchorEnd: const ReaderTextHit(3, 6),
          movingStart: const ReaderTextHit(1, 900),
          movingEnd: const ReaderTextHit(1, 904),
        ),
        (start: const ReaderTextHit(1, 900), end: const ReaderTextHit(3, 6)),
      );
    });
  });
}

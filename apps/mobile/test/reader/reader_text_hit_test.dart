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

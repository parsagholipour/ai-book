import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/reader/domain/reader_annotation.dart';
import 'package:tomeza/features/reader/domain/reader_annotation_geometry.dart';

TextMarkupAnnotation highlight({
  int page = 3,
  int revision = 1,
  bool orphaned = false,
}) {
  return TextMarkupAnnotation(
    id: 'a1',
    page: page,
    revision: revision,
    colorIndex: 2,
    createdAt: DateTime.utc(2026, 7, 20, 10),
    updatedAt: DateTime.utc(2026, 7, 20, 10),
    style: ReaderMarkupStyle.highlight,
    rects: const [NormRect(0.1, 0.2, 0.4, 0.02), NormRect(0.1, 0.23, 0.3, 0.02)],
    quote: 'The rabbit stretched.',
    orphaned: orphaned,
    bookPageIndex: 7,
  );
}

void main() {
  group('geometry', () {
    test('a normalized point survives the round trip through a page', () {
      const pageRect = Rect.fromLTWH(20, 40, 400, 600);
      const point = NormPoint(0.25, 0.5);

      final offset = point.toOffset(pageRect);
      expect(offset, const Offset(120, 340));
      expect(NormPoint.fromOffset(offset, pageRect), point);
    });

    test('a rectangle scales with the page rather than the screen', () {
      const norm = NormRect(0.1, 0.2, 0.5, 0.1);

      final small = norm.toRect(const Rect.fromLTWH(0, 0, 200, 300));
      final large = norm.toRect(const Rect.fromLTWH(0, 0, 800, 1200));

      expect(small, const Rect.fromLTWH(20, 60, 100, 30));
      expect(large, const Rect.fromLTWH(80, 240, 400, 120));
    });

    test('a page with no size does not produce infinities', () {
      expect(
        NormPoint.fromOffset(const Offset(5, 5), Rect.zero),
        const NormPoint(0, 0),
      );
      expect(
        NormRect.fromRect(const Rect.fromLTWH(0, 0, 5, 5), Rect.zero),
        const NormRect(0, 0, 0, 0),
      );
    });

    test('the eraser catches the middle of a two-point stroke', () {
      // Hit-testing only the recorded points would miss everything between
      // them, which on a straight line is the whole line.
      const stroke = InkStroke(
        points: [NormPoint(0.1, 0.5), NormPoint(0.9, 0.5)],
        colorIndex: 4,
        width: 0.004,
      );

      expect(stroke.hitTest(const NormPoint(0.5, 0.505), 0.016), isTrue);
      expect(stroke.hitTest(const NormPoint(0.5, 0.7), 0.016), isFalse);
      // Past the end of the segment, not merely far from the infinite line.
      expect(stroke.hitTest(const NormPoint(1.2, 0.5), 0.016), isFalse);
    });

    test('a stroke reports the box it occupies', () {
      const stroke = InkStroke(
        points: [
          NormPoint(0.2, 0.8),
          NormPoint(0.5, 0.1),
          NormPoint(0.7, 0.4),
        ],
        colorIndex: 0,
        width: 0.004,
      );

      final bounds = stroke.bounds;
      expect(bounds.left, closeTo(0.2, 1e-9));
      expect(bounds.top, closeTo(0.1, 1e-9));
      expect(bounds.right, closeTo(0.7, 1e-9));
      expect(bounds.bottom, closeTo(0.8, 1e-9));
    });

    test('stroke points survive being flattened into JSON', () {
      const stroke = InkStroke(
        points: [NormPoint(0.125, 0.25), NormPoint(0.5, 0.75)],
        colorIndex: 5,
        width: 0.006,
      );

      final restored = InkStroke.fromJson(stroke.toJson())!;

      expect(restored.points, stroke.points);
      expect(restored.colorIndex, 5);
      expect(restored.width, closeTo(0.006, 1e-9));
    });
  });

  group('json', () {
    test('a highlight round trips', () {
      final restored =
          ReaderAnnotation.fromJson(highlight().toJson())!
              as TextMarkupAnnotation;

      expect(restored.id, 'a1');
      expect(restored.page, 3);
      expect(restored.style, ReaderMarkupStyle.highlight);
      expect(restored.rects, hasLength(2));
      expect(restored.quote, 'The rabbit stretched.');
      expect(restored.bookPageIndex, 7);
      expect(restored.orphaned, isFalse);
    });

    test('a note keeps its pin, its passage and what was written', () {
      final note = NoteAnnotation(
        id: 'n1',
        page: 5,
        revision: 2,
        colorIndex: 1,
        createdAt: DateTime.utc(2026, 7, 21),
        updatedAt: DateTime.utc(2026, 7, 21),
        anchor: const NormPoint(0.8, 0.3),
        body: 'Check this against chapter two.',
        quote: 'a passage worth arguing with',
        rects: const [NormRect(0.1, 0.3, 0.6, 0.02)],
      );

      final restored =
          ReaderAnnotation.fromJson(note.toJson())! as NoteAnnotation;

      expect(restored.anchor, const NormPoint(0.8, 0.3));
      expect(restored.body, 'Check this against chapter two.');
      expect(restored.quote, 'a passage worth arguing with');
      expect(restored.rects, hasLength(1));
    });

    test('ink and a text box round trip', () {
      final ink = InkAnnotation(
        id: 'i1',
        page: 2,
        revision: 1,
        colorIndex: 4,
        createdAt: DateTime.utc(2026, 7, 22),
        updatedAt: DateTime.utc(2026, 7, 22),
        strokes: const [
          InkStroke(
            points: [NormPoint(0.1, 0.1), NormPoint(0.2, 0.2)],
            colorIndex: 4,
            width: 0.004,
          ),
        ],
      );
      final box = TextBoxAnnotation(
        id: 't1',
        page: 6,
        revision: 1,
        colorIndex: 5,
        createdAt: DateTime.utc(2026, 7, 22),
        updatedAt: DateTime.utc(2026, 7, 22),
        anchor: const NormPoint(0.2, 0.4),
        body: 'in the margin',
      );

      expect(
        (ReaderAnnotation.fromJson(ink.toJson())! as InkAnnotation)
            .strokes
            .single
            .points,
        hasLength(2),
      );
      final restoredBox =
          ReaderAnnotation.fromJson(box.toJson())! as TextBoxAnnotation;
      expect(restoredBox.body, 'in the margin');
      expect(restoredBox.widthFraction, 0.4);
    });

    test('a tombstone is preserved, because a sync has to see the deletion', () {
      final deleted = highlight().deleted(DateTime.utc(2026, 7, 23));

      final restored = ReaderAnnotation.fromJson(deleted.toJson())!;

      expect(restored.isDeleted, isTrue);
      expect(restored.deletedAt, DateTime.utc(2026, 7, 23));
      expect(restored.isPlaceable, isFalse);
    });

    test('garbage yields null instead of taking the rest of the markup down', () {
      expect(ReaderAnnotation.fromJson(const {}), isNull);
      expect(
        ReaderAnnotation.fromJson(const {'type': 'markup', 'id': 'x'}),
        isNull,
        reason: 'no page',
      );
      expect(
        ReaderAnnotation.fromJson(const {
          'type': 'markup',
          'id': 'x',
          'page': 0,
        }),
        isNull,
        reason: 'pages are 1-based',
      );
      expect(
        ReaderAnnotation.fromJson(const {
          'type': 'nonsense',
          'id': 'x',
          'page': 1,
        }),
        isNull,
      );
      expect(
        ReaderAnnotation.fromJson(const {
          'type': 'ink',
          'id': 'x',
          'page': 1,
          'strokes': <Object>[],
        }),
        isNull,
        reason: 'ink with nothing drawn is not ink',
      );
    });

    test('an unknown colour index falls back rather than throwing', () {
      final restored = ReaderAnnotation.fromJson({
        ...highlight().toJson(),
        'colorIndex': 99,
      })!;
      expect(restored.colorIndex, 99, reason: 'stored as written');
    });
  });

  group('behaviour', () {
    test('markup knows when it belongs to an earlier build', () {
      expect(highlight(revision: 1).isStaleFor(1), isFalse);
      expect(highlight(revision: 1).isStaleFor(2), isTrue);
    });

    test('orphaned markup is listed but not placed on a page', () {
      expect(highlight(orphaned: true).isPlaceable, isFalse);
      expect(highlight().isPlaceable, isTrue);
    });

    test('a pin sits in the left margin, clear of the words', () {
      // A line of prose ends wherever it happens to wrap, so a pin after it
      // lands on top of the text as often as beside it. Every line in a block
      // starts at the same place, and that margin is empty by construction.
      final pin = NoteAnnotation.pinFor(const [
        NormRect(0.12, 0.30, 0.7, 0.02),
        NormRect(0.12, 0.33, 0.5, 0.02),
      ]);

      expect(
        pin.x + NoteAnnotation.pinSize,
        lessThanOrEqualTo(0.12),
        reason: 'the pin must end before the passage begins',
      );
      expect(pin.y, 0.30, reason: 'beside the first line of the run');
    });

    test('a passage against the left edge still gets a pin on the page', () {
      final pin = NoteAnnotation.pinFor(const [NormRect(0.0, 0.4, 0.9, 0.02)]);

      expect(pin.x, 0.0, reason: 'tight to the edge rather than off the page');
      expect(pin.x + NoteAnnotation.pinSize, lessThanOrEqualTo(1.0));
    });

    test('a note with no passage is pinned somewhere sane', () {
      final pin = NoteAnnotation.pinFor(const []);
      expect(pin.x, lessThan(0.5), reason: 'the margin side, like the rest');
    });

    test('a note that follows its passage moves its pin with it', () {
      final note = NoteAnnotation(
        id: 'n1',
        page: 4,
        revision: 1,
        colorIndex: 0,
        createdAt: DateTime.utc(2026, 7, 21),
        updatedAt: DateTime.utc(2026, 7, 21),
        anchor: const NormPoint(0.7, 0.3),
        body: 'note',
        quote: 'passage',
        rects: const [NormRect(0.1, 0.3, 0.6, 0.02)],
      );

      final moved = note.withAnchoring(
        page: 6,
        revision: 2,
        rects: const [NormRect(0.15, 0.62, 0.5, 0.02)],
      );

      expect(moved.page, 6);
      // The pin follows the words rather than staying at coordinates that now
      // point at a different paragraph, and lands where a fresh one would.
      expect(
        moved.anchor,
        NoteAnnotation.pinFor(const [NormRect(0.15, 0.62, 0.5, 0.02)]),
      );
      expect(moved.anchor.y, closeTo(0.62, 1e-9));
    });

    test('recolouring ink recolours every stroke in it', () {
      final ink = InkAnnotation(
        id: 'i1',
        page: 1,
        revision: 1,
        colorIndex: 4,
        createdAt: DateTime.utc(2026, 7, 22),
        updatedAt: DateTime.utc(2026, 7, 22),
        strokes: const [
          InkStroke(
            points: [NormPoint(0, 0), NormPoint(1, 1)],
            colorIndex: 4,
            width: 0.004,
          ),
        ],
      );

      final red = ink.recolored(5);

      expect(red.colorIndex, 5);
      expect(red.strokes.single.colorIndex, 5);
      expect(red.strokes.single.points, ink.strokes.single.points);
    });

    test('the preview collapses whitespace and says what ink is', () {
      final wrapped = TextMarkupAnnotation(
        id: 'a',
        page: 1,
        revision: 1,
        colorIndex: 0,
        createdAt: DateTime.utc(2026),
        updatedAt: DateTime.utc(2026),
        style: ReaderMarkupStyle.highlight,
        rects: const [],
        quote: 'the rabbit\n  stretched',
      );
      expect(wrapped.preview, 'the rabbit stretched');

      final ink = InkAnnotation(
        id: 'i',
        page: 9,
        revision: 1,
        colorIndex: 0,
        createdAt: DateTime.utc(2026),
        updatedAt: DateTime.utc(2026),
        strokes: const [
          InkStroke(points: [NormPoint(0, 0)], colorIndex: 0, width: 0.004),
        ],
      );
      expect(ink.preview, 'Drawing');
    });
  });
}

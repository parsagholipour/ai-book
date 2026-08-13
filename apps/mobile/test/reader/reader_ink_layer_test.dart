import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/reader/domain/reader_annotation_geometry.dart';
import 'package:tomeza/features/reader/presentation/reader_annotation_controller.dart';
import 'package:tomeza/features/reader/presentation/reader_ink_layer.dart';

/// Pumps an input layer at a known page size.
///
/// This is how drawing gets covered at all: PDFium is not loaded under
/// `flutter test`, but the layer is positioned over a page and given its size,
/// so a fake page of the same size behaves identically.
Future<void> pumpLayer(WidgetTester tester, Widget layer) {
  return tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Center(child: SizedBox(width: 400, height: 600, child: layer)),
      ),
    ),
  );
}

/// Where a page-fraction position lands, given the layer above is 400x600
/// centred in an 800x600 test window.
Offset at(double x, double y) => Offset(200 + x * 400, y * 600);

void main() {
  testWidgets('a drag becomes a stroke in page fractions', (tester) async {
    final strokes = <InkStroke>[];
    await pumpLayer(
      tester,
      ReaderInkLayer(
        tool: ReaderTool.pen,
        color: Colors.black,
        colorIndex: 4,
        strokeWidth: 0.006,
        onStroke: strokes.add,
        onErase: (_) {},
      ),
    );

    final gesture = await tester.startGesture(at(0.25, 0.25));
    await gesture.moveTo(at(0.5, 0.5));
    await gesture.moveTo(at(0.75, 0.75));
    await gesture.up();
    await tester.pump();

    expect(strokes, hasLength(1));
    final stroke = strokes.single;
    expect(stroke.colorIndex, 4);
    expect(stroke.width, 0.006);
    expect(stroke.points.first.x, closeTo(0.25, 1e-6));
    expect(stroke.points.first.y, closeTo(0.25, 1e-6));
    expect(stroke.points.last.x, closeTo(0.75, 1e-6));
    expect(stroke.points.last.y, closeTo(0.75, 1e-6));
  });

  testWidgets('points that land on top of each other are dropped', (
    tester,
  ) async {
    // A touch screen reports far more points than a line needs, and every one
    // of them is bytes in the file.
    final strokes = <InkStroke>[];
    await pumpLayer(
      tester,
      ReaderInkLayer(
        tool: ReaderTool.pen,
        color: Colors.black,
        colorIndex: 4,
        strokeWidth: 0.004,
        onStroke: strokes.add,
        onErase: (_) {},
      ),
    );

    final gesture = await tester.startGesture(at(0.2, 0.2));
    for (var i = 0; i < 20; i++) {
      await gesture.moveTo(at(0.2 + i * 0.00001, 0.2));
    }
    await gesture.moveTo(at(0.8, 0.8));
    await gesture.up();
    await tester.pump();

    expect(strokes.single.points, hasLength(2));
  });

  testWidgets('a tap alone leaves no mark', (tester) async {
    final strokes = <InkStroke>[];
    await pumpLayer(
      tester,
      ReaderInkLayer(
        tool: ReaderTool.pen,
        color: Colors.black,
        colorIndex: 4,
        strokeWidth: 0.004,
        onStroke: strokes.add,
        onErase: (_) {},
      ),
    );

    await tester.tapAt(at(0.5, 0.5));
    await tester.pump();

    expect(strokes, isEmpty);
  });

  testWidgets('a second finger abandons the stroke rather than committing it', (
    tester,
  ) async {
    // Two fingers is a pinch. Leaving a stray mark every time the reader zooms
    // would make drawing mode unusable.
    final strokes = <InkStroke>[];
    await pumpLayer(
      tester,
      ReaderInkLayer(
        tool: ReaderTool.pen,
        color: Colors.black,
        colorIndex: 4,
        strokeWidth: 0.004,
        onStroke: strokes.add,
        onErase: (_) {},
      ),
    );

    final first = await tester.startGesture(at(0.2, 0.2));
    await first.moveTo(at(0.4, 0.4));
    final second = await tester.startGesture(at(0.8, 0.8));
    await first.moveTo(at(0.5, 0.5));
    await first.up();
    await second.up();
    await tester.pump();

    expect(strokes, isEmpty);
  });

  testWidgets('the eraser reports every point it is dragged over', (
    tester,
  ) async {
    final erased = <NormPoint>[];
    await pumpLayer(
      tester,
      ReaderInkLayer(
        tool: ReaderTool.eraser,
        color: Colors.black,
        colorIndex: 4,
        strokeWidth: 0.004,
        onStroke: (_) {},
        onErase: erased.add,
      ),
    );

    final gesture = await tester.startGesture(at(0.3, 0.3));
    await gesture.moveTo(at(0.6, 0.6));
    await gesture.up();
    await tester.pump();

    expect(erased, hasLength(2));
    expect(erased.first.x, closeTo(0.3, 1e-6));
    expect(erased.last.y, closeTo(0.6, 1e-6));
  });

  group('placement', () {
    testWidgets('a tap names a spot on the page', (tester) async {
      final taps = <NormPoint>[];
      await pumpLayer(tester, ReaderTapLayer(onTap: taps.add));

      await tester.tapAt(at(0.4, 0.75));
      await tester.pump();

      expect(taps, hasLength(1));
      expect(taps.single.x, closeTo(0.4, 1e-6));
      expect(taps.single.y, closeTo(0.75, 1e-6));
    });

    testWidgets('a drag is scrolling, not a placement', (tester) async {
      final taps = <NormPoint>[];
      await pumpLayer(tester, ReaderTapLayer(onTap: taps.add));

      final gesture = await tester.startGesture(at(0.4, 0.4));
      await gesture.moveTo(at(0.4, 0.1));
      await gesture.up();
      await tester.pump();

      expect(taps, isEmpty);
    });

    testWidgets('a pinch places nothing', (tester) async {
      final taps = <NormPoint>[];
      await pumpLayer(tester, ReaderTapLayer(onTap: taps.add));

      final first = await tester.startGesture(at(0.3, 0.3));
      final second = await tester.startGesture(at(0.7, 0.7));
      await first.up();
      await second.up();
      await tester.pump();

      expect(taps, isEmpty);
    });

    testWidgets('a rejected tap is not a tap', (tester) async {
      final taps = <NormPoint>[];
      await pumpLayer(
        tester,
        ReaderTapLayer(
          onTap: taps.add,
          acceptTap: (global) => global.dx < at(0.5, 0.5).dx,
        ),
      );

      await tester.tapAt(at(0.2, 0.5));
      await tester.tapAt(at(0.8, 0.5));
      await tester.pump();

      expect(taps, hasLength(1));
      expect(taps.single.x, closeTo(0.2, 1e-6));
    });

    testWidgets('a placement never becomes a double tap', (tester) async {
      // Nothing is listening for one while a note is looking for a spot, so
      // two quick taps are two placements — the second one is not swallowed.
      final taps = <NormPoint>[];
      await pumpLayer(tester, ReaderTapLayer(onTap: taps.add));

      await tester.tapAt(at(0.4, 0.4));
      await tester.pump(const Duration(milliseconds: 40));
      await tester.tapAt(at(0.4, 0.4));
      await tester.pump();

      expect(taps, hasLength(2));
    });
  });

  group('double tap', () {
    testWidgets('the second of two quick taps is a zoom, not a tap', (
      tester,
    ) async {
      final taps = <NormPoint>[];
      final zooms = <Offset>[];
      await pumpLayer(
        tester,
        ReaderTapLayer(onTap: taps.add, onDoubleTap: zooms.add),
      );

      await tester.tapAt(at(0.5, 0.5));
      await tester.pump(const Duration(milliseconds: 40));
      await tester.tapAt(at(0.5, 0.5));
      await tester.pump();

      // The first tap went out the moment it landed — it had to, and putting
      // back what it did is the reader's job, not this layer's.
      expect(taps, hasLength(1));
      // Reported in global coordinates, because the zoom is anchored in the
      // viewer's space rather than this page's.
      expect(zooms, [at(0.5, 0.5)]);
    });

    testWidgets('the zoom waits for the second finger to lift', (tester) async {
      // A second contact that is still on its way down might yet become a
      // drag. Zooming before that is known is what made a tap-then-scroll
      // zoom the page.
      final zooms = <Offset>[];
      await pumpLayer(
        tester,
        ReaderTapLayer(onTap: (_) {}, onDoubleTap: zooms.add),
      );

      await tester.tapAt(at(0.5, 0.5));
      await tester.pump(const Duration(milliseconds: 40));
      final second = await tester.startGesture(at(0.5, 0.5));
      await tester.pump();

      expect(zooms, isEmpty);

      await second.up();
      await tester.pump();

      expect(zooms, hasLength(1));
    });

    testWidgets('a drag on the second tap is scrolling, not a zoom', (
      tester,
    ) async {
      final taps = <NormPoint>[];
      final zooms = <Offset>[];
      await pumpLayer(
        tester,
        ReaderTapLayer(onTap: taps.add, onDoubleTap: zooms.add),
      );

      await tester.tapAt(at(0.5, 0.5));
      await tester.pump(const Duration(milliseconds: 40));
      final second = await tester.startGesture(at(0.5, 0.5));
      await second.moveTo(at(0.5, 0.1));
      await second.up();
      await tester.pump();

      expect(zooms, isEmpty);
      expect(taps, hasLength(1), reason: 'the drag is not a second tap');
    });

    testWidgets('two taps far apart in time are two taps', (tester) async {
      final taps = <NormPoint>[];
      final zooms = <Offset>[];
      await pumpLayer(
        tester,
        ReaderTapLayer(onTap: taps.add, onDoubleTap: zooms.add),
      );

      await tester.tapAt(at(0.5, 0.5));
      await tester.pump(const Duration(milliseconds: 400));
      await tester.tapAt(at(0.5, 0.5));
      await tester.pump();

      expect(taps, hasLength(2));
      expect(zooms, isEmpty);
    });

    testWidgets('two taps far apart on the page are two taps', (tester) async {
      final taps = <NormPoint>[];
      final zooms = <Offset>[];
      await pumpLayer(
        tester,
        ReaderTapLayer(onTap: taps.add, onDoubleTap: zooms.add),
      );

      await tester.tapAt(at(0.1, 0.1));
      await tester.pump(const Duration(milliseconds: 40));
      await tester.tapAt(at(0.9, 0.9));
      await tester.pump();

      expect(taps, hasLength(2));
      expect(zooms, isEmpty);
    });

    testWidgets('a third tap starts over rather than zooming again', (
      tester,
    ) async {
      // Otherwise a drum roll on the page would zoom in and out on every beat.
      final taps = <NormPoint>[];
      final zooms = <Offset>[];
      await pumpLayer(
        tester,
        ReaderTapLayer(onTap: taps.add, onDoubleTap: zooms.add),
      );

      for (var i = 0; i < 3; i++) {
        await tester.tapAt(at(0.5, 0.5));
        await tester.pump(const Duration(milliseconds: 40));
      }

      expect(zooms, hasLength(1));
      expect(taps, hasLength(2), reason: 'the third tap is a tap again');
    });

    testWidgets('a pinch closes the window instead of completing it', (
      tester,
    ) async {
      // Two fingers is a zoom the reader is driving themselves. The tap that
      // came before must not still be waiting for a partner afterwards.
      final taps = <NormPoint>[];
      final zooms = <Offset>[];
      await pumpLayer(
        tester,
        ReaderTapLayer(onTap: taps.add, onDoubleTap: zooms.add),
      );

      await tester.tapAt(at(0.1, 0.1));
      await tester.pump(const Duration(milliseconds: 40));
      final first = await tester.startGesture(at(0.5, 0.5));
      final second = await tester.startGesture(at(0.7, 0.7));
      await first.up();
      await second.up();
      await tester.pump(const Duration(milliseconds: 40));
      await tester.tapAt(at(0.5, 0.5));
      await tester.pump();

      expect(zooms, isEmpty);
      expect(taps, hasLength(2), reason: 'the pinch itself reported nothing');
    });
  });
}

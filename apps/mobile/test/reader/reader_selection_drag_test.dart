import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pdfrx/pdfrx.dart';
import 'package:tomeza/features/reader/data/reader_repository.dart';
import 'package:tomeza/features/reader/presentation/book_reader_screen.dart';
import 'package:tomeza/features/reader/presentation/reader_document_loader.dart';
import 'package:tomeza/features/reader/presentation/reader_selection_drag.dart';
import 'package:tomeza/features/reader/presentation/reader_view.dart';

import 'book_reader_test_support.dart';

/// Records what the layer asked for without going near a document.
///
/// The gesture is the half of this feature that cannot be checked against a
/// real viewer — PDFium's natives are not loaded under `flutter test` — and it
/// is also the half with the sharp edges: it has to take the press away from
/// pdfrx's own long press and from the pan, while leaving every pointer that is
/// not a long press to the page underneath.
class _RecordingDrag extends ReaderSelectionDrag {
  _RecordingDrag() : super(controller: PdfViewerController(), onChanged: _noop);

  final began = <Offset>[];
  final extended = <Offset>[];
  var ended = 0;

  static void _noop() {}

  @override
  Future<void> begin(Offset globalPosition) async {
    began.add(globalPosition);
  }

  @override
  Future<void> extendTo(Offset globalPosition) async {
    extended.add(globalPosition);
  }

  @override
  void end() => ended++;
}

/// The layer over something that wants the same pointers — a stand-in for the
/// viewer's own body, which sits below it in the same stack.
Future<_RecordingDrag> _pump(
  WidgetTester tester, {
  required List<PointerEvent> below,
}) async {
  final drag = _RecordingDrag();
  await tester.pumpWidget(
    Directionality(
      textDirection: TextDirection.ltr,
      child: Stack(
        children: [
          Listener(
            behavior: HitTestBehavior.opaque,
            onPointerDown: below.add,
            onPointerMove: below.add,
            onPointerUp: below.add,
            child: const SizedBox.expand(),
          ),
          ReaderSelectionDragLayer(drag: drag, size: const Size(800, 600)),
        ],
      ),
    ),
  );
  return drag;
}

void main() {
  testWidgets('a press held on the page starts a selection drag', (
    tester,
  ) async {
    final below = <PointerEvent>[];
    final drag = await _pump(tester, below: below);

    final gesture = await tester.startGesture(const Offset(120, 200));
    await tester.pump(readerSelectionLongPressDuration + kPressTimeout);
    expect(drag.began, [const Offset(120, 200)]);

    await gesture.moveBy(const Offset(60, 40));
    await tester.pump();
    expect(drag.extended, [const Offset(180, 240)]);

    await gesture.up();
    await tester.pump();
    expect(drag.ended, 1);
  });

  testWidgets('the press is claimed before pdfrx would claim its own', (
    tester,
  ) async {
    final drag = await _pump(tester, below: []);
    await tester.startGesture(const Offset(120, 200));

    // pdfrx runs a long press of its own on the page below, at Flutter's
    // default. Winning has to be a property of this layer rather than of the
    // order two identical deadlines happen to be registered in.
    expect(readerSelectionLongPressDuration, lessThan(kLongPressTimeout));

    await tester.pump(readerSelectionLongPressDuration + kPressTimeout);
    expect(drag.began, isNotEmpty);
    await tester.pump(kLongPressTimeout);
  });

  testWidgets('a tap is left to the page underneath', (tester) async {
    final below = <PointerEvent>[];
    final drag = await _pump(tester, below: below);

    await tester.tapAt(const Offset(120, 200));
    await tester.pump();

    expect(drag.began, isEmpty);
    // Translucent, not opaque: the layer joins the hit test rather than winning
    // it, so the viewer keeps its taps, its panning and its pinch zoom.
    expect(below.whereType<PointerDownEvent>(), hasLength(1));
    expect(below.whereType<PointerUpEvent>(), hasLength(1));
  });

  testWidgets('a drag that never rests is left to the page underneath', (
    tester,
  ) async {
    final below = <PointerEvent>[];
    final drag = await _pump(tester, below: below);

    // A scroll: moving before the deadline gives the gesture to the viewer's
    // pan, exactly as it does today.
    final gesture = await tester.startGesture(const Offset(120, 200));
    await tester.pump(const Duration(milliseconds: 20));
    await gesture.moveBy(const Offset(0, -80));
    await tester.pump(readerSelectionLongPressDuration * 2);
    await gesture.up();
    await tester.pump();

    expect(drag.began, isEmpty);
    expect(drag.extended, isEmpty);
    expect(below.whereType<PointerMoveEvent>(), isNotEmpty);
  });

  testWidgets('the reader asks the viewer to open its own context menu', (
    tester,
  ) async {
    // The regression guard for the quietest failure in this feature. A
    // selection this reader makes itself was made by no pointer, which the
    // viewer reads as a mouse — so left to infer, it stops offering the
    // context-menu slot the reader's whole action bar is built in, and stops
    // drawing the loupe over a handle being dragged. Both are said outright,
    // and neither has a symptom that looks like this line going missing.
    viewerParams = [];
    final repository = FakeReaderRepository();
    final loader = ReaderDocumentLoader(
      repository: repository,
      projectId: 'project-1',
    );
    addTearDown(loader.dispose);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          readerRepositoryProvider.overrideWithValue(repository),
          readerViewerBuilderProvider.overrideWithValue(capturingViewer),
        ],
        child: MaterialApp(
          home: ReaderView(
            projectId: 'project-1',
            export: pdfExport(),
            loader: loader,
            status: statusWith(pdfExport()),
            onOpenPaywall: () {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final selection = viewerParams.last.textSelectionParams;
    expect(selection?.enabled, isTrue);
    expect(selection?.showContextMenuAutomatically, isTrue);
    expect(selection?.magnifier?.enabled, isTrue);
  });

  group('readerSelectionAutoScroll', () {
    const height = 800.0;

    test('stands still across the middle of the screen, which is most of it', () {
      expect(readerSelectionAutoScroll(height / 2, height), 0);
      expect(readerSelectionAutoScroll(readerSelectionAutoScrollBand, height), 0);
      expect(
        readerSelectionAutoScroll(height - readerSelectionAutoScrollBand, height),
        0,
      );
    });

    test('goes on through the book at the bottom and back at the top', () {
      expect(readerSelectionAutoScroll(height - 8, height), greaterThan(0));
      expect(readerSelectionAutoScroll(8, height), lessThan(0));
    });

    test('creeps at the edge of the band and runs at the edge of the screen', () {
      final barelyIn = readerSelectionAutoScroll(
        height - readerSelectionAutoScrollBand + 4,
        height,
      );
      final atTheEdge = readerSelectionAutoScroll(height, height);
      expect(barelyIn, greaterThan(0));
      expect(barelyIn, lessThan(atTheEdge / 10));
      expect(atTheEdge, readerSelectionAutoScrollSpeed);
    });

    test('a finger dragged off the screen goes no faster than one at its edge', () {
      expect(
        readerSelectionAutoScroll(height + 500, height),
        readerSelectionAutoScrollSpeed,
      );
      expect(readerSelectionAutoScroll(-500, height), -readerSelectionAutoScrollSpeed);
    });

    test('does nothing at all on a viewer with no middle to speak of', () {
      expect(readerSelectionAutoScroll(4, readerSelectionAutoScrollBand * 2), 0);
    });
  });

  testWidgets('a cancelled pointer ends the drag', (tester) async {
    final drag = await _pump(tester, below: []);

    final gesture = await tester.startGesture(const Offset(120, 200));
    await tester.pump(readerSelectionLongPressDuration + kPressTimeout);
    expect(drag.began, isNotEmpty);

    await gesture.cancel();
    await tester.pump();
    expect(drag.ended, 1);
  });

  testWidgets('the layer going away mid-press ends the drag', (tester) async {
    // The failure this guards against is silent and permanent. A
    // LongPressGestureRecognizer disposed after it has been accepted reports
    // nothing at all — `resolve(rejected)` takes the accepted branch and only
    // resets — so the press would stay claimed for the rest of the session:
    // the auto-scroll ticker never stops, taps never toggle the bars again, and
    // the action bar never opens again.
    final drag = await _pump(tester, below: []);

    await tester.startGesture(const Offset(120, 200));
    await tester.pump(readerSelectionLongPressDuration + kPressTimeout);
    expect(drag.began, isNotEmpty);
    expect(drag.ended, 0);

    await tester.pumpWidget(
      const Directionality(
        textDirection: TextDirection.ltr,
        child: SizedBox.expand(),
      ),
    );
    expect(drag.ended, 1);
  });
}

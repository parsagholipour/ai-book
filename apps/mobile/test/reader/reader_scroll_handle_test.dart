import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pdfrx/pdfrx.dart';
import 'package:tomeza/features/reader/presentation/reader_scroll_handle.dart';

/// A controller with no viewer behind it.
///
/// [PdfViewerController] is documented as extendable, and everything the handle
/// reads is a getter, so the whole surface it touches can be answered from
/// plain fields. The listener pair is overridden too: the base class notifies
/// through the viewer it is attached to, and there is none here.
class FakeViewerController extends PdfViewerController {
  FakeViewerController({
    this.ready = true,
    this.docHeight = 3000,
    this.viewHeight = 600,
    this.zoom = 1,
    this.page = 1,
    this.totalPages = 30,
  });

  bool ready;
  double docHeight;
  double viewHeight;
  double zoom;
  int page;
  int totalPages;

  final _listeners = <VoidCallback>[];
  Matrix4 _value = Matrix4.identity();

  @override
  bool get isReady => ready;

  @override
  Size get documentSize => Size(400, docHeight);

  @override
  Rect get visibleRect => Rect.fromLTWH(0, 0, 400, viewHeight);

  @override
  double get currentZoom => zoom;

  @override
  int? get pageNumber => page;

  @override
  int get pageCount => totalPages;

  @override
  Matrix4 get value => _value;

  @override
  set value(Matrix4 next) {
    _value = next;
    notify();
  }

  @override
  void addListener(VoidCallback listener) => _listeners.add(listener);

  @override
  void removeListener(VoidCallback listener) => _listeners.remove(listener);

  /// Stands in for the viewer reporting that the book moved.
  void notify() {
    for (final listener in List<VoidCallback>.of(_listeners)) {
      listener();
    }
  }
}

Future<void> pumpHandle(
  WidgetTester tester,
  FakeViewerController controller, {
  bool alwaysVisible = false,
  String? Function(int page)? chapterFor,
  VoidCallback? onPageTap,
}) {
  return tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Stack(
          children: [
            // Stands in for the viewer: everything the handle does not claim
            // has to reach it.
            GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: onPageTap ?? () {},
              child: const SizedBox.expand(),
            ),
            ReaderScrollHandle(
              controller: controller,
              chapterFor: chapterFor ?? (_) => null,
              alwaysVisible: alwaysVisible,
            ),
          ],
        ),
      ),
    ),
  );
}

/// The fake viewer's scrollable extent: a 3000px document in a 600px window.
const _scrollRange = 2400.0;

/// How far the thumb can travel: the window less the pill. Derived rather than
/// written out, so resizing the pill cannot quietly change what these tests
/// claim about the mapping between the two.
const _track = 600.0 - ReaderScrollHandle.handleHeight;

/// Where the book sits once the thumb has been dragged to [top].
double _offsetForTop(double top) => -(top / _track) * _scrollRange;

double _opacity(WidgetTester tester) =>
    tester.widget<AnimatedOpacity>(find.byType(AnimatedOpacity)).opacity;

double _top(WidgetTester tester) =>
    tester.getTopLeft(find.byType(AnimatedOpacity)).dy;

Future<TestGesture> _startRecognizedDrag(WidgetTester tester) async {
  final gesture = await tester.startGesture(
    tester.getCenter(find.byType(AnimatedOpacity)),
  );
  // Cross touch slop first so subsequent update counts can be compared without
  // gesture recognition changing between the single- and multi-event cases.
  await gesture.moveBy(const Offset(0, 25));
  await tester.pump();
  return gesture;
}

Future<double> _dragInSteps(
  WidgetTester tester,
  FakeViewerController controller,
  List<double> steps,
) async {
  await pumpHandle(tester, controller, alwaysVisible: true);
  final gesture = await _startRecognizedDrag(tester);
  for (final step in steps) {
    await gesture.moveBy(Offset(0, step));
    await tester.pump();
  }
  await gesture.up();
  await tester.pumpAndSettle();
  return controller.value.y;
}

void main() {
  testWidgets('draws nothing until the viewer is ready', (tester) async {
    // The reader builds the handle before the document lays out, and every
    // widget test stubs the viewer out entirely — neither may throw.
    await pumpHandle(tester, FakeViewerController(ready: false));

    expect(find.byType(AnimatedOpacity), findsNothing);
  });

  testWidgets('draws nothing for a book that does not scroll', (tester) async {
    await pumpHandle(
      tester,
      FakeViewerController(docHeight: 500, viewHeight: 600),
    );

    expect(find.byType(AnimatedOpacity), findsNothing);
  });

  testWidgets('rides the scroll position', (tester) async {
    final controller = FakeViewerController();
    await pumpHandle(tester, controller, alwaysVisible: true);
    expect(_top(tester), 0);

    // Half way down the scroll range is half way down the track.
    controller.value = Matrix4.identity()..y = -_scrollRange / 2;
    await tester.pumpAndSettle();

    expect(_top(tester), closeTo(_track / 2, 1));
  });

  testWidgets('scrolls the book when dragged', (tester) async {
    final controller = FakeViewerController();
    await pumpHandle(tester, controller, alwaysVisible: true);

    await tester.drag(find.byType(AnimatedOpacity), const Offset(0, 100));
    await tester.pumpAndSettle();

    // The book moves by the same fraction of its range as the thumb did of
    // its track. The tolerance covers the touch slop the drag spends first.
    expect(controller.value.y, closeTo(_offsetForTop(100), 25));
  });

  testWidgets('a grab that sets off sideways still drags the book', (
    tester,
  ) async {
    // Nobody drags a scrollbar straight down.
    final controller = FakeViewerController();
    await pumpHandle(tester, controller, alwaysVisible: true);

    final gesture = await tester.startGesture(
      tester.getCenter(find.byType(AnimatedOpacity)),
    );
    await gesture.moveBy(const Offset(-80, 6));
    await tester.pump();
    await gesture.moveBy(const Offset(0, 40));
    await tester.pump();
    await gesture.up();
    await tester.pumpAndSettle();

    // Sideways movement moves nothing: the book follows the vertical part.
    expect(controller.value.y, closeTo(_offsetForTop(46), 1));
  });

  testWidgets('multi-event drag stays linear from a nonzero position', (
    tester,
  ) async {
    final controller = FakeViewerController();
    controller.value = Matrix4.identity()..y = -600;
    await pumpHandle(tester, controller, alwaysVisible: true);

    final gesture = await _startRecognizedDrag(tester);
    // The book starts a quarter of the way down, and the 25px touch-slop
    // crossing is itself a drag update that moves the handle that far again.
    const startTop = _track / 4 + 25;
    expect(_top(tester), closeTo(startTop, 1));

    for (var step = 1; step <= 5; step++) {
      await gesture.moveBy(const Offset(0, 20));
      await tester.pump();
      expect(_top(tester), closeTo(startTop + step * 20, 1));
    }

    await gesture.up();
    await tester.pumpAndSettle();
    // The recognized 25px plus five 20px updates put the thumb at one place on
    // the track, whatever route it took to get there.
    expect(controller.value.y, closeTo(_offsetForTop(startTop + 100), 1));
  });

  testWidgets('drag result depends on distance, not update count', (
    tester,
  ) async {
    final singleUpdate = FakeViewerController();
    singleUpdate.value = Matrix4.identity()..y = -600;
    final singleResult = await _dragInSteps(tester, singleUpdate, const [100]);

    final manyUpdates = FakeViewerController();
    manyUpdates.value = Matrix4.identity()..y = -600;
    final segmentedResult = await _dragInSteps(tester, manyUpdates, const [
      20,
      20,
      20,
      20,
      20,
    ]);

    expect(segmentedResult, closeTo(singleResult, 0.01));
    expect(segmentedResult, closeTo(_offsetForTop(_track / 4 + 125), 1));
  });

  testWidgets('drag clamps at the beginning and end of the book', (
    tester,
  ) async {
    final towardStart = FakeViewerController();
    towardStart.value = Matrix4.identity()..y = -600;
    expect(
      await _dragInSteps(tester, towardStart, const [-1000]),
      closeTo(0, 0.01),
    );

    final towardEnd = FakeViewerController();
    towardEnd.value = Matrix4.identity()..y = -600;
    expect(
      await _dragInSteps(tester, towardEnd, const [1000]),
      closeTo(-2400, 0.01),
    );
  });

  testWidgets('claims the pill and nothing else on the right edge', (
    tester,
  ) async {
    // The pill used to sit inside a 44px transparent strip that swallowed
    // every tap and pan landing near it. Only the pill may be grabbable.
    final controller = FakeViewerController();
    var pageTaps = 0;
    await pumpHandle(
      tester,
      controller,
      alwaysVisible: true,
      onPageTap: () => pageTaps++,
    );

    final pill = tester.getRect(find.byType(AnimatedOpacity));
    expect(pill.width, ReaderScrollHandle.handleWidth);
    expect(
      pill.right,
      tester.getRect(find.byType(Scaffold)).right,
      reason: 'the handle must sit flush with the viewer edge',
    );

    // Just left of the pill, and level with it.
    await tester.tapAt(Offset(pill.left - 8, pill.center.dy));
    // Below it, where the pill is not.
    await tester.tapAt(Offset(pill.center.dx, pill.bottom + 60));
    await tester.pumpAndSettle();

    expect(pageTaps, 2);
    expect(controller.value.y, 0, reason: 'neither tap moved the book');
  });

  testWidgets('thickens while it is held', (tester) async {
    final controller = FakeViewerController();
    await pumpHandle(tester, controller, alwaysVisible: true);
    expect(
      tester.getSize(find.byType(AnimatedOpacity)).width,
      ReaderScrollHandle.handleWidth,
    );

    final gesture = await tester.startGesture(
      tester.getCenter(find.byType(AnimatedOpacity)),
    );
    await gesture.moveBy(const Offset(0, 40));
    await tester.pump();

    expect(
      tester.getSize(find.byType(AnimatedOpacity)).width,
      ReaderScrollHandle.grabbedWidth,
    );

    await gesture.up();
    await tester.pumpAndSettle();
    expect(
      tester.getSize(find.byType(AnimatedOpacity)).width,
      ReaderScrollHandle.handleWidth,
    );
  });

  testWidgets('stays out of the way until the book moves', (tester) async {
    final controller = FakeViewerController();
    await pumpHandle(tester, controller);
    expect(_opacity(tester), 0, reason: 'a reading screen is the page');

    controller.notify();
    await tester.pumpAndSettle();
    expect(_opacity(tester), 1);

    await tester.pump(ReaderScrollHandle.idleTimeout);
    await tester.pumpAndSettle();
    expect(_opacity(tester), 0);
  });

  testWidgets('stays put while marking up', (tester) async {
    // Panning is off while drawing, so a handle that faded out would strand
    // the reader on the page they started on.
    final controller = FakeViewerController();
    await pumpHandle(tester, controller, alwaysVisible: true);

    await tester.pump(ReaderScrollHandle.idleTimeout);
    await tester.pumpAndSettle();

    expect(_opacity(tester), 1);
  });

  testWidgets('names the chapter and page while dragging', (tester) async {
    final controller = FakeViewerController(page: 12);
    await pumpHandle(
      tester,
      controller,
      alwaysVisible: true,
      chapterFor: (page) => 'The Harbour at Dusk',
    );
    expect(find.text('Page 12 of 30'), findsNothing);

    final gesture = await tester.startGesture(
      tester.getCenter(find.byType(AnimatedOpacity)),
    );
    await gesture.moveBy(const Offset(0, 40));
    await tester.pump();

    expect(find.text('The Harbour at Dusk'), findsOneWidget);
    expect(find.text('Page 12 of 30'), findsOneWidget);

    await gesture.up();
    await tester.pumpAndSettle();
    expect(find.text('Page 12 of 30'), findsNothing);
  });
}

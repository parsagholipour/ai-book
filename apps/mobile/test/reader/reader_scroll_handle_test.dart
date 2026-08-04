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
}) {
  return tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Stack(
          children: [
            const SizedBox.expand(),
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

double _opacity(WidgetTester tester) =>
    tester.widget<AnimatedOpacity>(find.byType(AnimatedOpacity)).opacity;

double _top(WidgetTester tester) =>
    tester.getTopLeft(find.byType(AnimatedOpacity)).dy;

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

    // Half way down a 2400px scroll range, on a 552px track.
    controller.value = Matrix4.identity()..y = -1200;
    await tester.pumpAndSettle();

    expect(_top(tester), closeTo(276, 1));
  });

  testWidgets('scrolls the book when dragged', (tester) async {
    final controller = FakeViewerController();
    await pumpHandle(tester, controller, alwaysVisible: true);

    await tester.drag(find.byType(AnimatedOpacity), const Offset(0, 100));
    await tester.pumpAndSettle();

    // 100px down a 552px track is 18% of a 2400px scroll range.
    expect(controller.value.y, closeTo(-435, 25));
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

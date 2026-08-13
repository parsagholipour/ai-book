import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

import 'app_components.dart';
import 'motion.dart';

/// Opens a fullscreen, pinch-zoomable gallery of pictures.
///
/// The route recipe is the same as the chat image preview so the two feel
/// identical; this one adds a pager, a counter and optional chrome.
Future<T?> showZoomableImageViewer<T>({
  required BuildContext context,
  required int itemCount,
  required IndexedWidgetBuilder itemBuilder,
  int initialIndex = 0,
  Widget? Function(BuildContext context, int index)? topBarTrailing,
  Widget? Function(BuildContext context, int index)? bottomBar,
}) {
  assert(
    itemCount > 0,
    'showZoomableImageViewer requires at least one picture',
  );
  return showDismissibleFadeRoute(
    context,
    ZoomableImageViewer(
      itemCount: itemCount,
      initialIndex: initialIndex.clamp(0, itemCount - 1),
      itemBuilder: itemBuilder,
      topBarTrailing: topBarTrailing,
      bottomBar: bottomBar,
    ),
  );
}

/// A translucent fade-in route that can be dismissed by tapping the barrier.
Future<T?> showDismissibleFadeRoute<T>(BuildContext context, Widget page) {
  return Navigator.of(context).push<T>(
    PageRouteBuilder<T>(
      opaque: false,
      barrierColor: Colors.black.withValues(alpha: 0.92),
      barrierDismissible: true,
      transitionDuration: AppMotion.medium,
      reverseTransitionDuration: AppMotion.fast,
      pageBuilder: (_, _, _) => page,
      transitionsBuilder: (context, animation, _, child) =>
          FadeTransition(opacity: animation, child: child),
    ),
  );
}

/// What one gesture on the picture turned out to be.
///
/// Every gesture arrives through the one scale recognizer, so this is decided
/// here rather than by three recognizers racing each other: see [_pager].
enum _Handling { undecided, zoom, page, dismiss }

/// Fullscreen pager of pictures, each of which zooms.
///
/// Three gestures share one surface — swipe, pinch and swipe-down-to-dismiss —
/// and the viewer decides between them itself rather than letting three
/// recognizers race.
class ZoomableImageViewer extends StatefulWidget {
  const ZoomableImageViewer({
    required this.itemCount,
    required this.initialIndex,
    required this.itemBuilder,
    this.topBarTrailing,
    this.bottomBar,
    super.key,
  });

  final int itemCount;
  final int initialIndex;
  final IndexedWidgetBuilder itemBuilder;
  final Widget? Function(BuildContext context, int index)? topBarTrailing;
  final Widget? Function(BuildContext context, int index)? bottomBar;

  @override
  State<ZoomableImageViewer> createState() => _ZoomableImageViewerState();
}

class _ZoomableImageViewerState extends State<ZoomableImageViewer> {
  late final PageController _pages = PageController(
    initialPage: widget.initialIndex,
  );
  late int _index = widget.initialIndex;

  /// The zoom. One for the whole pager rather than one per page, because it
  /// sits outside the pager — see [_pager].
  final _zoom = TransformationController();

  bool _chromeVisible = true;
  double _dragOffset = 0;

  /// The pager's own drag and hold, driven by hand — see [_pager].
  Drag? _pageDrag;
  ScrollHoldController? _pageHold;
  int _pointers = 0;
  Offset? _landedAt;

  _Handling _handling = _Handling.undecided;
  Offset _sinceStart = Offset.zero;

  /// How far a finger travels before the viewer commits to what the drag is.
  ///
  /// It is normally past this before the first update even arrives, because
  /// winning the gesture costs a touch slop of its own — which is the point:
  /// the direction is read from where the finger landed, so the picture starts
  /// moving on the same pixel a pager of its own would have started on.
  static const double _axisSlop = 6;

  @override
  void dispose() {
    _releasePageDrag();
    _releasePageHold();
    _pages.dispose();
    _zoom.dispose();
    super.dispose();
  }

  bool get _zoomed => _zoom.value.getMaxScaleOnAxis() > 1.01;

  void _showPage(int index) {
    setState(() {
      _index = index;
      // Nobody should arrive at a picture that is already scaled. Paging a
      // zoomed one is refused, so at rest this is only ever a no-op — but the
      // pager can settle onto the next picture while a pinch is going on, and
      // there the reader is zooming what they can see and gets to keep it.
      if (_pointers == 0) {
        _zoom.value = Matrix4.identity();
      }
    });
  }

  /// A finger landing on the pictures stops a snap that is still running,
  /// exactly as a `Scrollable`'s own drag recognizer does on pointer down.
  /// Without it the pager finished every animation before it would listen
  /// again, so a picture on its way past could not be caught or turned back.
  void _pointerDown(PointerDownEvent event) {
    _pointers += 1;
    if (_pointers > 1) return;
    _landedAt = event.position;
    if (_pageDrag != null || _pageHold != null || !_pages.hasClients) return;
    _pageHold = _pages.position.hold(() => _pageHold = null);
  }

  void _pointerGone(PointerEvent event) {
    _pointers = _pointers > 0 ? _pointers - 1 : 0;
    if (_pointers > 0) return;
    _landedAt = null;
    // Nothing took the pager over, so let it settle on a whole picture again.
    _releasePageHold();
  }

  void _interactionStart(ScaleStartDetails details) {
    _sinceStart = Offset.zero;
    if (details.pointerCount > 1 || _zoomed) {
      _handOverToZoom();
      return;
    }
    _handling = _Handling.undecided;
  }

  void _interactionUpdate(ScaleUpdateDetails details) {
    if (_handling == _Handling.zoom) return;
    if (details.pointerCount > 1 || _zoomed) {
      _handOverToZoom();
      return;
    }

    _sinceStart += details.focalPointDelta;
    if (_handling != _Handling.undecided) {
      _applyDrag(details, details.focalPointDelta);
      return;
    }
    // Read the direction from where the finger landed rather than from where
    // the gesture was won: by then it has travelled a touch slop already, and
    // that is both the better evidence and the pixel a pager would start on.
    final landed = _landedAt;
    final since = landed == null ? _sinceStart : details.focalPoint - landed;
    if (since.distance < _axisSlop) return;
    if (since.dx.abs() > since.dy.abs()) {
      _handling = _Handling.page;
      _startPageDrag(details);
    } else {
      _handling = _Handling.dismiss;
    }
    // Nothing moved while the axis was being decided, so replay it.
    _applyDrag(details, _sinceStart);
  }

  void _interactionEnd(ScaleEndDetails details) {
    // A finger arriving or leaving mid-gesture reports an end of its own. Only
    // an end with nothing left on the glass is the reader letting go.
    if (details.pointerCount > 0) {
      _handOverToZoom();
      return;
    }
    switch (_handling) {
      case _Handling.page:
        _endPageDrag(details.velocity);
      case _Handling.dismiss:
        _endDismiss(details.velocity);
      case _Handling.undecided:
      case _Handling.zoom:
        break;
    }
    _handling = _Handling.undecided;
  }

  /// A second finger — or a picture that is already zoomed — makes the gesture
  /// a pinch or a pan. Whatever it looked like a moment ago is unwound rather
  /// than finished: a page half-swiped by the drift before the second finger
  /// landed goes back where it was.
  void _handOverToZoom() {
    _handling = _Handling.zoom;
    // Where the first finger landed says nothing about the direction of
    // whatever the reader does with the one they have left.
    _landedAt = null;
    _releasePageDrag()?.cancel();
    if (_dragOffset != 0) {
      setState(() => _dragOffset = 0);
    }
  }

  void _applyDrag(ScaleUpdateDetails details, Offset delta) {
    switch (_handling) {
      case _Handling.page:
        _pageDrag?.update(
          DragUpdateDetails(
            globalPosition: details.focalPoint,
            localPosition: details.localFocalPoint,
            sourceTimeStamp: details.sourceTimeStamp,
            delta: Offset(delta.dx, 0),
            primaryDelta: delta.dx,
          ),
        );
      case _Handling.dismiss:
        setState(() => _dragOffset += delta.dy);
      case _Handling.undecided:
      case _Handling.zoom:
        break;
    }
  }

  void _startPageDrag(ScaleUpdateDetails details) {
    if (!_pages.hasClients) {
      _handling = _Handling.undecided;
      return;
    }
    _pageDrag = _pages.position.drag(
      DragStartDetails(
        globalPosition: details.focalPoint,
        localPosition: details.localFocalPoint,
        sourceTimeStamp: details.sourceTimeStamp,
        kind: PointerDeviceKind.touch,
      ),
      () => _pageDrag = null,
    );
  }

  void _endPageDrag(Velocity velocity) {
    final horizontal = velocity.pixelsPerSecond.dx;
    _releasePageDrag()?.end(
      DragEndDetails(
        velocity: Velocity(pixelsPerSecond: Offset(horizontal, 0)),
        primaryVelocity: horizontal,
      ),
    );
  }

  /// Takes the live page drag, if the pager is still there to receive what the
  /// caller does with it. Once the route is going away the pager has already
  /// disposed its own position, and ending or cancelling would reach into it.
  Drag? _releasePageDrag() {
    final drag = _pageDrag;
    _pageDrag = null;
    return _pages.hasClients ? drag : null;
  }

  /// Cancelling a hold is what hands the pager back to its own physics, so a
  /// picture stopped by a finger that then did something else — a tap, a
  /// pinch, a drag downwards — settles rather than sitting between two.
  void _releasePageHold() {
    final hold = _pageHold;
    _pageHold = null;
    if (_pages.hasClients) hold?.cancel();
  }

  void _endDismiss(Velocity velocity) {
    final speed = velocity.pixelsPerSecond.dy.abs();
    if (_dragOffset.abs() > 120 || speed > 700) {
      Navigator.of(context).pop();
      return;
    }
    setState(() => _dragOffset = 0);
  }

  void _doubleTap(TapDownDetails details) {
    final controller = _zoom;
    setState(() {
      if (controller.value.getMaxScaleOnAxis() > 1.01) {
        controller.value = Matrix4.identity();
        return;
      }
      // Anchored on the tap, because pinching a square avatar is fiddly.
      final position = details.localPosition;
      controller.value = Matrix4.identity()
        ..translateByDouble(-position.dx * 1.5, -position.dy * 1.5, 0, 1)
        ..scaleByDouble(2.5, 2.5, 2.5, 1);
    });
  }

  @override
  Widget build(BuildContext context) {
    final fade = (1 - (_dragOffset.abs() / 400)).clamp(0.0, 1.0);
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: Opacity(
        opacity: fade,
        child: Transform.translate(
          offset: Offset(0, _dragOffset),
          child: Stack(
            children: [
              Positioned.fill(child: _pager()),
              if (_chromeVisible) ...[
                Positioned(top: 0, left: 0, right: 0, child: _topBar()),
                if (widget.bottomBar != null)
                  Positioned(bottom: 0, left: 0, right: 0, child: _bottomBar()),
              ],
            ],
          ),
        ),
      ),
    );
  }

  /// The pictures, and the one gesture surface all three of swipe, pinch and
  /// dismiss are decided on.
  ///
  /// The pager owns **no drag recognizer of its own** (`dragDevices` is empty),
  /// and neither does the dismiss. Both used to, and Flutter's arena hands a
  /// gesture to whichever recognizer claims it first: a finger that drifts one
  /// touch slop before its partner lands is a page swipe or a dismiss for the
  /// rest of that gesture, so the pinch it turned into never zoomed anything.
  /// A one-finger pan of a zoomed picture lost the same race — the pager
  /// claims at `kTouchSlop` and a scale gesture pans at twice that, so the
  /// picture paged away instead of moving under the finger.
  ///
  /// So the [InteractiveViewer]'s scale recognizer is left as the only claimant
  /// and its callbacks decide what the movement meant, feeding the pager by
  /// hand ([_startPageDrag]) through the same `Drag` a `Scrollable` would use —
  /// which is what keeps the flings, the snapping and the overscroll native.
  ///
  /// The [Listener] is the other half of that: it is outside the arena, so it
  /// hears a finger land before any recognizer has claimed it, which is when a
  /// pager stops a snap it is in the middle of ([_pointerDown]).
  ///
  /// **The [InteractiveViewer] must stay outside the [PageView]**, which is why
  /// the zoom is one controller for the pager rather than one per picture. A
  /// `Scrollable` wraps its viewport in an `IgnorePointer` for as long as a
  /// fling or a snap is running, and a pointer is hit-tested once, when it
  /// lands — so a finger put down on a moving picture was routed to nothing
  /// inside the pager for the whole of that gesture. It stopped the snap (the
  /// [Listener] is above the ignored subtree, and so is the tap) and then did
  /// nothing at all until it lifted. A `Scrollable` keeps its own recognizer
  /// above that same `IgnorePointer` for exactly this reason.
  Widget _pager() {
    return Listener(
      onPointerDown: _pointerDown,
      onPointerUp: _pointerGone,
      onPointerCancel: _pointerGone,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        // A tap toggles the chrome rather than dismissing. With a pager, a tap
        // during a mis-swipe would throw the reader out of a gallery they are
        // still browsing — the one deliberate divergence from the chat preview.
        onTap: () => setState(() => _chromeVisible = !_chromeVisible),
        onDoubleTapDown: _doubleTap,
        onDoubleTap: () {},
        child: InteractiveViewer(
          transformationController: _zoom,
          minScale: 1,
          maxScale: 5,
          onInteractionStart: _interactionStart,
          onInteractionUpdate: _interactionUpdate,
          onInteractionEnd: _interactionEnd,
          child: PageView.builder(
            controller: _pages,
            scrollBehavior: ScrollConfiguration.of(context).copyWith(
              scrollbars: false,
              dragDevices: const <PointerDeviceKind>{},
            ),
            itemCount: widget.itemCount,
            onPageChanged: _showPage,
            itemBuilder: (context, index) {
              return Center(child: widget.itemBuilder(context, index));
            },
          ),
        ),
      ),
    );
  }

  Widget _topBar() {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.xs),
        child: Row(
          children: [
            const CloseButton(color: Colors.white),
            Expanded(
              child: Semantics(
                liveRegion: true,
                label: 'Picture ${_index + 1} of ${widget.itemCount}',
                child: ExcludeSemantics(
                  child: Text(
                    '${_index + 1} of ${widget.itemCount}',
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ),
            ),
            widget.topBarTrailing?.call(context, _index) ??
                const SizedBox(width: 48),
          ],
        ),
      ),
    );
  }

  Widget _bottomBar() {
    final bar = widget.bottomBar?.call(context, _index);
    if (bar == null) return const SizedBox.shrink();
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.md,
          0,
          AppSpacing.md,
          AppSpacing.md,
        ),
        child: bar,
      ),
    );
  }
}

import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

import '../domain/reader_annotation_geometry.dart';
import 'reader_annotation_controller.dart';
import 'reader_annotation_painter.dart';

/// Captures pen and eraser input over one page.
///
/// Placed by `pageOverlaysBuilder`, which positions it exactly over the page
/// and gives it the page's on-screen size. That is the whole reason drawing is
/// done here rather than over the viewer as a whole: a pointer position in this
/// widget's own coordinates *is* a position on the page, so normalizing it is a
/// division and the page it belongs to needs no working out.
///
/// Input is taken with a [Listener] rather than a [GestureDetector] on purpose.
/// A gesture detector would enter the arena and, if it won, stop the viewer
/// seeing the same pointers — pdfrx says as much — which would take pinch-zoom
/// away while a drawing tool is active. A listener only watches, so the viewer
/// keeps its two-finger gestures and a single finger is left free to draw
/// because panning is switched off for the duration.
class ReaderInkLayer extends StatefulWidget {
  const ReaderInkLayer({
    required this.tool,
    required this.color,
    required this.colorIndex,
    required this.strokeWidth,
    required this.onStroke,
    required this.onErase,
    super.key,
  });

  /// Either [ReaderTool.pen] or [ReaderTool.eraser].
  final ReaderTool tool;

  final Color color;
  final int colorIndex;

  /// Pen thickness as a fraction of the page width.
  final double strokeWidth;

  final void Function(InkStroke stroke) onStroke;
  final void Function(NormPoint point) onErase;

  @override
  State<ReaderInkLayer> createState() => _ReaderInkLayerState();
}

class _ReaderInkLayerState extends State<ReaderInkLayer> {
  final _live = _LiveStroke();
  final _pointers = <int>{};

  int? _drawing;

  /// Set when a second finger arrives, and only cleared once every finger has
  /// lifted. Without it, letting go of one finger of a pinch would be read as
  /// the start of a new stroke.
  bool _gestureClaimed = false;

  @override
  void dispose() {
    _live.dispose();
    super.dispose();
  }

  Rect _pageRect(BoxConstraints constraints) =>
      Rect.fromLTWH(0, 0, constraints.maxWidth, constraints.maxHeight);

  void _onDown(PointerDownEvent event, Rect pageRect) {
    _pointers.add(event.pointer);
    if (_pointers.length > 1) {
      // A pinch, not a stroke. Whatever was being drawn is abandoned rather
      // than committed as a stray mark.
      _gestureClaimed = true;
      _drawing = null;
      _live.clear();
      return;
    }
    if (_gestureClaimed) {
      return;
    }
    _drawing = event.pointer;
    final point = NormPoint.fromOffset(event.localPosition, pageRect);
    if (widget.tool == ReaderTool.eraser) {
      _live.startCursor(point);
      widget.onErase(point);
      return;
    }
    _live.start(point);
  }

  void _onMove(PointerMoveEvent event, Rect pageRect) {
    if (event.pointer != _drawing) {
      return;
    }
    final point = NormPoint.fromOffset(event.localPosition, pageRect);
    if (widget.tool == ReaderTool.eraser) {
      _live.startCursor(point);
      widget.onErase(point);
      return;
    }
    _live.extend(point);
  }

  void _onUp(PointerEvent event) {
    _pointers.remove(event.pointer);
    if (_pointers.isEmpty) {
      _gestureClaimed = false;
    }
    if (event.pointer != _drawing) {
      return;
    }
    _drawing = null;
    final points = _live.take();
    if (widget.tool == ReaderTool.pen && points.length >= 2) {
      widget.onStroke(
        InkStroke(
          points: points,
          colorIndex: widget.colorIndex,
          width: widget.strokeWidth,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final pageRect = _pageRect(constraints);
        return Listener(
          behavior: HitTestBehavior.translucent,
          onPointerDown: (event) => _onDown(event, pageRect),
          onPointerMove: (event) => _onMove(event, pageRect),
          onPointerUp: _onUp,
          onPointerCancel: _onUp,
          child: RepaintBoundary(
            child: CustomPaint(
              size: pageRect.size,
              painter: _LiveStrokePainter(
                live: _live,
                color: widget.color,
                strokeWidth: widget.strokeWidth,
                eraser: widget.tool == ReaderTool.eraser,
              ),
            ),
          ),
        );
      },
    );
  }
}

/// Turns a tap anywhere on a page into a position on that page.
///
/// Used while a note or a text box is waiting to be put somewhere, and while
/// reading, where a tap is what puts the bars away and brings them back. Like
/// [ReaderInkLayer] it listens rather than competing for the gesture, so the
/// page still pans and zooms underneath while the reader looks for the right
/// spot — and a drag is read as scrolling, not as a placement.
class ReaderTapLayer extends StatefulWidget {
  const ReaderTapLayer({required this.onTap, this.onDoubleTap, super.key});

  final void Function(NormPoint point) onTap;

  /// The second of two quick taps, reported when that finger *lifts* without
  /// having dragged. A second contact that moves is a pan, not a zoom — firing
  /// on the way down is what made a tap-then-scroll zoom the page.
  ///
  /// In **global** coordinates, because what it drives is the viewer's zoom and
  /// this layer is one page inside it.
  ///
  /// The tap before it has already gone out through [onTap] and cannot be taken
  /// back: nothing here can know a second one is coming without holding every
  /// single tap in the book for the length of the double-tap window. Undoing
  /// what that first tap did is therefore the caller's — see
  /// `_onReadingDoubleTap`.
  final void Function(Offset globalPosition)? onDoubleTap;

  /// How far a finger may travel and still count as a tap rather than a drag.
  static const slop = 12.0;

  @override
  State<ReaderTapLayer> createState() => _ReaderTapLayerState();
}

class _ReaderTapLayerState extends State<ReaderTapLayer> {
  Offset? _down;
  int? _pointer;

  /// Where the last tap landed, for as long as a second one could still join it
  /// into a double tap, and the timer that closes that window.
  ///
  /// A timer rather than a comparison of pointer timestamps, so the window runs
  /// on the same clock Flutter's own double-tap recognizer uses — including the
  /// test one, where every pointer event is stamped zero.
  Offset? _firstTap;
  Timer? _doubleTapWindow;

  /// Set on the touch that may complete a double tap, so a still release zooms
  /// instead of reporting a tap of its own, and a drag cancels rather than
  /// zooming.
  bool _paired = false;

  @override
  void dispose() {
    _doubleTapWindow?.cancel();
    super.dispose();
  }

  void _openDoubleTapWindow(Offset at) {
    _doubleTapWindow?.cancel();
    _firstTap = at;
    _doubleTapWindow = Timer(kDoubleTapTimeout, _closeDoubleTapWindow);
  }

  void _closeDoubleTapWindow() {
    _doubleTapWindow?.cancel();
    _doubleTapWindow = null;
    _firstTap = null;
  }

  /// Whether this touch is the second half of a double tap.
  ///
  /// Measured from where the first tap landed with the platform's own
  /// tolerance, which is far wider than [ReaderTapLayer.slop]: that one is
  /// about one finger staying still, this one about two taps meaning the same
  /// place. The 300ms window is paused rather than closed, so a still finger
  /// held a moment longer can still complete; a drag, a pinch or a cancel
  /// closes it for good.
  bool _beginsDoubleTap(PointerDownEvent event) {
    final first = _firstTap;
    if (first == null || widget.onDoubleTap == null) return false;
    if ((event.localPosition - first).distance > kDoubleTapSlop) return false;
    _doubleTapWindow?.cancel();
    _doubleTapWindow = null;
    return true;
  }

  bool _draggedPastSlop(Offset at, Offset down) =>
      (at - down).distance > ReaderTapLayer.slop;

  void _cancelPairing() {
    _paired = false;
    _closeDoubleTapWindow();
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final pageRect = Rect.fromLTWH(
          0,
          0,
          constraints.maxWidth,
          constraints.maxHeight,
        );
        return Listener(
          behavior: HitTestBehavior.translucent,
          onPointerDown: (event) {
            if (_pointer != null) {
              // A second finger means a pinch; nothing is being placed, and two
              // fingers at once are not the second half of a double tap.
              _pointer = null;
              _down = null;
              _cancelPairing();
              return;
            }
            _pointer = event.pointer;
            _down = event.localPosition;
            _paired = _beginsDoubleTap(event);
          },
          onPointerMove: (event) {
            final down = _down;
            if (!_paired || down == null || event.pointer != _pointer) {
              return;
            }
            if (_draggedPastSlop(event.localPosition, down)) {
              _cancelPairing();
            }
          },
          onPointerUp: (event) {
            final down = _down;
            final pointer = _pointer;
            final paired = _paired;
            _pointer = null;
            _down = null;
            _paired = false;
            if (down == null || pointer != event.pointer) return;
            if (_draggedPastSlop(event.localPosition, down)) {
              if (paired) _closeDoubleTapWindow();
              return;
            }
            if (paired) {
              // A still second tap. Reporting it as a tap as well would put
              // the bars back and then take them away again in one gesture.
              final onDoubleTap = widget.onDoubleTap;
              if (onDoubleTap != null) onDoubleTap(event.position);
              _closeDoubleTapWindow();
              return;
            }
            if (widget.onDoubleTap != null) {
              _openDoubleTapWindow(event.localPosition);
            }
            widget.onTap(
              NormPoint.fromOffset(event.localPosition, pageRect),
            );
          },
          onPointerCancel: (_) {
            final paired = _paired;
            _pointer = null;
            _down = null;
            _paired = false;
            // A candidate has already stopped the 300ms timer; leaving
            // `_firstTap` set would let a tap much later still zoom.
            if (paired) _closeDoubleTapWindow();
          },
          child: const SizedBox.expand(),
        );
      },
    );
  }
}

/// The stroke currently under the finger.
///
/// Held outside the widget's state and repainted through the painter's own
/// listenable: a `setState` for every pointer move would rebuild the layer
/// dozens of times a second and make the line lag behind the finger.
class _LiveStroke extends ChangeNotifier {
  final List<NormPoint> points = [];
  NormPoint? cursor;

  void start(NormPoint point) {
    points
      ..clear()
      ..add(point);
    cursor = point;
    notifyListeners();
  }

  void startCursor(NormPoint point) {
    cursor = point;
    notifyListeners();
  }

  void extend(NormPoint point) {
    final last = points.isEmpty ? null : points.last;
    if (last != null &&
        last.distanceTo(point) < InkStroke.minimumSampleDistance) {
      return;
    }
    points.add(point);
    cursor = point;
    notifyListeners();
  }

  void clear() {
    points.clear();
    cursor = null;
    notifyListeners();
  }

  List<NormPoint> take() {
    final taken = List<NormPoint>.of(points);
    clear();
    return taken;
  }
}

class _LiveStrokePainter extends CustomPainter {
  _LiveStrokePainter({
    required this.live,
    required this.color,
    required this.strokeWidth,
    required this.eraser,
  }) : super(repaint: live);

  final _LiveStroke live;
  final Color color;
  final double strokeWidth;
  final bool eraser;

  @override
  void paint(Canvas canvas, Size size) {
    final pageRect = Rect.fromLTWH(0, 0, size.width, size.height);
    if (eraser) {
      final cursor = live.cursor;
      if (cursor == null) {
        return;
      }
      // Shows exactly what the eraser will take, which is the difference
      // between rubbing something out and guessing.
      final radius =
          ReaderAnnotationController.eraserTolerance * pageRect.width;
      canvas
        ..drawCircle(
          cursor.toOffset(pageRect),
          radius,
          Paint()..color = color.withValues(alpha: 0.12),
        )
        ..drawCircle(
          cursor.toOffset(pageRect),
          radius,
          Paint()
            ..color = color.withValues(alpha: 0.6)
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1.5,
        );
      return;
    }
    if (live.points.isEmpty) {
      return;
    }
    paintInkStroke(
      canvas: canvas,
      pageRect: pageRect,
      stroke: InkStroke(points: live.points, colorIndex: 0, width: strokeWidth),
      color: color,
    );
  }

  @override
  bool shouldRepaint(_LiveStrokePainter oldDelegate) {
    return oldDelegate.color != color ||
        oldDelegate.strokeWidth != strokeWidth ||
        oldDelegate.eraser != eraser;
  }
}

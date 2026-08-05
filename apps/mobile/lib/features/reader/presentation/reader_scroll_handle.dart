import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pdfrx/pdfrx.dart';

import '../../../app/theme/app_theme.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';

/// The handle on the right edge that scrolls the book.
///
/// The book scrolls vertically, so the control that moves it points the same
/// way — dragging the handle down moves the reader down the book, at whatever
/// scale the whole book is. It is deliberately absent at rest: a reading screen
/// should be the page, so the handle fades in when the book moves or the handle
/// is touched and fades out again once it stops.
///
/// It lives in the reader's own `Stack` rather than in
/// [PdfViewerParams.viewerOverlayBuilder]. Two reasons, both load-bearing: the
/// viewer's parameters are memoized to stop a relayout loop, so nothing may be
/// added to them per rebuild; and an overlay inside the viewer does not exist
/// under `flutter test`, where the viewer itself is stubbed out. The reader's
/// `Stack` sits inside the same `Expanded` box as the viewer, so the geometry
/// below is measured against the same rectangle either way.
class ReaderScrollHandle extends StatefulWidget {
  const ReaderScrollHandle({
    required this.controller,
    required this.chapterFor,
    this.alwaysVisible = false,
    super.key,
  });

  final PdfViewerController controller;

  /// The chapter a PDF page falls in, for the bubble shown while dragging.
  /// Null whenever the book has no usable outline.
  final String? Function(int page) chapterFor;

  /// Pins the handle on regardless of the idle timer.
  ///
  /// Set while the reader is marking up: panning is off during drawing, so this
  /// is then the only way to get to another page, and a handle that fades out
  /// would strand them on the page they started on.
  final bool alwaysVisible;

  /// Height of the pill.
  ///
  /// Constant on purpose: the travel below is measured against it, so a height
  /// that grew on grab would move the track under the finger and make the book
  /// jump at the moment the reader took hold of it.
  static const handleHeight = 48.0;

  /// Width of the pill at rest, and while it is being held.
  ///
  /// The pill *is* the target — there is no transparent padding around it, so
  /// the rest of the right edge stays page and keeps taking taps and pans.
  /// That is why it has to be a real width rather than a hairline.
  static const handleWidth = 16.0;
  static const grabbedWidth = 22.0;

  /// Gap between the pill and the edge of the screen.
  static const edgeInset = 4.0;

  /// How long the handle stays up after the book stops moving.
  static const idleTimeout = Duration(milliseconds: 1500);

  @override
  State<ReaderScrollHandle> createState() => _ReaderScrollHandleState();
}

class _ReaderScrollHandleState extends State<ReaderScrollHandle> {
  /// Pins the pill to its own element across the bubble coming and going.
  final _pillKey = GlobalKey();

  Timer? _idle;
  bool _visible = false;
  bool _dragging = false;

  /// Track position minus the finger's local position when the drag started.
  ///
  /// Pointer events keep reporting from the gesture's original hit-test
  /// transform even though the thumb moves between frames. Holding this origin
  /// fixed makes each update reflect the finger's total displacement once,
  /// instead of adding it again to the thumb's already-updated position.
  double _dragTrackOrigin = 0;

  /// The page the bubble last announced, so a haptic fires once per page
  /// crossed rather than once per frame.
  int? _announcedPage;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onViewerMoved);
  }

  @override
  void didUpdateWidget(ReaderScrollHandle oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_onViewerMoved);
      widget.controller.addListener(_onViewerMoved);
    }
  }

  @override
  void dispose() {
    _idle?.cancel();
    widget.controller.removeListener(_onViewerMoved);
    super.dispose();
  }

  /// Any movement of the book — a finger on the page, a jump from the contents,
  /// our own drag — brings the handle up and restarts its countdown.
  void _onViewerMoved() {
    if (!mounted) return;
    _show();
  }

  void _show() {
    _idle?.cancel();
    _idle = Timer(ReaderScrollHandle.idleTimeout, _hide);
    if (!_visible) {
      setState(() => _visible = true);
    }
  }

  void _hide() {
    // A live drag outlasts the timer: the reader is holding the thing.
    if (!mounted || _dragging) return;
    setState(() => _visible = false);
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    // Not ready covers both the moment before the document lays out and the
    // stubbed viewer in widget tests, where the controller is never attached.
    if (!controller.isReady) {
      return const SizedBox.shrink();
    }

    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) => _handle(context),
    );
  }

  Widget _handle(BuildContext context) {
    final metrics = _metrics();
    if (metrics == null) {
      return const SizedBox.shrink();
    }

    final visible = _visible || widget.alwaysVisible;
    final duration = AppMotion.reducedMotion(context)
        ? Duration.zero
        : AppMotion.fast;
    final width = _dragging
        ? ReaderScrollHandle.grabbedWidth
        : ReaderScrollHandle.handleWidth;

    // Filling the viewer costs nothing: a `Stack` hit-tests its children and
    // then reports a miss, so everywhere the pill is not stays page. The only
    // opaque box in here is the pill itself.
    return Positioned.fill(
      child: IgnorePointer(
        ignoring: !visible,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            // The pill is first and keyed so that the bubble appearing beside
            // it cannot take its slot. Without that, taking hold of the handle
            // rebuilds the gesture detector from scratch, its recognizer is
            // disposed mid-drag, and the end of the drag is never reported —
            // leaving the handle stuck in its grabbed state.
            Positioned(
              key: _pillKey,
              right: ReaderScrollHandle.edgeInset,
              top: metrics.top,
              width: width,
              height: ReaderScrollHandle.handleHeight,
              child: AnimatedOpacity(
                opacity: visible ? 1 : 0,
                duration: duration,
                curve: AppMotion.standard,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onVerticalDragStart: (details) =>
                      _onDragStart(details, metrics),
                  onVerticalDragUpdate: (details) =>
                      _onDragUpdate(details, metrics),
                  onVerticalDragEnd: (_) => _onDragEnd(),
                  onVerticalDragCancel: _releaseDrag,
                  child: _pill(context),
                ),
              ),
            ),
            if (_dragging)
              Positioned(
                right: ReaderScrollHandle.edgeInset + width + 8,
                top: metrics.top,
                height: ReaderScrollHandle.handleHeight,
                child: Center(child: IgnorePointer(child: _bubble(context))),
              ),
          ],
        ),
      ),
    );
  }

  Widget _pill(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      label: 'Scroll through the book',
      value:
          'Page ${widget.controller.pageNumber ?? 1} of '
          '${widget.controller.pageCount}',
      slider: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: _dragging
              ? colors.primary
              : colors.onSurfaceVariant.withValues(alpha: 0.55),
          borderRadius: BorderRadius.circular(TomezaRadii.chip),
          border: Border.all(color: colors.surface.withValues(alpha: 0.7)),
        ),
        child: Center(
          child: Icon(
            Icons.drag_indicator,
            size: 14,
            color: _dragging ? colors.onPrimary : colors.surface,
          ),
        ),
      ),
    );
  }

  /// The readout that pops out to the left of the thumb while dragging.
  ///
  /// It reads the page off the controller rather than waiting for the reader's
  /// own `onPageChanged` round trip, so the number keeps up with the finger.
  Widget _bubble(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final page = widget.controller.pageNumber ?? 1;
    final chapter = widget.chapterFor(page);
    return Material(
      color: colors.inverseSurface,
      elevation: 3,
      borderRadius: BorderRadius.circular(TomezaRadii.control),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            if (chapter != null)
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 200),
                child: Text(
                  chapter,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: colors.onInverseSurface,
                  ),
                ),
              ),
            Text(
              'Page $page of ${widget.controller.pageCount}',
              style: theme.textTheme.labelSmall?.copyWith(
                color: colors.onInverseSurface.withValues(alpha: 0.75),
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ gesture

  void _onDragStart(DragStartDetails details, _HandleMetrics metrics) {
    // Keep one fixed origin for the whole gesture. The pill's height does not
    // change on grab, so taking hold also leaves the track under the finger.
    _dragTrackOrigin = metrics.top - details.localPosition.dy;
    _announcedPage = widget.controller.pageNumber;
    setState(() => _dragging = true);
    _show();
    AppHaptics.selection();
  }

  void _onDragUpdate(DragUpdateDetails details, _HandleMetrics metrics) {
    final trackY = _dragTrackOrigin + details.localPosition.dy;
    _scrollTo(trackY / metrics.travel, metrics);
    _show();

    final page = widget.controller.pageNumber;
    if (page != null && page != _announcedPage) {
      _announcedPage = page;
      AppHaptics.selection();
    }
  }

  void _onDragEnd() {
    _releaseDrag();
    AppHaptics.selection();
  }

  /// Lets go without the confirming tick, for a drag the arena took away.
  void _releaseDrag() {
    if (!_dragging) return;
    setState(() => _dragging = false);
    _show();
  }

  void _scrollTo(double fraction, _HandleMetrics metrics) {
    final matrix = widget.controller.value.clone();
    matrix.y = -(fraction.clamp(0.0, 1.0) * metrics.scrollRange);
    // The setter clamps to the viewer's safe range, so an overshoot at either
    // end is absorbed rather than throwing the document off screen.
    widget.controller.value = matrix;
  }

  /// Where the thumb sits and how far it can travel.
  ///
  /// The arithmetic is pdfrx's own, from `PdfViewerScrollThumb`: the matrix
  /// translation is the scroll offset, the document and visible rectangles are
  /// in document coordinates, and the track is the viewport height less the
  /// thumb. Deliberately *not* reading `controller.params.boundaryMargin` the
  /// way pdfrx does — the reader never sets one, and it is unreachable on a
  /// controller that has no viewer attached.
  _HandleMetrics? _metrics() {
    final controller = widget.controller;
    final view = controller.visibleRect;
    final documentHeight = controller.documentSize.height;
    final scrollRange = documentHeight - view.height;
    // A book shorter than the window does not scroll, so there is nothing to
    // drag and no handle to draw.
    if (scrollRange <= 0) {
      return null;
    }
    final travel =
        view.height * controller.currentZoom - ReaderScrollHandle.handleHeight;
    if (travel <= 0) {
      return null;
    }
    final progress = (-controller.value.y / scrollRange).clamp(0.0, 1.0);
    return _HandleMetrics(
      top: progress * travel,
      travel: travel,
      scrollRange: scrollRange,
    );
  }
}

class _HandleMetrics {
  const _HandleMetrics({
    required this.top,
    required this.travel,
    required this.scrollRange,
  });

  /// Distance from the top of the viewer to the top of the thumb.
  final double top;

  /// How far the thumb can move, in screen pixels.
  final double travel;

  /// How far the document can scroll, in document coordinates.
  final double scrollRange;
}

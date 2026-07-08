import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/gestures.dart' show DragStartBehavior;
import 'package:flutter/material.dart';

// Easier-open drawer.
//
// Keeps ONE GestureDetector for the whole lifetime so mid-drag rebuilds cannot
// cancel the recognizer. Drawer content is only mounted while opening/open
// (same as Material when dismissed), but the detector itself never swaps.

const double _kWidth = 304.0;
// Material uses 0.5 (~152px). ~55px is enough to snap open.
const double _kOpenThreshold = 0.18;
const double _kMinFlingVelocity = 180.0;
const Duration _kBaseSettleDuration = Duration(milliseconds: 246);

class EasyDrawerController extends StatefulWidget {
  const EasyDrawerController({
    super.key,
    required this.child,
    this.drawerCallback,
    this.dragStartBehavior = DragStartBehavior.down,
    this.scrimColor,
    this.drawerBarrierDismissible = true,
  });

  final Widget child;
  final DrawerCallback? drawerCallback;
  final DragStartBehavior dragStartBehavior;
  final Color? scrimColor;
  final bool drawerBarrierDismissible;

  @override
  State<EasyDrawerController> createState() => EasyDrawerControllerState();
}

class EasyDrawerControllerState extends State<EasyDrawerController>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  final FocusScopeNode _focusScopeNode = FocusScopeNode();
  final GlobalKey _drawerKey = GlobalKey();
  LocalHistoryEntry? _historyEntry;
  bool _previouslyOpened = false;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: _kBaseSettleDuration,
      vsync: this,
    )
      ..addListener(() => setState(() {}))
      ..addStatusListener(_animationStatusChanged);
  }

  @override
  void dispose() {
    _historyEntry?.remove();
    _controller.dispose();
    _focusScopeNode.dispose();
    super.dispose();
  }

  void open() {
    _controller.fling();
    widget.drawerCallback?.call(true);
    _previouslyOpened = true;
  }

  void close() {
    _controller.fling(velocity: -1.0);
    widget.drawerCallback?.call(false);
    _previouslyOpened = false;
  }

  bool get isDrawerOpen => !_controller.isDismissed;

  double get _width {
    final box = _drawerKey.currentContext?.findRenderObject() as RenderBox?;
    return box?.size.width ?? _kWidth;
  }

  void _ensureHistoryEntry() {
    if (_historyEntry != null) return;
    final route = ModalRoute.of(context);
    if (route == null) return;
    _historyEntry = LocalHistoryEntry(
      onRemove: () {
        _historyEntry = null;
        close();
      },
      impliesAppBarDismissal: false,
    );
    route.addLocalHistoryEntry(_historyEntry!);
    FocusScope.of(context).setFirstFocus(_focusScopeNode);
  }

  void _clearHistoryEntry() {
    _historyEntry?.remove();
    _historyEntry = null;
  }

  void _animationStatusChanged(AnimationStatus status) {
    switch (status) {
      case AnimationStatus.forward:
        _ensureHistoryEntry();
      case AnimationStatus.reverse:
        _clearHistoryEntry();
      case AnimationStatus.dismissed:
      case AnimationStatus.completed:
        break;
    }
  }

  void _handleDragDown(DragDownDetails details) {
    _controller.stop();
    if (!_controller.isDismissed) {
      _ensureHistoryEntry();
    }
  }

  void _handleDragCancel() {
    if (_controller.isDismissed || _controller.isAnimating) return;
    if (_controller.value < _kOpenThreshold) {
      close();
    } else {
      open();
    }
  }

  void _move(DragUpdateDetails details) {
    final next = (_controller.value + details.primaryDelta! / _width).clamp(
      0.0,
      1.0,
    );
    _controller.value = next;

    final opened = next > _kOpenThreshold;
    if (opened != _previouslyOpened) {
      widget.drawerCallback?.call(opened);
      _previouslyOpened = opened;
    }
  }

  void _settle(DragEndDetails details) {
    if (_controller.isDismissed) return;

    final velocity = details.primaryVelocity ?? 0;
    if (velocity.abs() >= _kMinFlingVelocity) {
      if (velocity > 0) {
        open();
      } else {
        close();
      }
      return;
    }

    if (_controller.value < _kOpenThreshold) {
      close();
    } else {
      open();
    }
  }

  @override
  Widget build(BuildContext context) {
    assert(debugCheckHasMaterialLocalizations(context));

    final showing = !_controller.isDismissed;
    final scrimColor =
        widget.scrimColor ??
        DrawerTheme.of(context).scrimColor ??
        Colors.black54;
    final effectiveScrim = scrimColor.withValues(
      alpha: scrimColor.a * _controller.value,
    );
    final platformHasBackButton =
        defaultTargetPlatform == TargetPlatform.android;

    // Detector is ALWAYS the same element. Only the overlay children toggle.
    return GestureDetector(
      onHorizontalDragDown: _handleDragDown,
      onHorizontalDragUpdate: _move,
      onHorizontalDragEnd: _settle,
      onHorizontalDragCancel: _handleDragCancel,
      behavior: HitTestBehavior.translucent,
      excludeFromSemantics: true,
      dragStartBehavior: widget.dragStartBehavior,
      child: SizedBox.expand(
        child: ListTileTheme.merge(
          style: ListTileStyle.drawer,
          child: Stack(
            fit: StackFit.expand,
            children: [
              if (showing)
                BlockSemantics(
                  child: ExcludeSemantics(
                    excluding: platformHasBackButton,
                    child: GestureDetector(
                      onTap: widget.drawerBarrierDismissible ? close : null,
                      child: Semantics(
                        label: MaterialLocalizations.of(
                          context,
                        ).modalBarrierDismissLabel,
                        child: ColoredBox(color: effectiveScrim),
                      ),
                    ),
                  ),
                ),
              if (showing)
                Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: Align(
                    alignment: AlignmentDirectional.centerEnd,
                    widthFactor: _controller.value.clamp(0.0, 1.0),
                    child: RepaintBoundary(
                      child: FocusScope(
                        key: _drawerKey,
                        node: _focusScopeNode,
                        child: widget.child,
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class EasyDrawerButton extends StatelessWidget {
  const EasyDrawerButton({required this.controllerKey, super.key});

  final GlobalKey<EasyDrawerControllerState> controllerKey;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      icon: const Icon(Icons.menu),
      tooltip: MaterialLocalizations.of(context).openAppDrawerTooltip,
      onPressed: () => controllerKey.currentState?.open(),
    );
  }
}

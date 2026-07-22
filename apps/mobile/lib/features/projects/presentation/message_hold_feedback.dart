import 'dart:async';

import 'package:flutter/material.dart';

/// Adds immediate press and pointer-hover feedback around a message that opens
/// its actions menu on a long press.
class MessageHoldFeedback extends StatefulWidget {
  const MessageHoldFeedback({
    required this.onLongPressStart,
    required this.child,
    super.key,
  });

  static const pressedScale = 0.98;
  static const hoveredScale = 1.006;
  static const pressedOpacity = 0.86;
  static const hoveredOpacity = 0.96;

  final Future<void> Function(LongPressStartDetails details) onLongPressStart;
  final Widget child;

  @override
  State<MessageHoldFeedback> createState() => _MessageHoldFeedbackState();
}

class _MessageHoldFeedbackState extends State<MessageHoldFeedback> {
  static const _animationDuration = Duration(milliseconds: 90);

  bool _pointerDown = false;
  bool _hovered = false;
  bool _menuOpen = false;

  void _setPointerDown(bool value) {
    if (_pointerDown == value) return;
    setState(() => _pointerDown = value);
  }

  void _setHovered(bool value) {
    if (_hovered == value) return;
    setState(() => _hovered = value);
  }

  void _handleLongPress(LongPressStartDetails details) {
    if (!_menuOpen) {
      setState(() => _menuOpen = true);
    }
    unawaited(
      widget.onLongPressStart(details).whenComplete(() {
        if (!mounted) return;
        setState(() => _menuOpen = false);
      }),
    );
  }

  @override
  Widget build(BuildContext context) {
    final active = _pointerDown || _menuOpen;
    final scale = active
        ? MessageHoldFeedback.pressedScale
        : (_hovered ? MessageHoldFeedback.hoveredScale : 1.0);
    final opacity = active
        ? MessageHoldFeedback.pressedOpacity
        : (_hovered ? MessageHoldFeedback.hoveredOpacity : 1.0);

    return MouseRegion(
      onEnter: (_) => _setHovered(true),
      onExit: (_) => _setHovered(false),
      child: Listener(
        behavior: HitTestBehavior.translucent,
        onPointerDown: (_) => _setPointerDown(true),
        onPointerUp: (_) => _setPointerDown(false),
        onPointerCancel: (_) => _setPointerDown(false),
        child: GestureDetector(
          behavior: HitTestBehavior.translucent,
          onLongPressStart: _handleLongPress,
          child: AnimatedScale(
            scale: scale,
            duration: _animationDuration,
            curve: Curves.easeOutCubic,
            child: AnimatedOpacity(
              opacity: opacity,
              duration: _animationDuration,
              curve: Curves.easeOutCubic,
              child: widget.child,
            ),
          ),
        ),
      ),
    );
  }
}

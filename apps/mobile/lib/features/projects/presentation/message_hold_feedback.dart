import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

/// Adds immediate press and pointer-hover feedback around a message that opens
/// its actions menu on a long press, and — where a reply is possible — the
/// swipe-to-reply drag.
class MessageHoldFeedback extends StatefulWidget {
  const MessageHoldFeedback({
    required this.onLongPressStart,
    required this.child,
    this.onSwipeReply,
    super.key,
  });

  static const pressedScale = 0.98;
  static const hoveredScale = 1.006;
  static const pressedOpacity = 0.86;
  static const hoveredOpacity = 0.96;

  /// How far the bubble must be dragged before releasing starts a reply.
  static const swipeReplyThreshold = 56.0;

  /// How far it can be dragged at all, so the gesture reads as a nudge rather
  /// than as dismissing the message.
  static const swipeReplyMaxDrag = 76.0;

  final Future<void> Function(LongPressStartDetails details) onLongPressStart;

  /// Starts a reply to this message. Null where replying is not offered, which
  /// also disables the drag entirely.
  final VoidCallback? onSwipeReply;
  final Widget child;

  @override
  State<MessageHoldFeedback> createState() => _MessageHoldFeedbackState();
}

class _MessageHoldFeedbackState extends State<MessageHoldFeedback> {
  static const _animationDuration = Duration(milliseconds: 90);

  bool _pointerDown = false;
  bool _hovered = false;
  bool _menuOpen = false;
  double _dragOffset = 0;

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

  void _handleDragUpdate(DragUpdateDetails details) {
    // Only the drag towards the centre of the screen counts, and it is capped:
    // this is a nudge that reveals the reply icon, not a dismiss.
    final next = (_dragOffset + details.delta.dx).clamp(
      0.0,
      MessageHoldFeedback.swipeReplyMaxDrag,
    );
    if (next == _dragOffset) return;
    setState(() => _dragOffset = next);
  }

  void _handleDragEnd() {
    final reply = _dragOffset >= MessageHoldFeedback.swipeReplyThreshold;
    setState(() => _dragOffset = 0);
    if (reply) {
      widget.onSwipeReply?.call();
    }
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
          // Offsets are measured from the pointer-down position, so the bubble
          // tracks the finger from the first pixel instead of jumping once the
          // recognizer wins the arena — which also keeps the threshold below a
          // real finger's travel rather than a touch-slop short of it.
          dragStartBehavior: DragStartBehavior.down,
          onLongPressStart: _handleLongPress,
          // Horizontal only, so the vertical transcript scroll still wins.
          onHorizontalDragUpdate: widget.onSwipeReply == null
              ? null
              : _handleDragUpdate,
          onHorizontalDragEnd: widget.onSwipeReply == null
              ? null
              : (_) => _handleDragEnd(),
          onHorizontalDragCancel: widget.onSwipeReply == null
              ? null
              : () => setState(() => _dragOffset = 0),
          child: Stack(
            children: [
              if (_dragOffset > 0)
                Positioned.fill(
                  child: Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: Opacity(
                      opacity:
                          (_dragOffset / MessageHoldFeedback.swipeReplyThreshold)
                              .clamp(0.0, 1.0),
                      child: Icon(
                        Icons.reply_outlined,
                        size: 20,
                        color: Theme.of(context).colorScheme.primary,
                      ),
                    ),
                  ),
                ),
              // Pixel-exact while dragging so the bubble tracks the finger, and
              // animated only on the way back, which is the spring-back.
              AnimatedContainer(
                duration: _dragOffset == 0
                    ? _animationDuration
                    : Duration.zero,
                curve: Curves.easeOutCubic,
                transform: Matrix4.translationValues(_dragOffset, 0, 0),
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
            ],
          ),
        ),
      ),
    );
  }
}

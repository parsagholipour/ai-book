import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../shared/ui/motion.dart';
import 'chat_assistant_avatar.dart';
import 'chat_message_text.dart';

/// The assistant-side "working on it" bubble, shown while a chat turn is in
/// flight.
///
/// A book chat turn is not a fast one — the server routes the message through a
/// model and, for a question, answers it with a second call, so a reply can be
/// most of a minute away. Without this the transcript simply stops: the send
/// button greys out and nothing else moves, which reads as a broken app rather
/// than a busy one.
///
/// Three dots pulse the way a person's typing indicator does, and the copy
/// beside them advances on a timer for the same reason. A spinner that has said
/// the same word for forty seconds stops being reassuring; naming a later stage
/// says the wait is expected. It never rewinds and never claims to be finished.
/// The dots only run while this bubble is on screen, which is only while the
/// server says a reply is in flight; with reduced motion they hold still.
class ChatThinkingBubble extends StatefulWidget {
  const ChatThinkingBubble({
    this.stages = creationThinkingStages,
    this.showAvatar = false,
    this.text = '',
    super.key,
  });

  /// What the bubble says, in order, one stage every four seconds. The last
  /// entry is where it settles, so make it one that stays true.
  final List<String> stages;

  /// Draws the assistant's avatar beside the bubble, for a transcript whose
  /// other assistant messages wear one.
  final bool showAvatar;
  final String text;

  @override
  State<ChatThinkingBubble> createState() => _ChatThinkingBubbleState();
}

/// Stages for the conversation that builds a book from scratch.
const creationThinkingStages = <String>[
  'Thinking…',
  'Thinking about your book…',
  'Shaping the details…',
  'Almost there…',
];

/// Stages for chatting about a book that already exists, where the wait is the
/// assistant reading the manuscript to work out what the message asks for.
const bookChatThinkingStages = <String>[
  'Reading your message…',
  'Looking through your book…',
  'Working out what to change…',
  'Almost there…',
];

class _ChatThinkingBubbleState extends State<ChatThinkingBubble>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1300),
  );
  Timer? _timer;
  int _stage = 0;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 4), (_) {
      if (!mounted) return;
      setState(() {
        _stage = (_stage + 1 < widget.stages.length) ? _stage + 1 : _stage;
      });
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (AppMotion.reducedMotion(context)) {
      _pulse.stop();
    } else if (!_pulse.isAnimating) {
      _pulse.repeat();
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final stage = widget.stages.isEmpty
        ? 'Thinking…'
        : widget.stages[_stage.clamp(0, widget.stages.length - 1)];
    final bubble = Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest,
        borderRadius: const BorderRadiusDirectional.only(
          topStart: Radius.circular(18),
          topEnd: Radius.circular(18),
          bottomEnd: Radius.circular(18),
          bottomStart: Radius.circular(4),
        ),
      ),
      child: widget.text.isNotEmpty
          ? ChatMessageText(widget.text)
          : Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Semantics(
                  label: 'Assistant is thinking',
                  child: ExcludeSemantics(
                    child: _TypingDots(
                      animation: _pulse,
                      color: colors.primary,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Flexible(
                  child: AnimatedSwitcher(
                    duration: AppMotion.medium,
                    child: Text(
                      stage,
                      key: ValueKey(stage),
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ),
                ),
              ],
            ),
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Align(
        alignment: AlignmentDirectional.centerStart,
        child: widget.showAvatar
            ? Row(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  const Padding(
                    padding: EdgeInsetsDirectional.only(end: 8),
                    child: ChatAssistantAvatar(),
                  ),
                  Flexible(child: bubble),
                ],
              )
            : bubble,
      ),
    );
  }
}

/// Three dots that swell in turn. Each is offset in the loop so the pulse
/// travels along the row instead of blinking in unison.
class _TypingDots extends StatelessWidget {
  const _TypingDots({required this.animation, required this.color});

  final Animation<double> animation;
  final Color color;

  static const _dot = 7.0;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: animation,
      builder: (context, _) {
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var i = 0; i < 3; i++) ...[
              if (i > 0) const SizedBox(width: 4),
              _dotAt(i),
            ],
          ],
        );
      },
    );
  }

  Widget _dotAt(int index) {
    // Held still (mid-strength) while the controller is stopped.
    final t = animation.isAnimating ? animation.value : 0.5;
    final phase = (t - index * 0.16) % 1.0;
    final wave = (math.sin(phase * 2 * math.pi - math.pi / 2) + 1) / 2;
    return Opacity(
      opacity: 0.35 + 0.65 * wave,
      child: Transform.scale(
        scale: 0.8 + 0.3 * wave,
        child: DecoratedBox(
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          child: const SizedBox.square(dimension: _dot),
        ),
      ),
    );
  }
}

import 'dart:async';

import 'package:flutter/material.dart';

/// The assistant-side "working on it" bubble, shown while a chat turn is in
/// flight.
///
/// A book chat turn is not a fast one — the server routes the message through a
/// model and, for a question, answers it with a second call, so a reply can be
/// most of a minute away. Without this the transcript simply stops: the send
/// button greys out and nothing else moves, which reads as a broken app rather
/// than a busy one.
///
/// The copy advances on a timer for the same reason. A spinner that has said
/// the same word for forty seconds stops being reassuring; naming a later stage
/// says the wait is expected. It never rewinds and never claims to be finished.
class ChatThinkingBubble extends StatefulWidget {
  const ChatThinkingBubble({this.stages = creationThinkingStages, super.key});

  /// What the bubble says, in order, one stage every four seconds. The last
  /// entry is where it settles, so make it one that stays true.
  final List<String> stages;

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

/// The short handoff after Undo has queued its compile but before the status
/// stream has delivered the first real progress tick.
const undoRebuildThinkingStages = <String>[
  'Rebuilding your book…',
  'Laying out the updated pages…',
  'Refreshing your book files…',
];

class _ChatThinkingBubbleState extends State<ChatThinkingBubble> {
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
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final stage = widget.stages.isEmpty
        ? 'Thinking…'
        : widget.stages[_stage.clamp(0, widget.stages.length - 1)];
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 5),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: colors.surfaceContainerHighest,
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(16),
            topRight: Radius.circular(16),
            bottomLeft: Radius.circular(4),
            bottomRight: Radius.circular(16),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox.square(
              dimension: 16,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                semanticsLabel: 'Assistant is thinking',
                color: colors.primary,
              ),
            ),
            const SizedBox(width: 10),
            AnimatedSwitcher(
              duration: const Duration(milliseconds: 250),
              child: Text(
                stage,
                key: ValueKey(stage),
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

import 'package:flutter/material.dart';

import '../domain/chat_reply_target.dart';

/// Drawing a reply: the quote inside a bubble, and the strip above the composer
/// that says what the next message is attached to.
///
/// Shared by both chat surfaces — the creation chat's part files reach these
/// through the parent library, and `ProjectChatScreen` imports it directly.
/// [ChatReplyTarget] itself is a domain type; it is re-exported here so a
/// widget file only needs this one import.
export '../domain/chat_reply_target.dart';

/// The quote drawn above a sent message's own text.
class ChatQuotedMessage extends StatelessWidget {
  const ChatQuotedMessage({
    required this.target,
    required this.foreground,
    super.key,
  });

  final ChatReplyTarget target;

  /// The bubble's text colour, so the quote reads on both bubble backgrounds.
  final Color foreground;

  @override
  Widget build(BuildContext context) {
    final accent = foreground.withValues(alpha: 0.55);
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.only(left: 10),
      decoration: BoxDecoration(
        border: Border(left: BorderSide(color: accent, width: 3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            target.isUser ? 'You' : 'Assistant',
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: accent,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            target.excerpt,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: foreground.withValues(alpha: 0.75),
            ),
          ),
        ],
      ),
    );
  }
}

/// The strip above the composer naming what the next message attaches to.
///
/// One widget for both modes because they are mutually exclusive: starting an
/// edit clears the reply target and vice versa, so two strips can never stack.
class ChatComposerContextBanner extends StatelessWidget {
  const ChatComposerContextBanner.editing({required this.onCancel, super.key})
    : replyTarget = null;

  const ChatComposerContextBanner.replying({
    required ChatReplyTarget target,
    required this.onCancel,
    super.key,
  }) : replyTarget = target;

  final ChatReplyTarget? replyTarget;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final target = replyTarget;
    return Material(
      color: colors.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 6, 6, 6),
        child: Row(
          children: [
            Icon(
              target == null ? Icons.edit_outlined : Icons.reply_outlined,
              size: 18,
              color: colors.primary,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: target == null
                  ? Text(
                      'Editing message',
                      style: Theme.of(context).textTheme.labelLarge,
                    )
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          target.isUser
                              ? 'Replying to yourself'
                              : 'Replying to the assistant',
                          style: Theme.of(context).textTheme.labelLarge,
                        ),
                        Text(
                          target.excerpt,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(color: colors.onSurfaceVariant),
                        ),
                      ],
                    ),
            ),
            IconButton(
              tooltip: target == null ? 'Cancel edit' : 'Cancel reply',
              visualDensity: VisualDensity.compact,
              onPressed: onCancel,
              icon: const Icon(Icons.close, size: 18),
            ),
          ],
        ),
      ),
    );
  }
}

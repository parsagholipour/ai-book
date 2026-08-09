import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../domain/chat_reply_target.dart';

/// Drawing a reply: the quote inside a bubble, and the strip above the composer
/// that says what the next message is attached to.
///
/// Shared by both chat surfaces — the creation chat's part files reach these
/// through the parent library, and `ProjectChatScreen` imports it directly.
/// [ChatReplyTarget] itself is a domain type; it is re-exported here so a
/// widget file only needs this one import.
export '../domain/chat_reply_target.dart';

/// Keeps lazily built chat rows addressable from a reply banner.
///
/// The exact reveal offset is captured while the replied-to row is visible.
/// That fallback matters after a long scroll, when [ListView] has disposed the
/// row and its [GlobalKey] temporarily has no context.
class ChatMessageAnchorController {
  ChatMessageAnchorController({required this.debugLabel});

  final String debugLabel;
  final Map<String, GlobalKey> _keys = <String, GlobalKey>{};
  double? _rememberedOffset;

  GlobalKey keyFor(String messageId) => _keys.putIfAbsent(
    messageId,
    () => GlobalKey(debugLabel: '$debugLabel-message-$messageId'),
  );

  void remember(ChatReplyTarget target) => rememberMessage(target.messageId);

  /// Captures a row for composer contexts that only need its id, such as an
  /// edit. Replies use [remember] because they already carry a quote target.
  void rememberMessage(String messageId) {
    final renderObject = _keys[messageId]?.currentContext?.findRenderObject();
    if (renderObject == null || !renderObject.attached) {
      _rememberedOffset = null;
      return;
    }
    _rememberedOffset = RenderAbstractViewport.of(
      renderObject,
    ).getOffsetToReveal(renderObject, 0.15).offset;
  }

  void forget() => _rememberedOffset = null;

  void reset() {
    _rememberedOffset = null;
    _keys.clear();
  }

  void reveal({
    required ChatReplyTarget target,
    required ScrollController scrollController,
  }) => revealMessage(
    messageId: target.messageId,
    scrollController: scrollController,
  );

  void revealMessage({
    required String messageId,
    required ScrollController scrollController,
  }) {
    if (!scrollController.hasClients) return;
    final targetContext = _keys[messageId]?.currentContext;
    final renderObject = targetContext?.findRenderObject();
    if (targetContext != null && renderObject?.attached == true) {
      unawaited(
        Scrollable.ensureVisible(
          targetContext,
          alignment: 0.15,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOutCubic,
        ),
      );
      return;
    }
    final offset = _rememberedOffset;
    if (offset == null) return;
    final position = scrollController.position;
    unawaited(
      scrollController.animateTo(
        offset.clamp(position.minScrollExtent, position.maxScrollExtent),
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeOutCubic,
      ),
    );
  }
}

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
  const ChatComposerContextBanner.editing({
    required this.onOpen,
    required this.onCancel,
    super.key,
  }) : replyTarget = null;

  const ChatComposerContextBanner.replying({
    required ChatReplyTarget target,
    required this.onOpen,
    required this.onCancel,
    super.key,
  }) : replyTarget = target;

  final ChatReplyTarget? replyTarget;
  final VoidCallback? onOpen;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final target = replyTarget;
    return Material(
      color: colors.surfaceContainerHighest,
      child: Row(
        children: [
          Expanded(
            child: Tooltip(
              message: target == null
                  ? 'Go to edited message'
                  : 'Go to replied message',
              child: InkWell(
                onTap: onOpen,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(14, 6, 8, 6),
                  child: Row(
                    children: [
                      Icon(
                        target == null
                            ? Icons.edit_outlined
                            : Icons.reply_outlined,
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
                                    style: Theme.of(
                                      context,
                                    ).textTheme.labelLarge,
                                  ),
                                  Text(
                                    target.excerpt,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: Theme.of(context).textTheme.bodySmall
                                        ?.copyWith(
                                          color: colors.onSurfaceVariant,
                                        ),
                                  ),
                                ],
                              ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          IconButton(
            tooltip: target == null ? 'Cancel edit' : 'Cancel reply',
            visualDensity: VisualDensity.compact,
            onPressed: onCancel,
            icon: const Icon(Icons.close, size: 18),
          ),
          const SizedBox(width: 6),
        ],
      ),
    );
  }
}

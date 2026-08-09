part of 'creation_chat_screen.dart';

// Post-generation project-chat bubbles: replies, content cards, operations, typing.
// Imports and shared state live in the parent library file.

class _ProjectChatMessageBubble extends StatelessWidget {
  const _ProjectChatMessageBubble({
    required this.message,
    required this.switchingBranch,
    this.activeProjectId,
    this.onSwitchBranch,
    this.onEdit,
    this.onReply,
    this.onOpenReplanCopy,
    this.onOpenPaywall,
    this.showProposalActions = false,
    this.showCreditCost = true,
    this.onApplyProposal,
    this.onCancelProposal,
    super.key,
  });

  final MobileProjectChatMessage message;
  final bool switchingBranch;

  /// False when this turn's edit already has an operation card in the
  /// transcript: that card carries the charge (and knows whether it was
  /// refunded), so the bubble would only be repeating the number.
  final bool showCreditCost;
  final String? activeProjectId;
  final void Function(MobileProjectChatMessage message, String direction)?
  onSwitchBranch;
  final void Function(MobileProjectChatMessage message)? onEdit;
  final void Function(MobileProjectChatMessage message)? onReply;
  final ValueChanged<String>? onOpenReplanCopy;
  final void Function(MobileProjectChatMessage message)? onOpenPaywall;
  final bool showProposalActions;
  final VoidCallback? onApplyProposal;
  final VoidCallback? onCancelProposal;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isUser = message.isUser;
    final background = isUser ? colors.primary : colors.surfaceContainerHighest;
    final foreground = isUser ? colors.onPrimary : colors.onSurface;
    final contentCard = message.isAssistant ? message.contentCard : null;
    final editProposal = message.isAssistant ? message.editProposal : null;
    final creditsCharged = message.isAssistant && showCreditCost
        ? message.creditsCharged
        : null;
    final branch = message.branch;
    final timestamp = _formatChatTimestamp(message.createdAt);
    final replanCopyTargetProjectId = message.isAssistant
        ? message.replanCopyTargetProjectId
        : null;
    final showReplanCopyLink =
        replanCopyTargetProjectId != null &&
        replanCopyTargetProjectId != activeProjectId &&
        onOpenReplanCopy != null;
    final replyTo = message.replyTo;
    final startReply = onReply == null ? null : () => onReply!(message);
    final bubble = MessageHoldFeedback(
      onLongPressStart: (details) => showMessageActionsMenu(
        context: context,
        position: details.globalPosition,
        message: message.content,
        onEdit: isUser && onEdit != null ? () => onEdit!(message) : null,
        onReply: startReply,
      ),
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 5),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.82,
        ),
        decoration: BoxDecoration(
          color: background,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(16),
            topRight: const Radius.circular(16),
            bottomLeft: Radius.circular(isUser ? 16 : 4),
            bottomRight: Radius.circular(isUser ? 4 : 16),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (replyTo != null)
              ChatQuotedMessage(target: replyTo, foreground: foreground),
            Row(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Flexible(
                  child: Text(
                    message.content,
                    style: Theme.of(
                      context,
                    ).textTheme.bodyMedium?.copyWith(color: foreground),
                  ),
                ),
                // The reply no longer names its price; the badge does, and it
                // explains what credits buy when tapped.
                if (creditsCharged != null) ...[
                  const SizedBox(width: 8),
                  CreditCostBadge(
                    credits: creditsCharged,
                    foreground: foreground,
                  ),
                ],
              ],
            ),
            if (timestamp != null) ...[
              const SizedBox(height: 6),
              Text(
                timestamp,
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: foreground.withValues(alpha: 0.7),
                ),
              ),
            ],
            if (branch != null && onSwitchBranch != null) ...[
              const SizedBox(height: 8),
              BranchNavigator(
                branch: branch,
                foreground: foreground,
                switching: switchingBranch,
                onPrevious: () => onSwitchBranch!(message, 'previous'),
                onNext: () => onSwitchBranch!(message, 'next'),
              ),
            ],
            if (onOpenPaywall != null) ...[
              const SizedBox(height: 10),
              FilledButton.icon(
                onPressed: () => onOpenPaywall!(message),
                icon: const Icon(Icons.add_card_outlined),
                label: const Text('Add credits'),
              ),
            ],
            if (showReplanCopyLink) ...[
              const SizedBox(height: 10),
              ActionChip(
                avatar: const Icon(Icons.open_in_new_outlined, size: 18),
                label: const Text('Open the new book'),
                onPressed: () => onOpenReplanCopy!(replanCopyTargetProjectId),
              ),
            ],
          ],
        ),
      ),
    );
    final manualEdit = message.isAssistant ? message.manualEdit : null;
    if (contentCard == null && manualEdit == null && editProposal == null) {
      return Align(
        alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
        child: bubble,
      );
    }
    return Align(
      alignment: Alignment.centerLeft,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          bubble,
          if (contentCard != null) _ContentCardBubble(card: contentCard),
          if (editProposal != null)
            EditProposalCard(
              proposal: editProposal,
              enabled: true,
              onApply: showProposalActions ? onApplyProposal : null,
              onCancel: showProposalActions ? onCancelProposal : null,
            ),
          if (manualEdit != null) SavedExportCard(message: message),
        ],
      ),
    );
  }
}

/// Read-only book content (outline, chapter, or page) shown in the chat.
class _ContentCardBubble extends StatefulWidget {
  const _ContentCardBubble({required this.card});

  final MobileChatContentCard card;

  @override
  State<_ContentCardBubble> createState() => _ContentCardBubbleState();
}

class _ContentCardBubbleState extends State<_ContentCardBubble> {
  static const _previewLimit = 1200;
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final card = widget.card;
    final icon = switch (card.type) {
      'page' => Icons.description_outlined,
      'chapter' => Icons.bookmark_outline,
      _ => Icons.list_alt_outlined,
    };
    return Container(
      margin: const EdgeInsets.only(bottom: 5),
      padding: const EdgeInsets.all(14),
      constraints: BoxConstraints(
        maxWidth: MediaQuery.sizeOf(context).width * 0.88,
      ),
      decoration: BoxDecoration(
        color: colors.surfaceContainerLow,
        border: Border.all(color: colors.outlineVariant),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(icon, size: 18, color: colors.primary),
              const SizedBox(width: 8),
              Expanded(
                child: Text(card.title, style: theme.textTheme.titleSmall),
              ),
            ],
          ),
          for (final section in card.sections) ...[
            const SizedBox(height: 10),
            if (section.label.trim().isNotEmpty)
              Text(
                section.label,
                style: theme.textTheme.labelLarge?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            if (section.body.trim().isNotEmpty) ...[
              const SizedBox(height: 2),
              Text(
                !_expanded && section.body.length > _previewLimit
                    ? '${section.body.substring(0, _previewLimit)}…'
                    : section.body,
                style: theme.textTheme.bodyMedium,
              ),
              if (section.body.length > _previewLimit)
                TextButton(
                  onPressed: () => setState(() => _expanded = !_expanded),
                  style: TextButton.styleFrom(
                    visualDensity: VisualDensity.compact,
                    padding: EdgeInsets.zero,
                  ),
                  child: Text(_expanded ? 'Show less' : 'Read more'),
                ),
            ],
          ],
        ],
      ),
    );
  }
}

// The edit operation card lives in `project_chat_operations.dart`: the book
// chat draws the same one, which is what keeps an applied edit offering the
// same follow-ups on both surfaces.

// The assistant-side "thinking" bubble lives in `chat_thinking_bubble.dart`:
// the post-generation book chat needs the same one, and it cannot reach a
// private widget inside this library.

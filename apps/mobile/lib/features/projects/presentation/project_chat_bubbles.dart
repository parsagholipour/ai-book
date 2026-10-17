import 'package:flutter/material.dart';

import '../../../app/theme/app_theme.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/touch_target.dart';
import '../domain/chat_markdown.dart';
import '../domain/project_models.dart';
import 'branch_navigator.dart';
import 'chat_message_text.dart';
import 'chat_reply_quote.dart';
import 'credit_cost_badge.dart';
import 'edit_proposal_card.dart';
import 'message_actions_menu.dart';
import 'message_hold_feedback.dart';
import 'page_limit_unlock_row.dart';
import 'project_chat_composer.dart';
import 'saved_export_card.dart';

// The operation card and the live progress card moved to their own files; the
// creation chat imports them through here, so they stay reachable from this one.
export 'chat_book_update_row.dart';
export 'project_chat_operation_card.dart';
export 'project_chat_progress.dart';

// The book chat's message widgets: the bubbles for user and assistant turns,
// the in-flight echo, and the follow-up after a top-up.

/// A just-sent user message shown optimistically until the refreshed
/// transcript (or a failure) replaces it.
class PendingEcho {
  const PendingEcho({required this.text, this.failed = false, this.error});

  final String text;
  final bool failed;
  final String? error;
}

/// The follow-up drawn after a top-up bought from an insufficient-credits
/// reply: it confirms the balance now covers the blocked edit and offers to
/// run it, so the purchase never ends in a silent chat. Local to the screen
/// that saw the purchase — after a restart the reply's own proposal card is
/// the durable way to proceed.
class CreditsReadyBubble extends StatelessWidget {
  const CreditsReadyBubble({
    required this.onProceed,
    this.onDismiss,
    super.key,
  });

  /// Applies the blocked edit's resumable proposal. Null while another send is
  /// in flight, which draws the button disabled rather than hiding it.
  final VoidCallback? onProceed;
  final VoidCallback? onDismiss;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: colors.primaryContainer.withValues(alpha: 0.6),
            borderRadius: BorderRadius.circular(AppRadii.card),
            border: Border.all(color: colors.primary.withValues(alpha: 0.3)),
          ),
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.sm + 2),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      Icons.check_circle_outline,
                      size: 20,
                      color: colors.onPrimaryContainer,
                    ),
                    const SizedBox(width: AppSpacing.xs),
                    Flexible(
                      child: Text(
                        'You now have enough credits.',
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: colors.onPrimaryContainer,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: AppSpacing.sm),
                Wrap(
                  spacing: AppSpacing.xs,
                  runSpacing: AppSpacing.xxs,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    FilledButton.icon(
                      key: const ValueKey('credits-ready-proceed'),
                      onPressed: onProceed,
                      icon: const Icon(Icons.play_arrow_outlined, size: 18),
                      label: const Text('Proceed'),
                    ),
                    if (onDismiss != null)
                      TextButton(
                        key: const ValueKey('credits-ready-dismiss'),
                        onPressed: onDismiss,
                        child: const Text('Not now'),
                      ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The optimistic bubble for a message that is still in flight or has failed.
///
/// A failed send keeps the words the reader wrote and says, underneath them and
/// in its own card, that it did not go — with the two things they can do about
/// it. The message is never lost: Dismiss hands it back to the composer.
class PendingEchoBubble extends StatelessWidget {
  const PendingEchoBubble({
    required this.echo,
    required this.onRetry,
    required this.onDismiss,
    super.key,
  });

  final PendingEcho echo;
  final VoidCallback onRetry;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final sent = userChatBubbleColors(colors);
    return Align(
      alignment: AlignmentDirectional.centerEnd,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          mainAxisSize: MainAxisSize.min,
          children: [
            Opacity(
              opacity: echo.failed ? 0.7 : 0.92,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: sent.background,
                  borderRadius: BorderRadius.circular(AppRadii.card),
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 12,
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Flexible(
                        child: Text(
                          echo.text,
                          style: TextStyle(color: sent.foreground),
                        ),
                      ),
                      if (!echo.failed) ...[
                        const SizedBox(width: AppSpacing.xs),
                        Padding(
                          padding: const EdgeInsets.only(top: 3),
                          child: SizedBox.square(
                            dimension: 14,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: sent.foreground,
                              semanticsLabel: 'Sending',
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
            if (echo.failed) ...[
              const SizedBox(height: AppSpacing.xs),
              Semantics(
                container: true,
                liveRegion: true,
                child: Container(
                  padding: const EdgeInsets.all(AppSpacing.sm),
                  decoration: BoxDecoration(
                    color: colors.errorContainer,
                    borderRadius: BorderRadius.circular(AppRadii.control),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Icon(
                            Icons.error_outline,
                            size: 20,
                            color: colors.onErrorContainer,
                          ),
                          const SizedBox(width: AppSpacing.xs),
                          Expanded(
                            child: Text(
                              echo.error ?? 'The message could not be sent.',
                              style: theme.textTheme.bodyMedium?.copyWith(
                                color: colors.onErrorContainer,
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: AppSpacing.xs),
                      Wrap(
                        spacing: AppSpacing.xs,
                        runSpacing: AppSpacing.xxs,
                        children: [
                          TextButton(
                            onPressed: onDismiss,
                            style: TextButton.styleFrom(
                              foregroundColor: colors.onErrorContainer,
                            ),
                            child: const Text('Dismiss'),
                          ),
                          FilledButton.icon(
                            onPressed: onRetry,
                            icon: const Icon(Icons.refresh, size: 18),
                            label: const Text('Retry'),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class ProjectMessageBubble extends StatelessWidget {
  const ProjectMessageBubble({
    required this.message,
    required this.editController,
    required this.editing,
    required this.submittingEdit,
    required this.switchingBranch,
    required this.onSwitchBranch,
    required this.showProposalActions,
    required this.sending,
    this.showCreditCost = true,
    this.applyingProposal = false,
    this.proposalOutcome,
    this.onReply,
    this.onReport,
    this.onStartEdit,
    this.onCancelEdit,
    this.onSubmitEdit,
    this.onOpenPaywall,
    this.onOpenReplanCopy,
    this.onApplyProposal,
    this.onCancelProposal,
    this.bookUpdate,
    super.key,
  });

  final MobileProjectChatMessage message;
  final TextEditingController editController;
  final bool editing;
  final bool submittingEdit;
  final bool switchingBranch;
  final bool showProposalActions;
  final bool sending;

  /// This message's proposal is the one being applied right now.
  final bool applyingProposal;

  /// How this message's proposal ended in this session, if it did.
  final EditProposalOutcome? proposalOutcome;

  /// False when this turn's edit already has an operation card underneath it:
  /// that card carries the charge (and knows whether it was refunded), so the
  /// bubble would only be repeating the number.
  final bool showCreditCost;
  final ValueChanged<String> onSwitchBranch;

  /// Quotes this message in the composer. Null while the message is being
  /// edited, since the two modes are mutually exclusive.
  final VoidCallback? onReply;

  /// Reports this AI reply for review. Null on the reader's own messages.
  final VoidCallback? onReport;
  final VoidCallback? onStartEdit;
  final VoidCallback? onCancelEdit;
  final VoidCallback? onSubmitEdit;
  final VoidCallback? onOpenPaywall;
  final VoidCallback? onOpenReplanCopy;
  final VoidCallback? onApplyProposal;
  final VoidCallback? onCancelProposal;

  /// The book this reply rebuilt, drawn at the foot of the reply
  /// (`ChatBookUpdateRow`). Null on every other message.
  final Widget? bookUpdate;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isUser = message.isUser;
    final branch = message.branch;
    final manualEdit = message.isAssistant ? message.manualEdit : null;
    final contentCard = message.isAssistant ? message.contentCard : null;
    final editProposal = message.isAssistant ? message.editProposal : null;
    final creditsCharged = message.isAssistant && showCreditCost
        ? message.creditsCharged
        : null;
    final sent = userChatBubbleColors(colors);
    final background = editing
        ? colors.surfaceContainerHighest
        : isUser
        ? sent.background
        : colors.surfaceContainerHighest;
    final foreground = editing
        ? colors.onSurface
        : isUser
        ? sent.foreground
        : colors.onSurface;
    final replyTo = message.replyTo;
    final startReply = onReply == null || editing ? null : () => onReply!();
    final bubble = MessageHoldFeedback(
      onLongPressStart: (details) => showMessageActionsMenu(
        context: context,
        position: details.globalPosition,
        message: chatBubbleCopyText(message.content, role: message.role),
        onEdit: isUser ? onStartEdit : null,
        onReply: startReply,
        onReport: isUser || editing ? null : onReport,
      ),
      // The bubble's padding is where a near miss on its small controls
      // lands (see [TouchTarget]).
      child: TouchTargetRegion(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: background,
              borderRadius: BorderRadius.circular(AppRadii.card),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (replyTo != null && !editing)
                    ChatQuotedMessage(target: replyTo, foreground: foreground),
                  if (editing)
                    InlineMessageEditor(
                      controller: editController,
                      submitting: submittingEdit,
                      onCancel: onCancelEdit,
                      onSubmit: onSubmitEdit,
                    )
                  else
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Flexible(
                          child: ChatMessageText.forRole(
                            message.content,
                            role: message.role,
                            style: TextStyle(color: foreground),
                          ),
                        ),
                        if (creditsCharged != null) ...[
                          const SizedBox(width: 8),
                          CreditCostBadge(
                            credits: creditsCharged,
                            foreground: foreground,
                          ),
                        ],
                        if (isUser && onStartEdit != null) ...[
                          const SizedBox(width: 4),
                          // Drawn in its small box, touched across 48dp.
                          TouchTarget(
                            child: IconButton(
                              tooltip: 'Edit message',
                              visualDensity: VisualDensity.compact,
                              constraints: const BoxConstraints(
                                minWidth: 32,
                                minHeight: 32,
                              ),
                              padding: EdgeInsets.zero,
                              onPressed: onStartEdit,
                              icon: Icon(
                                Icons.edit_outlined,
                                size: 18,
                                color: foreground,
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                  if (branch != null) ...[
                    const SizedBox(height: 8),
                    BranchNavigator(
                      branch: branch,
                      foreground: foreground,
                      switching: switchingBranch,
                      onPrevious: () => onSwitchBranch('previous'),
                      onNext: () => onSwitchBranch('next'),
                    ),
                  ],
                  if (onOpenPaywall != null) ...[
                    const SizedBox(height: 10),
                    _AddCreditsRow(
                      credits: message.insufficientCreditsRequired,
                      plans: message.asksForPlan,
                      onPressed: onOpenPaywall!,
                    ),
                  ],
                  if (message.isAssistant && message.pageLimit != null) ...[
                    const SizedBox(height: 10),
                    PageLimitUnlockRow(
                      limit: message.pageLimit!,
                      projectId: message.projectId,
                    ),
                  ],
                  if (onOpenReplanCopy != null) ...[
                    const SizedBox(height: 10),
                    ActionChip(
                      avatar: const Icon(Icons.open_in_new_outlined, size: 18),
                      label: const Text('Open the new book'),
                      onPressed: onOpenReplanCopy,
                    ),
                  ],
                  if (bookUpdate != null && !editing) bookUpdate!,
                ],
              ),
            ),
          ),
        ),
      ),
    );
    final extras = <Widget>[
      if (contentCard != null)
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: StandaloneContentCard(card: contentCard),
        ),
      if (editProposal != null)
        EditProposalCard(
          proposal: editProposal,
          enabled: !sending,
          applying: applyingProposal,
          outcome: proposalOutcome,
          onApply: showProposalActions ? onApplyProposal : null,
          onCancel: showProposalActions ? onCancelProposal : null,
        ),
      if (manualEdit != null) SavedExportCard(message: message),
    ];
    return Align(
      alignment: isUser
          ? AlignmentDirectional.centerEnd
          : AlignmentDirectional.centerStart,
      child: extras.isEmpty
          ? bubble
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [bubble, ...extras],
            ),
    );
  }
}

/// The way forward from a reply that could not run an edit for want of credits.
///
/// The button is the whole point of the block; the amount, when the server
/// named one, rides beside it as a badge rather than as a sentence.
class _AddCreditsRow extends StatelessWidget {
  const _AddCreditsRow({
    required this.credits,
    required this.onPressed,
    this.plans = false,
  });

  final int? credits;
  final VoidCallback onPressed;

  /// The reply is unlocked by a plan, not credits: say so on the button.
  final bool plans;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: AppSpacing.xs,
      runSpacing: AppSpacing.xs,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        FilledButton.icon(
          onPressed: onPressed,
          icon: Icon(
            plans ? Icons.workspace_premium_outlined : Icons.add_card_outlined,
          ),
          label: Text(plans ? 'See plans' : 'Add credits'),
        ),
        if (credits != null && !plans)
          CreditCostBadge(credits: credits!, kind: CreditCostKind.quoted),
      ],
    );
  }
}

class StandaloneContentCard extends StatelessWidget {
  const StandaloneContentCard({required this.card, super.key});

  final MobileChatContentCard card;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      constraints: BoxConstraints(
        maxWidth: MediaQuery.sizeOf(context).width * 0.86,
      ),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: colors.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: colors.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            card.title,
            style: Theme.of(
              context,
            ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
          ),
          for (final section in card.sections.take(4)) ...[
            const SizedBox(height: 8),
            if (section.label.trim().isNotEmpty)
              Text(
                section.label,
                style: Theme.of(context).textTheme.labelMedium,
              ),
            Text(section.body),
          ],
        ],
      ),
    );
  }
}

import 'package:flutter/material.dart';

import '../../../app/theme/app_theme.dart';
import '../../../shared/ui/motion.dart';

import '../../../shared/ui/feedback/app_feedback.dart';
import '../domain/project_models.dart';
import 'branch_navigator.dart';
import 'chat_reply_quote.dart';
import 'credit_cost_badge.dart';
import 'edit_proposal_card.dart';
import 'message_actions_menu.dart';
import 'message_hold_feedback.dart';
import 'progress_step_row.dart';
import 'project_chat_composer.dart';
import 'saved_export_card.dart';

// The book chat's message widgets: the intro and empty states, the bubbles for
// user and assistant turns, the in-flight echo, and the running/failed edit
// operation cards.

/// A just-sent user message shown optimistically until the refreshed
/// transcript (or a failure) replaces it.
class PendingEcho {
  const PendingEcho({required this.text, this.failed = false, this.error});

  final String text;
  final bool failed;
  final String? error;
}

class ChatIntroCard extends StatelessWidget {
  const ChatIntroCard({this.project, super.key});

  final MobileProjectDetail? project;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final status = project?.status;
    final hint = status == 'plan_ready'
        ? 'Ask questions or request plan changes. Plan edits use credits.'
        : status == 'complete'
        ? 'Ask questions or request edits to the latest generated book. Real edits show a credit price and need your confirmation before they run.'
        : 'You can ask questions now. Editing unlocks after planning or generation reaches the right stage.';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.auto_fix_high_outlined, color: colors.primary),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Edit in chat',
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(hint),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
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
    final colors = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: colors.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(18),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'You now have enough credits.',
                  style: TextStyle(color: colors.onSurface),
                ),
                const SizedBox(height: 10),
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    FilledButton.icon(
                      key: const ValueKey('credits-ready-proceed'),
                      onPressed: onProceed,
                      icon: const Icon(Icons.play_arrow_outlined, size: 18),
                      label: const Text('Proceed'),
                    ),
                    if (onDismiss != null) ...[
                      const SizedBox(width: 8),
                      TextButton(
                        key: const ValueKey('credits-ready-dismiss'),
                        onPressed: onDismiss,
                        child: const Text('Not now'),
                      ),
                    ],
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

class EmptyProjectChat extends StatelessWidget {
  const EmptyProjectChat({super.key});

  @override
  Widget build(BuildContext context) {
    return const AppEmptyState(
      title: 'No messages yet',
      message:
          'Ask “What should I improve?” or “Rewrite page 3 to sound warmer.”',
      icon: Icons.chat_bubble_outline,
    );
  }
}

class OperationBubble extends StatelessWidget {
  const OperationBubble({
    required this.operation,
    required this.retrying,
    this.undoing = false,
    this.onRetry,
    this.onUndo,
    this.onViewPlan,
    this.onOpenBook,
    this.onSeeChanges,
    super.key,
  });

  final MobileBookEditOperation operation;
  final bool retrying;
  final bool undoing;
  final VoidCallback? onRetry;
  final VoidCallback? onUndo;
  final VoidCallback? onViewPlan;

  /// Opens the book at the first page this edit touched.
  final VoidCallback? onOpenBook;

  /// Opens the before/after diff of what this edit did.
  final VoidCallback? onSeeChanges;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final waitingForRetry = operation.isAutomaticRetryPending;
    final failed = operation.isFailed && !waitingForRetry;
    final applied = operation.isApplied && !failed;
    return Card(
      color: failed ? colors.errorContainer : colors.secondaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                if (failed)
                  Icon(Icons.error_outline, color: colors.onErrorContainer)
                else if (applied)
                  Icon(Icons.check_circle_outline, color: colors.primary)
                else
                  const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    failed && operation.isPlanRevision
                        ? 'Plan revision failed. Your current plan is unchanged.'
                        : operation.displayAction,
                  ),
                ),
                if (operation.creditsCharged > 0) ...[
                  const SizedBox(width: 8),
                  CreditCostBadge(
                    credits: operation.creditsCharged,
                    // A failure costs nothing, and a bare price reads as a
                    // charge that stood — the refunded badge says otherwise.
                    kind: operation.creditsRefunded
                        ? CreditCostKind.refunded
                        : CreditCostKind.charged,
                    foreground: failed ? colors.onErrorContainer : null,
                  ),
                ],
              ],
            ),
            if (failed ||
                onUndo != null ||
                onOpenBook != null ||
                onSeeChanges != null) ...[
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 4,
                children: [
                  if (onOpenBook != null)
                    TextButton.icon(
                      onPressed: onOpenBook,
                      icon: const Icon(Icons.menu_book_outlined),
                      label: const Text('Open book'),
                    ),
                  if (onSeeChanges != null)
                    TextButton.icon(
                      onPressed: onSeeChanges,
                      icon: const Icon(Icons.difference_outlined),
                      label: const Text('See changes'),
                    ),
                  if (onRetry != null)
                    FilledButton.tonalIcon(
                      onPressed: retrying ? null : onRetry,
                      icon: retrying
                          ? const SizedBox.square(
                              dimension: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : Icon(
                              operation.retryAvailable
                                  ? Icons.refresh
                                  : Icons.edit_outlined,
                            ),
                      label: Text(
                        operation.retryAvailable
                            ? operation.isPlanRevision
                                  ? 'Retry revision'
                                  : 'Retry update'
                            : 'Edit request',
                      ),
                    ),
                  if (onUndo != null)
                    TextButton.icon(
                      onPressed: undoing ? null : onUndo,
                      icon: undoing
                          ? const SizedBox.square(
                              dimension: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.undo),
                      label: const Text('Undo'),
                    ),
                  if (onViewPlan != null)
                    TextButton.icon(
                      onPressed: onViewPlan,
                      icon: const Icon(Icons.article_outlined),
                      label: const Text('View current plan'),
                    ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// The optimistic bubble for a message that is still in flight or has failed.
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
    final colors = Theme.of(context).colorScheme;
    final sent = userChatBubbleColors(colors);
    final background = echo.failed ? colors.errorContainer : sent.background;
    final foreground = echo.failed
        ? colors.onErrorContainer
        : sent.foreground;
    return Align(
      alignment: Alignment.centerRight,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: background,
            borderRadius: BorderRadius.circular(18),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Flexible(
                      child: Text(
                        echo.text,
                        style: TextStyle(color: foreground),
                      ),
                    ),
                    if (!echo.failed) ...[
                      const SizedBox(width: 8),
                      SizedBox.square(
                        dimension: 14,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: foreground,
                        ),
                      ),
                    ],
                  ],
                ),
                if (echo.failed) ...[
                  const SizedBox(height: 6),
                  Text(
                    echo.error ?? 'The message could not be sent.',
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall?.copyWith(color: foreground),
                  ),
                  const SizedBox(height: 4),
                  Wrap(
                    spacing: 4,
                    children: [
                      TextButton(
                        onPressed: onDismiss,
                        child: Text(
                          'Dismiss',
                          style: TextStyle(color: foreground),
                        ),
                      ),
                      FilledButton.tonalIcon(
                        onPressed: onRetry,
                        icon: const Icon(Icons.refresh, size: 18),
                        label: const Text('Retry'),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
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
    this.onReply,
    this.onStartEdit,
    this.onCancelEdit,
    this.onSubmitEdit,
    this.onOpenPaywall,
    this.onOpenReplanCopy,
    this.onApplyProposal,
    this.onCancelProposal,
    super.key,
  });

  final MobileProjectChatMessage message;
  final TextEditingController editController;
  final bool editing;
  final bool submittingEdit;
  final bool switchingBranch;
  final bool showProposalActions;
  final bool sending;

  /// False when this turn's edit already has an operation card underneath it:
  /// that card carries the charge (and knows whether it was refunded), so the
  /// bubble would only be repeating the number.
  final bool showCreditCost;
  final ValueChanged<String> onSwitchBranch;

  /// Quotes this message in the composer. Null while the message is being
  /// edited, since the two modes are mutually exclusive.
  final VoidCallback? onReply;
  final VoidCallback? onStartEdit;
  final VoidCallback? onCancelEdit;
  final VoidCallback? onSubmitEdit;
  final VoidCallback? onOpenPaywall;
  final VoidCallback? onOpenReplanCopy;
  final VoidCallback? onApplyProposal;
  final VoidCallback? onCancelProposal;

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
        message: message.content,
        onEdit: isUser ? onStartEdit : null,
        onReply: startReply,
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: background,
            borderRadius: BorderRadius.circular(18),
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
                        child: Text(
                          message.content,
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
                        IconButton(
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
                  FilledButton.icon(
                    onPressed: onOpenPaywall,
                    icon: const Icon(Icons.add_card_outlined),
                    label: const Text('Add credits'),
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
              ],
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
          onApply: showProposalActions ? onApplyProposal : null,
          onCancel: showProposalActions ? onCancelProposal : null,
        ),
      if (manualEdit != null) SavedExportCard(message: message),
    ];
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
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

/// Live progress for the edit that is running right now.
///
/// Applying a proposal hands the work to the worker, which can take a while.
/// Without this the chat went quiet: a message appeared and nothing moved
/// again until the user thought to pull-to-refresh. This card is driven by the
/// project status stream, so it advances on its own and says what is happening.
class ChatOperationProgressCard extends StatefulWidget {
  const ChatOperationProgressCard({required this.status, super.key});

  final MobileProjectStatus status;

  @override
  State<ChatOperationProgressCard> createState() =>
      _ChatOperationProgressCardState();
}

class _ChatOperationProgressCardState extends State<ChatOperationProgressCard> {
  /// The highest percent this card has drawn for the current piece of work.
  ///
  /// The server's number climbs on its own, but a reconnecting status stream
  /// can deliver a stale tick, and a bar that animates backwards reads as work
  /// being undone. Reset when the project changes phase, because each phase
  /// numbers itself from its own start — an edit that follows a finished book
  /// begins near zero again. Held outside setState: it is resolved in build.
  int _shownPercent = 0;
  String? _shownStatus;

  int _monotonicPercent(String phase, int next) {
    if (phase != _shownStatus) {
      _shownStatus = phase;
      _shownPercent = next;
      return _shownPercent;
    }
    if (next > _shownPercent) {
      _shownPercent = next;
    }
    return _shownPercent;
  }

  @override
  Widget build(BuildContext context) {
    final status = widget.status;
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    // The step list's own number when there is one: it is what the bar sits
    // next to, and the two must never read differently.
    final steps = _liveSteps(status);
    final progress = _monotonicPercent(
      status.status,
      (status.editProgress?.percent ??
              status.generationProgress?.percent ??
              status.planningProgress?.percent ??
              status.progressPercent)
          .clamp(0, 100)
          .toInt(),
    );
    final pages = status.pageProgress;
    // During an edit that count is the whole book's, which says nothing about
    // the handful of pages being rewritten and reads as though the edit is
    // rewriting everything.
    final showPages =
        status.status != 'editing' &&
        pages.target > 0 &&
        pages.completed <= pages.target;

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: colors.primaryContainer.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: colors.primary.withValues(alpha: 0.25)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              SizedBox.square(
                dimension: 16,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: colors.onPrimaryContainer,
                  semanticsLabel: 'Working on your book',
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: AppSwitcher(
                  child: Text(
                    status.currentAction,
                    key: ValueKey(status.currentAction),
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: colors.onPrimaryContainer,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              AppAnimatedCount(
                value: progress,
                style: theme.textTheme.labelMedium?.copyWith(
                  color: colors.onPrimaryContainer,
                ),
                builder: (value) => '$value%',
              ),
            ],
          ),
          const SizedBox(height: 10),
          ClipRRect(
            borderRadius: BorderRadius.circular(999),
            child: AppAnimatedProgressBar(
              value: progress / 100,
              semanticLabel: status.currentAction,
            ),
          ),
          if (steps.isNotEmpty) ...[
            const SizedBox(height: 10),
            // With the detail line: an edit's steps carry counts ("3 of 7
            // pages") that are the only thing moving while one long step runs.
            for (final step in steps)
              ProgressStepRow(step: step, showDetail: true),
          ],
          if (showPages) ...[
            const SizedBox(height: 8),
            Text(
              '${pages.completed} of ${pages.target} pages',
              style: theme.textTheme.labelSmall?.copyWith(
                color: colors.onPrimaryContainer.withValues(alpha: 0.8),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// The milestones for whatever the book is doing right now.
///
/// One list rather than three branches: an edit, a plan revision and a
/// continuation all reach this card, they are never live at the same time, and
/// they all arrive as the same step shape.
List<MobileProjectStatusStep> _liveSteps(MobileProjectStatus status) {
  final steps =
      status.editProgress?.steps ??
      status.generationProgress?.steps ??
      status.planningProgress?.steps;
  return steps ?? const <MobileProjectStatusStep>[];
}

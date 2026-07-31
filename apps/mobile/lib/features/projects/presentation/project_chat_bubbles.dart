import 'package:flutter/material.dart';

import '../../../shared/ui/motion.dart';

import '../../../shared/ui/feedback/app_feedback.dart';
import '../domain/project_models.dart';
import 'branch_navigator.dart';
import 'edit_proposal_card.dart';
import 'message_actions_menu.dart';
import 'message_hold_feedback.dart';
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
                if (operation.creditsCharged > 0)
                  Text(
                    operation.creditsRefunded
                        // A failure costs nothing. Printing the price on its own
                        // reads as a charge that stood.
                        ? '${operation.creditsCharged} credits refunded'
                        : '${operation.creditsCharged} credits',
                  ),
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
    final background = echo.failed ? colors.errorContainer : colors.primary;
    final foreground = echo.failed ? colors.onErrorContainer : colors.onPrimary;
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
  final ValueChanged<String> onSwitchBranch;
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
    final background = editing
        ? colors.surfaceContainerHighest
        : isUser
        ? colors.primary
        : colors.surfaceContainerHighest;
    final foreground = editing
        ? colors.onSurface
        : isUser
        ? colors.onPrimary
        : colors.onSurface;
    final bubble = MessageHoldFeedback(
      onLongPressStart: (details) => showMessageActionsMenu(
        context: context,
        position: details.globalPosition,
        message: message.content,
        onEdit: isUser ? onStartEdit : null,
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
class ChatOperationProgressCard extends StatelessWidget {
  const ChatOperationProgressCard({required this.status, super.key});

  final MobileProjectStatus status;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final progress = status.progressPercent.clamp(0, 100);
    final pages = status.pageProgress;
    final showPages = pages.target > 0 && pages.completed <= pages.target;

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
                child: Text(
                  status.currentAction,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: colors.onPrimaryContainer,
                    fontWeight: FontWeight.w600,
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

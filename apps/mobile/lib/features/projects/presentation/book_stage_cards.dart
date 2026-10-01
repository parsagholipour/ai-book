import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../domain/project_models.dart';

// The two cards the book page draws for a book that is not simply fine: one
// that stopped, and one that finished with things worth a second look. Both used
// to be the loudest thing on the page — a checklist with an error tacked onto
// the end, and a wall of quoted concerns — and both are now a headline, one
// honest sentence, and the action.

/// A book whose writing stopped and will not resume on its own.
///
/// It leads with what happened, says what is safe, and puts the retry where the
/// thumb already is. The step list the running card draws is deliberately not
/// here: every step above the failure is ticked, and a column of ticks over a
/// failure reads as good news.
class BookStoppedCard extends StatelessWidget {
  const BookStoppedCard({
    required this.status,
    required this.busyAction,
    required this.hasPlan,
    this.onResume,
    this.onAskInChat,
    super.key,
  });

  final MobileProjectStatus status;
  final String? busyAction;

  /// Whether a plan exists: a book that stopped before it has one stopped while
  /// planning, and "writing" would be the wrong word for it.
  final bool hasPlan;
  final Future<void> Function()? onResume;
  final VoidCallback? onAskInChat;

  /// The step the server says is stuck, else the one it was on.
  static MobileProjectStatusStep? stoppedStep(MobileProjectStatus status) {
    for (final step in status.steps) {
      if (step.isFailed) return step;
    }
    for (final step in status.steps) {
      if (step.isActive) return step;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final completed = status.pageProgress.completed;
    final target = status.pageProgress.target;
    final message = status.failureMessage?.trim().isNotEmpty == true
        ? status.failureMessage!.trim()
        : status.effectiveAction;
    final step = stoppedStep(status);
    final resuming = busyAction == 'resume';
    final quote = status.recoveryQuote;

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ExcludeSemantics(
                child: Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(
                    color: colors.errorContainer,
                    borderRadius: BorderRadius.circular(AppRadii.control),
                  ),
                  child: Icon(
                    Icons.error_outline,
                    color: colors.onErrorContainer,
                  ),
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Semantics(
                      header: true,
                      child: Text(
                        hasPlan ? 'Writing stopped' : 'Planning stopped',
                        style: theme.textTheme.titleLarge?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                    const SizedBox(height: AppSpacing.xxs),
                    Text(
                      completed > 0
                          ? 'What is written so far is saved.'
                          : 'Nothing is lost. You can pick up where it stopped.',
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          DecoratedBox(
            decoration: BoxDecoration(
              color: colors.surfaceContainerHigh,
              borderRadius: BorderRadius.circular(AppRadii.control),
            ),
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.sm),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'What happened',
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: colors.onSurfaceVariant,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.xxs),
                  Text(message, style: theme.textTheme.bodyMedium),
                  if (step != null) ...[
                    const SizedBox(height: AppSpacing.xs),
                    Text(
                      [
                        'Stopped at: ${step.label}',
                        if (step.detail?.trim().isNotEmpty == true)
                          step.detail!.trim(),
                      ].join(' · '),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
          if (target > 0) ...[
            const SizedBox(height: AppSpacing.md),
            // Not the animated bar: nothing is moving, and a bar that shimmers
            // over a stopped book says the opposite.
            Semantics(
              label: '$completed of $target pages saved',
              child: ExcludeSemantics(
                child: LinearProgressIndicator(
                  value: (completed / target).clamp(0.0, 1.0),
                  minHeight: 6,
                ),
              ),
            ),
            const SizedBox(height: AppSpacing.xs),
            Text(
              '$completed of $target pages saved',
              style: theme.textTheme.labelMedium?.copyWith(
                color: colors.onSurfaceVariant,
              ),
            ),
          ],
          const SizedBox(height: AppSpacing.md),
          if (onResume != null)
            AppButton.primary(
              label: quote?.requiresConfirmation == false
                  ? 'Retry plan · ${quote!.credits} credits'
                  : 'Retry generation',
              onPressed: resuming ? null : () => onResume!(),
              loading: resuming,
              loadingLabel: 'Retrying generation',
              leading: const Icon(Icons.replay_outlined),
              expanded: true,
            ),
          if (onAskInChat != null) ...[
            if (onResume != null) const SizedBox(height: AppSpacing.xs),
            onResume == null
                ? AppButton.primary(
                    label: 'Ask in chat',
                    onPressed: onAskInChat,
                    leading: const Icon(Icons.chat_bubble_outline),
                    expanded: true,
                  )
                : AppButton.text(
                    label: 'Ask in chat instead',
                    onPressed: onAskInChat,
                    leading: const Icon(Icons.chat_bubble_outline),
                  ),
          ],
        ],
      ),
    );
  }
}

/// What the quality check found, folded down to a line.
///
/// The concerns are the model reviewer's opinions and the writer's own to
/// weigh, so they stay off the top of a book that is otherwise done: a count
/// and a way in. A book the checks *blocked* is different — there is something
/// to fix — so it opens already unfolded.
class BookQualityNotice extends StatefulWidget {
  const BookQualityNotice({
    required this.quality,
    required this.onOpenPage,
    required this.onReview,
    required this.onRequestRegeneration,
    super.key,
  });

  final MobileProjectQuality quality;

  /// Opens Edit Mode on one page of the book.
  final void Function(int pageIndex) onOpenPage;

  /// The notice's own action: into Edit Mode at the first flagged page.
  final VoidCallback onReview;
  final VoidCallback onRequestRegeneration;

  @override
  State<BookQualityNotice> createState() => _BookQualityNoticeState();
}

class _BookQualityNoticeState extends State<BookQualityNotice> {
  static const _shown = 8;
  late bool _open = widget.quality.isBlocked;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final quality = widget.quality;
    final blocked = quality.isBlocked;
    final tone = appToneColors(
      context,
      blocked ? AppTone.error : AppTone.warning,
    );
    final count = quality.issues.length;
    final title = blocked
        ? 'Quality checks flagged pages'
        : 'Review recommended';
    final subtitle = count == 0
        ? (blocked
              ? 'Some pages need fixing before the book is final.'
              : 'A few passages may be worth another look.')
        : blocked
        ? (count == 1 ? '1 issue to fix' : '$count issues to fix')
        : (count == 1
              ? '1 note on the writing'
              : '$count notes on the writing');
    final duration = AppMotion.reducedMotion(context)
        ? Duration.zero
        : AppMotion.medium;
    void toggle() {
      AppHaptics.selection();
      setState(() => _open = !_open);
    }

    return Card(
      clipBehavior: Clip.antiAlias,
      child: DecoratedBox(
        decoration: BoxDecoration(
          border: BorderDirectional(
            start: BorderSide(color: tone.accent, width: 4),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _header(
              context,
              toggle: Semantics(
                container: true,
                button: true,
                expanded: _open,
                label: '$title. $subtitle',
                onTap: toggle,
                child: ExcludeSemantics(
                  child: InkWell(
                    onTap: toggle,
                    child: Padding(
                      padding: const EdgeInsetsDirectional.fromSTEB(
                        AppSpacing.md,
                        AppSpacing.sm,
                        AppSpacing.xs,
                        AppSpacing.sm,
                      ),
                      child: Row(
                        children: [
                          Icon(
                            blocked
                                ? Icons.gpp_bad_outlined
                                : Icons.rate_review_outlined,
                            color: tone.accent,
                          ),
                          const SizedBox(width: AppSpacing.sm),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  title,
                                  style: theme.textTheme.titleSmall?.copyWith(
                                    fontWeight: FontWeight.w800,
                                  ),
                                ),
                                Text(
                                  subtitle,
                                  style: theme.textTheme.bodySmall?.copyWith(
                                    color: colors.onSurfaceVariant,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          AnimatedRotation(
                            turns: _open ? 0.5 : 0,
                            duration: duration,
                            child: Icon(
                              Icons.expand_more,
                              color: colors.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
              review: AppButton.text(
                label: 'Review',
                onPressed: widget.onReview,
              ),
            ),
            AnimatedSize(
              duration: duration,
              curve: AppMotion.enter,
              alignment: Alignment.topCenter,
              child: _open
                  ? _details(context)
                  : const SizedBox(width: double.infinity),
            ),
          ],
        ),
      ),
    );
  }

  /// The fold's title row and its one action. Beside each other on a phone; the
  /// action drops beneath at larger text, where the two together leave the
  /// title a sliver and it breaks mid-word.
  Widget _header(
    BuildContext context, {
    required Widget toggle,
    required Widget review,
  }) {
    final stacked = MediaQuery.textScalerOf(context).scale(1) >= 1.3;
    final action = Padding(
      padding: const EdgeInsetsDirectional.only(end: AppSpacing.xs),
      child: review,
    );
    if (stacked) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          toggle,
          Align(alignment: AlignmentDirectional.centerEnd, child: action),
        ],
      );
    }
    return Row(
      children: [
        Expanded(child: toggle),
        action,
      ],
    );
  }

  Widget _details(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final quality = widget.quality;
    final issues = quality.issues.take(_shown).toList();
    final more = quality.issues.length - issues.length;
    return Padding(
      padding: const EdgeInsetsDirectional.fromSTEB(
        AppSpacing.md,
        0,
        AppSpacing.md,
        AppSpacing.md,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            quality.isBlocked
                ? 'Fix these in Edit Mode, then save to run the checks again. '
                      'Your files stay available meanwhile.'
                : 'The book is ready to read and share. These are worth a '
                      'look if you want to polish it.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: colors.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
          for (final issue in issues)
            InkWell(
              borderRadius: BorderRadius.circular(AppRadii.compact),
              onTap: issue.affectedPageIndexes.isEmpty
                  ? null
                  : () => widget.onOpenPage(issue.affectedPageIndexes.first),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  vertical: AppSpacing.xs,
                  horizontal: AppSpacing.xxs,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      issue.message,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      issue.guidance,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                    if (issue.affectedPageIndexes.isNotEmpty) ...[
                      const SizedBox(height: AppSpacing.xxs),
                      Text(
                        'Pages ${issue.affectedPageIndexes.join(', ')} · Open Edit Mode',
                        style: theme.textTheme.labelMedium?.copyWith(
                          color: colors.primary,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          if (more > 0)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.xxs),
              child: Text(
                more == 1 ? 'And 1 more note.' : 'And $more more notes.',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            ),
          const SizedBox(height: AppSpacing.sm),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: AppButton.outlined(
              onPressed: widget.onRequestRegeneration,
              leading: const Icon(Icons.auto_fix_high_outlined),
              label: 'Request regeneration',
            ),
          ),
        ],
      ),
    );
  }
}

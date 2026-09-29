import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/project_models.dart';
import 'credit_cost_badge.dart';
import 'edit_kind_presentation.dart';
import 'plan_build_progress.dart';

/// The card an edit leaves in the transcript, from the moment it is queued to
/// long after it finished.
///
/// Three looks, each deliberate: working (the sparkle and the live progress),
/// done (a quiet check, with the follow-ups a finished edit offers), and failed
/// (the reason, what was refunded, and the way back). It never floods the whole
/// card in an alarm colour — a failed edit is something to fix, not a wall.
/// Tighter than a text button's default, so the three follow-ups of a finished
/// edit (Open book, See changes, Undo) sit on one line at phone width. The
/// height stays at the 48dp target.
final _followUpStyle = TextButton.styleFrom(
  padding: const EdgeInsets.symmetric(horizontal: 10),
  minimumSize: const Size(48, 48),
);

class OperationBubble extends StatelessWidget {
  const OperationBubble({
    required this.operation,
    required this.retrying,
    this.undoing = false,
    this.redoing = false,
    this.rebuilding = false,
    this.liveProgress,
    this.onRetry,
    this.onUndo,
    this.onRedo,
    this.onViewPlan,
    this.onOpenBook,
    this.onSeeChanges,
    super.key,
  });

  final MobileBookEditOperation operation;
  final bool retrying;
  final bool undoing;
  final bool redoing;

  /// Applied, but the free recompile has not published yet.
  final bool rebuilding;

  /// Live bar, percent and steps while this edit is still running.
  final Widget? liveProgress;
  final VoidCallback? onRetry;
  final VoidCallback? onUndo;
  final VoidCallback? onRedo;
  final VoidCallback? onViewPlan;

  /// Opens the book at the first page this edit touched.
  final VoidCallback? onOpenBook;

  /// Opens the before/after diff of what this edit did.
  final VoidCallback? onSeeChanges;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final waitingForRetry = operation.isAutomaticRetryPending;
    final failed = operation.isFailed && !waitingForRetry;
    final applied = operation.isApplied && !failed && !rebuilding;
    final running = !failed && !applied;
    final style = editKindStyle(operation.kind);
    final pages = pageChipLabel(operationPageNumbers(operation));
    final meta = [style.label, if (pages.isNotEmpty) pages].join(' · ');
    final title = failed && operation.isPlanRevision
        ? 'Plan revision failed. Your current plan is unchanged.'
        : operation.displayAction;

    final background = running
        ? colors.primaryContainer.withValues(alpha: 0.4)
        : colors.surfaceContainerLowest;
    final border = failed
        ? colors.error.withValues(alpha: 0.45)
        : running
        ? colors.primary.withValues(alpha: 0.3)
        : colors.outlineVariant;

    final hasActions =
        failed ||
        onUndo != null ||
        onRedo != null ||
        onOpenBook != null ||
        onSeeChanges != null;

    return Container(
      padding: const EdgeInsets.all(AppSpacing.sm + 2),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(AppRadii.card),
        border: Border.all(color: border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _StatusTile(running: running, failed: failed),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                        height: 1.3,
                      ),
                    ),
                    if (meta.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Row(
                        children: [
                          Icon(
                            style.icon,
                            size: 14,
                            color: colors.onSurfaceVariant,
                          ),
                          const SizedBox(width: 4),
                          Flexible(
                            child: Text(
                              meta,
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: colors.onSurfaceVariant,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
              if (operation.creditsCharged > 0) ...[
                const SizedBox(width: AppSpacing.xs),
                _CreditColumn(operation: operation),
              ],
            ],
          ),
          if (liveProgress != null) ...[
            const SizedBox(height: AppSpacing.sm),
            liveProgress!,
          ],
          if (hasActions) ...[
            const SizedBox(height: AppSpacing.xs),
            Wrap(
              spacing: AppSpacing.xs,
              runSpacing: 0,
              children: [
                if (onOpenBook != null)
                  TextButton.icon(
                    style: _followUpStyle,
                    onPressed: onOpenBook,
                    icon: const Icon(Icons.menu_book_outlined),
                    label: const Text('Open book'),
                  ),
                if (onSeeChanges != null)
                  TextButton.icon(
                    style: _followUpStyle,
                    onPressed: onSeeChanges,
                    icon: const Icon(Icons.difference_outlined),
                    label: const Text('See changes'),
                  ),
                if (onRetry != null)
                  AppButton.primary(
                    onPressed: retrying ? null : onRetry,
                    loading: retrying,
                    loadingLabel: 'Retrying',
                    leading: Icon(
                      operation.retryAvailable
                          ? Icons.refresh
                          : Icons.edit_outlined,
                    ),
                    label: operation.retryAvailable
                        ? operation.isPlanRevision
                              ? 'Retry revision'
                              : 'Retry update'
                        : 'Edit request',
                  ),
                // Screen-level flags: Redo spinning on B has to disable Undo
                // on A too, or the two unawaited writes race the manuscript.
                // A compile still in flight after Undo is the same race.
                if (onUndo != null)
                  TextButton.icon(
                    onPressed: undoing || redoing || rebuilding ? null : onUndo,
                    icon: undoing
                        ? const SizedBox.square(
                            dimension: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.undo),
                    label: const Text('Undo'),
                  ),
                if (onRedo != null)
                  TextButton.icon(
                    onPressed: redoing || undoing || rebuilding ? null : onRedo,
                    icon: redoing
                        ? const SizedBox.square(
                            dimension: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.redo),
                    label: const Text('Redo'),
                  ),
                if (onViewPlan != null)
                  TextButton.icon(
                    style: _followUpStyle,
                    onPressed: onViewPlan,
                    icon: const Icon(Icons.article_outlined),
                    label: const Text('View current plan'),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// The state of the edit as one glyph: working, done or failed.
class _StatusTile extends StatelessWidget {
  const _StatusTile({required this.running, required this.failed});

  final bool running;
  final bool failed;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final Widget glyph;
    final Color fill;
    if (failed) {
      fill = colors.errorContainer;
      glyph = Icon(Icons.error_outline, size: 20, color: colors.error);
    } else if (running) {
      fill = colors.primaryContainer;
      glyph = PlanBuildSparkle(color: colors.onPrimaryContainer, size: 22);
    } else {
      fill = colors.primaryContainer;
      glyph = _PoppingCheck(color: colors.onPrimaryContainer);
    }
    return ExcludeSemantics(
      child: Container(
        width: 36,
        height: 36,
        alignment: Alignment.center,
        decoration: BoxDecoration(color: fill, shape: BoxShape.circle),
        child: glyph,
      ),
    );
  }
}

/// The check lands with a small overshoot the first time a card shows it, so a
/// finished edit is a moment rather than a colour change. Instant under reduced
/// motion, and finite, so a settled transcript still holds still.
class _PoppingCheck extends StatelessWidget {
  const _PoppingCheck({required this.color});

  final Color color;

  @override
  Widget build(BuildContext context) {
    final icon = Icon(Icons.check, size: 20, color: color);
    if (AppMotion.reducedMotion(context)) return icon;
    return TweenAnimationBuilder<double>(
      tween: Tween<double>(begin: 0.4, end: 1),
      duration: AppMotion.slow,
      curve: AppMotion.emphasized,
      builder: (context, scale, child) =>
          Transform.scale(scale: scale, child: child),
      child: icon,
    );
  }
}

class _CreditColumn extends StatelessWidget {
  const _CreditColumn({required this.operation});

  final MobileBookEditOperation operation;

  @override
  Widget build(BuildContext context) {
    final refunded = operation.effectiveCreditsRefundedAmount;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        if (!operation.creditsRefunded || refunded == 0)
          CreditCostBadge(
            credits: operation.creditsCharged - refunded,
            kind: CreditCostKind.charged,
          ),
        if (refunded > 0) ...[
          if (!operation.creditsRefunded) const SizedBox(height: 4),
          CreditCostBadge(credits: refunded, kind: CreditCostKind.refunded),
        ],
      ],
    );
  }
}

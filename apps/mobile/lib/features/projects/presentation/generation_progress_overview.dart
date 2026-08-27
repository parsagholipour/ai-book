import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/project_models.dart';
import 'progress_step_row.dart';

/// The live "what is happening to my book right now" card on /handoff.
///
/// It draws the same milestone list as the chat's progress bubble — whichever
/// of the live step lists the server is sending, the coarse pipeline steps
/// otherwise — so the two surfaces never disagree about the same book.
class GenerationProgressOverviewCard extends StatelessWidget {
  const GenerationProgressOverviewCard({
    required this.status,
    required this.busyAction,
    this.initialMessage,
    this.onResume,
    super.key,
  });

  final MobileProjectStatus status;
  final String? initialMessage;
  final String? busyAction;
  final Future<void> Function()? onResume;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    // The percent follows the same source as the step list below: the
    // whole-book `progressPercent` sits flat on 10 for the entire planning
    // phase, which reads as stuck next to milestones that are moving.
    final progress =
        (status.editProgress?.percent ??
                status.generationProgress?.percent ??
                (status.status == 'planning'
                    ? status.planningProgress?.percent
                    : null) ??
                status.progressPercent)
            .clamp(0, 100)
            .toInt();
    // While the plan is being written the finer planning milestones are what
    // the chat draws, and this card promises to agree with it. Only while
    // planning: once a plan is approved those three steps are all done and the
    // coarse pipeline is the honest answer until writing reports in. An edit
    // sends its own list and no generation one — without it this card fell back
    // to the whole book's pipeline, which says nothing about the edit running.
    final rawSteps =
        status.generationProgress?.steps ??
        status.editProgress?.steps ??
        (status.status == 'planning' ? status.planningProgress?.steps : null) ??
        status.steps;
    final steps = imageAwareGenerationSteps(rawSteps, status);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              status.statusLabel,
              style: Theme.of(
                context,
              ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 6),
            Text(
              status.effectiveAction,
              style: Theme.of(
                context,
              ).textTheme.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
            ),
            if (initialMessage != null &&
                initialMessage != status.currentAction) ...[
              const SizedBox(height: 4),
              Text(
                initialMessage!,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
            ],
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: AppAnimatedProgressBar(
                    value: progress / 100,
                    semanticLabel: 'Book generation progress',
                  ),
                ),
                const SizedBox(width: 12),
                AppAnimatedCount(
                  value: progress,
                  builder: (value) => '$value%',
                  style: Theme.of(context).textTheme.labelLarge,
                ),
              ],
            ),
            const SizedBox(height: 14),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                AppMetricChip(
                  icon: Icons.menu_book_outlined,
                  label:
                      '${status.pageProgress.completed}/${status.pageProgress.target} pages',
                ),
                AppMetricChip(
                  icon: Icons.image_outlined,
                  label: '${status.imageCount} visuals',
                ),
              ],
            ),
            const SizedBox(height: 16),
            for (final step in steps)
              ProgressStepRow(step: step, dense: false, showDetail: true),
            if (status.isAutomaticRetryPending) ...[
              const SizedBox(height: 12),
              AppInlineNotice(
                icon: Icons.autorenew_outlined,
                title: 'Retry scheduled',
                message: status.retryMessage?.trim().isNotEmpty == true
                    ? status.retryMessage!
                    : 'Writing will continue automatically. You can leave this screen.',
                tone: AppTone.info,
              ),
            ] else if (status.hasFailure || status.status == 'failed') ...[
              const SizedBox(height: 12),
              AppInlineNotice(
                icon: Icons.error_outline,
                title: status.retryAvailable
                    ? 'Writing needs a retry'
                    : 'Writing needs attention',
                message: status.failureMessage?.trim().isNotEmpty == true
                    ? status.failureMessage!
                    : status.effectiveAction,
                tone: AppTone.error,
              ),
              if (onResume != null) ...[
                const SizedBox(height: 10),
                AppButton.primary(
                  label:
                      status.recoveryQuote?.requiresConfirmation == false
                      ? 'Retry plan · ${status.recoveryQuote!.credits} credits'
                      : 'Retry generation',
                  onPressed: busyAction == 'resume' ? null : () => onResume!(),
                  loading: busyAction == 'resume',
                  loadingLabel: 'Retrying generation',
                  leading: const Icon(Icons.replay_outlined),
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }
}

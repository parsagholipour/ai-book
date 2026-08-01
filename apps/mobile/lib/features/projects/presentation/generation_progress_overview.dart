import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/project_models.dart';
import 'progress_step_row.dart';

/// The live "what is happening to my book right now" card on /handoff.
///
/// It draws the same milestone list as the creation chat's progress bubble —
/// `generationProgress.steps` when the server sends it, the coarse pipeline
/// steps otherwise — so the two surfaces never disagree about the same book.
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
    final progress = status.progressPercent.clamp(0, 100).toInt();
    final steps = status.generationProgress?.steps ?? status.steps;
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
                tone: AppNoticeTone.info,
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
                tone: AppNoticeTone.error,
              ),
              if (onResume != null) ...[
                const SizedBox(height: 10),
                FilledButton.icon(
                  onPressed: busyAction == 'resume' ? null : () => onResume!(),
                  icon: busyAction == 'resume'
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            semanticsLabel: 'Retrying generation',
                          ),
                        )
                      : const Icon(Icons.replay_outlined),
                  label: const Text('Retry generation'),
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }
}

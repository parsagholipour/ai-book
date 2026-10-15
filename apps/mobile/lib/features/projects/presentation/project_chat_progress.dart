import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/project_models.dart';
import 'plan_build_progress.dart';
import 'progress_step_row.dart';
import 'waiting_in_line_note.dart';

// What the book chat draws while the worker is busy with the book: the card in
// the transcript, and the slim pill that keeps it in reach after scrolling up.
// Both are driven by the project status stream, and both animate only while
// that stream says work is in flight — a settled book holds still.

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
    final steps = liveSteps(status);
    final progress = _monotonicPercent(status.status, livePercent(status));
    final pages = status.pageProgress;
    // During an edit that count is the whole book's, which says nothing about
    // the handful of pages being rewritten and reads as though the edit is
    // rewriting everything.
    final showPages =
        status.status != 'editing' &&
        pages.target > 0 &&
        pages.completed <= pages.target;

    return Container(
      padding: const EdgeInsets.all(AppSpacing.md - 2),
      decoration: BoxDecoration(
        color: colors.primaryContainer.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(AppRadii.card),
        border: Border.all(color: colors.primary.withValues(alpha: 0.25)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Semantics(
                label: 'Working on your book',
                child: ExcludeSemantics(
                  child: PlanBuildSparkle(
                    color: colors.onPrimaryContainer,
                    size: 22,
                  ),
                ),
              ),
              const SizedBox(width: AppSpacing.sm - 2),
              Expanded(
                // A full-width box so the text sits at the reading edge in
                // either direction; the switcher itself only aligns left/right.
                child: AppSwitcher(
                  child: SizedBox(
                    key: ValueKey(status.currentAction),
                    width: double.infinity,
                    child: Text(
                      status.currentAction,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: colors.onPrimaryContainer,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: AppSpacing.xs),
              AppAnimatedCount(
                value: progress,
                style: theme.textTheme.labelMedium?.copyWith(
                  color: colors.onPrimaryContainer,
                  fontWeight: FontWeight.w700,
                ),
                builder: (value) => '$value%',
              ),
            ],
          ),
          // A continuation or a rebuild waits its turn behind other books.
          if (status.waitingInLineLabel != null) ...[
            const SizedBox(height: AppSpacing.xs),
            WaitingInLineNote(
              status: status,
              color: colors.onPrimaryContainer.withValues(alpha: 0.85),
            ),
          ],
          const SizedBox(height: AppSpacing.sm - 2),
          PlanBuildProgressBar(
            value: progress / 100,
            semanticLabel: status.currentAction,
            trackColor: colors.surface.withValues(alpha: 0.6),
          ),
          if (steps.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.sm - 2),
            // With the detail line: an edit's steps carry counts ("3 of 7
            // pages") that are the only thing moving while one long step runs.
            for (final step in steps)
              ProgressStepRow(step: step, showDetail: true),
          ],
          if (showPages) ...[
            const SizedBox(height: AppSpacing.xs),
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

/// The status's own percent for whatever it is doing, clamped to a percentage.
int livePercent(MobileProjectStatus status) =>
    (status.editProgress?.percent ??
            status.generationProgress?.percent ??
            status.planningProgress?.percent ??
            status.progressPercent)
        .clamp(0, 100)
        .toInt();

/// The milestones for whatever the book is doing right now.
///
/// One list rather than three branches: an edit, a plan revision and a
/// continuation all reach this card, they are never live at the same time, and
/// they all arrive as the same step shape.
List<MobileProjectStatusStep> liveSteps(MobileProjectStatus status) {
  final steps =
      status.editProgress?.steps ??
      status.generationProgress?.steps ??
      status.planningProgress?.steps;
  return steps ?? const <MobileProjectStatusStep>[];
}

/// A slim pill that says the book is being worked on and takes the reader back
/// to the progress card.
///
/// Shown only while the reader has scrolled away from the bottom of the
/// transcript: at the bottom the card itself is in view, and two indicators
/// there would read as two things happening.
class ChatLiveBanner extends StatelessWidget {
  const ChatLiveBanner({required this.status, required this.onTap, super.key});

  final MobileProjectStatus status;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final percent = livePercent(status);
    final label = switch (status.status) {
      'planning' => 'Revising your plan',
      'generating' => 'Writing your book',
      _ => 'Editing your book',
    };
    return Semantics(
      container: true,
      button: true,
      liveRegion: true,
      label: '$label, $percent percent. Tap to see progress.',
      onTap: onTap,
      child: ExcludeSemantics(
        child: Material(
          color: colors.primaryContainer,
          elevation: 3,
          shadowColor: Colors.black.withValues(alpha: 0.25),
          shape: const StadiumBorder(),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: ConstrainedBox(
              constraints: const BoxConstraints(
                minHeight: AppSizes.minimumTouchTarget,
              ),
              child: Padding(
                padding: const EdgeInsetsDirectional.fromSTEB(14, 6, 14, 6),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    PlanBuildSparkle(
                      color: colors.onPrimaryContainer,
                      size: 20,
                    ),
                    const SizedBox(width: AppSpacing.xs),
                    Flexible(
                      child: Text(
                        '$label · $percent%',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.labelLarge?.copyWith(
                          color: colors.onPrimaryContainer,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                    const SizedBox(width: AppSpacing.xxs),
                    Icon(
                      Icons.keyboard_arrow_down,
                      size: 20,
                      color: colors.onPrimaryContainer,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

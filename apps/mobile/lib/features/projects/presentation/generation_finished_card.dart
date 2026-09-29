import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/project_models.dart';
import 'book_cover.dart';
import 'generation_duration.dart';
import 'progress_step_row.dart';

/// The one line a finished book is summed up in: "Ready · 10 pages · 3 images ·
/// made in 7m 53s". Each part is dropped when its number is unknown, so an old
/// API build that sends no timing still reads as a sentence.
String finishedBookSummary({
  required int pages,
  required int images,
  int? durationMs,
}) {
  final made = formatGenerationDuration(durationMs);
  return [
    'Ready',
    if (pages > 0) pages == 1 ? '1 page' : '$pages pages',
    if (images > 0) images == 1 ? '1 image' : '$images images',
    if (made != null) 'made in $made',
  ].join(' · ');
}

/// What a completed book collapses to in the chat: its cover, its name, one
/// summary line, one primary action and quieter secondary ones, with the story
/// of how it was made folded away.
///
/// It draws nothing that moves. A finished book has no work in flight, so the
/// sparkle, the sheen and the 100% bar that narrated the writing are gone — the
/// card is the still, settled version of the progress bubble.
class GenerationFinishedCard extends StatefulWidget {
  const GenerationFinishedCard({
    required this.projectId,
    required this.title,
    required this.summary,
    required this.steps,
    required this.onOpen,
    this.coverImage,
    this.primaryAction,
    this.secondaryActions = const [],
    this.notice,
    super.key,
  });

  final String projectId;
  final String title;
  final String summary;

  /// The milestones behind the book, shown only when the reader asks.
  final List<MobileProjectStatusStep> steps;

  /// Opens the book's own page; the cover and title are its tap target.
  final VoidCallback onOpen;
  final MobileProjectImage? coverImage;

  /// The one thing to do next. Null while there is nothing to open yet.
  final Widget? primaryAction;

  /// Everything else, drawn outlined and beside each other so none of them
  /// competes with [primaryAction].
  final List<Widget> secondaryActions;

  /// Calm one-liner shown where the primary action would be, for the moment a
  /// finished book has no file to open yet.
  final String? notice;

  @override
  State<GenerationFinishedCard> createState() => _GenerationFinishedCardState();
}

class _GenerationFinishedCardState extends State<GenerationFinishedCard> {
  bool _showSteps = false;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final reduced = AppMotion.reducedMotion(context);
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Container(
          margin: const EdgeInsets.only(bottom: AppSpacing.xs),
          decoration: BoxDecoration(
            color: colors.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(AppRadii.card),
            // A quiet brand edge is the only celebration: enough to say
            // "done" without a banner.
            border: Border.all(color: colors.primary.withValues(alpha: 0.35)),
          ),
          clipBehavior: Clip.antiAlias,
          child: AppEntrance(
            offset: 12,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Semantics(
                  button: true,
                  label: 'Open ${widget.title}. ${widget.summary}',
                  child: ExcludeSemantics(
                    child: InkWell(
                      key: const ValueKey('finished-card-open'),
                      onTap: widget.onOpen,
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(
                          AppSpacing.md,
                          AppSpacing.md,
                          AppSpacing.md,
                          AppSpacing.sm,
                        ),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            BookCover(
                              title: widget.title,
                              seed: widget.projectId,
                              image: widget.coverImage,
                              width: 52,
                              borderRadius: 6,
                            ),
                            const SizedBox(width: AppSpacing.sm),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    widget.title,
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: text.titleMedium?.copyWith(
                                      fontWeight: FontWeight.w800,
                                    ),
                                  ),
                                  const SizedBox(height: AppSpacing.xxs),
                                  Row(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Padding(
                                        padding: const EdgeInsets.only(top: 1),
                                        child: Icon(
                                          Icons.check_circle,
                                          key: const ValueKey(
                                            'generation-icon-done',
                                          ),
                                          size: 16,
                                          color: colors.primary,
                                        ),
                                      ),
                                      const SizedBox(width: 6),
                                      Expanded(
                                        child: Text(
                                          widget.summary,
                                          style: text.bodySmall?.copyWith(
                                            color: colors.onSurfaceVariant,
                                          ),
                                        ),
                                      ),
                                    ],
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
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    AppSpacing.md,
                    0,
                    AppSpacing.md,
                    AppSpacing.xs,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (widget.primaryAction != null)
                        widget.primaryAction!
                      else if (widget.notice != null)
                        _PreparingNotice(message: widget.notice!),
                      if (widget.secondaryActions.isNotEmpty) ...[
                        const SizedBox(height: AppSpacing.xs),
                        _SecondaryActions(actions: widget.secondaryActions),
                      ],
                    ],
                  ),
                ),
                if (widget.steps.isNotEmpty) ...[
                  Divider(height: 1, color: colors.outlineVariant),
                  Semantics(
                    button: true,
                    expanded: _showSteps,
                    label: 'See how it was made',
                    child: ExcludeSemantics(
                      child: InkWell(
                        key: const ValueKey('finished-card-history'),
                        onTap: () => setState(() => _showSteps = !_showSteps),
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(
                            minHeight: AppSizes.minimumTouchTarget,
                          ),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: AppSpacing.md,
                            ),
                            child: Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    'See how it was made',
                                    style: text.labelLarge?.copyWith(
                                      color: colors.onSurfaceVariant,
                                    ),
                                  ),
                                ),
                                AnimatedRotation(
                                  turns: _showSteps ? 0.5 : 0,
                                  duration: reduced
                                      ? Duration.zero
                                      : AppMotion.medium,
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
                  ),
                  AnimatedSize(
                    duration: reduced ? Duration.zero : AppMotion.medium,
                    curve: AppMotion.enter,
                    alignment: Alignment.topCenter,
                    child: _showSteps
                        ? Padding(
                            padding: const EdgeInsets.fromLTRB(
                              AppSpacing.md,
                              0,
                              AppSpacing.md,
                              AppSpacing.sm,
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                for (final step in widget.steps)
                                  ProgressStepRow(
                                    step: step,
                                    showDetail: true,
                                    inlineDetail: true,
                                  ),
                              ],
                            ),
                          )
                        : const SizedBox(width: double.infinity),
                  ),
                ] else
                  const SizedBox(height: AppSpacing.xs),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Secondary actions side by side while they fit, stacked once the text is
/// large enough that two labels would squeeze each other.
class _SecondaryActions extends StatelessWidget {
  const _SecondaryActions({required this.actions});

  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final scale = MediaQuery.textScalerOf(context).scale(1);
    return LayoutBuilder(
      builder: (context, constraints) {
        final stacked = scale >= 1.35 || constraints.maxWidth < 300;
        if (stacked) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var i = 0; i < actions.length; i++) ...[
                if (i > 0) const SizedBox(height: AppSpacing.xs),
                actions[i],
              ],
            ],
          );
        }
        return Row(
          children: [
            for (var i = 0; i < actions.length; i++) ...[
              if (i > 0) const SizedBox(width: AppSpacing.xs),
              Expanded(child: actions[i]),
            ],
          ],
        );
      },
    );
  }
}

class _PreparingNotice extends StatelessWidget {
  const _PreparingNotice({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Row(
      children: [
        Icon(Icons.hourglass_empty, size: 16, color: colors.onSurfaceVariant),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            message,
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
          ),
        ),
      ],
    );
  }
}

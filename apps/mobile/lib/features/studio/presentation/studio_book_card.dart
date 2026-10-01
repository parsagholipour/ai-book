import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../projects/data/projects_repository.dart';
import '../../projects/domain/project_models.dart';
import '../data/studio_repository.dart';
import '../domain/manuscript_models.dart';
import 'manuscript_settings_sheet.dart';
import 'studio_cover_image.dart';
import 'studio_cover_picker.dart';
import 'studio_location.dart';

/// The book page of a book the author is writing and has not published yet.
///
/// There is no book to read, so the page is the manuscript: how much is
/// written and how far that is toward the goal, a way straight back into the
/// writing, every chapter one tap from its own page in the Studio, and — once
/// there is something to publish — the way to publish it. It is the page, not
/// a button to the page: everything on it is something the author can act on.
class StudioBookCard extends ConsumerStatefulWidget {
  const StudioBookCard({required this.project, super.key});

  final MobileProjectSummary project;

  @override
  ConsumerState<StudioBookCard> createState() => _StudioBookCardState();
}

/// How many chapters the card lists before it folds the rest.
const _foldAfter = 6;

class _StudioBookCardState extends ConsumerState<StudioBookCard> {
  bool _showAll = false;

  /// Re-reads the working copy while a cover is being made, so the row shows
  /// it the moment it lands.
  Timer? _coverPoll;

  String get _projectId => widget.project.id;

  @override
  void dispose() {
    _coverPoll?.cancel();
    super.dispose();
  }

  void _syncCoverPoll(bool pending) {
    if (!pending) {
      _coverPoll?.cancel();
      _coverPoll = null;
      return;
    }
    _coverPoll ??= Timer(studioCoverPollInterval, () {
      _coverPoll = null;
      if (mounted) ref.invalidate(manuscriptProvider(_projectId));
    });
  }

  Future<void> _openCover(Manuscript manuscript) async {
    AppHaptics.tap();
    await showStudioCoverSheet(
      context,
      projectId: _projectId,
      manuscript: manuscript,
    );
  }

  /// Opens the Studio and, on the way back, refreshes what it will have
  /// changed: the word count, the chapters, the book's own title.
  Future<void> _openStudio({String? chapterId, bool publish = false}) async {
    AppHaptics.tap();
    await context.push(
      studioLocation(_projectId, chapterId: chapterId, publish: publish),
    );
    if (!mounted) return;
    ref.invalidate(manuscriptProvider(_projectId));
    ref.invalidate(projectDetailProvider(_projectId));
  }

  Future<void> _openSettings(Manuscript manuscript) async {
    await showManuscriptSettingsSheet(
      context,
      projectId: _projectId,
      manuscript: manuscript,
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final value = ref.watch(manuscriptProvider(_projectId));
    final manuscript = value.value;
    final summary = widget.project.manuscript;
    final words = manuscript?.wordCount ?? summary?.wordCount ?? 0;
    // Once the working copy is here it is the authority, a cleared goal
    // included; the summary on the book only stands in until then.
    final goal = manuscript != null ? manuscript.goalWords : summary?.goalWords;
    _syncCoverPoll(manuscript?.cover.pending ?? false);

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _WritingProgress(
            words: words,
            goal: goal,
            onSetGoal: manuscript == null
                ? null
                : () => _openSettings(manuscript),
          ),
          const SizedBox(height: AppSpacing.md),
          AppButton.primary(
            key: const ValueKey('studio-continue'),
            label: words == 0 ? 'Start writing' : 'Continue writing',
            leading: const Icon(Icons.edit_outlined),
            expanded: true,
            onPressed: () => _openStudio(),
          ),
          const SizedBox(height: AppSpacing.lg),
          Row(
            children: [
              Expanded(
                child: Semantics(
                  header: true,
                  child: Text(
                    'Chapters',
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ),
              if (manuscript != null)
                Text(
                  '${manuscript.chapters.length}',
                  style: theme.textTheme.labelLarge?.copyWith(
                    color: colors.onSurfaceVariant,
                    fontWeight: FontWeight.w700,
                  ),
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.xs),
          AppSwitcher(child: _chapters(value)),
          if (words > 0) ...[
            const SizedBox(height: AppSpacing.md),
            Divider(height: 1, color: colors.outlineVariant),
            const SizedBox(height: AppSpacing.md),
            Text(
              'Publish when you are ready: it becomes a book you can read, '
              'share and download, and you can keep writing after.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
                height: 1.4,
              ),
            ),
            if (manuscript != null) ...[
              const SizedBox(height: AppSpacing.sm),
              _CoverRow(
                projectId: _projectId,
                manuscript: manuscript,
                onTap: () => _openCover(manuscript),
              ),
            ],
            const SizedBox(height: AppSpacing.sm),
            AppButton.outlined(
              key: const ValueKey('studio-publish'),
              label: 'Publish',
              leading: const Icon(Icons.menu_book_outlined),
              expanded: true,
              onPressed: () => _openStudio(publish: true),
            ),
          ],
        ],
      ),
    );
  }

  Widget _chapters(AsyncValue<Manuscript> value) {
    final manuscript = value.value;
    if (manuscript == null && value.hasError) {
      return AppInlineNotice(
        key: const ValueKey('studio-chapters-error'),
        tone: AppTone.error,
        title: 'Could not load your chapters',
        message: userFacingError(value.error!),
        actionLabel: 'Try again',
        onAction: () => ref.invalidate(manuscriptProvider(_projectId)),
      );
    }
    if (manuscript == null) {
      return AppSkeletonGroup(
        key: const ValueKey('studio-chapters-loading'),
        label: 'Loading chapters',
        child: Column(
          children: [for (var i = 0; i < 3; i++) const _ChapterRowSkeleton()],
        ),
      );
    }
    final chapters = manuscript.chapters;
    final folded = !_showAll && chapters.length > _foldAfter + 1;
    final shown = folded ? chapters.take(_foldAfter).toList() : chapters;
    return Column(
      key: const ValueKey('studio-chapters'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final chapter in shown)
          _ChapterRow(
            chapter: chapter,
            onTap: () => _openStudio(chapterId: chapter.id),
          ),
        if (folded)
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: AppButton.text(
              label: 'Show all ${chapters.length} chapters',
              leading: const Icon(Icons.expand_more),
              onPressed: () => setState(() => _showAll = true),
            ),
          ),
      ],
    );
  }
}

/// The book's cover as it will be bound: the picture once there is one, the
/// designed placeholder until then, and the way to change it.
class _CoverRow extends StatelessWidget {
  const _CoverRow({
    required this.projectId,
    required this.manuscript,
    required this.onTap,
  });

  final String projectId;
  final Manuscript manuscript;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final cover = manuscript.cover;
    final summary = studioCoverSummary(cover);
    return Semantics(
      container: true,
      button: true,
      label: 'Cover. $summary. Change cover',
      onTap: onTap,
      child: ExcludeSemantics(
        child: InkWell(
          key: const ValueKey('studio-cover'),
          onTap: onTap,
          borderRadius: BorderRadius.circular(AppRadii.control),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.xxs),
            child: Row(
              children: [
                StudioCoverImage(
                  projectId: projectId,
                  title: manuscript.title,
                  authorName: manuscript.authorName,
                  cover: cover,
                  width: 40,
                  radius: 5,
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Cover',
                        style: theme.textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        summary,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: AppSpacing.xs),
                Text(
                  'Change',
                  style: theme.textTheme.labelLarge?.copyWith(
                    color: colors.primary,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(width: AppSpacing.xs),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The word count, and the ring around it once there is a goal to fill.
class _WritingProgress extends StatelessWidget {
  const _WritingProgress({
    required this.words,
    required this.goal,
    required this.onSetGoal,
  });

  final int words;
  final int? goal;
  final VoidCallback? onSetGoal;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final localizations = MaterialLocalizations.of(context);
    final goal = this.goal;
    final hasGoal = goal != null && goal > 0;
    final progress = hasGoal ? (words / goal).clamp(0.0, 1.0) : null;
    final count = words == 1
        ? '1 word'
        : '${localizations.formatDecimal(words)} words';
    final percent = progress == null ? null : (progress * 100).floor();

    final String? caption;
    if (hasGoal) {
      caption = words >= goal
          ? 'Goal of ${localizations.formatDecimal(goal)} reached'
          : 'of your ${localizations.formatDecimal(goal)}-word goal';
    } else if (words == 0) {
      caption = 'Nothing written yet — your first chapter is waiting.';
    } else {
      caption = onSetGoal == null ? 'Your book so far' : null;
    }

    return Semantics(
      container: true,
      label: hasGoal
          ? '$count of a ${localizations.formatDecimal(goal)} word goal, '
                '$percent percent'
          : count,
      child: Row(
        children: [
          ExcludeSemantics(
            child: _GoalRing(
              progress: progress,
              child: percent == null
                  ? Icon(Icons.edit_note, color: colors.primary, size: 28)
                  : Text(
                      '$percent%',
                      style: theme.textTheme.labelLarge?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
            ),
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ExcludeSemantics(
                  child: Text(
                    count,
                    key: const ValueKey('studio-word-count'),
                    style: theme.textTheme.titleLarge?.copyWith(
                      fontWeight: FontWeight.w800,
                      height: 1.15,
                    ),
                  ),
                ),
                if (caption != null) ...[
                  const SizedBox(height: 2),
                  ExcludeSemantics(
                    child: Text(
                      caption,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ),
                ],
                if (!hasGoal && onSetGoal != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: _QuietLink(
                      key: const ValueKey('studio-set-goal'),
                      label: 'Set a word goal',
                      onTap: onSetGoal!,
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// A link-weight action: text in the brand colour with a comfortable target,
/// for things that should be findable without competing with the button.
class _QuietLink extends StatelessWidget {
  const _QuietLink({required this.label, required this.onTap, super.key});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Semantics(
      container: true,
      button: true,
      label: label,
      onTap: onTap,
      child: ExcludeSemantics(
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(AppRadii.compact),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 36),
            child: Align(
              widthFactor: 1,
              alignment: AlignmentDirectional.centerStart,
              child: Text(
                label,
                style: theme.textTheme.labelLarge?.copyWith(
                  color: theme.colorScheme.primary,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _GoalRing extends StatelessWidget {
  const _GoalRing({required this.progress, required this.child});

  /// 0..1, or null for no goal: the ring is then a plain disc.
  final double? progress;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    const size = 64.0;
    final progress = this.progress;
    return SizedBox.square(
      dimension: size,
      child: TweenAnimationBuilder<double>(
        tween: Tween(begin: 0, end: progress ?? 0),
        duration: AppMotion.adapt(context, AppMotion.slow * 2),
        curve: AppMotion.enter,
        builder: (context, value, _) => CustomPaint(
          painter: _RingPainter(
            progress: progress == null ? null : value,
            track: progress == null
                ? colors.primaryContainer.withValues(alpha: 0.7)
                : colors.surfaceContainerHighest,
            arc: colors.primary,
          ),
          child: Center(child: child),
        ),
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  const _RingPainter({
    required this.progress,
    required this.track,
    required this.arc,
  });

  final double? progress;
  final Color track;
  final Color arc;

  @override
  void paint(Canvas canvas, Size size) {
    final centre = size.center(Offset.zero);
    final progress = this.progress;
    if (progress == null) {
      canvas.drawCircle(centre, size.shortestSide / 2, Paint()..color = track);
      return;
    }
    const stroke = 6.0;
    final radius = (size.shortestSide - stroke) / 2;
    final rect = Rect.fromCircle(center: centre, radius: radius);
    canvas.drawCircle(
      centre,
      radius,
      Paint()
        ..color = track
        ..style = PaintingStyle.stroke
        ..strokeWidth = stroke,
    );
    if (progress <= 0) return;
    canvas.drawArc(
      rect,
      -math.pi / 2,
      2 * math.pi * progress,
      false,
      Paint()
        ..color = arc
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round
        ..strokeWidth = stroke,
    );
  }

  @override
  bool shouldRepaint(covariant _RingPainter oldDelegate) =>
      oldDelegate.progress != progress ||
      oldDelegate.track != track ||
      oldDelegate.arc != arc;
}

class _ChapterRow extends StatelessWidget {
  const _ChapterRow({required this.chapter, required this.onTap});

  final ManuscriptChapterSummary chapter;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final localizations = MaterialLocalizations.of(context);
    final words = chapter.wordCount == 1
        ? '1 word'
        : '${localizations.formatDecimal(chapter.wordCount)} words';
    final meta = [
      chapter.status.label,
      words,
      if (chapter.hasConflict) 'Needs your decision',
    ].join(' · ');
    return Semantics(
      container: true,
      button: true,
      label: 'Chapter ${chapter.position}, ${chapter.displayTitle}. $meta',
      onTap: onTap,
      child: ExcludeSemantics(
        child: InkWell(
          key: ValueKey('studio-chapter-${chapter.id}'),
          onTap: onTap,
          borderRadius: BorderRadius.circular(AppRadii.compact),
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              minHeight: AppSizes.minimumTouchTarget + 8,
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
              child: Row(
                children: [
                  DecoratedBox(
                    decoration: BoxDecoration(
                      color: colors.surfaceContainerHigh,
                      shape: BoxShape.circle,
                    ),
                    child: SizedBox.square(
                      dimension: 32,
                      child: Center(
                        child: Text(
                          '${chapter.position}',
                          style: theme.textTheme.labelMedium?.copyWith(
                            fontWeight: FontWeight.w800,
                            color: colors.onSurfaceVariant,
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          chapter.displayTitle,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodyLarge?.copyWith(
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          meta,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: chapter.hasConflict
                                ? appToneColors(context, AppTone.warning).accent
                                : colors.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: AppSpacing.xs),
                  Icon(
                    Icons.chevron_right,
                    size: 20,
                    color: colors.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ChapterRowSkeleton extends StatelessWidget {
  const _ChapterRowSkeleton();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: 12),
      child: Row(
        children: [
          AppSkeleton.circle(size: 32),
          SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AppSkeleton.line(widthFactor: 0.55, height: 14),
                SizedBox(height: 6),
                AppSkeleton.line(widthFactor: 0.35),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/project_models.dart';
import 'book_cover.dart';
import 'generation_duration.dart';

/// The facts a finished book is described by: "10 pages", "3 images",
/// "made in 7m 53s". Each one is dropped when its number is unknown, so an old
/// API build that sends no timing still reads cleanly.
List<String> finishedBookFacts({
  required int pages,
  required int images,
  int? durationMs,
}) {
  final made = formatGenerationDuration(durationMs);
  return [
    if (pages > 0) pages == 1 ? '1 page' : '$pages pages',
    if (images > 0) images == 1 ? '1 image' : '$images images',
    if (made != null) 'made in $made',
  ];
}

/// The one line a finished book is summed up in: "Ready · 10 pages · 3 images ·
/// made in 7m 53s". The card draws the facts on their own; this is the
/// sentence a screen reader hears.
String finishedBookSummary({
  required int pages,
  required int images,
  int? durationMs,
}) => [
  'Ready',
  ...finishedBookFacts(pages: pages, images: images, durationMs: durationMs),
].join(' · ');

/// What a completed book collapses to in the chat: its cover, its name, a
/// Ready badge and its facts, one primary action and quieter secondary ones
/// beside each other, and "Behind the book" folded away at its foot
/// (`behind_the_book.dart`).
///
/// It draws nothing that moves. A finished book has no work in flight, so the
/// sparkle, the sheen and the 100% bar that narrated the writing are gone — the
/// card is the still, settled version of the progress bubble. The brand wash
/// behind the cover is the only celebration.
class GenerationFinishedCard extends StatelessWidget {
  const GenerationFinishedCard({
    required this.projectId,
    required this.title,
    required this.facts,
    required this.onOpen,
    this.coverImage,
    this.primaryAction,
    this.secondaryActions = const [],
    this.notice,
    this.footer,
    super.key,
  });

  final String projectId;
  final String title;

  /// Short, unbreakable facts ("10 pages", "made in 1m 39s"); see
  /// [finishedBookFacts].
  final List<String> facts;

  /// Opens the book's own page; the cover and title are its tap target.
  final VoidCallback onOpen;
  final MobileProjectImage? coverImage;

  /// The one thing to do next. Null while there is nothing to open yet.
  final Widget? primaryAction;

  /// Everything else, drawn as quiet buttons beside each other so none of them
  /// competes with [primaryAction].
  final List<Widget> secondaryActions;

  /// Calm one-liner shown where the primary action would be, for the moment a
  /// finished book has no file to open yet.
  final String? notice;

  /// Drawn under the actions, edge to edge, and responsible for its own
  /// divider: "Behind the book", which hides itself when there is nothing
  /// behind this one.
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final dark = colors.brightness == Brightness.dark;
    final summary = ['Ready', ...facts].join(' · ');
    final hasActions =
        primaryAction != null || notice != null || secondaryActions.isNotEmpty;
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Container(
          margin: const EdgeInsets.only(bottom: AppSpacing.xs),
          decoration: BoxDecoration(
            color: colors.surfaceContainerLowest,
            borderRadius: BorderRadius.circular(AppRadii.card),
            border: Border.all(
              color: colors.primary.withValues(alpha: dark ? 0.28 : 0.16),
            ),
            boxShadow: AppElevation.resting(colors),
          ),
          clipBehavior: Clip.antiAlias,
          child: AppEntrance(
            offset: 12,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Semantics(
                  container: true,
                  button: true,
                  label: 'Open $title. $summary',
                  onTap: onOpen,
                  child: ExcludeSemantics(
                    child: DecoratedBox(
                      // The brand wash: the book sits in a little light, and
                      // it fades out before the actions begin.
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.topCenter,
                          end: Alignment.bottomCenter,
                          colors: [
                            colors.primaryContainer.withValues(
                              alpha: dark ? 0.45 : 0.75,
                            ),
                            colors.primaryContainer.withValues(alpha: 0),
                          ],
                        ),
                      ),
                      child: InkWell(
                        key: const ValueKey('finished-card-open'),
                        onTap: onOpen,
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(
                            AppSpacing.md,
                            AppSpacing.md,
                            AppSpacing.md,
                            AppSpacing.md,
                          ),
                          child: Row(
                            children: [
                              BookCover(
                                title: title,
                                seed: projectId,
                                image: coverImage,
                                width: 72,
                                borderRadius: 6,
                              ),
                              const SizedBox(width: AppSpacing.md),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    const _ReadyBadge(),
                                    const SizedBox(height: AppSpacing.xs),
                                    Text(
                                      title,
                                      maxLines: 3,
                                      overflow: TextOverflow.ellipsis,
                                      style: text.titleLarge?.copyWith(
                                        fontWeight: FontWeight.w800,
                                        height: 1.15,
                                        letterSpacing: -0.2,
                                      ),
                                    ),
                                    if (facts.isNotEmpty) ...[
                                      const SizedBox(height: 6),
                                      _Facts(facts: facts),
                                    ],
                                  ],
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                if (hasActions)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(
                      AppSpacing.md,
                      0,
                      AppSpacing.md,
                      AppSpacing.md,
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (primaryAction != null)
                          primaryAction!
                        else if (notice != null)
                          _PreparingNotice(message: notice!),
                        if (secondaryActions.isNotEmpty) ...[
                          const SizedBox(height: AppSpacing.xs),
                          _SecondaryActions(actions: secondaryActions),
                        ],
                      ],
                    ),
                  ),
                ?footer,
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// "✓ Ready", as a small brand pill above the title.
class _ReadyBadge extends StatelessWidget {
  const _ReadyBadge();

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.primary.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(AppRadii.pill),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(6, 3, 10, 3),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.check_circle,
              key: const ValueKey('generation-icon-done'),
              size: 14,
              color: colors.primary,
            ),
            const SizedBox(width: 4),
            Text(
              'Ready',
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                color: colors.primary,
                fontWeight: FontWeight.w800,
                letterSpacing: 0.2,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The facts on one line while they fit. A line only ever breaks between two
/// facts, never inside one, so "made in 1m 39s" is never split from its "39s".
class _Facts extends StatelessWidget {
  const _Facts({required this.facts});

  final List<String> facts;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final style = Theme.of(
      context,
    ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant);
    return Wrap(
      runSpacing: 2,
      children: [
        for (var i = 0; i < facts.length; i++)
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(facts[i], style: style, softWrap: false),
              if (i < facts.length - 1) Text('  ·  ', style: style),
            ],
          ),
      ],
    );
  }
}

/// Secondary actions side by side, in a quieter, shorter button than the
/// primary. They stack only when large text would squeeze two labels.
class _SecondaryActions extends StatelessWidget {
  const _SecondaryActions({required this.actions});

  final List<Widget> actions;

  /// The narrowest a side-by-side button gets before it stacks. "Open PDF" and
  /// "Edit book" with their icons need about 110 at normal text size.
  static const double _minimumActionWidth = 128;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final scale = MediaQuery.textScalerOf(context).scale(1);
    final quiet = OutlinedButton.styleFrom(
      minimumSize: const Size(0, AppSizes.minimumTouchTarget),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
      backgroundColor: colors.surfaceContainerLow,
      foregroundColor: colors.onSurface,
      iconColor: colors.primary,
      iconSize: 18,
      side: BorderSide(color: colors.outlineVariant),
    ).merge(OutlinedButtonTheme.of(context).style);
    return OutlinedButtonTheme(
      data: OutlinedButtonThemeData(style: quiet),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final gaps = AppSpacing.xs * (actions.length - 1);
          final stacked =
              scale >= 1.35 ||
              (constraints.maxWidth - gaps) / actions.length <
                  _minimumActionWidth;
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
      ),
    );
  }
}

class _PreparingNotice extends StatelessWidget {
  const _PreparingNotice({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surfaceContainerLow,
        borderRadius: BorderRadius.circular(AppRadii.control),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.sm,
          vertical: AppSpacing.sm,
        ),
        child: Row(
          children: [
            Icon(Icons.hourglass_empty, size: 16, color: colors.primary),
            const SizedBox(width: AppSpacing.xs),
            Expanded(
              child: Text(
                message,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

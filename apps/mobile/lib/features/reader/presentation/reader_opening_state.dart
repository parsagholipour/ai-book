import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../../projects/presentation/plan_build_progress.dart';

/// What the reader shows while there is no book on screen yet: a page taking
/// shape, what is happening to it, and how far along that is.
///
/// A bare spinner tells someone the app is busy and nothing else. This shows
/// the thing they are waiting for — a sheet of paper being set — and says which
/// of the honest steps it is on: looking for the latest version, then
/// downloading it. The animation runs only while one of those is really in
/// flight; the states that are *not* waiting on anything (an error, a locked
/// book) do not use this and hold still.
///
/// Fades in a beat late so a book that is already on the device — which opens
/// in a few frames — never flashes a screen that was gone before it was read.
class ReaderOpeningState extends StatelessWidget {
  const ReaderOpeningState({
    this.title,
    this.headline = 'Opening your book',
    this.detail,
    this.progress,
    this.receivedBytes = 0,
    this.totalBytes = 0,
    super.key,
  });

  /// The book's name, when the caller knows it.
  final String? title;

  /// What is happening right now, as one short line.
  final String headline;

  /// A quieter line under it — the step, or the numbers behind the bar.
  final String? detail;

  /// 0..1 once the size is known; null shows the bar sweeping instead.
  final double? progress;

  final int receivedBytes;
  final int totalBytes;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final title = this.title;
    final numbers = _numbersLine();
    final second = detail ?? numbers;

    return Semantics(
      container: true,
      liveRegion: true,
      label: headline,
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.lg,
            vertical: AppSpacing.lg,
          ),
          child: AppEntrance(
            duration: AppMotion.slow,
            offset: 8,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const _PagePlaceholder(),
                const SizedBox(height: AppSpacing.lg),
                if (title != null && title.isNotEmpty) ...[
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 280),
                    child: Text(
                      title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.center,
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                  const SizedBox(height: AppSpacing.xs),
                ],
                RisingStatusText(
                  text: headline,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: colors.onSurface,
                  ),
                ),
                const SizedBox(height: AppSpacing.sm),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 240),
                  child: PlanBuildProgressBar(
                    value: progress,
                    height: 6,
                    semanticLabel: headline,
                  ),
                ),
                const SizedBox(height: AppSpacing.xs),
                // Always laid out, so the bar does not jump when the numbers
                // arrive and the line has something to say.
                ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: 20),
                  child: second == null
                      ? null
                      : Text(
                          second,
                          textAlign: TextAlign.center,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: colors.onSurfaceVariant,
                          ),
                        ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// "47%  ·  1.4 of 3.0 MB", once there is a size to measure against.
  String? _numbersLine() {
    final value = progress;
    if (value == null) return null;
    final percent = '${(value * 100).round()}%';
    if (totalBytes <= 0) return percent;
    return '$percent  ·  ${_megabytes(receivedBytes)} of '
        '${_megabytes(totalBytes)}';
  }

  static String _megabytes(int bytes) {
    final megabytes = bytes / (1024 * 1024);
    if (megabytes >= 10) return '${megabytes.round()} MB';
    if (megabytes >= 0.1) return '${megabytes.toStringAsFixed(1)} MB';
    return '${(bytes / 1024).ceil()} KB';
  }
}

/// A sheet of paper with its lines not yet set, and the mark that says the
/// press is running.
class _PagePlaceholder extends StatelessWidget {
  const _PagePlaceholder();

  static const _lines = <double>[0.92, 1, 0.86, 1, 0.64];

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ExcludeSemantics(
      child: SizedBox(
        width: 168,
        height: 216,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            Positioned.fill(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: colors.surfaceContainerLowest,
                  borderRadius: BorderRadius.circular(AppRadii.compact),
                  border: Border.all(color: colors.outlineVariant),
                ),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(18, 22, 18, 18),
                  child: AppShimmer(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        _bar(colors, 0.5, height: 12),
                        const SizedBox(height: 18),
                        for (final factor in _lines) ...[
                          _bar(colors, factor),
                          const SizedBox(height: 9),
                        ],
                        const SizedBox(height: 9),
                        _bar(colors, 0.94),
                        const SizedBox(height: 9),
                        _bar(colors, 0.7),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            PositionedDirectional(
              end: -14,
              bottom: -14,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: colors.surface,
                  shape: BoxShape.circle,
                  border: Border.all(color: colors.outlineVariant),
                ),
                child: Padding(
                  padding: const EdgeInsets.all(9),
                  child: PlanBuildSparkle(color: colors.primary, size: 24),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _bar(ColorScheme colors, double widthFactor, {double height = 7}) {
    return FractionallySizedBox(
      alignment: AlignmentDirectional.centerStart,
      widthFactor: widthFactor,
      child: Container(
        height: height,
        decoration: BoxDecoration(
          color: colors.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(4),
        ),
      ),
    );
  }
}

import 'package:flutter/material.dart';

import '../motion.dart';
import 'app_tokens.dart';

/// The colour every skeleton block is drawn in.
///
/// One step darker than a card on light (so a block reads against white), one
/// step lighter than a card on dark.
Color appSkeletonColor(BuildContext context) {
  final scheme = Theme.of(context).colorScheme;
  return scheme.brightness == Brightness.light
      ? scheme.outlineVariant
      : scheme.surfaceContainerHighest;
}

/// One placeholder block: a rectangle, a line of text, or a circle.
///
/// Draw a whole placeholder screen from these inside one [AppSkeletonGroup],
/// which owns the shimmer and the screen-reader announcement. On their own they
/// are static, so a feature can lay them out to match its real content exactly
/// (same paddings, same heights) and swap in the data without a jump.
class AppSkeleton extends StatelessWidget {
  /// A rounded rectangle: a cover, a thumbnail, a card body.
  const AppSkeleton.box({
    this.width,
    this.height = 96,
    this.radius = AppRadii.compact,
    super.key,
  }) : _circle = false,
       widthFactor = null;

  /// A line of text. Give a [width] or a [widthFactor] of the space available;
  /// the height defaults to a body line.
  const AppSkeleton.line({
    this.width,
    this.widthFactor,
    this.height = 12,
    super.key,
  }) : _circle = false,
       radius = 999;

  /// A round avatar or icon well.
  const AppSkeleton.circle({required double size, super.key})
    : width = size,
      height = size,
      radius = 999,
      widthFactor = null,
      _circle = true;

  final double? width;
  final double? widthFactor;
  final double height;
  final double radius;
  final bool _circle;

  @override
  Widget build(BuildContext context) {
    Widget block = SizedBox(
      width: width,
      height: height,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: appSkeletonColor(context),
          shape: _circle ? BoxShape.circle : BoxShape.rectangle,
          borderRadius: _circle ? null : BorderRadius.circular(radius),
        ),
      ),
    );
    if (widthFactor != null) {
      block = FractionallySizedBox(
        alignment: AlignmentDirectional.centerStart,
        widthFactor: widthFactor,
        child: block,
      );
    }
    return ExcludeSemantics(child: block);
  }
}

/// Wraps a group of [AppSkeleton]s: a light sweeping across all of them at
/// once, one announcement for a screen reader instead of one per block, and a
/// still, dimmed placeholder when the platform asks for reduced motion.
class AppSkeletonGroup extends StatelessWidget {
  const AppSkeletonGroup({
    required this.child,
    this.label = 'Loading',
    super.key,
  });

  final Widget child;

  /// What a screen reader says while the group is on screen.
  final String label;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      liveRegion: true,
      label: label,
      child: ExcludeSemantics(child: AppShimmer(sweep: true, child: child)),
    );
  }
}

/// A list of rows, each an optional leading well and two lines of text: the
/// shape of a library, a history, a settings list.
class AppSkeletonList extends StatelessWidget {
  const AppSkeletonList({
    this.itemCount = 4,
    this.leading = AppSkeletonLeading.box,
    this.label = 'Loading',
    this.padding = EdgeInsets.zero,
    this.gap = AppSpacing.md,
    super.key,
  });

  final int itemCount;
  final AppSkeletonLeading leading;
  final String label;
  final EdgeInsetsGeometry padding;
  final double gap;

  @override
  Widget build(BuildContext context) {
    return AppSkeletonGroup(
      label: label,
      child: Padding(
        padding: padding,
        child: Column(
          children: [
            for (var i = 0; i < itemCount; i++) ...[
              if (i > 0) SizedBox(height: gap),
              _SkeletonRow(leading: leading, variant: i),
            ],
          ],
        ),
      ),
    );
  }
}

enum AppSkeletonLeading { none, box, circle }

class _SkeletonRow extends StatelessWidget {
  const _SkeletonRow({required this.leading, required this.variant});

  final AppSkeletonLeading leading;

  /// Varies the line lengths row to row, so a stack of them does not read as
  /// a pattern (or as a single repeated, broken widget).
  final int variant;

  @override
  Widget build(BuildContext context) {
    const titleFactors = [0.62, 0.48, 0.7, 0.55];
    const bodyFactors = [0.9, 0.78, 0.84, 0.7];
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        switch (leading) {
          AppSkeletonLeading.none => const SizedBox.shrink(),
          AppSkeletonLeading.box => const AppSkeleton.box(
            width: 56,
            height: 56,
          ),
          AppSkeletonLeading.circle => const AppSkeleton.circle(size: 48),
        },
        if (leading != AppSkeletonLeading.none)
          const SizedBox(width: AppSpacing.sm),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              AppSkeleton.line(
                widthFactor: titleFactors[variant % titleFactors.length],
                height: 14,
              ),
              const SizedBox(height: AppSpacing.xs),
              AppSkeleton.line(
                widthFactor: bodyFactors[variant % bodyFactors.length],
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// One card-shaped placeholder: an optional picture, a title and a few lines of
/// text on the app's own card surface.
class AppSkeletonCard extends StatelessWidget {
  const AppSkeletonCard({
    this.lines = 3,
    this.mediaHeight,
    this.label = 'Loading',
    super.key,
  });

  final int lines;

  /// Height of the picture block at the top; null for a text-only card.
  final double? mediaHeight;
  final String label;

  @override
  Widget build(BuildContext context) {
    return AppSkeletonGroup(
      label: label,
      child: _SkeletonCardBody(lines: lines, mediaHeight: mediaHeight),
    );
  }
}

class _SkeletonCardBody extends StatelessWidget {
  const _SkeletonCardBody({required this.lines, required this.mediaHeight});

  final int lines;
  final double? mediaHeight;

  @override
  Widget build(BuildContext context) {
    return Card(
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (mediaHeight != null)
            AppSkeleton.box(height: mediaHeight!, radius: 0),
          Padding(
            padding: const EdgeInsets.all(AppSpacing.md),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const AppSkeleton.line(widthFactor: 0.55, height: 16),
                for (var i = 0; i < lines; i++) ...[
                  const SizedBox(height: AppSpacing.xs + 2),
                  AppSkeleton.line(widthFactor: i == lines - 1 ? 0.65 : 1),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// [count] card placeholders, spaced like a real list of cards, under one
/// shimmer and one announcement.
class AppSkeletonCardList extends StatelessWidget {
  const AppSkeletonCardList({
    this.count = 3,
    this.lines = 3,
    this.mediaHeight,
    this.padding = EdgeInsets.zero,
    this.label = 'Loading',
    super.key,
  });

  final int count;
  final int lines;
  final double? mediaHeight;
  final EdgeInsetsGeometry padding;
  final String label;

  @override
  Widget build(BuildContext context) {
    return AppSkeletonGroup(
      label: label,
      child: Padding(
        padding: padding,
        child: Column(
          children: [
            for (var i = 0; i < count; i++) ...[
              if (i > 0) const SizedBox(height: AppSpacing.sm),
              _SkeletonCardBody(lines: lines, mediaHeight: mediaHeight),
            ],
          ],
        ),
      ),
    );
  }
}

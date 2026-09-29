import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';

// What the book page looks like before it knows anything: the hero's cover and
// title, the action row, and two cards, in the places the real ones land. A
// spinner over a blank page says nothing about what is coming; this says a book
// is coming, and where its parts will be.
//
// Every block is the design system's [AppSkeleton] sized to the real element it
// stands in for; [BookSkeletonBox] only fixes the fill-the-width default.

/// One placeholder block. Sized by its caller, coloured by the theme.
class BookSkeletonBox extends StatelessWidget {
  const BookSkeletonBox({
    required this.height,
    this.width,
    this.radius = AppRadii.compact,
    super.key,
  });

  final double height;

  /// Null fills the available width.
  final double? width;
  final double radius;

  @override
  Widget build(BuildContext context) {
    // Filling, not shrink-wrapped: a box with no child and no width would
    // collapse to nothing inside a start-aligned column.
    return AppSkeleton.box(
      width: width ?? double.infinity,
      height: height,
      radius: radius,
    );
  }
}

/// The book page while neither the status nor the detail has arrived.
class BookScreenSkeleton extends StatelessWidget {
  const BookScreenSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return AppSkeletonGroup(
      label: 'Opening your book',
      child: SingleChildScrollView(
        // Nothing here is worth scrolling, and a drag on a placeholder that
        // then swaps for the real list would read as a glitch.
        physics: const NeverScrollableScrollPhysics(),
        padding: AppInsets.screen,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const BookHeroSkeleton(withActions: true),
            const SizedBox(height: AppSpacing.sm),
            _cardSkeleton(context, lines: 2),
            const SizedBox(height: AppSpacing.sm),
            _cardSkeleton(context, lines: 3),
          ],
        ),
      ),
    );
  }

  Widget _cardSkeleton(BuildContext context, {required int lines}) {
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const BookSkeletonBox(height: 18, width: 140),
          const SizedBox(height: AppSpacing.sm),
          for (var i = 0; i < lines; i++) ...[
            BookSkeletonBox(height: 12, width: i == lines - 1 ? 200 : null),
            if (i < lines - 1) const SizedBox(height: AppSpacing.xs),
          ],
        ],
      ),
    );
  }
}

/// The hero's own shape: cover, title lines, and optionally the action row.
class BookHeroSkeleton extends StatelessWidget {
  const BookHeroSkeleton({this.withActions = false, super.key});

  final bool withActions;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const BookSkeletonBox(width: 96, height: 144, radius: 10),
              const SizedBox(width: AppSpacing.md),
              const Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    BookSkeletonBox(height: 24),
                    SizedBox(height: AppSpacing.xs),
                    BookSkeletonBox(height: 24, width: 120),
                    SizedBox(height: AppSpacing.sm),
                    BookSkeletonBox(height: 12, width: 90),
                    SizedBox(height: AppSpacing.sm),
                    BookSkeletonBox(height: 12),
                    SizedBox(height: AppSpacing.xs),
                    BookSkeletonBox(height: 12, width: 140),
                  ],
                ),
              ),
            ],
          ),
          if (withActions) ...[
            const SizedBox(height: AppSpacing.md),
            const BookSkeletonBox(
              height: AppSizes.controlHeight,
              radius: AppRadii.control,
            ),
            const SizedBox(height: AppSpacing.sm),
            const Row(
              children: [
                Expanded(
                  child: BookSkeletonBox(height: 60, radius: AppRadii.control),
                ),
                SizedBox(width: AppSpacing.xs),
                Expanded(
                  child: BookSkeletonBox(height: 60, radius: AppRadii.control),
                ),
                SizedBox(width: AppSpacing.xs),
                Expanded(
                  child: BookSkeletonBox(height: 60, radius: AppRadii.control),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

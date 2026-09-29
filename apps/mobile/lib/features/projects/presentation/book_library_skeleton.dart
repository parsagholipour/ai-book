import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';

/// The library while its first fetch runs: the search field and a few cards
/// drawn as shapes, in the places the real ones will land.
///
/// A centred spinner says "wait"; this says "your books, in a moment", and the
/// screen does not rearrange itself when they arrive.
class BookLibrarySkeleton extends StatelessWidget {
  const BookLibrarySkeleton({this.cards = 5, super.key});

  final int cards;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final fill = colors.onSurface.withValues(alpha: 0.10);

    Widget block({double? width, required double height, double radius = 6}) {
      return Container(
        width: width,
        height: height,
        decoration: BoxDecoration(
          color: fill,
          borderRadius: BorderRadius.circular(radius),
        ),
      );
    }

    Widget card() {
      return Card(
        margin: EdgeInsets.zero,
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              block(width: 72, height: 108, radius: 10),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    block(height: 16),
                    const SizedBox(height: 8),
                    block(width: 140, height: 16),
                    const SizedBox(height: 14),
                    block(width: 92, height: 22, radius: AppRadii.compact),
                    const SizedBox(height: 14),
                    block(width: 170, height: 12),
                  ],
                ),
              ),
            ],
          ),
        ),
      );
    }

    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Loading your books',
      child: ExcludeSemantics(
        child: AppShimmer(
          child: ListView(
            physics: const NeverScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(18, 12, 18, 24),
            children: [
              block(height: 56, radius: AppRadii.control),
              const SizedBox(height: AppSpacing.sm),
              // Clipped rather than wrapped: at a narrow width the third chip
              // simply runs off the edge, like the real row does.
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                physics: const NeverScrollableScrollPhysics(),
                child: Row(
                  children: [
                    for (final width in const [88.0, 112.0, 96.0]) ...[
                      block(width: width, height: 32, radius: AppRadii.pill),
                      const SizedBox(width: AppSpacing.xs),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: AppSpacing.lg),
              for (var i = 0; i < cards; i++) ...[
                card(),
                const SizedBox(height: AppSpacing.sm),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

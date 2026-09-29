import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';

/// The library while it loads: the same rows and cards it will become, so the
/// page does not rearrange itself when the cast arrives.
class CharacterLibrarySkeleton extends StatelessWidget {
  const CharacterLibrarySkeleton({
    required this.columns,
    required this.cardExtent,
    super.key,
  });

  /// How many cards abreast the real grid will draw; one is the list.
  final int columns;

  /// The height of one card, so the skeleton is the size of what replaces it.
  final double cardExtent;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Loading your characters',
      child: ExcludeSemantics(
        child: AppShimmer(
          child: SingleChildScrollView(
            physics: const NeverScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(18, 16, 18, 0),
            child: LayoutBuilder(
              builder: (context, constraints) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _Block(
                      height: 56,
                      radius: AppRadii.control,
                      colors: colors,
                    ),
                    const SizedBox(height: AppSpacing.md),
                    for (var row = 0; row < (columns == 1 ? 3 : 2); row++) ...[
                      Row(
                        children: [
                          for (var column = 0; column < columns; column++) ...[
                            if (column > 0)
                              const SizedBox(width: AppSpacing.sm),
                            Expanded(
                              child: _CardBlock(
                                height: columns == 1 ? 128 : cardExtent,
                                row: columns == 1,
                                colors: colors,
                              ),
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: AppSpacing.md),
                    ],
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}

class _Block extends StatelessWidget {
  const _Block({
    required this.height,
    required this.radius,
    required this.colors,
    this.width,
  });

  final double height;
  final double? width;
  final double radius;
  final ColorScheme colors;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: height,
      width: width,
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(radius),
      ),
    );
  }
}

class _CardBlock extends StatelessWidget {
  const _CardBlock({
    required this.height,
    required this.row,
    required this.colors,
  });

  final double height;
  final bool row;
  final ColorScheme colors;

  @override
  Widget build(BuildContext context) {
    final lines = [
      _Block(height: 16, width: 110, radius: 6, colors: colors),
      const SizedBox(height: AppSpacing.xs),
      _Block(height: 12, radius: 6, colors: colors),
    ];
    return Container(
      height: height,
      padding: EdgeInsets.all(row ? AppSpacing.sm : 0),
      decoration: BoxDecoration(
        color: colors.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(AppRadii.card),
        border: Border.all(color: colors.outlineVariant),
      ),
      clipBehavior: Clip.antiAlias,
      child: row
          ? Row(
              children: [
                _Block(
                  height: 104,
                  width: 84,
                  radius: AppRadii.control,
                  colors: colors,
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: lines,
                  ),
                ),
              ],
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(child: ColoredBox(color: colors.surfaceContainerHigh)),
                Padding(
                  padding: const EdgeInsets.all(AppSpacing.sm),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: lines,
                  ),
                ),
              ],
            ),
    );
  }
}

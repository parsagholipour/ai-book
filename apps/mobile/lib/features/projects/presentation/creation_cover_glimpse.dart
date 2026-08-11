import 'package:flutter/material.dart';

import '../../../shared/ui/motion.dart';
import 'book_cover.dart';

/// The little book at the head of the creation chat: a cover that
/// materializes as the brief fills in.
///
/// Readiness drives opacity, so an empty idea reads as the ghost of a book
/// and a buildable one reads as a finished object. The palette comes from
/// the server's cover-design glimpse when one exists (the same catalog the
/// real designed cover is picked from), else from [BookCover]'s seeded
/// placeholder — the same widget the library shelf uses, so the book the
/// user watches forming here is the book they later shelve.
class CreationCoverGlimpse extends StatelessWidget {
  const CreationCoverGlimpse({
    required this.title,
    required this.readinessScore,
    required this.canBuild,
    required this.seed,
    this.palette,
    this.width = 28,
    super.key,
  });

  /// Working title typeset on the cover; null renders an untitled ghost.
  final String? title;

  /// Brief readiness, 0–100.
  final int readinessScore;

  /// A buildable brief shows the cover at full strength whatever the score.
  final bool canBuild;

  /// Stable string (normally the draft id) for the fallback palette.
  final String seed;

  /// Server cover-design colours; null falls back to the seeded palette.
  final List<Color>? palette;

  /// Kept small on purpose: the glimpse lives in a helper bar, so it reads
  /// as a status mark that happens to be a book, not a hero image.
  final double width;

  @override
  Widget build(BuildContext context) {
    final score = readinessScore.clamp(0, 100);
    // Never fully invisible: a ghost of a book invites filling it in, an
    // empty gap in the row does not.
    final solidity = canBuild ? 1.0 : 0.35 + 0.65 * (score / 100);

    return Semantics(
      label: 'Cover preview',
      child: ExcludeSemantics(
        child: TweenAnimationBuilder<double>(
          tween: Tween<double>(end: solidity),
          duration: AppMotion.reducedMotion(context)
              ? Duration.zero
              : AppMotion.slow,
          curve: AppMotion.standard,
          child: BookCover(
            title: title ?? '',
            seed: seed,
            palette: palette,
            width: width,
            // The default radius reads blobby this small.
            borderRadius: (width / 5).clamp(4.0, 10.0),
          ),
          builder: (context, value, child) =>
              Opacity(opacity: value, child: child),
        ),
      ),
    );
  }
}

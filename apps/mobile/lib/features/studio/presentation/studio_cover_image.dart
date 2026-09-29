import 'package:flutter/material.dart';

import '../../../shared/ui/authed_network_image.dart';
import '../../../shared/ui/motion.dart';
import '../../projects/presentation/book_cover.dart';
import '../../projects/presentation/plan_build_progress.dart';
import '../domain/assist_models.dart';

// A Studio book's cover as it is drawn wherever it appears — the picker, the
// writing card — and the words that say what it is.

/// One line saying what the book's cover is now.
String studioCoverSummary(ManuscriptCover cover) {
  if (cover.pending) {
    return cover.source == ManuscriptCoverSource.ai
        ? 'Being drawn…'
        : 'Being made…';
  }
  return switch (cover.source) {
    ManuscriptCoverSource.design => 'Designed with your title and name',
    ManuscriptCoverSource.upload => 'Your own picture',
    ManuscriptCoverSource.ai => 'Drawn with AI',
  };
}

/// What the chosen kind of cover is, for under the choices.
String studioCoverDescription(ManuscriptCover cover) => switch (cover.source) {
  ManuscriptCoverSource.design =>
    'A clean typographic cover with your title and name.',
  ManuscriptCoverSource.upload =>
    'Your picture is the front cover. Choose it again to use a '
        'different one.',
  ManuscriptCoverSource.ai =>
    'Drawn from your book’s title and story. Generate again for a '
        'different one.',
};

/// A Studio book's cover: the picture when there is one, over the designed
/// placeholder the rest of the app draws from the title (so a slow network
/// still shows a book), veiled with a sparkle while a new one is being made.
///
/// A redrawn cover keeps its server path, but the API versions every cover URL
/// (`?v=`), so a new cover is a new [ManuscriptCover.imageUrl] and a new
/// request; the URL is used as it arrives.
class StudioCoverImage extends StatelessWidget {
  const StudioCoverImage({
    required this.projectId,
    required this.title,
    required this.cover,
    this.authorName,
    this.width,
    this.radius = 10,
    this.working = false,
    super.key,
  });

  final String projectId;
  final String title;
  final String? authorName;
  final ManuscriptCover cover;
  final double? width;
  final double radius;

  /// A request is on its way, whatever [cover] says yet.
  final bool working;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final url = cover.imageUrl;
    final busy = working || cover.pending;
    final size = width;
    Widget face = Stack(
      fit: StackFit.expand,
      children: [
        BookCover(
          title: title,
          seed: projectId,
          authorName: authorName,
          elevated: false,
          borderRadius: 0,
        ),
        if (url != null) ...[
          AuthedNetworkImage(
            key: ValueKey(url),
            url: url,
            cacheBuster: null,
            fit: BoxFit.cover,
            transitionDuration: AppMotion.medium,
          ),
          // The placeholder's own spine is under the picture now.
          const Positioned(
            left: 0,
            top: 0,
            bottom: 0,
            width: 6,
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [Color(0x47000000), Color(0x05000000)],
                ),
              ),
            ),
          ),
        ],
      ],
    );
    if (size != null && size < _coverDesignWidth) {
      // The placeholder sets its type for a cover a hand's width across; at a
      // thumbnail's width the title breaks mid-word or drops out. Drawn at that
      // width and scaled down, a thumbnail is the same cover, smaller.
      face = FittedBox(
        fit: BoxFit.cover,
        clipBehavior: Clip.hardEdge,
        child: SizedBox(
          width: _coverDesignWidth,
          height: _coverDesignWidth / kBookCoverAspectRatio,
          child: face,
        ),
      );
    }
    final art = Stack(
      fit: StackFit.expand,
      children: [
        face,
        AnimatedSwitcher(
          duration: AppMotion.adapt(context, AppMotion.medium),
          child: busy
              ? ColoredBox(
                  key: const ValueKey('cover-veil'),
                  color: colors.primaryContainer.withValues(alpha: 0.55),
                  child: Center(
                    child: PlanBuildSparkle(
                      color: colors.primary,
                      size: ((size ?? 96) / 3).clamp(16, 32).toDouble(),
                    ),
                  ),
                )
              : const SizedBox.shrink(key: ValueKey('cover-clear')),
        ),
      ],
    );
    final framed = AspectRatio(
      aspectRatio: kBookCoverAspectRatio,
      child: DecoratedBox(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(radius),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.16),
              blurRadius: 8,
              offset: const Offset(0, 3),
            ),
          ],
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(radius),
          child: art,
        ),
      ),
    );
    return Semantics(
      image: true,
      label: busy ? 'Cover for $title, being made' : 'Cover for $title',
      child: ExcludeSemantics(
        child: size == null ? framed : SizedBox(width: size, child: framed),
      ),
    );
  }
}

/// The width a Studio cover is drawn at before a thumbnail scales it down.
const _coverDesignWidth = 144.0;

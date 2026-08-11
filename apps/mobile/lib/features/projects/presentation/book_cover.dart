import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/ui/motion.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';

/// Standard proportions of a printed trade paperback. Every cover in the app
/// uses this so a shelf of books lines up.
const double kBookCoverAspectRatio = 2 / 3;

/// A book cover tile.
///
/// Renders real cover art when the project has it. Until the cover job
/// finishes — which is most of a book's life — it renders a designed
/// placeholder built from the title rather than a grey box, so the library
/// always reads as a shelf of books the user made.
class BookCover extends ConsumerWidget {
  const BookCover({
    required this.title,
    required this.seed,
    this.image,
    this.authorName,
    this.width,
    this.palette,
    this.borderRadius = 10,
    super.key,
  });

  /// Title drawn on the placeholder cover.
  final String title;

  /// Stable string (normally the project id) that picks the placeholder
  /// palette, so a given book keeps the same colours between launches.
  final String seed;

  /// Overrides the seeded placeholder palette: the first two colours paint
  /// the gradient and an optional third paints the rule accent. Real cover
  /// art still wins over both. The creation chat passes the server's
  /// cover-design glimpse through here.
  final List<Color>? palette;

  final MobileProjectImage? image;
  final String? authorName;
  final double? width;
  final double borderRadius;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final radius = BorderRadius.circular(borderRadius);
    final cover = AspectRatio(
      aspectRatio: kBookCoverAspectRatio,
      child: DecoratedBox(
        decoration: BoxDecoration(
          borderRadius: radius,
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.18),
              blurRadius: 10,
              offset: const Offset(0, 4),
            ),
          ],
        ),
        child: ClipRRect(
          borderRadius: radius,
          child: Stack(
            fit: StackFit.expand,
            children: [
              _CoverArtwork(
                title: title,
                seed: seed,
                authorName: authorName,
                image: image,
                palette: palette,
              ),
              // A faint spine down the binding edge: the cue that reads as
              // "book" more than any other single detail.
              Positioned(
                left: 0,
                top: 0,
                bottom: 0,
                width: 6,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      colors: [
                        Colors.black.withValues(alpha: 0.28),
                        Colors.black.withValues(alpha: 0.02),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );

    final label = image?.altText.isNotEmpty == true
        ? image!.altText
        : 'Cover for $title';

    return Semantics(
      image: true,
      label: label,
      child: ExcludeSemantics(
        child: width == null ? cover : SizedBox(width: width, child: cover),
      ),
    );
  }
}

class _CoverArtwork extends ConsumerWidget {
  const _CoverArtwork({
    required this.title,
    required this.seed,
    required this.image,
    this.authorName,
    this.palette,
  });

  final String title;
  final String seed;
  final String? authorName;
  final MobileProjectImage? image;
  final List<Color>? palette;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final cover = image;
    final placeholder = _PlaceholderCover(
      title: title,
      seed: seed,
      authorName: authorName,
      palette: palette,
    );
    if (cover == null) {
      return placeholder;
    }

    final headers = ref.watch(projectAssetHeadersProvider);
    final config = ref.watch(appConfigProvider);
    final uri = config.apiBaseUrl.resolve(cover.url).toString();

    return headers.when(
      // The placeholder stays visible underneath while the art loads, so a
      // slow network shows a book rather than an empty frame.
      data: (value) => Image.network(
        uri,
        headers: value,
        fit: BoxFit.cover,
        errorBuilder: (context, error, stackTrace) => placeholder,
        frameBuilder: (context, child, frame, wasSynchronouslyLoaded) {
          if (wasSynchronouslyLoaded || frame != null) {
            return AnimatedSwitcher(
              duration: AppMotion.medium,
              child: KeyedSubtree(key: const ValueKey('art'), child: child),
            );
          }
          return placeholder;
        },
      ),
      loading: () => placeholder,
      error: (error, stackTrace) => placeholder,
    );
  }
}

/// A cover generated from the book's own title and a seeded palette.
class _PlaceholderCover extends StatelessWidget {
  const _PlaceholderCover({
    required this.title,
    required this.seed,
    this.authorName,
    this.palette,
  });

  final String title;
  final String seed;
  final String? authorName;
  final List<Color>? palette;

  @override
  Widget build(BuildContext context) {
    final override = palette;
    final gradient = override != null && override.length >= 2
        ? [override[0], override[1]]
        : _paletteFor(seed);
    final rule = override != null && override.length >= 3
        ? override[2]
        : Colors.white.withValues(alpha: 0.7);
    final display = title.trim().isEmpty ? 'Untitled book' : title.trim();

    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: gradient,
        ),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          // Type scales with the tile so one widget serves both a 56px shelf
          // thumbnail and a full-width hero cover.
          final scale = constraints.maxWidth / 150;
          final titleSize = (15 * scale).clamp(7.0, 30.0).toDouble();
          final ruleWidth = (26 * scale).clamp(10.0, 52.0).toDouble();
          final pad = (14 * scale).clamp(6.0, 26.0).toDouble();
          // Below this the type cannot get smaller, only more cramped: the
          // tile reads better as pure palette and rule (the creation chat's
          // helper-bar glimpse is the case).
          final showTitle = constraints.maxWidth >= 44;
          final showAuthor =
              constraints.maxWidth > 92 &&
              authorName?.trim().isNotEmpty == true;

          return Padding(
            padding: EdgeInsets.all(pad),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                Container(
                  width: ruleWidth,
                  height: (2 * scale).clamp(1.0, 3.0).toDouble(),
                  color: rule,
                ),
                if (showTitle) ...[
                  SizedBox(height: (8 * scale).clamp(4.0, 14.0).toDouble()),
                  Text(
                    display,
                    maxLines: 4,
                    overflow: TextOverflow.ellipsis,
                    // Cover type is artwork sized to the tile, not UI text:
                    // the finished cover art it stands in for does not
                    // inflate with the text-scale setting, and a scaled line
                    // overflows the cover's fixed aspect box at thumbnail
                    // sizes.
                    textScaler: TextScaler.noScaling,
                    style: TextStyle(
                      fontFamily: 'Manrope',
                      color: Colors.white,
                      fontSize: titleSize,
                      height: 1.15,
                      fontWeight: FontWeight.w800,
                      letterSpacing: -0.2,
                    ),
                  ),
                ],
                if (showAuthor) ...[
                  SizedBox(height: (6 * scale).clamp(3.0, 10.0).toDouble()),
                  Text(
                    authorName!.trim(),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textScaler: TextScaler.noScaling,
                    style: TextStyle(
                      fontFamily: 'Manrope',
                      color: Colors.white.withValues(alpha: 0.82),
                      fontSize: (titleSize * 0.62).clamp(6.0, 15.0).toDouble(),
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ],
            ),
          );
        },
      ),
    );
  }
}

/// Deep, saturated pairs that all carry white text at AA contrast.
const List<List<Color>> _coverPalettes = [
  [Color(0xFF0F6B5C), Color(0xFF0A3F35)],
  [Color(0xFF2E4C7E), Color(0xFF16233F)],
  [Color(0xFF7A3B12), Color(0xFF3D1D08)],
  [Color(0xFF5B2A6B), Color(0xFF2C1434)],
  [Color(0xFF8A2233), Color(0xFF45111A)],
  [Color(0xFF1F5B63), Color(0xFF0E2D31)],
  [Color(0xFF3F5A22), Color(0xFF1F2D11)],
  [Color(0xFF24405C), Color(0xFF10202E)],
];

List<Color> _paletteFor(String seed) {
  if (seed.isEmpty) {
    return _coverPalettes.first;
  }
  var hash = 0;
  for (final unit in seed.codeUnits) {
    hash = (hash * 31 + unit) & 0x7fffffff;
  }
  return _coverPalettes[hash % _coverPalettes.length];
}

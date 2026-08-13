import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/zoomable_image_viewer.dart';
import '../domain/character_image_models.dart';
import 'character_network_image.dart';

/// Opens the picture the reader tapped, with the rest of the history either
/// side of it.
Future<CharacterImageAction2?> showCharacterImageViewer({
  required BuildContext context,
  required List<CharacterImage> images,
  required int initialIndex,
  required String characterName,
}) {
  return showDismissibleFadeRoute<CharacterImageAction2>(
    context,
    CharacterImageViewer(
      images: images,
      initialIndex: initialIndex,
      characterName: characterName,
    ),
  );
}

/// What the viewer asks its caller to do next, keyed to a picture.
typedef CharacterImageAction2 = ({
  String imageId,
  CharacterViewerIntent intent,
});

enum CharacterViewerIntent { makeMain, showAsPhoto, options }

/// Character chrome around the shared zoomable gallery: per-picture actions
/// and a caption for where the bytes came from.
class CharacterImageViewer extends StatelessWidget {
  const CharacterImageViewer({
    required this.images,
    required this.initialIndex,
    required this.characterName,
    super.key,
  });

  final List<CharacterImage> images;
  final int initialIndex;
  final String characterName;

  @override
  Widget build(BuildContext context) {
    return ZoomableImageViewer(
      itemCount: images.length,
      initialIndex: initialIndex,
      itemBuilder: (context, index) {
        return CharacterNetworkImage(
          url: images[index].url,
          fit: BoxFit.contain,
          semanticLabel: characterName,
          placeholder: const Center(
            child: SizedBox.square(
              dimension: 28,
              child: CircularProgressIndicator(strokeWidth: 2.5),
            ),
          ),
          errorPlaceholder: const Center(
            child: Text(
              "Couldn't load this picture",
              style: TextStyle(color: Colors.white70),
            ),
          ),
        );
      },
      topBarTrailing: (context, index) {
        return IconButton(
          key: const ValueKey('character-viewer-options'),
          tooltip: 'Picture options',
          color: Colors.white,
          onPressed: () => Navigator.of(context).pop((
            imageId: images[index].id,
            intent: CharacterViewerIntent.options,
          )),
          icon: const Icon(Icons.more_horiz),
        );
      },
      bottomBar: (context, index) =>
          _CharacterViewerCaption(image: images[index]),
    );
  }
}

class _CharacterViewerCaption extends StatelessWidget {
  const _CharacterViewerCaption({required this.image});

  final CharacterImage image;

  @override
  Widget build(BuildContext context) {
    final caption = image.source == CharacterImageSource.generated
        ? 'AI illustration'
        : image.isOwnArtwork
        ? 'Your artwork'
        : 'Your photo';
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          image.isMain ? 'Main picture · $caption' : caption,
          textAlign: TextAlign.center,
          // Dark chrome in both themes: this sits on black, and inheriting
          // the scheme's foreground would be unreadable dark green in the
          // light theme.
          style: const TextStyle(color: Colors.white70),
        ),
        if (image.canBeMain || image.canBeShownAsPhoto) ...[
          const SizedBox(height: AppSpacing.xs),
          FilledButton.icon(
            key: const ValueKey('character-viewer-make-main'),
            onPressed: () => Navigator.of(context).pop((
              imageId: image.id,
              intent: image.canBeMain
                  ? CharacterViewerIntent.makeMain
                  : CharacterViewerIntent.showAsPhoto,
            )),
            icon: const Icon(Icons.check_circle_outline),
            label: Text(
              image.canBeMain
                  ? 'Make main picture'
                  : 'Show this as their picture',
            ),
          ),
        ],
      ],
    );
  }
}

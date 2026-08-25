import 'package:flutter/material.dart';

import '../../../shared/ui/authed_network_image.dart';
import '../domain/character_models.dart';

/// The character's face at [radius]: the finished portrait, else the uploaded
/// photo, else initials — with a progress veil while a portrait is being drawn.
///
/// Character images are served behind the mobile bearer token, so they load
/// with explicit auth headers rather than as plain network images, the same
/// way the voice call avatar does.
class CharacterAvatar extends StatelessWidget {
  const CharacterAvatar({
    required this.character,
    this.radius = 24,
    super.key,
  });

  final LibraryCharacter character;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final initials = _InitialsFace(initials: character.initials, radius: radius);

    Widget face = initials;
    final imageUrl = character.displayImageUrl;
    if (imageUrl != null) {
      // The photo and portrait are always served from the same two URLs, so
      // updatedAt busts the image cache when either is replaced.
      face = AuthedNetworkImage(
        url: imageUrl,
        cacheBuster: character.updatedAt.millisecondsSinceEpoch.toString(),
        fit: BoxFit.cover,
        semanticLabel: character.name,
        loadingPlaceholder: initials,
        errorPlaceholder: initials,
      );
    }

    if (character.portraitStatus.isBusy) {
      face = Stack(
        fit: StackFit.expand,
        children: [
          face,
          ColoredBox(color: colors.surface.withValues(alpha: 0.55)),
          Center(
            child: SizedBox.square(
              dimension: (radius * 0.9).clamp(14, 28).toDouble(),
              child: const CircularProgressIndicator(
                strokeWidth: 2,
                semanticsLabel: 'Drawing portrait',
              ),
            ),
          ),
        ],
      );
    }

    return ClipOval(
      child: SizedBox.square(dimension: radius * 2, child: face),
    );
  }
}

class _InitialsFace extends StatelessWidget {
  const _InitialsFace({required this.initials, required this.radius});

  final String initials;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ColoredBox(
      color: colors.surfaceContainerHighest,
      child: Center(
        child: Text(
          initials,
          style: TextStyle(
            fontSize: radius * 0.72,
            fontWeight: FontWeight.w700,
            color: colors.onSurfaceVariant,
          ),
        ),
      ),
    );
  }
}

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/character_image_models.dart';
import '../domain/character_models.dart';
import 'character_network_image.dart';

/// The character's picture at the size it deserves.
///
/// The library drew this face at 72px and nowhere else, which is why the
/// illustration a reader paid for could never actually be looked at.
class CharacterProfileHeader extends StatelessWidget {
  const CharacterProfileHeader({
    required this.character,
    required this.mainImage,
    required this.fallbackImageUrl,
    required this.pendingUpload,
    required this.uploadProgress,
    required this.onTapPicture,
    required this.onAddPicture,
    super.key,
  });

  final LibraryCharacter character;

  /// The picture every other surface calls main, or null while the character
  /// has none.
  final CharacterImage? mainImage;

  /// The character's own alias URL, used when the picture list could not be
  /// read at all. A failed history request is not the same as having no
  /// picture, and showing initials over a character who has one would be the
  /// app losing their face to a dropped connection.
  final String? fallbackImageUrl;

  /// Bytes the reader just approved, drawn immediately rather than after the
  /// round trip. Six seconds of nothing happening is the difference between a
  /// working upload and a broken one, as far as anyone can tell.
  final Uint8List? pendingUpload;
  final double? uploadProgress;

  final VoidCallback onTapPicture;
  final VoidCallback onAddPicture;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final pending = pendingUpload;

    Widget picture;
    if (pending != null) {
      picture = Image.memory(pending, fit: BoxFit.cover);
    } else if (mainImage != null || fallbackImageUrl != null) {
      picture = CharacterNetworkImage(
        url: mainImage?.url ?? fallbackImageUrl!,
        semanticLabel: character.name,
        decodeWidth: MediaQuery.sizeOf(context).width,
      );
    } else {
      picture = _InitialsPlate(character: character, onAdd: onAddPicture);
    }

    return Stack(
      fit: StackFit.expand,
      children: [
        GestureDetector(
          key: const ValueKey('character-profile-picture'),
          behavior: HitTestBehavior.opaque,
          onTap: mainImage == null || pending != null ? null : onTapPicture,
          child: Semantics(
            button: mainImage != null,
            label: mainImage == null
                ? 'No picture yet'
                : 'View ${character.name}',
            child: picture,
          ),
        ),
        // The one hardcoded colour on this screen, and it earns it: it sits
        // over a photograph rather than over a themed surface, so the app bar
        // title has to stay readable whatever the picture is.
        const IgnorePointer(
          child: DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [Color(0x66000000), Color(0x00000000), Color(0x44000000)],
                stops: [0, 0.45, 1],
              ),
            ),
          ),
        ),
        if (character.portraitStatus.isBusy)
          IgnorePointer(
            child: ColoredBox(
              color: colors.surface.withValues(alpha: 0.45),
              child: const Center(
                child: SizedBox.square(
                  dimension: 36,
                  child: CircularProgressIndicator(
                    semanticsLabel: 'Drawing the illustration',
                  ),
                ),
              ),
            ),
          ),
        if (pending != null)
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: AppAnimatedProgressBar(
              value: uploadProgress ?? 0,
              semanticLabel: 'Uploading your picture',
            ),
          ),
      ],
    );
  }
}

/// What a character with no picture at all shows: their initials, and the ask.
class _InitialsPlate extends StatelessWidget {
  const _InitialsPlate({required this.character, required this.onAdd});

  final LibraryCharacter character;
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ColoredBox(
      color: theme.colorScheme.surfaceContainerHigh,
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              character.initials,
              style: theme.textTheme.displayMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: AppSpacing.sm),
            AppButton.tonal(
              key: const ValueKey('character-header-add-picture'),
              label: 'Add a picture',
              leading: const Icon(Icons.add_photo_alternate_outlined),
              onPressed: onAdd,
            ),
          ],
        ),
      ),
    );
  }
}

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/character_image_models.dart';
import '../domain/character_models.dart';
import 'character_identity.dart';
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
        if (mainImage != null && pending == null)
          PositionedDirectional(
            bottom: AppSpacing.sm,
            end: AppSpacing.sm,
            child: IconButton.filledTonal(
              tooltip: 'View full picture',
              onPressed: onTapPicture,
              icon: const Icon(Icons.open_in_full_rounded),
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
    return Stack(
      fit: StackFit.expand,
      children: [
        CharacterIdentityArt(character: character),
        Positioned(
          left: AppSpacing.md,
          right: AppSpacing.md,
          bottom: AppSpacing.md,
          child: Center(
            child: AppButton.tonal(
              key: const ValueKey('character-header-add-picture'),
              label: 'Add a picture',
              leading: const Icon(Icons.add_photo_alternate_outlined),
              onPressed: onAdd,
            ),
          ),
        ),
      ],
    );
  }
}

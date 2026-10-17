import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/character_image_models.dart';
import '../domain/character_models.dart';
import 'character_identity.dart';
import 'character_network_image.dart';
import 'character_portrait_drawing.dart';

/// The character's picture at the size it deserves, and every state that
/// picture can be in.
///
/// The library drew this face at 72px and nowhere else, which is why the
/// illustration a reader paid for could never actually be looked at. Each state
/// here is its own composition rather than a spinner laid over the last one:
/// a picture (tap to zoom), a drawing in progress, an upload in flight, or — for
/// a character with nothing yet — the initials plate (tap to add a photo).
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
    final pending = pendingUpload;
    final drawing = character.portraitStatus.isBusy;
    final hasPicture =
        pending != null || mainImage != null || fallbackImageUrl != null;

    Widget picture;
    if (pending != null) {
      picture = Image.memory(
        pending,
        fit: BoxFit.cover,
        width: double.infinity,
        height: double.infinity,
      );
    } else if (mainImage != null || fallbackImageUrl != null) {
      picture = CharacterNetworkImage(
        url: mainImage?.url ?? fallbackImageUrl!,
        semanticLabel: character.name,
        decodeWidth: MediaQuery.sizeOf(context).width,
        fill: true,
      );
    } else {
      picture = _EmptyPlate(
        character: character,
        drawing: drawing,
        onAdd: onAddPicture,
      );
    }

    final canView = mainImage != null && pending == null;
    // An empty plate is the photo button's target too: tapping a face that is
    // not there yet is how most people try to add one.
    final canAdd = !hasPicture && !drawing;
    return Stack(
      fit: StackFit.expand,
      children: [
        GestureDetector(
          key: const ValueKey('character-profile-picture'),
          behavior: HitTestBehavior.opaque,
          onTap: canView
              ? onTapPicture
              : canAdd
              ? onAddPicture
              : null,
          child: Semantics(
            button: canView,
            label: hasPicture ? 'View ${character.name}' : 'No picture yet',
            child: picture,
          ),
        ),
        if (canView && !drawing)
          PositionedDirectional(
            bottom: AppSpacing.sm,
            end: AppSpacing.sm,
            child: _OverlayButton(
              icon: Icons.open_in_full_rounded,
              tooltip: 'View full picture',
              onPressed: onTapPicture,
            ),
          ),
        if (canView && !drawing && character.usedInBooks)
          const PositionedDirectional(
            top: AppSpacing.sm,
            start: AppSpacing.sm,
            child: AppStatusBadge(
              label: 'Ready for books',
              icon: Icons.check_circle_outline_rounded,
              tone: AppTone.success,
            ),
          )
        else if (canView &&
            !drawing &&
            characterPictureStatus(character) ==
                CharacterPictureStatus.photoOnly)
          const PositionedDirectional(
            top: AppSpacing.sm,
            start: AppSpacing.sm,
            child: AppStatusBadge(
              label: 'Photo only',
              icon: Icons.photo_camera_outlined,
              tone: AppTone.info,
            ),
          ),
        if (drawing)
          Positioned.fill(
            child: IgnorePointer(
              child: CharacterDrawingOverlay(name: character.name),
            ),
          ),
        if (pending != null) _UploadOverlay(progress: uploadProgress),
      ],
    );
  }
}

/// The round, translucent control every overlay on a picture uses, so it reads
/// on a dark photograph and a pale plate alike.
class _OverlayButton extends StatelessWidget {
  const _OverlayButton({
    required this.icon,
    required this.tooltip,
    required this.onPressed,
    super.key,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return IconButton.filled(
      tooltip: tooltip,
      onPressed: onPressed,
      style: IconButton.styleFrom(
        backgroundColor: colors.surface.withValues(alpha: 0.92),
        foregroundColor: colors.onSurface,
      ),
      icon: Icon(icon),
    );
  }
}

/// The frame the reader just approved, going up.
class _UploadOverlay extends StatelessWidget {
  const _UploadOverlay({required this.progress});

  final double? progress;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final percent = ((progress ?? 0) * 100).round();
    return Positioned.fill(
      child: IgnorePointer(
        child: Semantics(
          liveRegion: true,
          label: 'Uploading your picture',
          value: '$percent percent',
          child: ExcludeSemantics(
            child: Stack(
              fit: StackFit.expand,
              children: [
                ColoredBox(color: colors.surface.withValues(alpha: 0.4)),
                Align(
                  alignment: Alignment.bottomCenter,
                  child: Padding(
                    padding: const EdgeInsets.all(AppSpacing.md),
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        color: colors.surface.withValues(alpha: 0.94),
                        borderRadius: BorderRadius.circular(AppRadii.control),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.all(AppSpacing.sm),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Text(
                              'Uploading your picture · $percent%',
                              style: theme.textTheme.labelLarge,
                            ),
                            const SizedBox(height: AppSpacing.xs),
                            AppAnimatedProgressBar(value: progress ?? 0),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// What a character with no picture at all shows: their initials, centred on
/// the plate, and a corner button that adds a photo.
///
/// Nothing else is drawn over the plate. The photo and drawing buttons, with the
/// line about whose photos may be added, are in the reference card under the
/// name, so the empty plate has the same layout as one with a picture: the
/// face in the middle and one control in the corner.
class _EmptyPlate extends StatelessWidget {
  const _EmptyPlate({
    required this.character,
    required this.drawing,
    required this.onAdd,
  });

  final LibraryCharacter character;
  final bool drawing;
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: [
        CharacterIdentityArt(character: character),
        if (!drawing)
          PositionedDirectional(
            bottom: AppSpacing.sm,
            end: AppSpacing.sm,
            child: _OverlayButton(
              key: const ValueKey('character-header-add-picture'),
              icon: Icons.add_a_photo_outlined,
              tooltip: 'Add a photo',
              onPressed: onAdd,
            ),
          ),
      ],
    );
  }
}

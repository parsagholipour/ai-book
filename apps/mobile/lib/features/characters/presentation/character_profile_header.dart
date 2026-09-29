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
/// a character with nothing yet — the initials plate with the two ways out of
/// it.
class CharacterProfileHeader extends StatelessWidget {
  const CharacterProfileHeader({
    required this.character,
    required this.mainImage,
    required this.fallbackImageUrl,
    required this.pendingUpload,
    required this.uploadProgress,
    required this.onTapPicture,
    required this.onAddPicture,
    this.onDescribe,
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

  /// The second way out of an empty plate: write them down, then have them
  /// drawn. Absent, the plate offers only the photo.
  final VoidCallback? onDescribe;

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
        onDescribe: onDescribe,
      );
    }

    final canView = mainImage != null && pending == null;
    return Stack(
      fit: StackFit.expand,
      children: [
        GestureDetector(
          key: const ValueKey('character-profile-picture'),
          behavior: HitTestBehavior.opaque,
          onTap: canView ? onTapPicture : null,
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

/// What a character with no picture at all shows: their initials, and the two
/// ways out — a photo, or a description to draw from.
///
/// One pair of buttons here, and none repeated further down the page: the
/// reference card under it only prices the drawing.
class _EmptyPlate extends StatelessWidget {
  const _EmptyPlate({
    required this.character,
    required this.drawing,
    required this.onAdd,
    required this.onDescribe,
  });

  final LibraryCharacter character;
  final bool drawing;
  final VoidCallback onAdd;
  final VoidCallback? onDescribe;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final palette = characterPalette(theme.colorScheme, character.id);
    return Stack(
      fit: StackFit.expand,
      children: [
        CharacterIdentityArt(character: character, showInitials: false),
        Align(
          alignment: const Alignment(0, -0.36),
          child: Text(
            character.initials,
            textScaler: TextScaler.noScaling,
            style: TextStyle(
              fontSize: 84,
              fontWeight: FontWeight.w800,
              letterSpacing: -2,
              color: palette.foreground,
            ),
          ),
        ),
        if (!drawing) ...[
          const PositionedDirectional(
            top: AppSpacing.sm,
            start: AppSpacing.sm,
            child: AppStatusBadge(
              label: 'No picture yet',
              icon: Icons.add_photo_alternate_outlined,
            ),
          ),
          Align(
            alignment: Alignment.bottomCenter,
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.md),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  AppButton.primary(
                    key: const ValueKey('character-header-add-picture'),
                    label: 'Add a photo',
                    leading: const Icon(Icons.add_photo_alternate_outlined),
                    expanded: true,
                    onPressed: onAdd,
                  ),
                  if (onDescribe != null) ...[
                    const SizedBox(height: AppSpacing.xxs),
                    AppButton.text(
                      key: const ValueKey('character-header-describe'),
                      label: character.description.trim().isEmpty
                          ? 'Describe them'
                          : 'Edit their description',
                      leading: const Icon(Icons.notes_outlined),
                      expanded: true,
                      onPressed: onDescribe,
                    ),
                  ],
                ],
              ),
            ),
          ),
        ],
      ],
    );
  }
}

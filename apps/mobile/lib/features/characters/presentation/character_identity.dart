import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/authed_network_image.dart';
import '../domain/character_models.dart';

/// The palette pick for a character with no picture: stable per id, drawn from
/// the brand family only (mint, blue, sage), never gold.
///
/// One function for every surface that draws initials — the library card, the
/// profile hero, the small avatar — so a character is the same colour at every
/// size.
({Color background, Color foreground}) characterPalette(
  ColorScheme colors,
  String id,
) {
  final palette = [
    (colors.primaryContainer, colors.onPrimaryContainer),
    (colors.tertiaryContainer, colors.onTertiaryContainer),
    (colors.secondaryContainer, colors.onSecondaryContainer),
  ];
  final index = id.runes.fold(0, (sum, rune) => sum + rune) % palette.length;
  final (background, foreground) = palette[index];
  return (background: background, foreground: foreground);
}

/// A stable, themed identity even before the first picture is added.
///
/// Shared by the library card and the profile header so a character looks the
/// same at both sizes: the same palette pick, the same initials, the same
/// picture once there is one.
class CharacterIdentityArt extends StatelessWidget {
  const CharacterIdentityArt({required this.character, super.key});
  final LibraryCharacter character;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final palette = characterPalette(colors, character.id);
    final background = palette.background;
    final foreground = palette.foreground;
    final placeholder = ColoredBox(
      color: background,
      child: LayoutBuilder(
        builder: (context, constraints) => Stack(
          fit: StackFit.expand,
          children: [
            PositionedDirectional(
              bottom: -45,
              start: -30,
              child: Container(
                width: 160,
                height: 160,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: foreground.withValues(alpha: 0.08),
                    width: 28,
                  ),
                ),
              ),
            ),
            PositionedDirectional(
              top: -30,
              end: -24,
              child: Container(
                width: 110,
                height: 110,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: foreground.withValues(alpha: 0.05),
                ),
              ),
            ),
            Center(
              child: Text(
                character.initials,
                textScaler: TextScaler.noScaling,
                style: TextStyle(
                  fontSize: (constraints.maxHeight * 0.35).clamp(28, 88),
                  fontWeight: FontWeight.w800,
                  letterSpacing: -2,
                  color: foreground,
                ),
              ),
            ),
          ],
        ),
      ),
    );
    final url = character.displayImageUrl;
    return ExcludeSemantics(
      child: url == null
          ? placeholder
          : LayoutBuilder(
              builder: (_, constraints) => AuthedNetworkImage(
                url: url,
                cacheBuster: character.updatedAt.millisecondsSinceEpoch
                    .toString(),
                logicalDecodeWidth: constraints.maxWidth,
                fit: BoxFit.cover,
                loadingPlaceholder: placeholder,
                errorPlaceholder: placeholder,
              ),
            ),
    );
  }
}

/// Where a character's picture stands, as one value every card, row and header
/// reads instead of each re-deriving it.
///
/// A saved photograph is a face to browse, not yet artwork a book can use, so
/// [photoOnly] and [ready] are never the same thing.
enum CharacterPictureStatus { drawing, failed, ready, photoOnly, none }

CharacterPictureStatus characterPictureStatus(LibraryCharacter character) {
  if (character.portraitStatus.isBusy) return CharacterPictureStatus.drawing;
  if (character.portraitStatus == CharacterPortraitStatus.failed) {
    return CharacterPictureStatus.failed;
  }
  if (character.usedInBooks) return CharacterPictureStatus.ready;
  if (character.needsCartoonReference) return CharacterPictureStatus.photoOnly;
  return CharacterPictureStatus.none;
}

/// A small label for a picture status that needs the reader's eye.
///
/// A finished character carries no label at all — a check badge says it — so
/// the words on a card are only ever about something still owed.
class CharacterStatusPill extends StatelessWidget {
  const CharacterStatusPill({required this.character, super.key});

  final LibraryCharacter character;

  @override
  Widget build(BuildContext context) {
    final (label, icon, tone) = switch (characterPictureStatus(character)) {
      CharacterPictureStatus.drawing => (
        'Drawing',
        Icons.auto_awesome,
        AppTone.info,
      ),
      CharacterPictureStatus.failed => (
        'Couldn\'t draw · Retry',
        Icons.refresh_rounded,
        AppTone.error,
      ),
      CharacterPictureStatus.photoOnly => (
        'Photo only',
        Icons.photo_camera_outlined,
        AppTone.info,
      ),
      CharacterPictureStatus.none => (
        'No picture yet',
        Icons.add_photo_alternate_outlined,
        AppTone.neutral,
      ),
      CharacterPictureStatus.ready => ('', Icons.check, AppTone.success),
    };
    if (label.isEmpty) return const SizedBox.shrink();
    return AppStatusBadge(label: label, icon: icon, tone: tone);
  }
}

/// The corner check on a character a book can draw.
class CharacterReadyBadge extends StatelessWidget {
  const CharacterReadyBadge({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      label: 'Illustration ready',
      child: ExcludeSemantics(
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: colors.primary,
            shape: BoxShape.circle,
            border: Border.all(color: colors.surfaceContainerLowest, width: 2),
          ),
          child: Padding(
            padding: const EdgeInsets.all(4),
            child: Icon(Icons.check, size: 14, color: colors.onPrimary),
          ),
        ),
      ),
    );
  }
}

import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/authed_network_image.dart';
import '../domain/character_models.dart';

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
    final palette = [
      (colors.primaryContainer, colors.onPrimaryContainer),
      (colors.tertiaryContainer, colors.onTertiaryContainer),
      (colors.secondaryContainer, colors.onSecondaryContainer),
    ];
    final index =
        character.id.runes.fold(0, (sum, rune) => sum + rune) % palette.length;
    final (background, foreground) = palette[index];
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
            Center(
              child: Text(
                character.initials,
                textScaler: TextScaler.noScaling,
                style: TextStyle(
                  fontSize: (constraints.maxHeight * 0.35).clamp(32, 88),
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

/// One line on where a character's illustration stands.
///
/// A saved photograph is a face to browse, not yet artwork a book can use, so
/// the two are never called the same thing here.
class CharacterIllustrationStatus extends StatelessWidget {
  const CharacterIllustrationStatus({
    required this.character,
    this.showNextStep = true,
    super.key,
  });
  final LibraryCharacter character;

  /// On a card the line doubles as the next thing to do; on the profile, where
  /// the step itself sits right underneath, it only reports.
  final bool showNextStep;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final (label, icon, color) = character.portraitStatus.isBusy
        ? ('Drawing illustration', Icons.hourglass_top_rounded, colors.tertiary)
        // Worded the same on both surfaces: on the profile the retry sits in
        // the card right underneath, whose own title is "Illustration failed".
        : character.portraitStatus == CharacterPortraitStatus.failed
        ? ('Illustration failed · Retry', Icons.refresh_rounded, colors.error)
        : character.usedInBooks
        ? (
            'Illustration ready',
            Icons.check_circle_outline_rounded,
            colors.primary,
          )
        : character.needsCartoonReference
        ? (
            showNextStep ? 'Photo only · Illustrate next' : 'Photo only',
            Icons.auto_awesome_outlined,
            colors.tertiary,
          )
        : (
            showNextStep ? 'Add a picture' : 'No picture yet',
            Icons.add_photo_alternate_outlined,
            colors.onSurfaceVariant,
          );
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 16, color: color),
        const SizedBox(width: AppSpacing.xxs),
        Expanded(
          child: Text(
            label,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(
              context,
            ).textTheme.labelSmall?.copyWith(color: color),
          ),
        ),
      ],
    );
  }
}

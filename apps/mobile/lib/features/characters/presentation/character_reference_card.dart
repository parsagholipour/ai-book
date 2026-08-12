import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/character_image_models.dart';
import '../domain/character_models.dart';
import 'character_reference_copy.dart';

/// What a book will do with this character, and the one control that changes
/// it.
///
/// Sits above the description on the profile because it is the only thing on
/// the page that decides what an illustrated book draws. Nothing here is
/// `AppTone.warning`: a character with only a photo is an unfinished step, not
/// a problem, and gold means the Max tier and real warnings.
class CharacterReferenceCard extends StatelessWidget {
  const CharacterReferenceCard({
    required this.character,
    required this.images,
    required this.portraitCredits,
    required this.busy,
    required this.portraitBusy,
    required this.waitGaveUp,
    required this.onGeneratePortrait,
    required this.onAddPicture,
    required this.onPromote,
    required this.onCheckAgain,
    super.key,
  });

  final LibraryCharacter character;
  final List<CharacterImage> images;

  /// The price the character list came with; this card never fetches it.
  final int portraitCredits;

  final bool busy;
  final bool portraitBusy;

  /// The poll gave up waiting for a drawing that never landed.
  final bool waitGaveUp;

  final VoidCallback onGeneratePortrait;
  final VoidCallback onAddPicture;
  final void Function(CharacterImage image) onPromote;
  final VoidCallback onCheckAgain;

  /// The reader's own drawing, saved but not yet what books use. It is
  /// promotable for free, so it must not be offered a priced redraw as though
  /// that were the only way forward.
  CharacterImage? get _freeArtwork {
    for (final image in images) {
      if (image.canBeMain && image.isCurrentPhoto) return image;
    }
    for (final image in images) {
      if (image.canBeMain && image.isOwnArtwork) return image;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    return AppSwitcher(child: _card(context));
  }

  Widget _card(BuildContext context) {
    final theme = Theme.of(context);
    final captionStyle = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );

    if (character.portraitStatus.isBusy) {
      return AppCard(
        key: const ValueKey('character-reference-drawing'),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Align(
              alignment: AlignmentDirectional.centerStart,
              child: AppStatusBadge(
                label: 'Drawing the illustration — this takes a minute',
                icon: Icons.hourglass_bottom,
                tone: AppTone.info,
              ),
            ),
            const SizedBox(height: AppSpacing.sm),
            if (waitGaveUp) ...[
              Text('This is taking longer than usual.', style: captionStyle),
              const SizedBox(height: AppSpacing.xs),
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: AppButton.text(
                  label: 'Check again',
                  onPressed: onCheckAgain,
                ),
              ),
            ] else
              const AppAnimatedProgressBar(
                value: 0,
                semanticLabel: 'Drawing the illustration',
              ),
          ],
        ),
      );
    }

    if (character.portraitStatus == CharacterPortraitStatus.failed) {
      return AppInlineNotice(
        key: const ValueKey('character-reference-failed'),
        icon: Icons.error_outline,
        tone: AppTone.error,
        title: 'Illustration failed',
        message:
            character.portraitError ??
            'It could not be drawn. The credits were refunded.',
        actionLabel: 'Retry',
        onAction: busy ? null : onGeneratePortrait,
      );
    }

    final artwork = _freeArtwork;
    // The priced draw leads only when it is the one thing left to do. With the
    // reader's own artwork sitting there promotable for free, or with a book
    // already drawing this character, a redraw is a secondary act.
    final leads = artwork == null && referenceWanted(character);
    final pricedLabel = referenceCtaLabel(character, portraitCredits);
    final pricedIcon = const Icon(Icons.auto_awesome_outlined);
    final priced = leads
        ? AppButton.primary(
            key: const ValueKey('character-generate-portrait'),
            label: pricedLabel,
            leading: pricedIcon,
            loading: portraitBusy,
            expanded: true,
            onPressed: busy ? null : onGeneratePortrait,
          )
        : AppButton.outlined(
            key: const ValueKey('character-generate-portrait'),
            label: pricedLabel,
            leading: pricedIcon,
            loading: portraitBusy,
            onPressed: busy ? null : onGeneratePortrait,
          );

    return AppCard(
      key: const ValueKey('character-reference-card'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            referenceStatusLine(character),
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: AppSpacing.sm),
          if (artwork != null)
            AppActionGroup(
              primary: AppButton.primary(
                key: const ValueKey('character-use-this-drawing'),
                label: 'Use this drawing',
                leading: const Icon(Icons.check_circle_outline),
                onPressed: busy ? null : () => onPromote(artwork),
              ),
              secondary: [priced],
            )
          else if (!character.hasPhoto && images.isEmpty)
            AppActionGroup(
              primary: priced,
              secondary: [
                AppButton.text(
                  label: 'Add a picture',
                  leading: const Icon(Icons.add_photo_alternate_outlined),
                  onPressed: busy ? null : onAddPicture,
                ),
              ],
            )
          else
            Align(alignment: AlignmentDirectional.centerStart, child: priced),
          const SizedBox(height: AppSpacing.xs),
          Text(referenceExplainer(character), style: captionStyle),
        ],
      ),
    );
  }
}

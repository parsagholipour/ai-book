import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/character_image_models.dart';
import '../domain/character_models.dart';
import 'character_photo_pick.dart';
import 'character_reference_copy.dart';

/// What a book will do with this character, and the controls that change it.
///
/// Every button here spans the card, one under the other, so their edges line
/// up with the card's and with each other whatever the labels say. A character
/// with no picture at all gets both ways to one here — a photo, or a drawing
/// from their description — because the plate above them carries only a corner
/// button.
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
    required this.onAddPhoto,
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
  final VoidCallback onAddPhoto;
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
    // Not `AppSwitcher`: its size transition clips to the card's bounds, which
    // cuts the card's own shadow off at the corners.
    final duration = AppMotion.reducedMotion(context)
        ? Duration.zero
        : AppMotion.medium;
    return AnimatedSize(
      duration: duration,
      curve: AppMotion.standard,
      alignment: Alignment.topCenter,
      clipBehavior: Clip.none,
      child: AnimatedSwitcher(
        duration: duration,
        switchInCurve: AppMotion.enter,
        switchOutCurve: AppMotion.exit,
        layoutBuilder: (current, previous) => Stack(
          alignment: Alignment.topCenter,
          clipBehavior: Clip.none,
          children: [...previous, ?current],
        ),
        child: _card(context),
      ),
    );
  }

  Widget _card(BuildContext context) {
    final theme = Theme.of(context);
    final captionStyle = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );

    if (character.portraitStatus.isBusy) {
      // The picture itself carries the animation, so this says what is
      // happening and that leaving is fine — not a second bar stuck at zero.
      return AppCard(
        key: const ValueKey('character-reference-drawing'),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Align(
              alignment: AlignmentDirectional.centerStart,
              child: AppStatusBadge(
                label: 'Drawing the illustration',
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
                child: AppButton.outlined(
                  label: 'Check again',
                  leading: const Icon(Icons.refresh),
                  onPressed: onCheckAgain,
                ),
              ),
            ] else
              Text(
                'You can leave this page. It keeps drawing in the background, '
                'and a failed drawing is refunded.',
                style: captionStyle,
              ),
          ],
        ),
      );
    }

    if (character.portraitStatus == CharacterPortraitStatus.failed) {
      return AppCard(
        key: const ValueKey('character-reference-failed'),
        tone: AppTone.error,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.error_outline),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Illustration failed',
                        style: theme.textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: AppSpacing.xxs),
                      Text(
                        character.portraitError ??
                            'It could not be drawn. The credits were refunded.',
                        maxLines: 4,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),
            AppButton.primary(
              label: 'Retry',
              leading: const Icon(Icons.refresh_rounded),
              expanded: true,
              onPressed: busy ? null : onGeneratePortrait,
            ),
          ],
        ),
      );
    }

    final artwork = _freeArtwork;
    // The priced draw leads only when it is the one thing left to do. With the
    // reader's own artwork sitting there promotable for free, or with a book
    // already drawing this character, a redraw is a secondary act.
    final leads = artwork == null && referenceWanted(character);
    // The same branch as the "Add a photo or a drawing" status line: nothing
    // uploaded and nothing a book draws from yet. A drawing of theirs still in
    // the history is the free way out of that, so it goes first.
    final offersPhoto =
        artwork == null && !character.hasPhoto && !character.usedInBooks;
    final pricedLabel = referenceCtaLabel(character);
    final price = portraitPriceLabel(portraitCredits);
    final pricedIcon = const Icon(Icons.auto_awesome_outlined);
    final priced = leads
        ? AppButton.primary(
            key: const ValueKey('character-generate-portrait'),
            label: pricedLabel,
            detail: price,
            leading: pricedIcon,
            loading: portraitBusy,
            expanded: true,
            onPressed: busy ? null : onGeneratePortrait,
          )
        : AppButton.outlined(
            key: const ValueKey('character-generate-portrait'),
            label: pricedLabel,
            detail: price,
            leading: pricedIcon,
            loading: portraitBusy,
            expanded: true,
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
          const SizedBox(height: AppSpacing.md),
          if (artwork != null) ...[
            AppButton.primary(
              key: const ValueKey('character-use-this-drawing'),
              label: 'Use this drawing',
              leading: const Icon(Icons.check_circle_outline),
              expanded: true,
              onPressed: busy ? null : () => onPromote(artwork),
            ),
            const SizedBox(height: AppSpacing.xs),
          ] else if (offersPhoto) ...[
            AppButton.primary(
              key: const ValueKey('character-add-photo'),
              label: 'Add a photo',
              leading: const Icon(Icons.add_a_photo_outlined),
              expanded: true,
              onPressed: busy ? null : onAddPhoto,
            ),
            const SizedBox(height: AppSpacing.xs),
          ],
          priced,
          const SizedBox(height: AppSpacing.sm),
          // Next to the photo button, the line about whose photos may be added
          // says more than a description of the drawing: the status line above
          // has already said what either picture is for.
          Text(
            offersPhoto
                ? characterPhotoConsentLine
                : referenceExplainer(character),
            key: offersPhoto
                ? const ValueKey('character-reference-photo-consent')
                : null,
            style: captionStyle,
          ),
        ],
      ),
    );
  }
}

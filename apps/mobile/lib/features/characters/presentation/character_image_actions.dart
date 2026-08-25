import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/character_image_models.dart';
import '../domain/character_models.dart';
import 'character_reference_copy.dart';

/// What the reader picked for one retained picture.
enum CharacterImageAction { view, makeMain, showAsPhoto, draw, share, delete }

/// The per-picture menu, opened by a long-press in the strip or the viewer's
/// overflow.
///
/// The copy here is the whole reason this is a sheet rather than a row of
/// icons: promoting a picture changes what every future book draws, and
/// deleting one can change it back. Both deserve a sentence.
Future<CharacterImageAction?> showCharacterImageActions(
  BuildContext context, {
  required LibraryCharacter character,
  required CharacterImage image,
  required int portraitCredits,
  required bool hasPromotableSuccessor,
  bool includeView = true,
}) {
  return showAppActionSheet<CharacterImageAction>(
    context,
    builder: (sheetContext) {
      final colors = Theme.of(sheetContext).colorScheme;
      void pick(CharacterImageAction action) =>
          Navigator.of(sheetContext).pop(action);

      return Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (includeView)
            ListTile(
              key: const ValueKey('character-image-view'),
              leading: const Icon(Icons.fullscreen),
              title: const Text('View picture'),
              onTap: () => pick(CharacterImageAction.view),
            ),
          if (image.isMain)
            ListTile(
              key: const ValueKey('character-image-is-main'),
              enabled: false,
              leading: Icon(Icons.check_circle, color: colors.primary),
              title: const Text('Main picture'),
              subtitle: Text(
                character.usedInBooks
                    ? 'Your books draw this character from it.'
                    : 'This is the picture the app shows for them.',
              ),
            )
          else if (image.canBeMain)
            ListTile(
              key: const ValueKey('character-image-promote'),
              leading: const Icon(Icons.check_circle_outline),
              title: const Text('Make this the main picture'),
              subtitle: const Text(
                'Your books will draw this character from it.',
              ),
              onTap: () => pick(CharacterImageAction.makeMain),
            )
          else if (image.canBeShownAsPhoto)
            // Deliberately says nothing about books: this moves the stored
            // photo and nothing else, because a book cannot draw from a
            // photograph.
            ListTile(
              key: const ValueKey('character-image-show-as-photo'),
              leading: const Icon(Icons.person_outline),
              title: const Text('Show this as their picture'),
              subtitle: const Text(
                'Your books still need an illustrated version to draw from.',
              ),
              onTap: () => pick(CharacterImageAction.showAsPhoto),
            )
          else if (image.isCurrentPhoto &&
              !character.usedInBooks &&
              !character.portraitStatus.isBusy)
            // The honest version of "make this the main picture" for a
            // photograph: `POST /:id/portrait` draws from the *stored* photo,
            // which this already is.
            ListTile(
              key: const ValueKey('character-image-draw'),
              leading: const Icon(Icons.auto_awesome_outlined),
              title: Text(drawFromPictureLabel(portraitCredits)),
              subtitle: const Text(
                "Books can't draw from a photo, so we make an illustrated "
                'version first.',
              ),
              onTap: () => pick(CharacterImageAction.draw),
            ),
          ListTile(
            key: const ValueKey('character-image-share'),
            leading: const Icon(Icons.ios_share),
            title: const Text('Share'),
            onTap: () => pick(CharacterImageAction.share),
          ),
          const Divider(height: 1),
          ListTile(
            key: const ValueKey('character-image-delete'),
            leading: Icon(Icons.delete_outline, color: colors.error),
            title: Text(
              'Delete picture',
              style: TextStyle(color: colors.error),
            ),
            subtitle: Text(
              characterImageDeleteConsequence(
                character: character,
                image: image,
                hasPromotableSuccessor: hasPromotableSuccessor,
              ),
            ),
            onTap: () => pick(CharacterImageAction.delete),
          ),
        ],
      );
    },
  );
}

/// What deleting this picture will actually do, in the reader's terms.
///
/// This is the sentence the whole sheet exists for. Delete is the one action
/// here that asks first, because it is the only one that is not a tap away from
/// being undone.
String characterImageDeleteConsequence({
  required LibraryCharacter character,
  required CharacterImage image,
  required bool hasPromotableSuccessor,
}) {
  if (!image.isCurrentReference) {
    return 'This is not what your books draw from, so nothing else changes.';
  }
  if (hasPromotableSuccessor) {
    return 'Your books draw ${character.name} from this. Deleting it puts the '
        'previous illustration back.';
  }
  return 'Your books draw ${character.name} from this. Deleting it means new '
      'books invent their look again.';
}

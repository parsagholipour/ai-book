import '../domain/character_models.dart';

/// The words for what a character's picture currently buys.
///
/// Lifted out of the old photo section unchanged, because these sentences are
/// the one place the app admits that a stored photo does *not* reach a book —
/// the avatar shows that face on every screen, and without saying so the app
/// would be promising a book it will not deliver.

/// What the picture currently buys, in the reader's terms.
///
/// Ordered by what the reader has, not by what they uploaded: a character drawn
/// from a description alone has no photo and still reaches books.
String referenceStatusLine(LibraryCharacter character) {
  if (character.portraitSource == CharacterPortraitSource.adoptedUpload &&
      character.usedInBooks) {
    return 'Your artwork is this character — your books will draw them from '
        'it.';
  }
  if (character.usedInBooks) {
    return 'Your books draw this character from the illustrated version.';
  }
  if (!character.hasPhoto) {
    return 'Add a photo or a drawing so your books can keep them looking '
        'the same.';
  }
  if (character.portraitStatus.isBusy) {
    return 'Your photo is being turned into an illustration.';
  }
  if (character.photoKind == CharacterPhotoKind.illustration) {
    // Artwork that was not adopted on upload — a portrait job held the row, or
    // the reading was not confident enough to take a face on trust.
    return 'Your drawing is saved. Make it this character\'s look so your '
        'books can draw from it.';
  }
  // Deliberately kind-neutral: this is also the branch for a photo nothing
  // read (no vision model configured, a timeout) and for an honest "unsure",
  // and the app may not assert something about the image the server never
  // said. What is owed is the same either way.
  return 'Your books cannot draw from this image yet — make an illustrated '
      'version.';
}

/// What an "illustrated version" *is*, which the button's own name does not
/// say. It is the only picture of this character a book ever draws — the photo
/// behind it stays on this screen — so the term has to be spelled out wherever
/// the button is offered, not just in the one status line that happens to
/// mention it.
String referenceExplainer(LibraryCharacter character) {
  if (character.usedInBooks) {
    return 'Your books illustrate this character from it. Redrawing applies '
        'to new books — the ones you have already made keep their look.';
  }
  return character.hasPhoto
      ? 'Your books illustrate every picture of this character from it, '
            'never from your photo.'
      : 'Your books illustrate every picture of this character from it.';
}

/// The priced call to action.
///
/// The price is never written into a literal: it is operator-editable, ships
/// with the character list, and a hardcoded number would be wrong the day it
/// changes. Zero means the deployment is not charging for portraits at all, and
/// the label says nothing about credits rather than saying "(0 credits)".
String referenceCtaLabel(LibraryCharacter character, int credits) {
  final label = referenceWanted(character)
      ? 'Make illustrated version'
      : referenceIsRedraw(character)
      ? 'Redraw illustration'
      : 'Generate portrait';
  return credits > 0 ? '$label ($credits credits)' : label;
}

/// Whether the priced draw would *replace* the illustration a book already
/// draws this character from.
///
/// This is the one form of the draw that asks before it spends. Every other one
/// is a step the reader is missing — the first illustration, or a retry after a
/// refunded failure — where a dialog would only stand between them and the
/// thing the screen has been asking them for.
bool referenceIsRedraw(LibraryCharacter character) {
  return !referenceWanted(character) && character.usedInBooks;
}

/// The question, which has to name who is being redrawn: the profile is reached
/// from a list, and the picture on screen is the answer.
String redrawConfirmationTitle(LibraryCharacter character) {
  final name = character.name.trim();
  return name.isEmpty ? 'Redraw this illustration?' : 'Redraw $name?';
}

/// What a redraw costs and what it does not take away.
///
/// The price is the reason to ask at all, so it leads — and it is the list's
/// number rather than a literal, exactly as the button's label is. The rest is
/// what makes the answer easy: the drawing on screen is not destroyed by the
/// one that replaces it, and neither is any book already made.
String redrawConfirmationMessage(LibraryCharacter character, int credits) {
  final price = credits > 0
      ? 'Draws a new illustration for $credits credits.'
      : 'Draws a new illustration.';
  return '$price The one you have now stays in Pictures and you can put it '
      'back. Books you have already made keep their look.';
}

/// Drawing an illustration is the one action that changes what a book can do,
/// so while it is still owed it leads rather than sitting as a secondary
/// "generate portrait".
bool referenceWanted(LibraryCharacter character) {
  return character.needsCartoonReference &&
      !character.portraitStatus.isBusy &&
      character.portraitStatus != CharacterPortraitStatus.failed;
}

/// The priced label for drawing *from a specific picture*, used where a
/// photograph is offered an illustration instead of a promote it cannot have.
String drawFromPictureLabel(int credits) {
  const label = 'Draw an illustration';
  return credits > 0 ? '$label ($credits credits)' : label;
}

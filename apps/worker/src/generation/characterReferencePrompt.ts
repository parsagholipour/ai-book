import { libraryCharacterFaceInstruction } from "@book-maker/core";

/**
 * What a page or cover render attaches: the per-book character sheets, plus —
 * where the model's reference budget has room left — the reader's own saved
 * artwork for those same characters.
 *
 * The sheet is a redraw of that artwork, so by the time it reaches a page the
 * face is two generations from the one the reader recognises. Sending the
 * original alongside it is what stops that compounding. It is strictly
 * additive: the faces only ever fill slots the sheets did not want, so a page
 * with as many characters as the budget allows still gets every sheet.
 */
export type CharacterReferenceSelection = {
  paths: string[];
  /** Characters whose own artwork travels at the end of `paths`, in that order. */
  libraryFaceNames: string[];
};

/**
 * What to say about the attachment — said about `attached` rather than about
 * the selection, because every sentence here is *indexed*.
 *
 * Both claims point at particular pictures. "Use the 5 attached character
 * reference images" is a count, and `libraryCharacterFaceInstruction` adds a
 * tail attribution: "the last 2 reference images are the reader's own saved
 * artwork for Ada and Bea … match it exactly". A layer that shortens the
 * attachment and leaves those standing does not merely drop information, it
 * re-points both sentences at different pictures — the third and fourth
 * sheets become the first two characters' saved faces, to be matched exactly.
 * That is a wrong face, silently, on the one render path with no
 * reference-image quality signal, which is why the second argument exists and
 * why `FallbackImageAdapter.refitForFallback` reaches it through
 * `ImageRequest.promptForReferenceImages`.
 *
 * A name survives only while its own file does. The faces sit at the tail of
 * `paths` in `libraryFaceNames` order, so a cut from the tail gives up a face
 * before it gives up a character's design — but the pairing is read back off
 * the paths rather than assumed from the count, so any other subset still
 * gets a true sentence or none.
 */
export function characterReferencePromptInstruction(
  selection: CharacterReferenceSelection,
  attached: readonly string[] = selection.paths
): string {
  const count = attached.length;
  if (count === 0) {
    return "";
  }
  return [
    `Use the ${count} attached character reference image${count === 1 ? "" : "s"} as the authoritative design source.`,
    "Preserve each referenced character's face, silhouette, outfit, colors, and distinctive details; change only pose, expression, lighting, and scene placement.",
    libraryCharacterFaceInstruction(attachedLibraryFaceNames(selection, attached))
  ]
    .filter(Boolean)
    .join(" ");
}

/** The saved-artwork names whose own file is still attached, in tail order. */
function attachedLibraryFaceNames(
  selection: CharacterReferenceSelection,
  attached: readonly string[]
): string[] {
  if (selection.libraryFaceNames.length === 0) {
    return [];
  }
  const sent = new Set(attached);
  const firstFace = selection.paths.length - selection.libraryFaceNames.length;
  return selection.libraryFaceNames.filter((_name, index) => {
    const path = selection.paths[firstFace + index];
    return path !== undefined && sent.has(path);
  });
}

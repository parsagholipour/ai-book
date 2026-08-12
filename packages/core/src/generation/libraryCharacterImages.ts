/**
 * The retention rule for a library character's picture history.
 *
 * Pure on purpose: the API prunes after an upload and the worker prunes after a
 * drawing, and they must make the same decision. `packages/core` may reach
 * neither Prisma nor the filesystem, so each side does its own I/O around this.
 */

/**
 * How many versions of one character's picture are kept.
 *
 * A real bound rather than a comfortable one: nothing sweeps
 * `IMAGE_STORAGE_DIR/characters/`, so anything not pruned here lives as long as
 * the volume does. At 100 characters per account and a few hundred KB per
 * optimized image, twenty is a worst case of well under a gigabyte — and it is
 * quoted to the reader on the picture strip, because a history that silently
 * drops the oldest entry while the app says every version is kept would be
 * lying.
 */
export const LIBRARY_CHARACTER_IMAGE_LIMIT = 20;

export type PrunableCharacterImage = { id: string; fileName: string };

export type PruneLibraryCharacterImagesOptions = {
  limit?: number;
  /**
   * The character's live pointers (`photoPath`, `portraitPath`). They are
   * exempt but still counted, so a character can never automatically prune the
   * picture its books draw from: the automatic path may not break an existing
   * book's reference seed, even though the reader's own explicit delete may.
   */
  keepFileNames: readonly (string | null | undefined)[];
};

/**
 * Which retained images to drop, given the character's images newest-first.
 *
 * Returns them in the order they were given, so a caller unlinking in sequence
 * removes the newest doomed entry first; nothing depends on that, but it keeps
 * a partial failure from leaving the oldest survivors deleted and the newest
 * ones not.
 */
export function pruneLibraryCharacterImages(
  newestFirst: readonly PrunableCharacterImage[],
  options: PruneLibraryCharacterImagesOptions
): PrunableCharacterImage[] {
  const limit = options.limit ?? LIBRARY_CHARACTER_IMAGE_LIMIT;
  const keep = new Set(options.keepFileNames.filter((name): name is string => Boolean(name)));
  const doomed: PrunableCharacterImage[] = [];
  let kept = 0;
  for (const image of newestFirst) {
    if (kept < limit || keep.has(image.fileName)) {
      kept += 1;
      continue;
    }
    doomed.push(image);
  }
  return doomed;
}

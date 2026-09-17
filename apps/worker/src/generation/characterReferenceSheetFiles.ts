import { objectKey, objectReference, objectStore } from "@book-maker/storage";

/**
 * Each render pass owns unique sheet objects. A pass deletes objects whose rows
 * definitely did not publish; an ambiguous commit re-reads the rows first.
 * Published and superseded plan sheets remain until project deletion because
 * a reader or Undo may still need them.
 */

/** The durable prefix for this project’s generated images. */
export function projectImagePrefix(projectId: string): string {
  return objectKey("images", projectId);
}

/**
 * The provider object reference an `ImageAsset.path` names, or nothing when the path is
 * not one of this project's own asset URLs.
 */
export function imageReferenceForAsset(path: string, projectId: string): string | undefined {
  let pathname = path;
  try {
    pathname = new URL(path).pathname;
  } catch {
    // Stored paths can also be relative API asset paths.
  }
  const marker = `/assets/images/${projectId}/`;
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }
  try {
    const filename = decodeURIComponent(pathname.slice(markerIndex + marker.length));
    if (!filename || filename.includes("/")) return undefined;
    return objectReference(objectKey("images", projectId, filename));
  } catch {
    return undefined;
  }
}

/**
 * The objects one render pass wrote, in the order the cast was resolved.
 *
 * A character the pass was refused has no entry and no file, so the gaps are
 * not holes to be filled — they are the refusals, and a sweep must not invent
 * a path for them.
 */
export function renderedSheetFileNames(rendered: readonly ({ filename: string } | undefined)[]): string[] {
  return rendered.flatMap((item) => (item ? [item.filename] : []));
}

/**
 * Delete sheets a pass wrote and did not publish.
 *
 * Best effort in both directions, the way every other orphan cleanup in the
 * worker is: a file that cannot be removed is storage noise, and failing a book
 * over it would cost far more than the bytes. Object deletion is idempotent.
 */
export async function discardCharacterReferenceSheetFiles(
  projectId: string,
  filenames: readonly string[]
): Promise<void> {
  await Promise.all(
    filenames.map(async (filename) => {
      try {
        await objectStore().delete(objectKey("images", projectId, filename));
      } catch {
        // An unreachable orphan is storage noise, never a reason to fail the book.
      }
    })
  );
}

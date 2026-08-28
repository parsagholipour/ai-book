import { config } from "../runtime/config.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where a book's character reference sheets sit on disk, and who owns a file
 * whose row never landed.
 *
 * The filesystem half of `characterReferences.ts`, kept apart from it for the
 * reason `characterReferenceFileNames.ts` is: the rule here is about paths and
 * lifetimes, not about rows or providers, and it has to be readable on its own
 * because nothing else in this repo enforces it.
 *
 * **Nothing sweeps `IMAGE_STORAGE_DIR/<projectId>/`.** `attachmentStorage.ts`
 * expires user uploads, `startExportTempCleanup` expires export scratch, and
 * `deleteProjectStorage` removes the directory when the whole project goes —
 * and that is the complete list. A generated image file lives exactly as long
 * as the project does, whatever happens to the row that named it.
 *
 * That was survivable while a sheet's filename was a function of its character:
 * a second render of the cast wrote the same paths, so the file set was bounded
 * by the cast however many times a book re-rendered it. It stopped being
 * survivable when `characterReferenceFileStems` began stamping every stem with
 * the pass's own render id — which it must, because the renders left the
 * advisory lock and two passes over one cast would otherwise truncate each
 * other's files under a page render reading them. Per pass, every pass that
 * does not publish its cast leaves a whole cast behind: a provider timeout half
 * way through a nine-character book, a lease that expired under a slow render,
 * a commit that stood down as a duplicate. On a flaky provider day that is
 * several casts for one book, forever.
 *
 * So the render id stays and **the pass sweeps after itself**: a sheet file
 * whose pass did not commit a row for it is unreachable by construction — the
 * stem is unique to that pass, so no other pass will ever write or read that
 * path, and the only way anything learns of a sheet is the `ImageAsset` row
 * naming it. Which is why the sweep is safe where the commit's own stale-row
 * delete is not: rows a *published* sheet is deleted with may still be in the
 * hands of a page render that read them a moment ago, so those files are left
 * as the storage noise `applyImageInsertion` and `generateImage` already
 * accept — and they are bounded, at most one cast per supersede.
 */

/** The one directory every one of this project's generated images is written to. */
export function projectImageDir(projectId: string): string {
  return join(config.IMAGE_STORAGE_DIR, projectId);
}

/**
 * The local file an `ImageAsset.path` names, or nothing when the stored path is
 * not one of this project's own asset URLs.
 */
export function localImagePathForAsset(path: string, projectId: string): string | undefined {
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
  const filename = decodeURIComponent(pathname.slice(markerIndex + marker.length));
  if (!filename || filename.includes("/")) {
    return undefined;
  }
  return join(projectImageDir(projectId), filename);
}

/**
 * The files one render pass put on disk, in the order the cast was resolved.
 *
 * A character the pass was refused has no entry and no file, so the gaps are
 * not holes to be filled — they are the refusals, and a sweep must not invent
 * a path for them.
 */
export function renderedSheetFileNames(rendered: readonly ({ filename: string } | undefined)[]): string[] {
  return rendered.flatMap((item) => (item ? [item.filename] : []));
}

/**
 * Unlink sheets a pass wrote and did not publish.
 *
 * Best effort in both directions, the way every other orphan cleanup in the
 * worker is: a file that cannot be removed is storage noise, and failing a book
 * over it would cost far more than the bytes. `force` so the other end of a
 * race having already won is not an error either.
 */
export async function discardCharacterReferenceSheetFiles(
  projectId: string,
  filenames: readonly string[]
): Promise<void> {
  const dir = projectImageDir(projectId);
  await Promise.all(
    filenames.map(async (filename) => {
      try {
        await rm(join(dir, filename), { force: true });
      } catch {
        // A sheet nothing can reach anyway is not worth a delivery. `force`
        // already absorbs ENOENT, so what is left here is a permission or I/O
        // fault — and one raised synchronously, which a trailing `.catch` on
        // the promise would not have caught at all.
      }
    })
  );
}

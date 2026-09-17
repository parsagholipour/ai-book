import {
  libraryCharacterObjectKey,
  libraryCharacterRelativeFile,
  optimizeImageForStorage,
  type OptimizedImage
} from "@book-maker/core";
import { objectStore } from "@book-maker/storage";
import { extname } from "node:path";

/**
 * Files for account-level library characters:
 * `images/characters/<userId>/<characterId>-{photo,portrait}-<token>.<ext>`.
 * The token is what makes a version retained rather than overwritten; names
 * are minted by `characterImageStore.ts`, which is the only writer.
 *
 * Deliberately not ATTACHMENT_STORAGE_DIR — that tree is swept on a retention
 * window and a character lives until deleted — and deliberately outside any
 * project directory, so the project asset route, the PDF renderer's allowlist,
 * and the export sweeps can never reach these. The path shape is validated by
 * `libraryCharacterObjectKey` (core), which both this module and the worker's
 * portrait/seeding paths resolve through.
 */

const PHOTO_MIME_ALLOWLIST = new Set(["image/jpeg", "image/png", "image/webp"]);

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

export function characterFileContentType(fileName: string): string {
  return MIME_BY_EXT[extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

export function resolveCharacterPhotoMimeType(mimeType: string | undefined, filename: string): string | null {
  const candidate = mimeType?.toLowerCase().trim() || MIME_BY_EXT[extname(filename).toLowerCase()];
  return candidate && PHOTO_MIME_ALLOWLIST.has(candidate) ? candidate : null;
}

/**
 * Re-encodes the upload before it is uploaded: the pass normalizes the format
 * and drops the metadata (EXIF, GPS) a phone photo carries.
 *
 * `alwaysReencode` is what makes that true. Without it the optimizer keeps the
 * original buffer whenever the re-encode comes out larger, which is the common
 * case for an already-compressed photo under the resize threshold — so a
 * picture that had been through a messaging app was stored byte-for-byte, with
 * the location it was taken at still in it. Storing a larger file is the
 * cheaper of the two.
 */
export async function optimizeCharacterPhoto(bytes: Buffer, mimeType: string): Promise<OptimizedImage> {
  return optimizeImageForStorage({ bytes, mimeType, alwaysReencode: true });
}

export async function saveLibraryCharacterFile(
  _imageStorageDir: string,
  userId: string,
  fileName: string,
  bytes: Buffer
): Promise<void> {
  const path = libraryCharacterObjectKey(libraryCharacterRelativeFile(userId, fileName));
  if (!path) {
    throw new Error(`Unsafe character file path segments: ${userId}/${fileName}`);
  }
  await objectStore().put(path, bytes, { contentType: characterFileContentType(fileName) });
}

export async function readLibraryCharacterFile(
  _imageStorageDir: string,
  userId: string,
  fileName: string
): Promise<Buffer | null> {
  const path = libraryCharacterObjectKey(libraryCharacterRelativeFile(userId, fileName));
  if (!path) {
    return null;
  }
  return objectStore().get(path);
}

export async function deleteLibraryCharacterFile(
  _imageStorageDir: string,
  userId: string,
  fileName: string | null
): Promise<void> {
  if (!fileName) {
    return;
  }
  const path = libraryCharacterObjectKey(libraryCharacterRelativeFile(userId, fileName));
  if (path) {
    await objectStore().delete(path);
  }
}

import {
  libraryCharacterDiskPath,
  libraryCharacterRelativeFile,
  optimizeImageForStorage,
  type OptimizedImage
} from "@book-maker/core";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";

/**
 * Files for account-level library characters:
 * `IMAGE_STORAGE_DIR/characters/<userId>/<characterId>-{photo,portrait}-<token>.<ext>`.
 * The token is what makes a version retained rather than overwritten; names
 * are minted by `characterImageStore.ts`, which is the only writer.
 *
 * Deliberately not ATTACHMENT_STORAGE_DIR — that tree is swept on a retention
 * window and a character lives until deleted — and deliberately outside any
 * project directory, so the project asset route, the PDF renderer's allowlist,
 * and the export sweeps can never reach these. The path shape is validated by
 * `libraryCharacterDiskPath` (core), which both this module and the worker's
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
 * Re-encodes the upload before it touches disk: the pass normalizes the format
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
  imageStorageDir: string,
  userId: string,
  fileName: string,
  bytes: Buffer
): Promise<void> {
  const path = libraryCharacterDiskPath(imageStorageDir, libraryCharacterRelativeFile(userId, fileName));
  if (!path) {
    throw new Error(`Unsafe character file path segments: ${userId}/${fileName}`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

export async function readLibraryCharacterFile(
  imageStorageDir: string,
  userId: string,
  fileName: string
): Promise<Buffer | null> {
  const path = libraryCharacterDiskPath(imageStorageDir, libraryCharacterRelativeFile(userId, fileName));
  if (!path) {
    return null;
  }
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

export async function deleteLibraryCharacterFile(
  imageStorageDir: string,
  userId: string,
  fileName: string | null
): Promise<void> {
  if (!fileName) {
    return;
  }
  const path = libraryCharacterDiskPath(imageStorageDir, libraryCharacterRelativeFile(userId, fileName));
  if (path) {
    await rm(path, { force: true }).catch(() => undefined);
  }
}

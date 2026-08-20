import {
  libraryCharacterDiskPath,
  libraryCharacterFileName,
  libraryCharacterFileToken,
  libraryCharacterRelativeFile,
  pruneLibraryCharacterImages,
  type OptimizedImage
} from "@book-maker/core";
import { prisma, type LibraryCharacterImageModel, type LibraryCharacterModel } from "@book-maker/db";
import { stat } from "node:fs/promises";
import { deleteLibraryCharacterFile, saveLibraryCharacterFile } from "./characterStorage.js";
import {
  libraryCharacterMentionInclude,
  type LibraryCharacterWithMentions
} from "./characterMentions.js";

/**
 * The retained-history half of the character library.
 *
 * Both route groups reach it: `routes/characters.ts` records a version on every
 * upload and drawing, and `routes/characterImages.ts` lists, promotes and
 * deletes them. The ownership helpers live here too, so the two groups cannot
 * drift on what "this user's character" means.
 */

/** Statuses in which a portrait job owns the character row. */
export const PORTRAIT_OPEN_STATUSES = ["QUEUED", "GENERATING"] as const;

export async function ownedCharacter(id: string, userId: string): Promise<LibraryCharacterWithMentions | null> {
  return prisma.libraryCharacter.findFirst({
    where: { id, userId },
    include: libraryCharacterMentionInclude
  });
}

/** One retained picture, scoped by all three of image, character and owner. */
export async function ownedCharacterImage(
  characterId: string,
  imageId: string,
  userId: string
): Promise<LibraryCharacterImageModel | null> {
  return prisma.libraryCharacterImage.findFirst({ where: { id: imageId, characterId, userId } });
}

/**
 * Whether a `QUEUED`/`GENERATING` claim still has a job behind it.
 *
 * A claim can outlive its job: a worker killed hard never runs its failure
 * path, and nothing else resets an account-level row. Without this every
 * promote and every pointer-holding delete would 409 forever, leaving "delete
 * the whole character" as the only way out — which now costs the reader their
 * entire history. `DELETE /:id` has always carried this escape hatch; the image
 * routes share it rather than growing a second copy.
 */
export async function portraitClaimIsLive(character: LibraryCharacterModel): Promise<boolean> {
  if (!PORTRAIT_OPEN_STATUSES.includes(character.portraitStatus as (typeof PORTRAIT_OPEN_STATUSES)[number])) {
    return false;
  }
  if (!character.portraitJobId) {
    return false;
  }
  const backingJob = await prisma.generationJob.findUnique({
    where: { id: character.portraitJobId },
    select: { status: true }
  });
  return Boolean(backingJob && ["QUEUED", "ACTIVE"].includes(backingJob.status));
}

/** Newest first, with a stable tiebreak so a drawing and its upload never swap. */
export async function loadCharacterImages(characterId: string, userId: string): Promise<LibraryCharacterImageModel[]> {
  return prisma.libraryCharacterImage.findMany({
    where: { characterId, userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
}

export type RecordedCharacterImage = { fileName: string; image: LibraryCharacterImageModel };

/**
 * Writes one retained version: the row first, then the bytes.
 *
 * Row first is the rule on the way in, and its inverse — file first — is the
 * rule on the way out. Both converge on *a row with no file is recoverable, a
 * file with no row is not*: nothing sweeps `IMAGE_STORAGE_DIR/characters/`, so
 * an unreferenced file is permanent invisible growth, while a row whose write
 * failed renders a broken tile the reader can delete.
 *
 * A failed write hands back both halves: the row *and* whatever the write left
 * behind. `writeFile` truncates into existence before it fails on ENOSPC, and
 * the name carries a token nothing will ever mint again — so without the unlink
 * those bytes are unreachable by every route, the prune and every sweep, for as
 * long as the volume lives.
 */
export async function recordCharacterImage(options: {
  imageStorageDir: string;
  userId: string;
  characterId: string;
  source: "UPLOAD" | "GENERATED";
  kind: "photo" | "portrait";
  optimized: OptimizedImage;
  photoKind?: "PHOTOGRAPH" | "ILLUSTRATION" | "UNKNOWN" | undefined;
  referenceEligible: boolean;
}): Promise<RecordedCharacterImage> {
  const fileName = libraryCharacterFileName(
    options.characterId,
    options.kind,
    options.optimized.extension,
    libraryCharacterFileToken()
  );
  const image = await prisma.libraryCharacterImage.create({
    data: {
      characterId: options.characterId,
      userId: options.userId,
      source: options.source,
      fileName,
      byteSize: options.optimized.outputBytes,
      ...(options.optimized.width ? { width: options.optimized.width } : {}),
      ...(options.optimized.height ? { height: options.optimized.height } : {}),
      ...(options.photoKind ? { photoKind: options.photoKind } : {}),
      referenceEligible: options.referenceEligible
    }
  });
  try {
    await saveLibraryCharacterFile(options.imageStorageDir, options.userId, fileName, options.optimized.bytes);
  } catch (error) {
    await deleteLibraryCharacterFile(options.imageStorageDir, options.userId, fileName);
    await prisma.libraryCharacterImage.delete({ where: { id: image.id } }).catch(() => undefined);
    throw error;
  }
  return { fileName, image };
}

/**
 * Trims a character back to the retention limit, oldest first.
 *
 * The live pointers are exempt but still counted, so the automatic path can
 * never drop the picture a book draws from. A reader's own explicit delete
 * still can — that is the same contract deleting a character has always had.
 */
export async function pruneCharacterImages(
  imageStorageDir: string,
  userId: string,
  characterId: string
): Promise<void> {
  const [character, images] = await Promise.all([
    prisma.libraryCharacter.findFirst({
      where: { id: characterId, userId },
      select: { photoPath: true, portraitPath: true }
    }),
    loadCharacterImages(characterId, userId)
  ]);
  if (!character) {
    return;
  }
  const doomed = pruneLibraryCharacterImages(images, {
    keepFileNames: [character.photoPath, character.portraitPath]
  });
  for (const image of doomed) {
    await deleteLibraryCharacterFile(imageStorageDir, userId, image.fileName);
    await prisma.libraryCharacterImage.deleteMany({ where: { id: image.id, userId } });
  }
}

/**
 * Whether the bytes are really on disk.
 *
 * Promote checks this before it moves the reference: a READY row naming a file
 * that is gone would tell every surface — and every book build — that this
 * character reaches a book.
 */
export async function characterImageExists(
  imageStorageDir: string,
  userId: string,
  fileName: string
): Promise<boolean> {
  const path = libraryCharacterDiskPath(imageStorageDir, libraryCharacterRelativeFile(userId, fileName));
  if (!path) {
    return false;
  }
  try {
    const stats = await stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

import { mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Server-side storage for the raw files users upload into the creation chat,
 * so attachments survive app reinstalls and follow the account across devices.
 * The text digest lives in the draft payload; this stores the original bytes.
 *
 * Layout: <ATTACHMENT_STORAGE_DIR>/<draftId>/<attachmentId>
 *
 * Retention: uploaded user files are deleted after ATTACHMENT_RETENTION_DAYS
 * (6 months). Generated books and plans are never touched by this module.
 */

const SAFE_SEGMENT = /^[a-zA-Z0-9_-]{1,64}$/;

export function creationAttachmentFilePath(
  root: string,
  draftId: string,
  attachmentId: string
): string | null {
  if (!SAFE_SEGMENT.test(draftId) || !SAFE_SEGMENT.test(attachmentId)) {
    return null;
  }
  return join(root, draftId, attachmentId);
}

export async function saveCreationAttachmentFile(
  root: string,
  draftId: string,
  attachmentId: string,
  data: Buffer
): Promise<void> {
  const path = creationAttachmentFilePath(root, draftId, attachmentId);
  if (!path) {
    throw new Error(`Unsafe attachment path segments: ${draftId}/${attachmentId}`);
  }
  await mkdir(join(root, draftId), { recursive: true });
  await writeFile(path, data);
}

export async function readCreationAttachmentFile(
  root: string,
  draftId: string,
  attachmentId: string
): Promise<Buffer | null> {
  const path = creationAttachmentFilePath(root, draftId, attachmentId);
  if (!path) {
    return null;
  }
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

export async function deleteCreationAttachmentFile(
  root: string,
  draftId: string,
  attachmentId: string
): Promise<void> {
  const path = creationAttachmentFilePath(root, draftId, attachmentId);
  if (path) {
    await rm(path, { force: true });
  }
}

/** Removes every stored file for a draft (used when the chat session is deleted). */
export async function deleteCreationAttachmentDraftDir(root: string, draftId: string): Promise<void> {
  if (SAFE_SEGMENT.test(draftId)) {
    await rm(join(root, draftId), { recursive: true, force: true });
  }
}

export type AttachmentSweepResult = {
  deletedFiles: number;
  removedDirs: number;
};

/**
 * Deletes stored attachment files older than the retention window, then prunes
 * empty draft directories. Uses file mtime: attachment files are written once
 * at upload and never modified, so mtime equals upload time.
 */
export async function sweepExpiredCreationAttachments(
  root: string,
  retentionDays: number,
  now: () => Date = () => new Date()
): Promise<AttachmentSweepResult> {
  const cutoff = now().getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const result: AttachmentSweepResult = { deletedFiles: 0, removedDirs: 0 };

  let draftDirs: string[];
  try {
    draftDirs = await readdir(root);
  } catch {
    return result;
  }

  for (const draftId of draftDirs) {
    const draftDir = join(root, draftId);
    let entries: string[];
    try {
      entries = await readdir(draftDir);
    } catch {
      continue;
    }
    let remaining = entries.length;
    for (const entry of entries) {
      const filePath = join(draftDir, entry);
      try {
        const info = await stat(filePath);
        if (info.isFile() && info.mtimeMs < cutoff) {
          await rm(filePath, { force: true });
          result.deletedFiles += 1;
          remaining -= 1;
        }
      } catch {
        // Raced with another delete; nothing to do.
      }
    }
    if (remaining === 0) {
      try {
        await rmdir(draftDir);
        result.removedDirs += 1;
      } catch {
        // Directory gained a file since the scan; leave it.
      }
    }
  }
  return result;
}

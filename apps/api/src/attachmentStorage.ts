import { objectKey, objectStore } from "@book-maker/storage";

/**
 * Server-side storage for the raw files users upload into the creation chat,
 * so attachments survive app reinstalls and follow the account across devices.
 * The text digest lives in the draft payload; this stores the original bytes.
 *
 * Object key: attachments/<draftId>/<attachmentId>
 *
 * Retention: uploaded user files are deleted after ATTACHMENT_RETENTION_DAYS
 * (6 months). Generated books and plans are never touched by this module.
 */

const SAFE_SEGMENT = /^[a-zA-Z0-9_-]{1,64}$/;

export function creationAttachmentFilePath(
  _root: string,
  draftId: string,
  attachmentId: string
): string | null {
  if (!SAFE_SEGMENT.test(draftId) || !SAFE_SEGMENT.test(attachmentId)) {
    return null;
  }
  return objectKey("attachments", draftId, attachmentId);
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
  await objectStore().put(path, data);
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
  return objectStore().get(path);
}

export async function deleteCreationAttachmentFile(
  root: string,
  draftId: string,
  attachmentId: string
): Promise<void> {
  const path = creationAttachmentFilePath(root, draftId, attachmentId);
  if (path) {
    await objectStore().delete(path);
  }
}

/** Removes every stored file for a draft (used when the chat session is deleted). */
export async function deleteCreationAttachmentDraftDir(_root: string, draftId: string): Promise<void> {
  if (SAFE_SEGMENT.test(draftId)) {
    await objectStore().deletePrefix(`${objectKey("attachments", draftId)}/`);
  }
}

export type AttachmentSweepResult = {
  deletedFiles: number;
  removedDirs: number;
};

/** Deletes uploaded originals older than the retention window using object last-modified time. */
export async function sweepExpiredCreationAttachments(
  _root: string,
  retentionDays: number,
  now: () => Date = () => new Date()
): Promise<AttachmentSweepResult> {
  const cutoff = now().getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const result: AttachmentSweepResult = { deletedFiles: 0, removedDirs: 0 };
  const objects = await objectStore().list(`${objectKey("attachments")}/`);
  const drafts = new Map<string, number>();
  for (const object of objects) {
    const segments = object.key.split("/");
    if (segments.length !== 3 || !SAFE_SEGMENT.test(segments[1]!) || !SAFE_SEGMENT.test(segments[2]!)) continue;
    const draftId = segments[1]!;
    drafts.set(draftId, (drafts.get(draftId) ?? 0) + 1);
    if (object.lastModified && object.lastModified.getTime() < cutoff) {
      await objectStore().delete(object.key);
      result.deletedFiles += 1;
      drafts.set(draftId, drafts.get(draftId)! - 1);
    }
  }
  // S3 has no directories; count the draft prefixes emptied by this sweep.
  result.removedDirs = [...drafts.values()].filter((remaining) => remaining === 0).length;
  return result;
}

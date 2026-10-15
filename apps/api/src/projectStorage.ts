import { objectKey, objectStore } from "@book-maker/storage";
import { recordStorageDeletion, type StorageDeletionDatabase } from "./storageDeletionSweep.js";

/** Anything with a logger: a Fastify request, or the account-deletion sweep's. */
type LogSource = { log: { warn: (object: unknown, message: string) => void } };

/**
 * Deletes a deleted book's bytes: its `books/`, `images/`, `voice/` and
 * `audio/` prefixes. Called after the project row is gone, by the reader's
 * delete, the operator's, and account deletion.
 *
 * The prefixes are recorded as pending first (`storageDeletionSweep.ts`), so
 * the delete here is the first attempt, not the only one: a prefix that fails
 * now is retried every 15 minutes, and objects a still-stopping job writes
 * afterwards are swept up for a day. A failed record is logged and the delete
 * still runs — the book's row is already gone, so refusing here would only
 * leave the reader a 500 for a book that no longer exists.
 */
export async function deleteProjectStorage(
  projectId: string,
  request: LogSource,
  options: { db?: StorageDeletionDatabase } = {}
) {
  const targets = {
    book: `${objectKey("books", projectId)}/`,
    images: `${objectKey("images", projectId)}/`,
    voice: `${objectKey("voice", projectId)}/`,
    audio: `${objectKey("audio", projectId)}/`
  };
  const results: Record<keyof typeof targets, boolean> = {
    book: false,
    images: false,
    voice: false,
    audio: false
  };

  try {
    await recordStorageDeletion(Object.values(targets), { projectId, ...(options.db ? { db: options.db } : {}) });
  } catch (error) {
    request.log.warn(
      { err: error, projectId, event: "storage.deletion_unrecorded" },
      "Project storage deletion could not be recorded for retry; deleting once"
    );
  }

  for (const [key, path] of Object.entries(targets) as Array<[keyof typeof targets, string]>) {
    try {
      await objectStore().deletePrefix(path);
      results[key] = true;
    } catch (error) {
      request.log.warn({ err: error, projectId, path }, "Project asset cleanup failed; the storage deletion sweep retries it");
    }
  }

  return results;
}

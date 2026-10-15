import { prisma, type Prisma } from "@book-maker/db";
import { objectStore, type ObjectStore } from "@book-maker/storage";
import { failureReason } from "./monitoring/readiness.js";

/**
 * A deleted book's bytes stay deleted.
 *
 * A book's delete removed its four storage prefixes once, best effort: an S3
 * failure was logged, the delete still answered 200, and nothing tried again.
 * And a job still running for the book (a stop is a request, not a kill) could
 * go on writing run-log events and pictures into the prefix after it was
 * emptied. Either way the reader's book was gone from the app and still in the
 * bucket, which is the deletion promise Google Play holds the app to (launch
 * review, 2026-10-13).
 *
 * So the prefixes are written down first (`recordStorageDeletion`, called by
 * `deleteProjectStorage` before its first delete), and this sweep deletes each
 * one again every 15 minutes. A row is finished only when it is a day old **and**
 * the pass found the prefix empty: a failed delete is retried until it succeeds,
 * and whatever a stopping job wrote in that day is swept up behind it. Nothing
 * here touches the worker; the writes it removes are ones the worker made
 * after the book's row was gone.
 */

export const STORAGE_DELETION_SWEEP_INTERVAL_MS = 15 * 60_000;
/** How long a prefix is watched for late writes before an empty pass may close it. */
export const STORAGE_DELETION_SETTLE_MS = 24 * 60 * 60_000;
/** A second API process, or a restart, does not sweep a prefix again this soon. */
const MIN_PASS_GAP_MS = 10 * 60_000;
/** Prefixes per pass; four per book, so a pass covers fifty deleted books. */
export const STORAGE_DELETION_BATCH = 200;

export type StorageDeletionDatabase = {
  pendingStorageDeletion: Pick<Prisma.TransactionClient["pendingStorageDeletion"], "upsert" | "findMany" | "updateMany" | "deleteMany">;
};

type DeletionLogger = { warn(object: Record<string, unknown>, message: string): void; error(object: Record<string, unknown>, message: string): void };

/**
 * Writes the prefixes down before anything is deleted, so a crash or an S3
 * failure between here and the delete still leaves them to the sweep. A prefix
 * deleted again restarts its day.
 */
export async function recordStorageDeletion(
  prefixes: readonly string[],
  input: { projectId?: string; db?: StorageDeletionDatabase; now?: Date } = {}
): Promise<void> {
  const db = input.db ?? prisma;
  const requestedAt = input.now ?? new Date();
  const projectId = input.projectId ?? null;
  await Promise.all(
    prefixes.map((prefix) =>
      db.pendingStorageDeletion.upsert({
        where: { prefix },
        create: { prefix, projectId, requestedAt },
        update: { requestedAt, projectId }
      })
    )
  );
}

export type StorageDeletionSweepResult = { swept: number; objectsDeleted: number; completed: number; failed: number };

export async function runStorageDeletionSweep(
  input: { db?: StorageDeletionDatabase; store?: ObjectStore; now?: Date; log: DeletionLogger; batch?: number }
): Promise<StorageDeletionSweepResult> {
  const db = input.db ?? prisma;
  const store = input.store ?? objectStore();
  const now = input.now ?? new Date();
  const result: StorageDeletionSweepResult = { swept: 0, objectsDeleted: 0, completed: 0, failed: 0 };
  const due = await db.pendingStorageDeletion.findMany({
    where: { OR: [{ lastSweptAt: null }, { lastSweptAt: { lte: new Date(now.getTime() - MIN_PASS_GAP_MS) } }] },
    orderBy: [{ lastSweptAt: { sort: "asc", nulls: "first" } }, { requestedAt: "asc" }],
    take: input.batch ?? STORAGE_DELETION_BATCH
  });

  for (const row of due) {
    result.swept += 1;
    try {
      const found = (await store.list(row.prefix)).length;
      if (found > 0) {
        await store.deletePrefix(row.prefix);
        result.objectsDeleted += found;
      }
      const settled = now.getTime() - row.requestedAt.getTime() >= STORAGE_DELETION_SETTLE_MS;
      if (found === 0 && settled) {
        // Only the row this pass read: a prefix recorded again meanwhile has a newer requestedAt.
        await db.pendingStorageDeletion.deleteMany({ where: { prefix: row.prefix, requestedAt: row.requestedAt } });
        result.completed += 1;
        continue;
      }
      if (found > 0) {
        // A delete that failed earlier, or bytes a stopping job wrote after it.
        input.log.warn(
          { event: "storage.deletion_swept", prefix: row.prefix, projectId: row.projectId, objects: found },
          "Objects were still under a deleted book's prefix and have been removed"
        );
      }
      await db.pendingStorageDeletion.updateMany({
        where: { prefix: row.prefix },
        data: { lastSweptAt: now, lastFound: found, attempts: { increment: 1 }, lastError: null }
      });
    } catch (error) {
      result.failed += 1;
      const reason = failureReason(error);
      const fields = { event: "storage.deletion_failed", prefix: row.prefix, projectId: row.projectId, attempts: row.attempts + 1, reason };
      // A day of failures is no longer a blip: the deletion promise is late.
      if (now.getTime() - row.requestedAt.getTime() >= STORAGE_DELETION_SETTLE_MS) {
        input.log.error(fields, "A deleted book's storage still could not be deleted after a day of retries");
      } else {
        input.log.warn(fields, "A deleted book's storage could not be deleted; it is retried in 15 minutes");
      }
      // The next pass retries either way; a database that cannot take this write is the readiness check's to report.
      await db.pendingStorageDeletion
        .updateMany({
          where: { prefix: row.prefix },
          data: { lastSweptAt: now, lastFound: null, attempts: { increment: 1 }, lastError: reason }
        })
        .catch(() => undefined);
    }
  }
  return result;
}

import { DEFAULT_EXPORT_TEMP_MIN_AGE_MS, EXPORT_TEMP_MIN_AGE_FLOOR_MS, isPendingExportTempName } from "@book-maker/core";
import { objectStore } from "@book-maker/storage";

/** Collects publication predecessors left by a worker that exited before its finally block. */
export async function sweepStaleExportObjects(options: { minAgeMs?: number; signal?: AbortSignal } = {}): Promise<number> {
  const cutoff = Date.now() - Math.max(options.minAgeMs ?? DEFAULT_EXPORT_TEMP_MIN_AGE_MS, EXPORT_TEMP_MIN_AGE_FLOOR_MS);
  let removed = 0;
  for (const item of await objectStore().list("books/.export-backups/")) {
    if (options.signal?.aborted) break;
    const parts = item.key.split("/");
    const name = parts[3];
    if (parts.length !== 4 || !name?.startsWith(".book-superseded-") || !isPendingExportTempName(name)
      || !item.lastModified || item.lastModified.getTime() > cutoff) continue;
    const current = await objectStore().head(item.key);
    if (!current?.lastModified || current.lastModified.getTime() !== item.lastModified.getTime()
      || current.size !== item.size || current.lastModified.getTime() > cutoff) continue;
    await objectStore().delete(item.key);
    removed++;
  }
  return removed;
}

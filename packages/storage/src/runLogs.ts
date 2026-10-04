import { randomUUID } from "node:crypto";
import { objectKey, objectStore, validateObjectKey, type StoredObject } from "./store.js";
let lastTime = 0n;

function accountRunLogsPrefix(userId: string): string {
  return objectKey("books", ".account-runs", userId);
}

export function accountRunLogKey(userId: string, filename: string): string {
  return objectKey("books", ".account-runs", userId, "runs", filename);
}

/** Keep the content-free marker: a provider can return after account deletion. */
export async function deleteAccountRunLogs(userId: string): Promise<void> {
  const prefix = accountRunLogsPrefix(userId);
  await objectStore().put(`${prefix}/deleted`, "", { contentType: "application/octet-stream" });
  await objectStore().deletePrefix(`${prefix}/runs/`);
}

/** Each append is an immutable object: simultaneous workers cannot lose another event. */
export async function appendRunLog(key: string, entry: unknown, options: { accountUserId?: string } = {}): Promise<void> {
  validateObjectKey(key);
  const accountPrefix = options.accountUserId === undefined ? null : accountRunLogsPrefix(options.accountUserId);
  if (accountPrefix && !key.startsWith(`${accountPrefix}/runs/`)) throw new Error("Account run log is outside its owner's prefix.");
  const deletionKey = accountPrefix ? `${accountPrefix}/deleted` : null;
  const store = objectStore();
  if (deletionKey && await store.head(deletionKey)) return;
  const wallTime = BigInt(Date.now()) * 1_000_000n;
  lastTime = wallTime > lastTime ? wallTime : lastTime + 1n;
  const eventKey = `${key}.events/${lastTime.toString().padStart(20, "0")}-${randomUUID()}.json`;
  const line = typeof entry === "string" ? entry.trimEnd() : JSON.stringify(entry);
  try {
    await store.put(eventKey, `${line}\n`, { contentType: "application/x-ndjson" });
    // The marker precedes cleanup. If this PUT finishes after the sweep's
    // listing, this writer removes its own event instead of recreating content.
    if (deletionKey && await store.head(deletionKey)) await store.delete(eventKey);
  } catch (error) {
    // An ambiguous PUT or unreadable fence is not permission to retain private
    // content. Cleanup is idempotent; storage errors still reach the caller.
    if (deletionKey) await store.delete(eventKey);
    throw error;
  }
}
export async function readRunLog(key: string): Promise<string> {
  const objects = await objectStore().list(`${validateObjectKey(key)}.events/`);
  const lines: string[] = [];
  for (const event of objects.sort((a, b) => a.key.localeCompare(b.key))) {
    const bytes = await objectStore().get(event.key);
    if (bytes) lines.push(bytes.toString("utf8"));
  }
  return lines.join("");
}
export async function listRunLogs(projectId: string): Promise<StoredObject[]> {
  const events = await objectStore().list(`${objectKey("books", projectId, "runs")}/`);
  const logs = new Map<string, StoredObject>();
  for (const event of events) {
    const key = event.key.split(".events/")[0]!;
    if (key === event.key) continue;
    const previous = logs.get(key);
    logs.set(key, { key, size: (previous?.size ?? 0) + event.size,
      ...(event.lastModified ? { lastModified: new Date(Math.max(previous?.lastModified?.getTime() ?? 0, event.lastModified.getTime())) } : {}) });
  }
  return [...logs.values()].sort((a,b) => a.key.localeCompare(b.key));
}

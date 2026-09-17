import { randomUUID } from "node:crypto";
import { objectKey, objectStore, validateObjectKey, type StoredObject } from "./store.js";
let lastTime = 0n;
/** Each append is an immutable object: simultaneous workers cannot lose another event. */
export async function appendRunLog(key: string, entry: unknown): Promise<void> {
  validateObjectKey(key);
  const wallTime = BigInt(Date.now()) * 1_000_000n;
  lastTime = wallTime > lastTime ? wallTime : lastTime + 1n;
  const eventKey = `${key}.events/${lastTime.toString().padStart(20, "0")}-${randomUUID()}.json`;
  const line = typeof entry === "string" ? entry.trimEnd() : JSON.stringify(entry);
  await objectStore().put(eventKey, `${line}\n`, { contentType: "application/x-ndjson" });
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

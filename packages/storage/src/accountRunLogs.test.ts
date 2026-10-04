import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { accountRunLogKey, appendRunLog, deleteAccountRunLogs, readRunLog } from "./runLogs.js";
import { setObjectStoreForTests } from "./store.js";
import { MemoryObjectStore } from "./testing.js";

let store: MemoryObjectStore;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => { store = new MemoryObjectStore(); setObjectStoreForTests(store); });
afterEach(() => { vi.restoreAllMocks(); setObjectStoreForTests(null); });

it("deletes only the account's logs and prevents a retained worker logger from recreating them", async () => {
  const key = accountRunLogKey("user-1", "portrait.jsonl");
  const other = accountRunLogKey("user-10", "portrait.jsonl");
  await appendRunLog(key, { prompt: "private description" }, { accountUserId: "user-1" });
  await appendRunLog(other, { prompt: "another account" }, { accountUserId: "user-10" });

  await deleteAccountRunLogs("user-1");
  await appendRunLog(key, { response: "late provider response" }, { accountUserId: "user-1" });

  expect(await readRunLog(key)).toBe("");
  expect(await readRunLog(other)).toContain("another account");
});

it("removes a provider event whose PUT finishes after account cleanup", async () => {
  const key = accountRunLogKey("user-1", "portrait.jsonl");
  const put = store.put.bind(store);
  const writing = deferred();
  const release = deferred();
  vi.spyOn(store, "put").mockImplementation(async (eventKey, data, options) => {
    if (eventKey.startsWith(`${key}.events/`)) { writing.resolve(); await release.promise; }
    await put(eventKey, data, options);
  });
  const append = appendRunLog(key, { prompt: "private description" }, { accountUserId: "user-1" });
  await writing.promise;
  await deleteAccountRunLogs("user-1");
  release.resolve();
  await append;
  expect(await readRunLog(key)).toBe("");
});

it("removes the event if its post-write deletion check fails", async () => {
  const key = accountRunLogKey("user-1", "portrait.jsonl");
  vi.spyOn(store, "head").mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("S3 unavailable"));
  await expect(appendRunLog(key, { prompt: "private description" }, { accountUserId: "user-1" })).rejects.toThrow("S3 unavailable");
  expect(await readRunLog(key)).toBe("");
});

it("never writes account content when the deletion marker cannot be checked", async () => {
  vi.spyOn(store, "head").mockRejectedValue(new Error("S3 unavailable"));
  await expect(appendRunLog(accountRunLogKey("user-1", "portrait.jsonl"), {}, { accountUserId: "user-1" })).rejects.toThrow("S3 unavailable");
  expect(store.objects.size).toBe(0);
});

it("retains the deletion marker after a failed cleanup so a retry can finish", async () => {
  const key = accountRunLogKey("user-1", "portrait.jsonl");
  await appendRunLog(key, { prompt: "private" }, { accountUserId: "user-1" });
  vi.spyOn(store, "delete").mockRejectedValueOnce(new Error("S3 unavailable"));
  await expect(deleteAccountRunLogs("user-1")).rejects.toThrow("S3 unavailable");
  await appendRunLog(key, { prompt: "must not be written" }, { accountUserId: "user-1" });
  expect(await readRunLog(key)).not.toContain("must not be written");
  await deleteAccountRunLogs("user-1");
  expect(await readRunLog(key)).toBe("");
});

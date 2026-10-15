import { describe, expect, it, vi } from "vitest";
import { deleteProjectStorage } from "./projectStorage.js";
import { runStorageDeletionSweep, STORAGE_DELETION_SETTLE_MS, STORAGE_DELETION_SWEEP_INTERVAL_MS } from "./storageDeletionSweep.js";
import { seedObject, testObjectStore } from "./testing/objectStorage.js";
import { memoryPendingStorageDeletions } from "./testing/pendingStorageDeletions.js";

const T0 = new Date("2026-10-13T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const log = () => ({ warn: vi.fn(), error: vi.fn() });
const projectKeys = (projectId: string) => [...testObjectStore.objects.keys()].filter((key) => key.includes(`/${projectId}/`));

async function deletedBook(projectId = "project-1") {
  const pending = memoryPendingStorageDeletions();
  for (const category of ["books", "images", "voice", "audio"]) seedObject(`${category}/${projectId}/artifact`, "bytes");
  vi.useFakeTimers({ toFake: ["Date"], now: T0 });
  try {
    await deleteProjectStorage(projectId, { log: { warn: vi.fn() } }, { db: pending.db });
  } finally {
    vi.useRealTimers();
  }
  return pending;
}

describe("the storage deletion sweep", () => {
  it("removes what a still-running job wrote into a deleted book's prefix after the delete", async () => {
    const { db } = await deletedBook();
    expect(projectKeys("project-1")).toEqual([]);
    // A stopping job appends one more run-log event and finishes one more picture.
    seedObject("books/project-1/runs/run-1.events/0007.json", "{}");
    seedObject("images/project-1/page-4.webp", "late");
    seedObject("images/project-10/page-1.webp", "a different book");

    const logger = log();
    const result = await runStorageDeletionSweep({ db, now: at(STORAGE_DELETION_SWEEP_INTERVAL_MS), log: logger });

    expect(result).toMatchObject({ swept: 4, objectsDeleted: 2, completed: 0, failed: 0 });
    expect(projectKeys("project-1")).toEqual([]);
    expect(testObjectStore.objects.has("images/project-10/page-1.webp")).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "storage.deletion_swept", prefix: "images/project-1/" }), expect.any(String));
  });

  it("retries a delete that failed until it succeeds", async () => {
    const pending = memoryPendingStorageDeletions();
    seedObject("books/project-1/book.pdf", "bytes");
    const failing = vi.spyOn(testObjectStore, "deletePrefix").mockRejectedValue(new Error("SlowDown: please reduce your request rate"));
    try {
      vi.useFakeTimers({ toFake: ["Date"], now: T0 });
      const immediate = await deleteProjectStorage("project-1", { log: { warn: vi.fn() } }, { db: pending.db });
      vi.useRealTimers();
      expect(immediate.book).toBe(false);

      const logger = log();
      const failed = await runStorageDeletionSweep({ db: pending.db, now: at(STORAGE_DELETION_SWEEP_INTERVAL_MS), log: logger });
      expect(failed.failed).toBe(1);
      expect(pending.rows.get("books/project-1/")).toMatchObject({ lastFound: null, attempts: 1, lastError: expect.stringContaining("SlowDown") });
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "storage.deletion_failed" }), expect.any(String));
    } finally {
      failing.mockRestore();
      vi.useRealTimers();
    }

    await runStorageDeletionSweep({ db: pending.db, now: at(2 * STORAGE_DELETION_SWEEP_INTERVAL_MS), log: log() });
    expect(testObjectStore.objects.has("books/project-1/book.pdf")).toBe(false);
    expect(pending.rows.get("books/project-1/")).toMatchObject({ lastFound: 1, attempts: 2, lastError: null });
  });

  it("closes a prefix only once it is a day old and a pass found it empty", async () => {
    const { db, rows } = await deletedBook();
    // Empty passes inside the day keep watching.
    await runStorageDeletionSweep({ db, now: at(STORAGE_DELETION_SWEEP_INTERVAL_MS), log: log() });
    expect(rows.size).toBe(4);

    // A day on, a late write is found: deleted, and the row stays for one more pass.
    seedObject("audio/project-1/chapter-1.mp3", "late");
    const late = await runStorageDeletionSweep({ db, now: at(STORAGE_DELETION_SETTLE_MS), log: log() });
    expect(late).toMatchObject({ objectsDeleted: 1, completed: 3 });
    expect([...rows.keys()]).toEqual(["audio/project-1/"]);

    const done = await runStorageDeletionSweep({ db, now: at(STORAGE_DELETION_SETTLE_MS + STORAGE_DELETION_SWEEP_INTERVAL_MS), log: log() });
    expect(done.completed).toBe(1);
    expect(rows.size).toBe(0);
  });

  it("does not sweep a prefix again within ten minutes of the last pass", async () => {
    const { db } = await deletedBook();
    const list = vi.spyOn(testObjectStore, "list");
    try {
      await runStorageDeletionSweep({ db, now: at(STORAGE_DELETION_SWEEP_INTERVAL_MS), log: log() });
      expect(list).toHaveBeenCalledTimes(4);
      // A second API process, or a restart, a minute later.
      const again = await runStorageDeletionSweep({ db, now: at(STORAGE_DELETION_SWEEP_INTERVAL_MS + 60_000), log: log() });
      expect(again.swept).toBe(0);
      expect(list).toHaveBeenCalledTimes(4);
    } finally {
      list.mockRestore();
    }
  });

  it("calls a day of failures an error, not a warning", async () => {
    const { db } = await deletedBook();
    const failing = vi.spyOn(testObjectStore, "list").mockRejectedValue(new Error("AccessDenied"));
    try {
      const logger = log();
      await runStorageDeletionSweep({ db, now: at(STORAGE_DELETION_SETTLE_MS + 1), log: logger });
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "storage.deletion_failed" }), expect.any(String));
    } finally {
      failing.mockRestore();
    }
  });
});

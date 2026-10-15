import { describe, expect, it, vi } from "vitest";
import { deleteProjectStorage } from "./projectStorage.js";
import { seedObject, testObjectStore } from "./testing/objectStorage.js";
import { memoryPendingStorageDeletions } from "./testing/pendingStorageDeletions.js";

const PREFIXES = ["books/project-1/", "images/project-1/", "voice/project-1/", "audio/project-1/"];

describe("project object cleanup", () => {
  it("deletes every project category without touching sibling projects or library characters", async () => {
    for (const category of ["books", "images", "voice", "audio"]) {
      seedObject(`${category}/project-1/nested/artifact`, "delete");
      seedObject(`${category}/project-10/artifact`, "keep");
    }
    seedObject("images/characters/user-a/portrait.webp", "keep");
    const warn = vi.fn();
    const { db } = memoryPendingStorageDeletions();
    const result = await deleteProjectStorage("project-1", { log: { warn } }, { db });
    expect(result).toEqual({ book: true, images: true, voice: true, audio: true });
    expect([...testObjectStore.objects.keys()].sort()).toEqual([
      "audio/project-10/artifact", "books/project-10/artifact", "images/characters/user-a/portrait.webp",
      "images/project-10/artifact", "voice/project-10/artifact"
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("records every prefix for the sweep before the first delete is attempted", async () => {
    const { db, rows } = memoryPendingStorageDeletions();
    const seenAtFirstDelete: string[][] = [];
    const deletion = vi.spyOn(testObjectStore, "deletePrefix").mockImplementation(async () => {
      seenAtFirstDelete.push([...rows.keys()]);
    });
    try {
      await deleteProjectStorage("project-1", { log: { warn: vi.fn() } }, { db });
      expect(seenAtFirstDelete[0]?.sort()).toEqual([...PREFIXES].sort());
      expect([...rows.values()].every((row) => row.projectId === "project-1" && row.lastSweptAt === null)).toBe(true);
    } finally {
      deletion.mockRestore();
    }
  });

  it("reports failed storage cleanup while attempting the remaining categories, and leaves it recorded", async () => {
    const deletion = vi.spyOn(testObjectStore, "deletePrefix").mockRejectedValueOnce(new Error("S3 unavailable"));
    const warn = vi.fn();
    const { db, rows } = memoryPendingStorageDeletions();
    try {
      const result = await deleteProjectStorage("project-1", { log: { warn } }, { db });
      expect(result).toEqual({ book: false, images: true, voice: true, audio: true });
      expect(deletion).toHaveBeenCalledTimes(4);
      expect(warn).toHaveBeenCalledOnce();
      expect(rows.has("books/project-1/")).toBe(true);
    } finally {
      deletion.mockRestore();
    }
  });

  it("still deletes when the record cannot be written, and says so", async () => {
    seedObject("books/project-1/book.pdf", "delete");
    const warn = vi.fn();
    const broken = { pendingStorageDeletion: { upsert: vi.fn(async () => Promise.reject(new Error("database down"))) } };
    const result = await deleteProjectStorage("project-1", { log: { warn } }, { db: broken as never });
    expect(result).toEqual({ book: true, images: true, voice: true, audio: true });
    expect(testObjectStore.objects.has("books/project-1/book.pdf")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "storage.deletion_unrecorded" }), expect.any(String));
  });
});

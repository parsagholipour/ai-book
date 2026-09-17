import { describe, expect, it, vi } from "vitest";
import { seedObject, testObjectStore } from "./testing/objectStorage.js";
import {
  creationAttachmentFilePath,
  deleteCreationAttachmentDraftDir,
  readCreationAttachmentFile,
  saveCreationAttachmentFile,
  sweepExpiredCreationAttachments
} from "./attachmentStorage.js";

const root = "/unused-local-directory";

describe("private attachment storage", () => {
  it("round-trips original bytes without a local storage directory", async () => {
    await saveCreationAttachmentFile(root, "draft-1", "att_1", Buffer.from("photo bytes"));
    expect((await readCreationAttachmentFile(root, "draft-1", "att_1"))?.toString()).toBe("photo bytes");
    expect([...testObjectStore.objects.keys()]).toEqual(["attachments/draft-1/att_1"]);
  });

  it("rejects path traversal segments", () => {
    expect(creationAttachmentFilePath(root, "../evil", "att_1")).toBeNull();
    expect(creationAttachmentFilePath(root, "draft-1", "..")).toBeNull();
    expect(creationAttachmentFilePath(root, "draft/1", "att_1")).toBeNull();
  });

  it("returns null only for a missing original", async () => {
    expect(await readCreationAttachmentFile(root, "draft-1", "att_gone")).toBeNull();
    const failure = vi.spyOn(testObjectStore, "get").mockRejectedValueOnce(new Error("S3 unavailable"));
    await expect(readCreationAttachmentFile(root, "draft-1", "att_1")).rejects.toThrow("S3 unavailable");
    failure.mockRestore();
  });

  it("removes only the requested draft prefix", async () => {
    seedObject("attachments/draft-1/att_1", "a");
    seedObject("attachments/draft-10/att_1", "b");
    await deleteCreationAttachmentDraftDir(root, "draft-1");
    expect([...testObjectStore.objects.keys()]).toEqual(["attachments/draft-10/att_1"]);
  });

  it("sweeps expired originals using object timestamps and preserves books", async () => {
    const now = new Date("2026-07-08T00:00:00Z");
    const old = new Date("2025-12-01T00:00:00Z");
    seedObject("attachments/draft-old/att_old", "old", old);
    seedObject("attachments/draft-mixed/att_old", "old", old);
    seedObject("attachments/draft-mixed/att_recent", "recent", now);
    seedObject("books/draft-old/book.pdf", "permanent", old);
    expect(await sweepExpiredCreationAttachments(root, 180, () => now)).toEqual({ deletedFiles: 2, removedDirs: 1 });
    expect([...testObjectStore.objects.keys()].sort()).toEqual([
      "attachments/draft-mixed/att_recent", "books/draft-old/book.pdf"
    ]);
  });

  it("keeps originals exactly at the retention boundary", async () => {
    const now = new Date("2026-07-08T00:00:00Z");
    seedObject("attachments/draft-1/att_edge", "edge", new Date(now.getTime() - 180 * 86400_000));
    expect(await sweepExpiredCreationAttachments(root, 180, () => now)).toEqual({ deletedFiles: 0, removedDirs: 0 });
  });

  it("does nothing for an empty bucket", async () => {
    expect(await sweepExpiredCreationAttachments(root, 180)).toEqual({ deletedFiles: 0, removedDirs: 0 });
  });
});

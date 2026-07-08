import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  creationAttachmentFilePath,
  deleteCreationAttachmentDraftDir,
  readCreationAttachmentFile,
  saveCreationAttachmentFile,
  sweepExpiredCreationAttachments
} from "./attachmentStorage.js";

describe("attachment storage", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "book-maker-attachment-storage-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("round-trips a stored file", async () => {
    await saveCreationAttachmentFile(root, "draft-1", "att_1", Buffer.from("photo bytes"));
    const read = await readCreationAttachmentFile(root, "draft-1", "att_1");
    expect(read?.toString("utf8")).toBe("photo bytes");
  });

  it("rejects path-traversal segments", () => {
    expect(creationAttachmentFilePath(root, "../evil", "att_1")).toBeNull();
    expect(creationAttachmentFilePath(root, "draft-1", "..")).toBeNull();
    expect(creationAttachmentFilePath(root, "draft/1", "att_1")).toBeNull();
  });

  it("returns null for a missing file", async () => {
    expect(await readCreationAttachmentFile(root, "draft-1", "att_gone")).toBeNull();
  });

  it("removes a whole draft directory", async () => {
    await saveCreationAttachmentFile(root, "draft-1", "att_1", Buffer.from("a"));
    await saveCreationAttachmentFile(root, "draft-1", "att_2", Buffer.from("b"));
    await deleteCreationAttachmentDraftDir(root, "draft-1");
    expect(existsSync(join(root, "draft-1"))).toBe(false);
  });

  describe("retention sweep", () => {
    it("deletes files past the retention window and keeps recent ones", async () => {
      const now = new Date("2026-07-08T00:00:00.000Z");
      const oldDir = join(root, "draft-old");
      const mixedDir = join(root, "draft-mixed");
      mkdirSync(oldDir);
      mkdirSync(mixedDir);
      writeFileSync(join(oldDir, "att_old"), "old");
      writeFileSync(join(mixedDir, "att_old"), "old");
      writeFileSync(join(mixedDir, "att_recent"), "recent");
      const sevenMonthsAgo = new Date("2025-12-01T00:00:00.000Z");
      utimesSync(join(oldDir, "att_old"), sevenMonthsAgo, sevenMonthsAgo);
      utimesSync(join(mixedDir, "att_old"), sevenMonthsAgo, sevenMonthsAgo);

      const swept = await sweepExpiredCreationAttachments(root, 180, () => now);

      expect(swept.deletedFiles).toBe(2);
      expect(existsSync(join(mixedDir, "att_old"))).toBe(false);
      expect(existsSync(join(mixedDir, "att_recent"))).toBe(true);
      // The fully expired draft directory is pruned once empty.
      expect(existsSync(oldDir)).toBe(false);
      expect(swept.removedDirs).toBe(1);
    });

    it("keeps files exactly inside the window", async () => {
      const now = new Date("2026-07-08T00:00:00.000Z");
      const dir = join(root, "draft-1");
      mkdirSync(dir);
      writeFileSync(join(dir, "att_edge"), "edge");
      const insideWindow = new Date(now.getTime() - 179 * 24 * 60 * 60 * 1000);
      utimesSync(join(dir, "att_edge"), insideWindow, insideWindow);

      const swept = await sweepExpiredCreationAttachments(root, 180, () => now);

      expect(swept.deletedFiles).toBe(0);
      expect(existsSync(join(dir, "att_edge"))).toBe(true);
    });

    it("is a no-op when the storage root does not exist", async () => {
      const swept = await sweepExpiredCreationAttachments(join(root, "missing"), 180);
      expect(swept).toEqual({ deletedFiles: 0, removedDirs: 0 });
    });
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", () => ({ prisma: {} }));

import { seedObject, testObjectStore } from "../testing/objectStorage.js";
import {
  startStudioImageSweep,
  studioImageSweepMode,
  sweepStudioImages,
  type StudioImageSweepOptions,
  type StudioImageSweepResult
} from "./studioImageSweep.js";
import { fakeSweepDb, type FakeSweepDb } from "./testing/studioImageSweepDb.js";

const NOW = new Date("2026-09-30T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);
const url = (filename: string, projectId = "p1") => `![x](/assets/images/${projectId}/${filename})`;
const key = (filename: string, projectId = "p1") => `images/${projectId}/${filename}`;

/** A book whose working copy last changed `quietDays` ago. */
function addBook(fake: FakeSweepDb, projectId: string, quietDays = 60) {
  const manuscriptId = `m-${projectId}`;
  fake.tables.project.push({ id: projectId, mediaSettings: {} });
  fake.tables.manuscript.push({ id: manuscriptId, projectId, revision: 7, settings: {}, updatedAt: daysAgo(quietDays) });
  fake.tables.manuscriptChapter.push({
    id: `c-${projectId}`,
    manuscriptId,
    markdown: "Words.",
    conflictMarkdown: null,
    notes: "",
    updatedAt: daysAgo(quietDays)
  });
  return manuscriptId;
}

function sweep(fake: FakeSweepDb, overrides: Partial<StudioImageSweepOptions> = {}): Promise<StudioImageSweepResult> {
  return sweepStudioImages({ mode: "delete", cursor: null, now: () => NOW, db: fake.db, ...overrides });
}

const present = (objectKey: string) => testObjectStore.objects.has(objectKey);

describe("sweepStudioImages", () => {
  it("deletes an old picture no row names and leaves everything else in the prefix alone", async () => {
    const fake = fakeSweepDb();
    addBook(fake, "p1");
    fake.tables.page.push({ id: "pg1", projectId: "p1", markdown: url("upload-kept.jpg") });
    for (const name of [
      "upload-orphan.jpg",
      "cover-upload-orphan.jpg",
      "studio-image-orphan.png",
      "upload-kept.jpg",
      "cover.png",
      "chat-image-op1.png",
      "page-3-op1-uuid.png",
      "character-reference-ada-r1.png"
    ]) {
      seedObject(key(name), "bytes", daysAgo(45));
    }
    seedObject("images/p1/nested/upload-deep.jpg", "bytes", daysAgo(45));

    const result = await sweep(fake);

    expect(result.reclaimed).toBe(3);
    expect(result.reclaimedBytes).toBe(15);
    expect(result.kept.referenced).toBe(1);
    for (const name of ["upload-orphan.jpg", "cover-upload-orphan.jpg", "studio-image-orphan.png"]) {
      expect(present(key(name)), name).toBe(false);
    }
    for (const name of ["upload-kept.jpg", "cover.png", "chat-image-op1.png", "page-3-op1-uuid.png", "character-reference-ada-r1.png"]) {
      expect(present(key(name)), name).toBe(true);
    }
    expect(present("images/p1/nested/upload-deep.jpg")).toBe(true);
  });

  it("keeps a picture named by any one source", async () => {
    const fake = fakeSweepDb();
    const manuscriptId = addBook(fake, "p1");
    const t = fake.tables;
    t.manuscriptChapter.push(
      { id: "c-live", manuscriptId, markdown: url("upload-chapter.jpg"), conflictMarkdown: null, notes: "", updatedAt: daysAgo(60) },
      { id: "c-bin", manuscriptId, markdown: url("upload-deleted.jpg"), conflictMarkdown: null, notes: "", deletedAt: daysAgo(59), updatedAt: daysAgo(59) },
      { id: "c-conf", manuscriptId, markdown: "", conflictMarkdown: url("upload-conflict.jpg"), notes: "", updatedAt: daysAgo(60) }
    );
    t.manuscriptVersion.push({ id: "v1", chapterId: "c-bin", markdown: url("upload-version.jpg") });
    t.page.push({ id: "pg1", projectId: "p1", markdown: url("studio-image-page.png") });
    t.pageEditSnapshot.push({ id: "s1", projectId: "p1", markdownBefore: url("upload-undo.jpg"), markdownAfter: url("upload-redo.jpg") });
    t.archivedPageEditSnapshot.push({ id: "a1", projectId: "p1", markdownBefore: url("upload-archived.jpg"), markdownAfter: null });
    t.imageAsset.push({ id: "i1", projectId: "p1", path: "https://api.example.com/assets/images/p1/cover-upload-now.jpg", metadata: {} });
    t.bookEditOperation.push({ id: "o1", projectId: "p1", classifier: { demotedAssets: [{ path: "/assets/images/p1/upload-demoted.jpg" }] } });
    t.manuscriptAssist.push(
      { id: "inbox", projectId: "p1", status: "READY", result: { url: "/assets/images/p1/studio-image-inbox.png" }, updatedAt: daysAgo(40) },
      { id: "drawing", projectId: "p1", status: "RUNNING", result: null, updatedAt: daysAgo(40) },
      { id: "gone", projectId: "p1", status: "DISMISSED", result: { url: "/assets/images/p1/studio-image-gone.png" }, updatedAt: daysAgo(40) }
    );
    t.moderationReport.push({ id: "r1", projectId: "p1", targetSnapshot: { filename: "cover-upload-reported.jpg" } });
    const referenced = [
      "upload-chapter.jpg",
      "upload-deleted.jpg",
      "upload-conflict.jpg",
      "upload-version.jpg",
      "studio-image-page.png",
      "upload-undo.jpg",
      "upload-redo.jpg",
      "upload-archived.jpg",
      "cover-upload-now.jpg",
      "upload-demoted.jpg",
      "studio-image-inbox.png",
      "studio-image-drawing.webp",
      "cover-upload-reported.jpg"
    ];
    for (const name of [...referenced, "studio-image-gone.png"]) {
      seedObject(key(name), "x", daysAgo(45));
    }

    const result = await sweep(fake);

    for (const name of referenced) {
      expect(present(key(name)), name).toBe(true);
    }
    expect(present(key("studio-image-gone.png"))).toBe(false);
    expect(result.reclaimed).toBe(1);
    expect(result.kept.referenced).toBe(referenced.length);
  });

  it("does not let another book's rows keep a picture, or this book's rows keep another's", async () => {
    const fake = fakeSweepDb();
    addBook(fake, "p1");
    addBook(fake, "p2");
    fake.tables.page.push({ id: "pg2", projectId: "p2", markdown: url("upload-a.jpg", "p1") });
    fake.tables.page.push({ id: "pg1", projectId: "p1", markdown: url("upload-b.jpg", "p2") });
    seedObject(key("upload-a.jpg", "p1"), "x", daysAgo(45));
    seedObject(key("upload-b.jpg", "p2"), "x", daysAgo(45));

    await sweep(fake);

    expect(present(key("upload-a.jpg", "p1"))).toBe(false);
    expect(present(key("upload-b.jpg", "p2"))).toBe(false);
  });

  it("keeps a picture younger than the grace period, and one with no age to prove", async () => {
    const fake = fakeSweepDb();
    addBook(fake, "p1");
    seedObject(key("upload-new.jpg"), "x", daysAgo(29));
    seedObject(key("upload-undated.jpg"), "x");
    testObjectStore.metadata.set(key("upload-undated.jpg"), { size: 1 });

    const result = await sweep(fake);

    expect(result.reclaimed).toBe(0);
    expect(result.kept).toMatchObject({ young: 1, undated: 1 });
    expect(present(key("upload-new.jpg"))).toBe(true);
    expect(present(key("upload-undated.jpg"))).toBe(true);
  });

  it("leaves a book alone while its working copy or its assists changed within the grace period", async () => {
    const fake = fakeSweepDb();
    addBook(fake, "p1");
    addBook(fake, "p2");
    fake.tables.manuscriptChapter.find((row) => row.id === "c-p1")!.updatedAt = daysAgo(2);
    fake.tables.manuscriptAssist.push({ id: "applied", projectId: "p2", status: "APPLIED", result: null, updatedAt: daysAgo(1) });
    seedObject(key("upload-removed-yesterday.jpg", "p1"), "x", daysAgo(200));
    seedObject(key("studio-image-applied.png", "p2"), "x", daysAgo(200));

    const result = await sweep(fake);

    expect(result.reclaimed).toBe(0);
    expect(result.kept.activeBook).toBe(2);
    expect(present(key("upload-removed-yesterday.jpg", "p1"))).toBe(true);
    expect(present(key("studio-image-applied.png", "p2"))).toBe(true);
  });

  it("reads no rows for a book with no old candidates", async () => {
    const fake = fakeSweepDb();
    addBook(fake, "p1");
    seedObject(key("cover.png"), "x", daysAgo(400));
    seedObject(key("upload-new.jpg"), "x", daysAgo(1));

    await sweep(fake);

    expect(fake.reads.map((read) => read.table)).toEqual(["manuscript"]);
  });

  describe("the second look before the delete", () => {
    it("keeps a picture a row started naming after the first read", async () => {
      const fake = fakeSweepDb();
      addBook(fake, "p1");
      seedObject(key("upload-late.jpg"), "x", daysAgo(45));
      const head = vi.spyOn(testObjectStore, "head").mockImplementationOnce(async (objectKey) => {
        // A chat undo lands between the first read and the re-check.
        fake.tables.pageEditSnapshot.push({ id: "s9", projectId: "p1", markdownBefore: url("upload-late.jpg"), markdownAfter: null });
        return testObjectStore.metadata.get(objectKey) ?? null;
      });

      const result = await sweep(fake);

      head.mockRestore();
      expect(result.kept.referencedOnRecheck).toBe(1);
      expect(present(key("upload-late.jpg"))).toBe(true);
    });

    it("keeps everything of a book whose working copy changed during the pass", async () => {
      const fake = fakeSweepDb();
      addBook(fake, "p1");
      seedObject(key("upload-a.jpg"), "x", daysAgo(45));
      seedObject(key("upload-b.jpg"), "x", daysAgo(45));
      const head = vi.spyOn(testObjectStore, "head").mockImplementation(async (objectKey) => {
        // An autosave from a long-offline device: the revision moves.
        fake.tables.manuscript[0]!.revision = 8;
        return testObjectStore.metadata.get(objectKey) ?? null;
      });
      const log = { info: vi.fn(), warn: vi.fn() };

      const result = await sweep(fake, { log });

      head.mockRestore();
      expect(result.kept.changedDuringPass).toBe(2);
      expect(present(key("upload-a.jpg"))).toBe(true);
      expect(present(key("upload-b.jpg"))).toBe(true);
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: "studio_images.kept", reason: "book_changed_during_pass", count: 2 }),
        expect.any(String)
      );
    });

    it("keeps an object rewritten or removed since it was listed", async () => {
      const fake = fakeSweepDb();
      addBook(fake, "p1");
      seedObject(key("studio-image-redrawn.png"), "x", daysAgo(45));
      seedObject(key("upload-vanished.jpg"), "x", daysAgo(45));
      const head = vi.spyOn(testObjectStore, "head").mockImplementation(async (objectKey) => {
        if (objectKey.endsWith("redrawn.png")) return { size: 1, lastModified: NOW };
        return null;
      });

      const result = await sweep(fake);

      head.mockRestore();
      expect(result.kept.rewritten).toBe(2);
      expect(result.reclaimed).toBe(0);
      expect(present(key("studio-image-redrawn.png"))).toBe(true);
    });

    it("re-reads only the text rows that name a candidate", async () => {
      const fake = fakeSweepDb();
      addBook(fake, "p1");
      seedObject(key("upload-orphan.jpg"), "x", daysAgo(45));

      await sweep(fake);

      const pageReads = fake.reads.filter((read) => read.table === "page").map((read) => JSON.stringify(read.where));
      expect(pageReads).toHaveLength(2);
      expect(pageReads[0]).toContain('"contains":"images/"');
      expect(pageReads[1]).toContain('"contains":"upload-orphan.jpg"');
    });
  });

  describe("bounded work", () => {
    it("walks the books from a cursor and wraps once it reaches the last", async () => {
      const fake = fakeSweepDb();
      for (const projectId of ["p1", "p2", "p3"]) {
        addBook(fake, projectId);
        seedObject(key("upload-orphan.jpg", projectId), "x", daysAgo(45));
      }

      const first = await sweep(fake, { maxBooks: 2 });
      expect(first).toMatchObject({ booksScanned: 2, nextCursor: "p2", reclaimed: 2 });
      expect(present(key("upload-orphan.jpg", "p3"))).toBe(true);

      const second = await sweep(fake, { maxBooks: 2, cursor: first.nextCursor });
      expect(second).toMatchObject({ booksScanned: 1, nextCursor: null, reclaimed: 1 });
      expect(present(key("upload-orphan.jpg", "p3"))).toBe(false);
    });

    it("holds the cursor on a book the per-book budget cut short, and makes progress each pass", async () => {
      const fake = fakeSweepDb();
      addBook(fake, "p1");
      addBook(fake, "p2");
      for (const index of [1, 2, 3, 4, 5]) {
        seedObject(key(`upload-${index}.jpg`, "p1"), "x", daysAgo(45));
      }
      seedObject(key("upload-9.jpg", "p2"), "x", daysAgo(45));

      const first = await sweep(fake, { maxDeletesPerBook: 2 });
      expect(first).toMatchObject({ booksScanned: 1, reclaimed: 2, nextCursor: null });
      expect(first.kept.overBudget).toBe(3);
      const second = await sweep(fake, { maxDeletesPerBook: 2, cursor: first.nextCursor });
      expect(second).toMatchObject({ reclaimed: 2, nextCursor: null });
      const third = await sweep(fake, { maxDeletesPerBook: 2, cursor: second.nextCursor });
      expect(third).toMatchObject({ booksScanned: 2, reclaimed: 2, nextCursor: null });
      expect(testObjectStore.objects.size).toBe(0);
    });

    it("stops at the pass's deletion budget", async () => {
      const fake = fakeSweepDb();
      for (const projectId of ["p1", "p2", "p3"]) {
        addBook(fake, projectId);
        seedObject(key("upload-a.jpg", projectId), "x", daysAgo(45));
      }

      const result = await sweep(fake, { maxDeletes: 2 });

      expect(result).toMatchObject({ booksScanned: 2, reclaimed: 2, nextCursor: "p2" });
    });

    it("scans nothing once the time budget is spent or the pass is aborted", async () => {
      const fake = fakeSweepDb();
      addBook(fake, "p1");
      seedObject(key("upload-a.jpg"), "x", daysAgo(45));
      const controller = new AbortController();
      controller.abort();

      expect(await sweep(fake, { deadlineMs: -1, cursor: "p0" })).toMatchObject({ booksScanned: 0, nextCursor: "p0" });
      expect(await sweep(fake, { signal: controller.signal })).toMatchObject({ booksScanned: 0, nextCursor: null });
      expect(present(key("upload-a.jpg"))).toBe(true);
    });

    it("does not pin the cursor on a book it cannot make progress on", async () => {
      const fake = fakeSweepDb();
      addBook(fake, "p1");
      addBook(fake, "p2");
      for (const index of [1, 2, 3]) {
        seedObject(key(`upload-${index}.jpg`, "p1"), "x", daysAgo(45));
      }
      seedObject(key("upload-9.jpg", "p2"), "x", daysAgo(45));

      const dry = await sweep(fake, { mode: "dry-run", maxDeletesPerBook: 2 });
      expect(dry).toMatchObject({ booksScanned: 2, reclaimed: 3, nextCursor: null });

      const failing = vi.spyOn(testObjectStore, "delete").mockImplementation(async (objectKey) => {
        if (objectKey.startsWith("images/p1/")) throw new Error("AccessDenied");
        testObjectStore.objects.delete(objectKey);
      });
      const result = await sweep(fake, { maxDeletesPerBook: 2 });
      failing.mockRestore();
      expect(result).toMatchObject({ booksScanned: 2, reclaimed: 1, nextCursor: null });
      expect(result.kept.deleteFailed).toBe(2);
    });
  });

  describe("failures", () => {
    it("keeps a book whose rows cannot be read and carries on with the next", async () => {
      const fake = fakeSweepDb();
      addBook(fake, "p1");
      addBook(fake, "p2");
      seedObject(key("upload-a.jpg", "p1"), "x", daysAgo(45));
      seedObject(key("upload-a.jpg", "p2"), "x", daysAgo(45));
      const pages = fake.db.page.findMany as unknown as (options: { where: { projectId: string } }) => Promise<unknown[]>;
      fake.db.page.findMany = (async (options: { where: { projectId: string } }) => {
        if (options.where.projectId === "p1") throw new Error("connection reset");
        return pages(options);
      }) as unknown as typeof fake.db.page.findMany;
      const log = { info: vi.fn(), warn: vi.fn() };

      const result = await sweep(fake, { log });

      expect(result).toMatchObject({ failedBooks: 1, reclaimed: 1, nextCursor: null });
      expect(present(key("upload-a.jpg", "p1"))).toBe(true);
      expect(present(key("upload-a.jpg", "p2"))).toBe(false);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: "studio_images.sweep_declined", projectId: "p1" }),
        expect.any(String)
      );
    });

    it("keeps a book whose listing fails", async () => {
      const fake = fakeSweepDb();
      addBook(fake, "p1");
      seedObject(key("upload-a.jpg"), "x", daysAgo(45));
      const list = vi.spyOn(testObjectStore, "list").mockRejectedValueOnce(new Error("SlowDown"));

      const result = await sweep(fake);

      list.mockRestore();
      expect(result.failedBooks).toBe(1);
      expect(present(key("upload-a.jpg"))).toBe(true);
    });

    it("answers rather than throws when the books cannot be listed", async () => {
      const fake = fakeSweepDb();
      fake.db.manuscript.findMany = (async () => {
        throw new Error("database down");
      }) as unknown as typeof fake.db.manuscript.findMany;
      const log = { info: vi.fn(), warn: vi.fn() };

      const result = await sweep(fake, { cursor: "p7", log });

      expect(result).toMatchObject({ booksScanned: 0, nextCursor: "p7", reclaimed: 0 });
      expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "studio_images.sweep_failed" }), expect.any(String));
    });

    it("keeps nothing it cannot delete, and does not throw", async () => {
      const fake = fakeSweepDb();
      addBook(fake, "p1");
      seedObject(key("upload-a.jpg"), "x", daysAgo(45));
      const failing = vi.spyOn(testObjectStore, "delete").mockRejectedValueOnce(new Error("AccessDenied"));

      const result = await sweep(fake);

      failing.mockRestore();
      expect(result.kept.deleteFailed).toBe(1);
      expect(result.reclaimed).toBe(0);
      expect(present(key("upload-a.jpg"))).toBe(true);
    });
  });

  it("only logs in a dry run", async () => {
    const fake = fakeSweepDb();
    addBook(fake, "p1");
    seedObject(key("upload-orphan.jpg"), "abc", daysAgo(45));
    const log = { info: vi.fn(), warn: vi.fn() };

    const result = await sweep(fake, { mode: "dry-run", log });

    expect(result).toMatchObject({ mode: "dry-run", reclaimed: 1, reclaimedBytes: 3 });
    expect(present(key("upload-orphan.jpg"))).toBe(true);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "studio_images.would_reclaim", projectId: "p1", filenames: ["upload-orphan.jpg"] }),
      expect.any(String)
    );
  });
});

describe("studioImageSweepMode", () => {
  it("deletes in production, only logs elsewhere, and obeys the setting", () => {
    expect(studioImageSweepMode({ NODE_ENV: "production", STUDIO_IMAGE_SWEEP: undefined })).toBe("delete");
    expect(studioImageSweepMode({ NODE_ENV: "development", STUDIO_IMAGE_SWEEP: undefined })).toBe("dry-run");
    expect(studioImageSweepMode({ NODE_ENV: undefined, STUDIO_IMAGE_SWEEP: undefined })).toBe("dry-run");
    expect(studioImageSweepMode({ NODE_ENV: "production", STUDIO_IMAGE_SWEEP: "off" })).toBe("off");
    expect(studioImageSweepMode({ NODE_ENV: "development", STUDIO_IMAGE_SWEEP: "delete" })).toBe("delete");
  });
});

describe("startStudioImageSweep", () => {
  const log = () => ({ info: vi.fn(), warn: vi.fn() });
  const resultFor = (cursor: string | null): StudioImageSweepResult => ({
    mode: "delete",
    booksScanned: 1,
    nextCursor: cursor,
    reclaimed: 0,
    reclaimedBytes: 0,
    kept: {
      young: 0,
      undated: 0,
      activeBook: 0,
      referenced: 0,
      referencedOnRecheck: 0,
      rewritten: 0,
      changedDuringPass: 0,
      overBudget: 0,
      deleteFailed: 0
    },
    failedBooks: 0
  });

  it("carries the cursor from one pass to the next and runs one pass at a time", async () => {
    const sweepFn = vi.fn(async (options: StudioImageSweepOptions) => resultFor(options.cursor === null ? "p5" : null));
    const sweeper = startStudioImageSweep({ mode: "delete", log: log(), firstRunDelayMs: 60_000, sweep: sweepFn });

    const [a, b] = await Promise.all([sweeper.runNow(), sweeper.runNow()]);
    expect(a).toBe(b);
    await sweeper.runNow();
    await sweeper.stop();

    expect(sweepFn).toHaveBeenCalledTimes(2);
    expect(sweepFn.mock.calls.map(([options]) => options.cursor)).toEqual([null, "p5"]);
    expect(await sweeper.runNow()).toBeNull();
  });

  it("survives a pass that throws", async () => {
    const logger = log();
    const sweeper = startStudioImageSweep({
      mode: "dry-run",
      log: logger,
      firstRunDelayMs: 60_000,
      sweep: async () => {
        throw new Error("boom");
      }
    });

    expect(await sweeper.runNow()).toBeNull();
    await sweeper.stop();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "studio_images.sweep_failed" }), expect.any(String));
  });

  it("does nothing when switched off", async () => {
    const sweepFn = vi.fn();
    const sweeper = startStudioImageSweep({ mode: "off", log: log(), sweep: sweepFn });
    expect(await sweeper.runNow()).toBeNull();
    await sweeper.stop();
    expect(sweepFn).not.toHaveBeenCalled();
  });
});

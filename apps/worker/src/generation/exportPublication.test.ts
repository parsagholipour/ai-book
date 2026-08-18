import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    project: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    generationJob: { updateMany: vi.fn(), findFirst: vi.fn(), upsert: vi.fn() },
    generationAttempt: { updateMany: vi.fn(), findUnique: vi.fn() },
    bookEditOperation: { updateMany: vi.fn(), findUnique: vi.fn() },
    voiceCharacter: { count: vi.fn() },
    $transaction: vi.fn()
  },
  rename: vi.fn(),
  rm: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  /** Ordered trace of everything the publication does, commit included. */
  events: [] as string[]
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma }));
vi.mock("node:fs/promises", () => ({
  rename: mocks.rename,
  rm: mocks.rm,
  readFile: mocks.readFile,
  writeFile: mocks.writeFile
}));

import { bookPdfCoverNumbering, exportContentDigest } from "@book-maker/core";

import {
  discardPendingExports,
  exportPublicationSuperseded,
  pendingExportPaths,
  publishCompiledExports
} from "./exportPublication.js";

/** What each render wrote, keyed by the scratch path it wrote it to. */
const RENDERED: Record<string, Buffer> = {
  "/books/project-1/.book-token.pdf": Buffer.from("%PDF-token"),
  "/books/project-1/.book-token.epub": Buffer.from("epub-token")
};

const writtenRecords = () =>
  (mocks.writeFile.mock.calls as [path: string, contents: string][])
    .filter(([path]) => path.endsWith(".provenance.json"))
    .map(([path, contents]) => [path, JSON.parse(contents)] as const);

const pending = pendingExportPaths("/books/project-1", "token");

/** Predecessors are parked under a per-publication name; the uuid is not the point. */
const stable = (path: string) => path.replace(/\.book-superseded-[^.]+\./, ".book-superseded.");

const renameCalls = () => mocks.rename.mock.calls as [from: string, to: string][];
const rmPaths = () => (mocks.rm.mock.calls as [path: string][]).map(([path]) => path);

/** Only the moves that put this compile's own render onto a downloadable name. */
const publishedMoves = () => renameCalls().filter(([from]) => Object.values(pending).includes(from));

/** The digest of the bytes a publication installs over `book.pdf`. */
const publishedPdfDigest = () => exportContentDigest(RENDERED[pending.pdf] as Buffer);

/** Every `pdfPageMap` this publication wrote, in order; the status write carries none. */
const pageMapWrites = () =>
  (mocks.prisma.project.update.mock.calls as [{ data?: { pdfPageMap?: unknown } }][])
    .map(([call]) => call.data?.pdfPageMap)
    .filter((map) => map !== undefined);

const publishResult = (overrides: Record<string, unknown> = {}) =>
  publishCompiledExports({
    projectId: "project-1",
    generationJobId: "job-1",
    projectDir: "/books/project-1",
    pending,
    epubProduced: true,
    pdfPageMap: bookPdfCoverNumbering(false),
    contentRevision: 7,
    expectedProjectStatus: "GENERATING",
    status: "COMPLETE",
    ownsProjectStatus: true,
    ...overrides
  });

const publish = async (overrides: Record<string, unknown> = {}) =>
  (await publishResult(overrides)).published;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.length = 0;
  // A transaction that records its own commit, so a test can say when the
  // status write became visible relative to the files it describes.
  mocks.prisma.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
    try {
      const result = await callback(mocks.prisma);
      mocks.events.push("commit");
      return result;
    } catch (error) {
      mocks.events.push("rollback");
      throw error;
    }
  });
  mocks.prisma.project.updateMany.mockImplementation(async () => {
    mocks.events.push("claim");
    return { count: 1 };
  });
  mocks.prisma.project.update.mockResolvedValue({});
  mocks.prisma.generationJob.updateMany.mockImplementation(async () => {
    mocks.events.push("claim job");
    return { count: 1 };
  });
  mocks.prisma.generationJob.findFirst.mockResolvedValue(null);
  mocks.prisma.generationJob.upsert.mockResolvedValue({ id: "character-job-1", status: "QUEUED" });
  mocks.prisma.generationAttempt.updateMany.mockImplementation(async () => {
    mocks.events.push("settle attempt");
    return { count: 1 };
  });
  mocks.prisma.generationAttempt.findUnique.mockResolvedValue(null);
  mocks.prisma.bookEditOperation.updateMany.mockImplementation(async () => {
    mocks.events.push("settle edit");
    return { count: 1 };
  });
  mocks.prisma.bookEditOperation.findUnique.mockResolvedValue(null);
  mocks.prisma.voiceCharacter.count.mockResolvedValue(0);
  mocks.rename.mockImplementation(async (_from: string, to: string) => {
    mocks.events.push(`rename ${stable(to)}`);
  });
  mocks.rm.mockResolvedValue(undefined);
  mocks.readFile.mockImplementation(async (path: string) => {
    const rendered = RENDERED[path];
    if (!rendered) {
      throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    }
    return rendered;
  });
  mocks.writeFile.mockImplementation(async (path: string) => {
    mocks.events.push(`record ${path.split("/").pop()}`);
  });
});

describe("pendingExportPaths", () => {
  it("renders beside the published names, never onto them", () => {
    expect(pending).toEqual({
      markdown: "/books/project-1/.book-token.md",
      pdf: "/books/project-1/.book-token.pdf",
      epub: "/books/project-1/.book-token.epub"
    });
  });

  it("names every compile separately, because two compiles for one project overlap", () => {
    expect(pendingExportPaths("/books/project-1").pdf).not.toBe(pendingExportPaths("/books/project-1").pdf);
  });
});

describe("exportPublicationSuperseded", () => {
  it("is true once the manuscript moved past the revision this compile was queued for", async () => {
    mocks.prisma.project.findUnique.mockResolvedValue({ contentRevision: 8 });
    await expect(exportPublicationSuperseded("project-1", 7)).resolves.toBe(true);
  });

  it("is false at the same revision, and for a payload that carries none", async () => {
    mocks.prisma.project.findUnique.mockResolvedValue({ contentRevision: 7 });
    await expect(exportPublicationSuperseded("project-1", 7)).resolves.toBe(false);

    await expect(exportPublicationSuperseded("project-1", null)).resolves.toBe(false);
    expect(mocks.prisma.project.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("publishCompiledExports", () => {
  it("degrades a legacy or rangeless map to cover numbering rather than failing the book", async () => {
    // `compile-export` owns the project's outcome and has no retry budget, so
    // refusing to publish here sends a book whose pages are already written to
    // `markFailed` — FAILED and refunded over metadata. The ranges still have
    // to go: they describe a different render than the bytes being installed.
    // Version 1 is the legacy shape; a version-2 measured map with empty
    // `pages` is current and is not rewritten (see below).
    await expect(
      publish({ pdfPageMap: { version: 1, totalPdfPages: 8, hasCoverPage: true, pages: [] } })
    ).resolves.toBe(true);

    expect(pageMapWrites()).toEqual([
      { ...bookPdfCoverNumbering(true), contentRevision: 7, pdfDigest: publishedPdfDigest() }
    ]);
    expect(publishedMoves().map(([, to]) => to)).toContain("/books/project-1/book.pdf");
  });

  it("stamps a version-2 measured map even when it holds no ranges", async () => {
    const pageMap = {
      version: 2 as const,
      totalPdfPages: 8,
      hasCoverPage: true,
      contentsStartPdfPage: 2,
      backMatterStartPdfPage: 8,
      pages: []
    };

    await expect(publish({ pdfPageMap: pageMap })).resolves.toBe(true);
    expect(mocks.prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: {
        pdfPageMap: {
          ...pageMap,
          contentRevision: 7,
          pdfDigest: exportContentDigest(RENDERED[pending.pdf] as Buffer)
        }
      }
    });
  });

  it("clears the stored ranges of a publication that offers no map, keeping its cover skip", async () => {
    mocks.prisma.project.findUnique.mockResolvedValue({
      pdfPageMap: {
        version: 2,
        totalPdfPages: 9,
        hasCoverPage: true,
        pages: [{ index: 1, startPdfPage: 2, endPdfPage: 9 }],
        contentRevision: 7
      }
    });

    await expect(publish({ pdfPageMap: undefined })).resolves.toBe(true);

    // Read under the publication's own lock, and replaced whole: a stale map
    // stamped with this revision is exactly what chat would mistranslate.
    expect(pageMapWrites()).toEqual([
      { ...bookPdfCoverNumbering(true), contentRevision: 7, pdfDigest: publishedPdfDigest() }
    ]);
  });

  it("leaves a column no reader can parse alone rather than guessing a cover skip", async () => {
    mocks.prisma.project.findUnique.mockResolvedValue({ pdfPageMap: null });

    await expect(publish({ pdfPageMap: undefined })).resolves.toBe(true);
    expect(pageMapWrites()).toEqual([]);
  });

  it("allows an EPUB-only repair to leave the PDF map untouched", async () => {
    await expect(
      publish({ ownsProjectStatus: false, repairFormat: "epub", pdfPageMap: undefined })
    ).resolves.toBe(true);

    const mapWrites = mocks.prisma.project.update.mock.calls.filter(
      ([call]) => (call as { data?: { pdfPageMap?: unknown } }).data?.pdfPageMap !== undefined
    );
    expect(mapWrites).toEqual([]);
  });

  it("stamps a cover-numbering stub with the bytes installed by the transaction", async () => {
    const stub = bookPdfCoverNumbering(true);

    await expect(publish({ pdfPageMap: stub })).resolves.toBe(true);
    expect(mocks.prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: {
        pdfPageMap: {
          ...stub,
          contentRevision: 7,
          pdfDigest: exportContentDigest(RENDERED[pending.pdf] as Buffer)
        }
      }
    });
  });

  it("stamps a successful measured map instead of degrading it", async () => {
    const pageMap = {
      version: 2 as const,
      totalPdfPages: 8,
      hasCoverPage: true,
      pages: [{ index: 1, startPdfPage: 2, endPdfPage: 8 }]
    };

    await expect(publish({ pdfPageMap: pageMap })).resolves.toBe(true);
    expect(mocks.prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: {
        pdfPageMap: {
          ...pageMap,
          contentRevision: 7,
          pdfDigest: exportContentDigest(RENDERED[pending.pdf] as Buffer)
        }
      }
    });
  });

  it("claims the project at its revision, then moves the artifacts into place", async () => {
    await expect(publish()).resolves.toBe(true);

    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: {
        id: "project-1",
        contentRevision: 7,
        status: "GENERATING"
      },
      data: { contentRevision: { increment: 0 } }
    });
    expect(mocks.prisma.generationJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: "job-1",
        projectId: "project-1",
        type: "COMPILE_EXPORT",
        status: "ACTIVE",
        contentRevision: 7
      },
      data: expect.objectContaining({ status: "COMPLETED", progress: 100 })
    });
    expect(mocks.prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "COMPLETE" }
    });
    expect(publishedMoves()).toEqual([
      ["/books/project-1/.book-token.md", "/books/project-1/book.md"],
      ["/books/project-1/.book-token.pdf", "/books/project-1/book.pdf"],
      ["/books/project-1/.book-token.epub", "/books/project-1/book.epub"]
    ]);
  });

  it("atomically settles attempt/edit state and persists character preparation with publication", async () => {
    const result = await publishResult({
      generationAttemptId: "attempt-1",
      editOperationId: "operation-1",
      characterPreparation: { planId: "plan-1", attemptId: "attempt-1" }
    });

    expect(result).toEqual({ published: true, characterPreparationJobId: "character-job-1" });
    expect(mocks.prisma.generationAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: "attempt-1", projectId: "project-1", status: { in: ["QUEUED", "ACTIVE"] } },
      data: {
        status: "SUCCEEDED",
        finishedAt: expect.any(Date),
        error: null,
        refundPending: false
      }
    });
    expect(mocks.prisma.bookEditOperation.updateMany).toHaveBeenCalledWith({
      where: { id: "operation-1", projectId: "project-1", status: { in: ["QUEUED", "ACTIVE"] } },
      data: { status: "APPLIED", appliedAt: expect.any(Date) }
    });
    expect(mocks.prisma.generationJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dedupeKey: "prepare-characters:project-1:plan-1:attempt:attempt-1" },
        create: expect.objectContaining({
          projectId: "project-1",
          type: "PREPARE_CHARACTER_CANDIDATES",
          status: "QUEUED",
          payload: { planId: "plan-1" }
        })
      })
    );
    const characterCreate = mocks.prisma.generationJob.upsert.mock.calls[0]?.[0]?.create;
    expect(characterCreate).not.toHaveProperty("attemptId");
    expect(mocks.events.indexOf("settle attempt")).toBeLessThan(mocks.events.indexOf("commit"));
    expect(mocks.events.indexOf("settle edit")).toBeLessThan(mocks.events.indexOf("commit"));
  });

  it("keeps the existing-character guard inside the publication transaction", async () => {
    mocks.prisma.voiceCharacter.count.mockResolvedValue(1);

    await expect(
      publishResult({
        generationAttemptId: "attempt-1",
        characterPreparation: { planId: "plan-1", attemptId: "attempt-1" }
      })
    ).resolves.toEqual({ published: true, characterPreparationJobId: null });

    expect(mocks.prisma.generationJob.findFirst).not.toHaveBeenCalled();
    expect(mocks.prisma.generationJob.upsert).not.toHaveBeenCalled();
  });

  it("reuses an open character-preparation row instead of creating a duplicate", async () => {
    mocks.prisma.generationJob.findFirst.mockResolvedValue({ id: "character-job-open" });

    await expect(
      publishResult({
        generationAttemptId: "attempt-1",
        characterPreparation: { planId: "plan-1", attemptId: "attempt-1" }
      })
    ).resolves.toEqual({ published: true, characterPreparationJobId: "character-job-open" });

    expect(mocks.prisma.generationJob.upsert).not.toHaveBeenCalled();
  });

  it("rolls publication back rather than delivering against a failed attempt", async () => {
    mocks.prisma.generationAttempt.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.generationAttempt.findUnique.mockResolvedValue({
      projectId: "project-1",
      status: "FAILED"
    });

    await expect(
      publishResult({ generationAttemptId: "attempt-1" })
    ).rejects.toThrow("could not settle its generation attempt");

    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.events).toContain("rollback");
  });

  it("parks each artifact it replaces, and drops the parked copies once the set is whole", async () => {
    // SQL cannot undo a rename, so the rollback for a half-moved set has to be
    // made out of renames too: every predecessor is held beside its published
    // name until the last of them has been replaced.
    await expect(publish()).resolves.toBe(true);

    expect(renameCalls().map(([from, to]) => `${stable(from)} -> ${stable(to)}`)).toEqual([
      "/books/project-1/book.md -> /books/project-1/.book-superseded.md",
      "/books/project-1/.book-token.md -> /books/project-1/book.md",
      "/books/project-1/book.pdf -> /books/project-1/.book-superseded.pdf",
      "/books/project-1/.book-token.pdf -> /books/project-1/book.pdf",
      "/books/project-1/book.epub -> /books/project-1/.book-superseded.epub",
      "/books/project-1/.book-token.epub -> /books/project-1/book.epub",
      "/books/project-1/book.pdf.provenance.json -> /books/project-1/.book-superseded.pdf.provenance.json",
      "/books/project-1/.book-token.pdf.provenance.json -> /books/project-1/book.pdf.provenance.json",
      "/books/project-1/book.epub.provenance.json -> /books/project-1/.book-superseded.epub.provenance.json",
      "/books/project-1/.book-token.epub.provenance.json -> /books/project-1/book.epub.provenance.json"
    ]);
    expect(rmPaths().map(stable)).toEqual([
      "/books/project-1/.book-superseded.md",
      "/books/project-1/.book-superseded.pdf",
      "/books/project-1/.book-superseded.epub",
      "/books/project-1/.book-superseded.pdf.provenance.json",
      "/books/project-1/.book-superseded.epub.provenance.json"
    ]);
  });

  it("commits the status only once every file is in place, under one transaction", async () => {
    // Both halves of the race live here. The claim holds the project row's write
    // lock until commit, so an edit's revision bump cannot land between deciding
    // to publish and publishing — which is what once let a stalled compile move
    // pre-edit files over a newer compile's. And because the status write is
    // invisible until commit, no status read sees a project reported COMPLETE
    // whose `book.pdf` has not been renamed into place yet; the app reads that
    // window as a missing export and answers it with a whole repair compile.
    await expect(publish()).resolves.toBe(true);

    expect(mocks.events).toEqual([
      "claim",
      "claim job",
      "record .book-token.pdf.provenance.json",
      "record .book-token.epub.provenance.json",
      "rename /books/project-1/.book-superseded.md",
      "rename /books/project-1/book.md",
      "rename /books/project-1/.book-superseded.pdf",
      "rename /books/project-1/book.pdf",
      "rename /books/project-1/.book-superseded.epub",
      "rename /books/project-1/book.epub",
      "rename /books/project-1/.book-superseded.pdf.provenance.json",
      "rename /books/project-1/book.pdf.provenance.json",
      "rename /books/project-1/.book-superseded.epub.provenance.json",
      "rename /books/project-1/book.epub.provenance.json",
      "commit"
    ]);
  });

  it("records the digest of what it published, under the revision it claimed", async () => {
    // Nothing else ties downloaded bytes to a compile: every one of them is
    // served from `book.pdf`, and two compiles of one manuscript can differ by
    // no bytes at all, so a download landing mid-publication would otherwise be
    // filed under whichever revision the reader last heard about.
    await expect(publish()).resolves.toBe(true);

    expect(writtenRecords()).toEqual([
      [
        "/books/project-1/.book-token.pdf.provenance.json",
        expect.objectContaining({
          revision: 7,
          digest: exportContentDigest(RENDERED["/books/project-1/.book-token.pdf"] as Buffer),
          byteSize: 10
        })
      ],
      [
        "/books/project-1/.book-token.epub.provenance.json",
        expect.objectContaining({
          revision: 7,
          digest: exportContentDigest(RENDERED["/books/project-1/.book-token.epub"] as Buffer)
        })
      ]
    ]);
  });

  it("reads the revision under the claim's lock when the payload carries none", async () => {
    // A payload with no revision claims unconditionally, so there is nothing to
    // record it under — except the row this transaction is already holding,
    // which is the one read that cannot race the files it describes.
    mocks.prisma.project.findUnique.mockResolvedValue({ contentRevision: 12 });

    await expect(publish({ contentRevision: null })).resolves.toBe(true);

    expect(writtenRecords().map(([, record]) => record.revision)).toEqual([12, 12]);
  });

  it("publishes a book whose record could not be written rather than failing it", async () => {
    // The book is on disk and downloadable. Failing here would mark it FAILED
    // and refund a whole generation over a hundred bytes of metadata — and a
    // download of bytes no record describes is answered as exactly that.
    mocks.writeFile.mockRejectedValue(new Error("ENOSPC"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(publish()).resolves.toBe(true);
    expect(publishedMoves()).toHaveLength(3);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("records nothing for a render it could not read back", async () => {
    mocks.readFile.mockRejectedValue(new Error("EIO"));

    await expect(publish()).resolves.toBe(true);
    expect(writtenRecords()).toEqual([]);
  });

  it("puts every artifact back when one of the moves fails, rather than publishing half a set", async () => {
    // The markdown has already been published by the time the PDF's move fails,
    // and rolling the status write back cannot un-rename it. Nothing downstream
    // would ever notice a spliced set either: every download surface checks that
    // a file exists, never that the set agrees, and a repair is queued only for
    // one that is missing — so this book served a post-edit markdown beside a
    // pre-edit PDF until some later revision bump happened to rebuild it.
    mocks.rename.mockImplementation(async (from: string, to: string) => {
      if (from === pending.pdf) {
        throw new Error("ENOSPC");
      }
      mocks.events.push(`rename ${stable(from)} -> ${stable(to)}`);
    });

    await expect(publish()).rejects.toThrow("ENOSPC");
    expect(mocks.events).toEqual([
      "claim",
      "claim job",
      "record .book-token.pdf.provenance.json",
      "record .book-token.epub.provenance.json",
      "rename /books/project-1/book.md -> /books/project-1/.book-superseded.md",
      "rename /books/project-1/.book-token.md -> /books/project-1/book.md",
      "rename /books/project-1/book.pdf -> /books/project-1/.book-superseded.pdf",
      // Newest move first: the PDF never landed, so its predecessor fills the
      // gap; the markdown's overwrites the copy that did.
      "rename /books/project-1/.book-superseded.pdf -> /books/project-1/book.pdf",
      "rename /books/project-1/.book-superseded.md -> /books/project-1/book.md",
      "rollback"
    ]);
  });

  it("removes what it installed when there was no predecessor to put back", async () => {
    // The first compile of a book parks nothing, so an interrupted one has to
    // leave the published name absent — which is the one shape the repair lane
    // knows how to answer — rather than a lone artifact of a book nobody has.
    mocks.rename.mockImplementation(async (from: string, to: string) => {
      if (from.startsWith("/books/project-1/book.")) {
        throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      }
      if (from === pending.pdf) {
        throw new Error("ENOSPC");
      }
      mocks.events.push(`rename ${stable(to)}`);
    });

    await expect(publish()).rejects.toThrow("ENOSPC");
    expect(mocks.events).toEqual([
      "claim",
      "claim job",
      "record .book-token.pdf.provenance.json",
      "record .book-token.epub.provenance.json",
      "rename /books/project-1/book.md",
      "rollback"
    ]);
    expect(rmPaths()).toEqual(["/books/project-1/book.md"]);
  });

  it("keeps the failure that stopped the publication when the restore fails too", async () => {
    mocks.rename.mockImplementation(async (from: string) => {
      if (from === pending.pdf || from.includes(".book-superseded-")) {
        throw new Error(from === pending.pdf ? "ENOSPC" : "EIO");
      }
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(publish()).rejects.toThrow("ENOSPC");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("publishes nothing at all when an edit took the revision first", async () => {
    // The edit deleted the compiled files and queued its own recompile, so
    // republishing here would restore the pre-edit book — and the status write
    // would flip the reader's EDITING project back to COMPLETE.
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 0 });

    await expect(publish()).resolves.toBe(false);
    expect(mocks.rename).not.toHaveBeenCalled();
  });

  it("publishes nothing when stop already terminalized the durable compile row", async () => {
    mocks.prisma.generationJob.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(publish()).resolves.toBe(false);

    expect(mocks.prisma.generationJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "job-1", status: "ACTIVE" }) })
    );
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    expect(mocks.rename).not.toHaveBeenCalled();
  });

  it("restores every predecessor when SQL commit rejects after the callback", async () => {
    mocks.prisma.$transaction.mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => {
      await callback(mocks.prisma);
      mocks.events.push("commit rejected");
      throw new Error("transaction commit failed");
    });

    await expect(publish()).rejects.toThrow("transaction commit failed");

    const restores = renameCalls()
      .filter(([from]) => from.includes(".book-superseded-"))
      .map(([from, to]) => `${stable(from)} -> ${stable(to)}`);
    expect(restores.slice(-5)).toEqual([
      "/books/project-1/.book-superseded.epub.provenance.json -> /books/project-1/book.epub.provenance.json",
      "/books/project-1/.book-superseded.pdf.provenance.json -> /books/project-1/book.pdf.provenance.json",
      "/books/project-1/.book-superseded.epub -> /books/project-1/book.epub",
      "/books/project-1/.book-superseded.pdf -> /books/project-1/book.pdf",
      "/books/project-1/.book-superseded.md -> /books/project-1/book.md"
    ]);
    expect(rmPaths()).toEqual([]);
  });

  it("retires an old EPUB and its provenance when the new conversion fails", async () => {
    await expect(publish({ epubProduced: false })).resolves.toBe(true);

    expect(publishedMoves().map(([, to]) => to)).toEqual([
      "/books/project-1/book.md",
      "/books/project-1/book.pdf"
    ]);
    expect(renameCalls().map(([from]) => from)).toContain("/books/project-1/book.epub");
    expect(renameCalls().map(([from]) => from)).toContain(
      "/books/project-1/book.epub.provenance.json"
    );
  });

  it("claims unconditionally when the job payload carries no revision", async () => {
    await expect(publish({ contentRevision: null })).resolves.toBe(true);

    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "GENERATING" },
      data: { contentRevision: { increment: 0 } }
    });
  });

  it("writes no status for a repair, and refuses a project somebody else is writing", async () => {
    // An edit sets EDITING before it rewrites a page and bumps the revision only
    // once every page is saved, so a repair compiled for the pre-edit revision
    // still matches it for the whole of the edit. Without the status guard it
    // published a pre-edit PDF and reported the half-applied book COMPLETE.
    await expect(publish({ ownsProjectStatus: false, repairFormat: "pdf" })).resolves.toBe(true);

    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", contentRevision: 7, status: { in: ["COMPLETE", "REVIEW_REQUIRED"] } },
      data: { contentRevision: { increment: 0 } }
    });
    expect(publishedMoves()).toEqual([[pending.pdf, "/books/project-1/book.pdf"]]);
    expect(renameCalls().map(([from]) => from)).not.toContain("/books/project-1/book.md");
    expect(renameCalls().map(([from]) => from)).not.toContain("/books/project-1/book.epub");
  });

  it("installs reconstructed markdown with a repair that had no published manuscript", async () => {
    await expect(
      publish({ ownsProjectStatus: false, repairFormat: "pdf", publishReconstructedMarkdown: true })
    ).resolves.toBe(true);

    expect(publishedMoves()).toEqual([
      [pending.markdown, "/books/project-1/book.md"],
      [pending.pdf, "/books/project-1/book.pdf"]
    ]);
    expect(renameCalls().map(([from]) => from)).not.toContain("/books/project-1/book.epub");
  });

  it("keeps the status guard for a repair whose payload carries no revision", async () => {
    // The revision check is what a legacy row is missing, which leaves the
    // status as the only thing standing between it and an in-flight edit.
    await expect(
      publish({ ownsProjectStatus: false, contentRevision: null, repairFormat: "pdf" })
    ).resolves.toBe(true);

    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: { in: ["COMPLETE", "REVIEW_REQUIRED"] } },
      data: { contentRevision: { increment: 0 } }
    });
  });

  it("never lets a repair's deterministic-only verdict overwrite REVIEW_REQUIRED", async () => {
    // A repair runs with `skipFinalReview`, so its report is built from the
    // deterministic checks alone. Speaking a verdict it did not earn could only
    // ever clear the review flag a full compile raised.
    await expect(
      publish({ ownsProjectStatus: false, status: "COMPLETE", repairFormat: "pdf" })
    ).resolves.toBe(true);

    expect(mocks.prisma.project.updateMany.mock.calls[0]?.[0]?.data).not.toHaveProperty("status");
  });
});

describe("discardPendingExports", () => {
  it("removes every scratch path and survives one that is already gone", async () => {
    mocks.rm.mockRejectedValueOnce(new Error("EBUSY"));

    await expect(discardPendingExports(pending)).resolves.toBeUndefined();
    expect(rmPaths()).toEqual([
      "/books/project-1/.book-token.md",
      "/books/project-1/.book-token.pdf",
      "/books/project-1/.book-token.epub",
      "/books/project-1/.book-token.pdf.provenance.json",
      "/books/project-1/.book-token.epub.provenance.json"
    ]);
  });
});

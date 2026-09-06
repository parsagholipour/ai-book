/**
 * The companion formats — EPUB and Word — through publication: what a compile
 * installs when one of them failed to render, what a companion-only repair may
 * touch, and the scratch names every compile renders under.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/exportPublicationMocks.js")).dbModuleMock());
vi.mock(
  "node:fs/promises",
  async () => (await import("./testing/exportPublicationMocks.js")).fsModuleMock()
);

import { bookPdfCoverNumbering } from "@book-maker/core";
import { discardPendingExports, pendingExportPaths, publishCompiledExports } from "./exportPublication.js";
import {
  mocks,
  renameCalls,
  resetExportPublicationMocks,
  rmPaths,
  writtenRecords
} from "./testing/exportPublicationMocks.js";

const pending = pendingExportPaths("/books/project-1", "token");

/** Only the moves that put this compile's own render onto a downloadable name. */
const publishedMoves = () => renameCalls().filter(([from]) => Object.values(pending).includes(from));

const publishResult = (overrides: Record<string, unknown> = {}) =>
  publishCompiledExports({
    projectId: "project-1",
    generationJobId: "job-1",
    projectDir: "/books/project-1",
    pending,
    companionsProduced: { epub: true, docx: true },
    pdfPageMap: bookPdfCoverNumbering(false),
    contentRevision: 7,
    expectedProjectStatus: "GENERATING",
    status: "COMPLETE",
    ownsProjectStatus: true,
    ...overrides
  });

const publish = async (overrides: Record<string, unknown> = {}) =>
  (await publishResult(overrides)).published;

beforeEach(resetExportPublicationMocks);


describe("pendingExportPaths", () => {
  it("renders beside the published names, never onto them", () => {
    expect(pending).toEqual({
      markdown: "/books/project-1/.book-token.md",
      pdf: "/books/project-1/.book-token.pdf",
      epub: "/books/project-1/.book-token.epub",
      docx: "/books/project-1/.book-token.docx"
    });
  });

  it("names every compile separately, because two compiles for one project overlap", () => {
    expect(pendingExportPaths("/books/project-1").pdf).not.toBe(pendingExportPaths("/books/project-1").pdf);
  });
});

describe("publishCompiledExports with companion formats", () => {
  it("allows a companion-only repair to leave the PDF map untouched", async () => {
    for (const repairFormat of ["epub", "docx"] as const) {
      vi.clearAllMocks();
      await expect(publish({ ownsProjectStatus: false, repairFormat, pdfPageMap: undefined })).resolves.toBe(true);

      const mapWrites = mocks.prisma.project.update.mock.calls.filter(
        ([call]) => (call as { data?: { pdfPageMap?: unknown } }).data?.pdfPageMap !== undefined
      );
      expect(mapWrites, repairFormat).toEqual([]);
    }
  });
  it("retires an old EPUB and its provenance when the new conversion fails", async () => {
    await expect(publish({ companionsProduced: { epub: false, docx: true } })).resolves.toBe(true);

    expect(publishedMoves().map(([, to]) => to)).toEqual([
      "/books/project-1/book.md",
      "/books/project-1/book.pdf",
      "/books/project-1/book.docx"
    ]);
    expect(renameCalls().map(([from]) => from)).toContain("/books/project-1/book.epub");
    expect(renameCalls().map(([from]) => from)).toContain(
      "/books/project-1/book.epub.provenance.json"
    );
  });
  it("retires an old Word file and its provenance when the new conversion fails", async () => {
    await expect(publish({ companionsProduced: { epub: true, docx: false } })).resolves.toBe(true);

    expect(publishedMoves().map(([, to]) => to)).toEqual([
      "/books/project-1/book.md",
      "/books/project-1/book.pdf",
      "/books/project-1/book.epub"
    ]);
    expect(renameCalls().map(([from]) => from)).toContain("/books/project-1/book.docx");
    expect(renameCalls().map(([from]) => from)).toContain(
      "/books/project-1/book.docx.provenance.json"
    );
    expect(writtenRecords().map(([path]) => path)).not.toContain(
      "/books/project-1/.book-token.docx.provenance.json"
    );
  });
  it("installs only the Word file for a Word repair, and retires nothing when that render failed", async () => {
    await expect(publish({ ownsProjectStatus: false, repairFormat: "docx" })).resolves.toBe(true);
    expect(publishedMoves()).toEqual([[pending.docx, "/books/project-1/book.docx"]]);
    expect(renameCalls().map(([from]) => from)).not.toContain("/books/project-1/book.pdf");
    expect(renameCalls().map(([from]) => from)).not.toContain("/books/project-1/book.epub");

    vi.clearAllMocks();
    await expect(
      publish({ ownsProjectStatus: false, repairFormat: "docx", companionsProduced: { epub: true, docx: false } })
    ).resolves.toBe(true);
    expect(publishedMoves()).toEqual([]);
    expect(renameCalls().map(([from]) => from)).toContain("/books/project-1/book.docx");
    expect(renameCalls().map(([from]) => from)).not.toContain("/books/project-1/book.epub");
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
      "/books/project-1/.book-token.docx",
      "/books/project-1/.book-token.pdf.provenance.json",
      "/books/project-1/.book-token.epub.provenance.json",
      "/books/project-1/.book-token.docx.provenance.json"
    ]);
  });
});

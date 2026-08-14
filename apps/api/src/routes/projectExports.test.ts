import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportContentDigest, loadConfig, type AppConfig } from "@book-maker/core";

/**
 * The lazy rebuild's one race: a render that started before an edit — or before
 * the book was finished at all — must not end up as the book everybody
 * downloads.
 */

const mockPrisma = vi.hoisted(() => ({
  project: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  generationJob: { findFirst: vi.fn() },
  $transaction: vi.fn()
}));

const mockGeneratePdf = vi.hoisted(() => vi.fn());
const mockGenerateEpub = vi.hoisted(() => vi.fn());
const mockProvenanceWrite = vi.hoisted(() => ({ failure: null as Error | null }));

vi.mock("@book-maker/db", () => ({
  Prisma: { DbNull: Symbol("DbNull") },
  prisma: mockPrisma,
  researchCitationsForExport: async (
    sources: Array<{ title: string; url: string | null; summary: string }>
  ) => sources.map((source) => ({ ...source, url: source.url ?? undefined }))
}));

vi.mock("@book-maker/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@book-maker/core")>();
  return {
    ...actual,
    writeExportProvenance: async (options: Parameters<typeof actual.writeExportProvenance>[0]) => {
      if (mockProvenanceWrite.failure) {
        throw mockProvenanceWrite.failure;
      }
      return actual.writeExportProvenance(options);
    },
    generateBookEpub: mockGenerateEpub,
    getBookGenerationStrategy: () => ({
      ...actual.getBookGenerationStrategy(),
      compileMarkdown: () => "# A Book\n\nOnce upon a time.\n",
      compileMarkdownWithPageAnchors: () => ({
        markdown: "# A Book\n\nOnce upon a time.\n",
        pageAnchors: [],
        hasCoverPage: false,
        hasContents: false
      }),
      generatePdf: mockGeneratePdf,
      generatePdfWithPageMap: async (markdown: string, options: Record<string, unknown>) => {
        const { pageMapPlan: _pageMapPlan, ...rest } = options;
        return { pdf: await mockGeneratePdf(markdown, rest as never) };
      }
    })
  };
});

const originalEnv = { ...process.env };
let bookStorageDir = "";
let appConfig: AppConfig;

function projectRow(contentRevision: number) {
  return {
    id: "project-1",
    title: "A Book",
    category: "fiction",
    language: "en",
    authorName: null,
    mediaSettings: {},
    contentRevision,
    currentPlan: { planningPackage: { title: "A Book" } },
    pages: [{ index: 0, title: "One", markdown: "Once upon a time.", images: [] }],
    images: [],
    research: []
  };
}

function exportSource(contentRevision: number, status: "COMPLETE" | "GENERATING" | "EDITING" | "FAILED" = "COMPLETE") {
  return {
    title: "A Book",
    language: "en",
    currentPlanId: "plan-1",
    mediaSettings: {},
    contentRevision,
    status
  } as const;
}

/** Enough of a Fastify reply for `sendProject*Export` to answer into. */
function fakeReply() {
  const captured = { statusCode: 200, payload: undefined as unknown };
  const reply = {
    code(status: number) {
      captured.statusCode = status;
      return reply;
    },
    send(payload: unknown) {
      captured.payload = payload;
      return reply;
    },
    header: () => reply,
    type: () => reply
  };
  return { reply, captured };
}

const fakeRequest = { log: { error: () => undefined } };

/** A render that takes long enough for an edit to land underneath it. */
function renderWriting(bytes: string, onRender?: () => void) {
  return async (_markdown: string, options: { outputPath?: string }) => {
    onRender?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    writeFileSync(options.outputPath!, bytes);
    return Buffer.from(bytes);
  };
}

function projectDirEntries(): string[] {
  return readdirSync(join(bookStorageDir, "project-1"));
}

describe("lazy export rebuilds", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockProvenanceWrite.failure = null;
    bookStorageDir = mkdtempSync(join(tmpdir(), "book-maker-exports-"));
    mkdirSync(join(bookStorageDir, "project-1"), { recursive: true });
    process.env = {
      ...originalEnv,
      OPENAI_API_KEY: "",
      GEMINI_API_KEY: "",
      BOOK_STORAGE_DIR: bookStorageDir,
      IMAGE_STORAGE_DIR: join(bookStorageDir, "images")
    };
    appConfig = loadConfig(process.env);
    mockPrisma.project.findUnique.mockResolvedValue(projectRow(7));
    mockPrisma.$transaction.mockImplementation((fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma));
    mockPrisma.project.updateMany.mockResolvedValue({ count: 1 });
    // The proof the metadata heal demands before stamping a revision onto
    // sidecar-less bytes: some compile really COMPLETED for that revision.
    mockPrisma.generationJob.findFirst.mockResolvedValue({ id: "compile-7" });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(bookStorageDir, { recursive: true, force: true });
  });

  it("publishes the render onto book.pdf when the manuscript has not moved", async () => {
    mockGeneratePdf.mockImplementation(renderWriting("rendered-pdf"));
    const { rebuildProjectPdfExport } = await import("./projectExports.js");

    const pdf = await rebuildProjectPdfExport(appConfig, "project-1", exportSource(7));

    expect(pdf?.toString()).toBe("rendered-pdf");
    expect(readFileSync(join(bookStorageDir, "project-1", "book.pdf"), "utf8")).toBe("rendered-pdf");
    expect(mockPrisma.project.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "project-1", contentRevision: 7 })
      })
    );
    // The scratch render is gone either way, and the published bytes are filed
    // under the revision they were published for.
    expect(projectDirEntries()).toEqual(["book.pdf", "book.pdf.provenance.json"]);
  });

  it("clears the stored page map when a rebuild renders saved book.md unmeasured", async () => {
    const { Prisma } = await import("@book-maker/db");
    mockPrisma.project.findUnique.mockResolvedValue({ ...projectRow(7), pages: [] });
    writeFileSync(join(bookStorageDir, "project-1", "book.md"), "# Saved\n\nProse.\n");
    mockGeneratePdf.mockImplementation(renderWriting("unmeasured-pdf"));
    const { rebuildProjectPdfExport } = await import("./projectExports.js");

    await rebuildProjectPdfExport(appConfig, "project-1", exportSource(7));

    expect(mockPrisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: expect.objectContaining({ pdfPageMap: Prisma.DbNull })
    });
  });

  it("records what it published, so a download can name the compile it got", async () => {
    // Every compile of this book is served from `book.pdf`, and two of them can
    // differ by no bytes at all, so the reader cannot tell one from another by
    // asking for it. The record is the only thing that can.
    mockGeneratePdf.mockImplementation(renderWriting("rendered-pdf"));
    const { rebuildProjectPdfExport, readProjectExportArtifact } = await import("./projectExports.js");

    await rebuildProjectPdfExport(appConfig, "project-1", exportSource(7));
    const artifact = await readProjectExportArtifact(appConfig, "project-1", "pdf");

    expect(artifact?.bytes.toString()).toBe("rendered-pdf");
    expect(artifact?.provenance).toEqual({
      state: "exact",
      revision: 7,
      digest: exportContentDigest(Buffer.from("rendered-pdf"))
    });
  });

  it("hands back a book it could not identify when no safe migration source is available", async () => {
    // A file published before any of this existed, and the shape a same-length
    // replacement leaves behind: the record describes bytes that are no longer
    // the ones on disk. Neither may be answered with a revision.
    writeFileSync(join(bookStorageDir, "project-1", "book.pdf"), "legacy-pdf");
    const { readProjectExportArtifact } = await import("./projectExports.js");

    expect((await readProjectExportArtifact(appConfig, "project-1", "pdf"))?.provenance).toMatchObject({
      state: "unknown"
    });

    writeFileSync(
      join(bookStorageDir, "project-1", "book.pdf.provenance.json"),
      JSON.stringify({
        revision: 7,
        digest: exportContentDigest(Buffer.from("other-pdf")),
        byteSize: "legacy-pdf".length,
        publishedAt: "2026-08-11T00:00:00.000Z"
      })
    );

    expect((await readProjectExportArtifact(appConfig, "project-1", "pdf"))?.provenance).toMatchObject({
      state: "mismatch"
    });
  });

  it("backfills a legacy export under the publisher lock without rerendering it", async () => {
    writeFileSync(join(bookStorageDir, "project-1", "book.pdf"), "legacy-pdf");
    const { readProjectExportArtifact } = await import("./projectExports.js");

    const artifact = await readProjectExportArtifact(appConfig, "project-1", "pdf", {
      contentRevision: 7,
      status: "COMPLETE"
    });

    expect(artifact?.bytes.toString()).toBe("legacy-pdf");
    expect(artifact?.provenance).toEqual({
      state: "exact",
      revision: 7,
      digest: exportContentDigest(Buffer.from("legacy-pdf"))
    });
    expect(mockGeneratePdf).not.toHaveBeenCalled();
    expect(mockPrisma.project.updateMany).toHaveBeenCalledWith({
      where: {
        id: "project-1",
        contentRevision: 7,
        status: { in: ["COMPLETE", "REVIEW_REQUIRED"] }
      },
      data: { contentRevision: { increment: 0 } }
    });
    expect(mockPrisma.generationJob.findFirst).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        type: "COMPILE_EXPORT",
        status: "COMPLETED",
        contentRevision: 7
      },
      select: { id: true }
    });
    expect(projectDirEntries()).toEqual(["book.pdf", "book.pdf.provenance.json"]);
  });

  it("keeps sidecar-less bytes unknown when no compile ever completed for the claimed revision", async () => {
    // The shape a failed presentation recompile leaves behind: the preference
    // bumped the revision without deleting the compiled files, the recompile
    // failed, and COMPLETE was restored — so the row sits one revision ahead
    // of the bytes on disk. Stamping the row's revision onto them would label
    // a book that does not contain the change as exactly containing it.
    writeFileSync(join(bookStorageDir, "project-1", "book.pdf"), "pre-toggle-pdf");
    mockPrisma.generationJob.findFirst.mockResolvedValue(null);
    const { readProjectExportArtifact } = await import("./projectExports.js");

    const artifact = await readProjectExportArtifact(appConfig, "project-1", "pdf", {
      contentRevision: 8,
      status: "COMPLETE"
    });

    expect(artifact?.bytes.toString()).toBe("pre-toggle-pdf");
    expect(artifact?.provenance).toMatchObject({ state: "unknown" });
    expect(projectDirEntries()).toEqual(["book.pdf"]);
  });

  it("heals a transient provenance write failure without rerendering", async () => {
    mockGeneratePdf.mockImplementation(renderWriting("current-pdf"));
    mockProvenanceWrite.failure = new Error("temporary sidecar failure");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { rebuildProjectPdfExport, readProjectExportArtifact } = await import("./projectExports.js");

    await rebuildProjectPdfExport(appConfig, "project-1", exportSource(7));
    expect(projectDirEntries()).toEqual(["book.pdf"]);

    mockProvenanceWrite.failure = null;
    mockGeneratePdf.mockClear();
    const artifact = await readProjectExportArtifact(appConfig, "project-1", "pdf", {
      contentRevision: 7,
      status: "REVIEW_REQUIRED"
    });

    expect(artifact?.provenance).toMatchObject({ state: "exact", revision: 7 });
    expect(mockGeneratePdf).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(bookStorageDir, "project-1", "book.pdf.provenance.json"), "utf8"))).toMatchObject({
      revision: 7,
      digest: exportContentDigest(Buffer.from("current-pdf"))
    });
    logged.mockRestore();
  });

  it("never relabels bytes contradicted by an existing provenance record", async () => {
    writeFileSync(join(bookStorageDir, "project-1", "book.pdf"), "replacement");
    const oldRecord = JSON.stringify({
      revision: 7,
      digest: exportContentDigest(Buffer.from("old-edition")),
      byteSize: "replacement".length,
      publishedAt: "2026-08-10T00:00:00.000Z"
    });
    writeFileSync(join(bookStorageDir, "project-1", "book.pdf.provenance.json"), oldRecord);
    const { readProjectExportArtifact } = await import("./projectExports.js");

    const artifact = await readProjectExportArtifact(appConfig, "project-1", "pdf", {
      contentRevision: 7,
      status: "COMPLETE"
    });

    expect(artifact?.provenance).toMatchObject({ state: "mismatch" });
    expect(readFileSync(join(bookStorageDir, "project-1", "book.pdf.provenance.json"), "utf8")).toBe(oldRecord);
  });

  it("does not backfill when the revision claim loses to an edit", async () => {
    writeFileSync(join(bookStorageDir, "project-1", "book.pdf"), "legacy-pdf");
    mockPrisma.project.updateMany.mockResolvedValueOnce({ count: 0 });
    const { readProjectExportArtifact } = await import("./projectExports.js");

    const artifact = await readProjectExportArtifact(appConfig, "project-1", "pdf", {
      contentRevision: 7,
      status: "COMPLETE"
    });

    expect(artifact?.provenance).toMatchObject({ state: "unknown" });
    expect(projectDirEntries()).toEqual(["book.pdf"]);
  });

  it("stands down rather than overwriting an export published while it rendered", async () => {
    // The edit lands mid-render: the revision moves and the worker's recompile
    // publishes the book the reader actually has now.
    mockGeneratePdf.mockImplementation(
      renderWriting("stale-pdf", () => {
        mockPrisma.project.updateMany.mockResolvedValue({ count: 0 });
        writeFileSync(join(bookStorageDir, "project-1", "book.pdf"), "fresh-pdf");
      })
    );
    const { rebuildProjectPdfExport } = await import("./projectExports.js");

    const pdf = await rebuildProjectPdfExport(appConfig, "project-1", exportSource(7));

    expect(readFileSync(join(bookStorageDir, "project-1", "book.pdf"), "utf8")).toBe("fresh-pdf");
    // The caller is answered with the current book, not the one it rendered.
    expect(pdf?.toString()).toBe("fresh-pdf");
    expect(projectDirEntries()).toEqual(["book.pdf"]);
  });

  it.each([
    { format: "pdf" as const, rendered: "api-pdf", worker: "worker-pdf" },
    { format: "epub" as const, rendered: "api-epub", worker: "worker-epub" }
  ])("keeps a same-revision worker $format published before the API gets the lock", async ({ format, rendered, worker }) => {
    const generator = format === "pdf" ? mockGeneratePdf : mockGenerateEpub;
    generator.mockImplementation(renderWriting(rendered));
    const filename = `book.${format}`;
    const record = JSON.stringify({
      revision: 7,
      digest: exportContentDigest(Buffer.from(worker)),
      byteSize: worker.length,
      publishedAt: "2026-08-11T00:00:00.000Z"
    });
    // The API render is finished, but the worker held the project-row lock
    // first and committed its same-revision detached repair before the API's
    // transaction callback can acquire that lock.
    mockPrisma.$transaction.mockImplementationOnce((fn: (tx: typeof mockPrisma) => unknown) => {
      writeFileSync(join(bookStorageDir, "project-1", filename), worker);
      writeFileSync(join(bookStorageDir, "project-1", `${filename}.provenance.json`), record);
      return fn(mockPrisma);
    });
    const { rebuildProjectEpubExport, rebuildProjectPdfExport } = await import("./projectExports.js");

    const artifact =
      format === "pdf"
        ? await rebuildProjectPdfExport(appConfig, "project-1", exportSource(7))
        : await rebuildProjectEpubExport(appConfig, "project-1", { ...exportSource(7), authorName: null });

    expect(mockPrisma.project.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ contentRevision: 7 }) })
    );
    expect(artifact?.toString()).toBe(worker);
    expect(readFileSync(join(bookStorageDir, "project-1", filename), "utf8")).toBe(worker);
    // Standing down must not retire or rewrite the worker's provenance, and the
    // API's scratch artifact is removed by the ordinary loser cleanup.
    expect(readFileSync(join(bookStorageDir, "project-1", `${filename}.provenance.json`), "utf8")).toBe(record);
    expect(projectDirEntries().sort()).toEqual([filename, `${filename}.provenance.json`].sort());
  });

  it("answers with its own render when the book it lost to is not on disk", async () => {
    mockGeneratePdf.mockImplementation(
      renderWriting("stale-pdf", () => {
        mockPrisma.project.updateMany.mockResolvedValue({ count: 0 });
      })
    );
    const { rebuildProjectPdfExport } = await import("./projectExports.js");

    const pdf = await rebuildProjectPdfExport(appConfig, "project-1", exportSource(7));

    expect(pdf?.toString()).toBe("stale-pdf");
    expect(projectDirEntries()).toEqual([]);
  });

  it("refuses to publish over a book that is being written", async () => {
    mockGeneratePdf.mockImplementation(renderWriting("rendered-pdf"));
    const { rebuildProjectPdfExport } = await import("./projectExports.js");

    await rebuildProjectPdfExport(appConfig, "project-1", exportSource(7));

    expect(mockPrisma.project.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ["COMPLETE", "REVIEW_REQUIRED"] } })
      })
    );
  });

  it("answers a download made while the book is being written rather than rendering a fragment", async () => {
    mockGeneratePdf.mockImplementation(renderWriting("partial-pdf"));
    const { sendProjectPdfExport } = await import("./projectExports.js");
    const { reply, captured } = fakeReply();

    await sendProjectPdfExport({
      request: fakeRequest as never,
      reply: reply as never,
      appConfig,
      projectId: "project-1",
      project: exportSource(0, "GENERATING")
    });

    expect(captured.statusCode).toBe(409);
    // The pages written so far are not a book, so none of this is rendered.
    expect(mockGeneratePdf).not.toHaveBeenCalled();
    expect(projectDirEntries()).toEqual([]);
  });

  it("serves the compiled book during an edit instead of re-rendering it", async () => {
    writeFileSync(join(bookStorageDir, "project-1", "book.pdf"), "compiled-pdf");
    const { sendProjectPdfExport } = await import("./projectExports.js");
    const { reply, captured } = fakeReply();

    const pdf = await sendProjectPdfExport({
      request: fakeRequest as never,
      reply: reply as never,
      appConfig,
      projectId: "project-1",
      project: exportSource(7, "EDITING")
    });

    expect(captured.statusCode).toBe(200);
    expect((pdf as Buffer).toString()).toBe("compiled-pdf");
    expect(mockGeneratePdf).not.toHaveBeenCalled();
  });

  it("publishes nothing from a render that began before the book was finished", async () => {
    // The worker's own compile lands while this render is running: it publishes
    // the whole book, and leaves the revision exactly where this render found
    // it, so the claim alone would have let the fragment replace it.
    mockGeneratePdf.mockImplementation(
      renderWriting("partial-pdf", () => {
        writeFileSync(join(bookStorageDir, "project-1", "book.pdf"), "whole-pdf");
      })
    );
    const { rebuildProjectPdfExport } = await import("./projectExports.js");

    const pdf = await rebuildProjectPdfExport(appConfig, "project-1", exportSource(0, "GENERATING"));

    expect(mockPrisma.project.updateMany).not.toHaveBeenCalled();
    expect(readFileSync(join(bookStorageDir, "project-1", "book.pdf"), "utf8")).toBe("whole-pdf");
    // And the caller is answered with the finished book, not the fragment.
    expect(pdf?.toString()).toBe("whole-pdf");
    expect(projectDirEntries()).toEqual(["book.pdf"]);
  });

  it("renders a project that will not finish without publishing it", async () => {
    mockGeneratePdf.mockImplementation(renderWriting("salvaged-pdf"));
    const { rebuildProjectPdfExport } = await import("./projectExports.js");

    const pdf = await rebuildProjectPdfExport(appConfig, "project-1", exportSource(7, "FAILED"));

    // Its pages are static, so the download is whole — but a failed book has no
    // canonical export to become.
    expect(pdf?.toString()).toBe("salvaged-pdf");
    expect(mockPrisma.project.updateMany).not.toHaveBeenCalled();
    expect(projectDirEntries()).toEqual([]);
  });

  it("shares one render between requests for the same manuscript", async () => {
    mockGeneratePdf.mockImplementation(renderWriting("rendered-pdf"));
    const { rebuildProjectPdfExport } = await import("./projectExports.js");

    const [first, second] = await Promise.all([
      rebuildProjectPdfExport(appConfig, "project-1", exportSource(7)),
      rebuildProjectPdfExport(appConfig, "project-1", exportSource(7))
    ]);

    expect(mockGeneratePdf).toHaveBeenCalledTimes(1);
    expect(first?.toString()).toBe("rendered-pdf");
    expect(second?.toString()).toBe("rendered-pdf");
  });

  it("does not answer a post-edit request from the render in flight", async () => {
    mockGeneratePdf.mockImplementation(renderWriting("rendered-pdf"));
    const { rebuildProjectPdfExport } = await import("./projectExports.js");

    await Promise.all([
      rebuildProjectPdfExport(appConfig, "project-1", exportSource(7)),
      rebuildProjectPdfExport(appConfig, "project-1", exportSource(8))
    ]);

    expect(mockGeneratePdf).toHaveBeenCalledTimes(2);
  });
});

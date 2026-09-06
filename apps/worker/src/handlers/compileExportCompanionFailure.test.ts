import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "bullmq";
import type { ReaderChapter } from "@book-maker/core";

vi.mock("@book-maker/db", async () => (await import("./testing/compileExportMocks.js")).dbModuleMock());
vi.mock("../runtime/config.js", async () => (await import("./testing/compileExportMocks.js")).configModuleMock());
vi.mock(
  "../generation/projectInput.js",
  async () => (await import("./testing/compileExportMocks.js")).projectInputModuleMock()
);
vi.mock(
  "../generation/exportPublication.js",
  async () => (await import("./testing/compileExportMocks.js")).exportPublicationModuleMock()
);
vi.mock("../runtime/dispatch.js", async () => (await import("./testing/compileExportMocks.js")).dispatchModuleMock());
vi.mock(
  "../runtime/jobLifecycle.js",
  async () => (await import("./testing/compileExportMocks.js")).jobLifecycleModuleMock()
);
vi.mock(
  "../providers/loggedAdapters.js",
  async () => (await import("./testing/compileExportMocks.js")).loggedAdaptersModuleMock()
);
vi.mock(
  "../generation/embeddingWrites.js",
  async () => (await import("./testing/compileExportMocks.js")).embeddingWritesModuleMock()
);
vi.mock(
  "../generation/entityState.js",
  async () => (await import("./testing/compileExportMocks.js")).entityStateModuleMock()
);
vi.mock("./characters.js", async () => (await import("./testing/compileExportMocks.js")).charactersModuleMock());
vi.mock(
  "../generation/bookHelpers.js",
  async () => (await import("./testing/compileExportMocks.js")).bookHelpersModuleMock()
);
vi.mock("../generation/finalQaPageTargets.js", async () => {
  const actual =
    await vi.importActual<typeof import("../generation/finalQaPageTargets.js")>(
      "../generation/finalQaPageTargets.js"
    );
  return (await import("./testing/compileExportMocks.js")).finalQaPageTargetsModuleMock(actual);
});
vi.mock(
  "../generation/storyStateStore.js",
  async () => (await import("./testing/compileExportMocks.js")).storyStateStoreModuleMock()
);
vi.mock(
  "../generation/qualityEnrichment.js",
  async () => (await import("./testing/compileExportMocks.js")).qualityEnrichmentModuleMock()
);
vi.mock(
  "../generation/qualitySettings.js",
  async () => (await import("./testing/compileExportMocks.js")).qualitySettingsModuleMock()
);
vi.mock("../generation/pageReview.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/pageReview.js")>("../generation/pageReview.js");
  return (await import("./testing/compileExportMocks.js")).pageReviewModuleMock(actual);
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return (await import("./testing/compileExportMocks.js")).coreModuleMock(actual);
});

import { compileExport } from "./compileExport.js";
import { pendingExportPaths } from "../generation/exportArtifacts.js";
import {
  DETACHED_FROM_PROJECT_LIFECYCLE,
  EXPORT_REPAIR_FORMAT,
  PRESENTATION_ONLY_RECOMPILE,
  PRESENTATION_RECOMPILE_FALLBACK_STATUS
} from "@book-maker/core";
import { StopRequestedError } from "../runtime/jobTypes.js";
import { mocks } from "./testing/compileExportMocks.js";

describe("compileExport companion-format failure publication", () => {
  const dirs: string[] = [];
  const plan = { title: "The Long Walk", premise: "A walk home.", audience: "adults", chapters: [] };
  const input = {
    title: "The Long Walk",
    prompt: "A book about walking home.",
    category: "fiction",
    targetPages: 12,
    complexity: 3,
    temperature: 0.6,
    language: "en",
    mediaSettings: { finalReview: true }
  };

  const pages = Array.from({ length: 12 }, (_, position) => ({
    id: `page-${position + 1}`,
    index: position + 1,
    title: `Page ${position + 1}`,
    markdown: `Page ${position + 1} prose about the long walk home and everything seen along it.`,
    summary: `Page ${position + 1} summary.`,
    imagePrompt: null,
    status: "COMPLETED",
    images: [],
    chapter: null
  }));
  const publishedMarkdown = "# Published layout\n\nExact compiled prose.\n";
  const modelChapters: ReaderChapter[] = [
    { index: 1, title: "Setting Out", summary: "The road begins.", startPageIndex: 1, endPageIndex: 6 },
    { index: 2, title: "Coming Home", summary: "The road ends.", startPageIndex: 7, endPageIndex: 12 }
  ];

  const job = (payload: Record<string, unknown> = {}) =>
    ({
      data: { projectId: "project-1", planId: "plan-1", generationJobId: "gj-1", ...payload }
    }) as unknown as Job;

  beforeEach(async () => {
    vi.clearAllMocks();
    const storage = await mkdtemp(join(tmpdir(), "compile-export-companion-failure-"));
    dirs.push(storage);
    mocks.config.BOOK_STORAGE_DIR = storage;
    mocks.config.IMAGE_STORAGE_DIR = join(storage, "images");
    await mkdir(join(storage, "project-1"), { recursive: true });
    await writeFile(join(storage, "project-1", "book.md"), publishedMarkdown, "utf8");
    mocks.inputForPlanVersion.mockReturnValue(input);
    mocks.prisma.planVersion.findUnique.mockResolvedValue({
      id: "plan-1",
      planningPackage: plan,
      inputSnapshot: null
    });
    mocks.prisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      title: plan.title,
      status: "COMPLETE",
      contentRevision: 4,
      authorName: null,
      mediaSettings: {},
      pages,
      images: [],
      research: []
    });
    mocks.strategy.runFinalBookQa.mockResolvedValue({
      approved: true,
      issues: [],
      requiredFixes: [],
      repairPageIndexes: []
    });
    mocks.strategy.compileMarkdown.mockReturnValue("# The Long Walk\n\nProse.\n");
    mocks.createReaderChaptersForExport.mockResolvedValue({ chapters: modelChapters, source: "model" });
    mocks.generateJsonWithRetry.mockResolvedValue({ data: { issues: [] } });
    mocks.exportPublicationSuperseded.mockResolvedValue(false);
    // The real scratch names under a fixed token: `.book-test.md`, `.book-test.pdf`, …
    mocks.pendingExportPaths.mockImplementation((projectDir: string) => pendingExportPaths(projectDir, "test"));
    mocks.publishCompiledExports.mockImplementation(async (options: { characterPreparation?: unknown }) => ({
      published: true,
      characterPreparationJobId: options.characterPreparation ? "character-job-1" : null
    }));
    mocks.loadProjectStoryState.mockResolvedValue({ promises: [], facts: [], entities: {}, unanswered: [] });
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "balanced",
      enabled: (): boolean => false
    });
  });

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs.length = 0;
  });

  it("retires stale EPUB on a presentation reprint whose conversion fails", async () => {
    mocks.generateBookEpub.mockRejectedValue(new Error("converter failed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await compileExport(
      job({
        contentRevision: 4,
        skipFinalReview: true,
        [PRESENTATION_ONLY_RECOMPILE]: true,
        [PRESENTATION_RECOMPILE_FALLBACK_STATUS]: "REVIEW_REQUIRED"
      })
    );

    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({
        companionsProduced: { epub: false, docx: true },
        repairFormat: null,
        status: "REVIEW_REQUIRED"
      })
    );
    logged.mockRestore();
  });

  it("retires stale EPUB on an undo/manual recompile whose conversion fails", async () => {
    mocks.generateBookEpub.mockRejectedValue(new Error("converter failed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await compileExport(job({ contentRevision: 4, skipFinalReview: true }));

    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({
        companionsProduced: { epub: false, docx: true },
        repairFormat: null,
        ownsProjectStatus: true
      })
    );
    logged.mockRestore();
  });

  it("records a Word failure and still publishes the EPUB", async () => {
    // `clearAllMocks` keeps implementations, so the EPUB rejection an earlier
    // case installed has to be put back to a render that succeeds.
    mocks.generateBookEpub.mockResolvedValue(Buffer.alloc(0));
    mocks.generateBookDocx.mockRejectedValue(new Error("docx converter failed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await compileExport(job({ contentRevision: 4, skipFinalReview: true }));

    expect(mocks.generateBookDocx).toHaveBeenCalledTimes(2);
    expect(mocks.generateBookEpub).toHaveBeenCalledTimes(1);
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({ companionsProduced: { epub: true, docx: false }, repairFormat: null })
    );
    const reports = mocks.prisma.generationJob.update.mock.calls
      .map(([call]) => (call as { data?: { qualityReport?: { issues?: { code: string }[] } } }).data?.qualityReport)
      .filter((report) => report !== undefined);
    const codes = reports.at(-1)?.issues?.map((issue) => issue.code) ?? [];
    expect(codes).toContain("DOCX_EXPORT_FAILED");
    expect(codes).not.toContain("EPUB_EXPORT_FAILED");
    logged.mockRestore();
  });

  it("keeps both warnings when both companions fail", async () => {
    mocks.generateBookEpub.mockRejectedValue(new Error("epub converter failed"));
    mocks.generateBookDocx.mockRejectedValue(new Error("docx converter failed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await compileExport(job({ contentRevision: 4, skipFinalReview: true }));

    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({ companionsProduced: { epub: false, docx: false } })
    );
    const reports = mocks.prisma.generationJob.update.mock.calls
      .map(([call]) => (call as { data?: { qualityReport?: { issues?: { code: string }[] } } }).data?.qualityReport)
      .filter((report) => report !== undefined);
    const codes = reports.at(-1)?.issues?.map((issue) => issue.code) ?? [];
    expect(codes).toContain("EPUB_EXPORT_FAILED");
    expect(codes).toContain("DOCX_EXPORT_FAILED");
    logged.mockRestore();
  });
  it("renders only the Word file for a Word repair, from the exact published markdown", async () => {
    mocks.generateBookEpub.mockResolvedValue(Buffer.alloc(0));
    mocks.generateBookDocx.mockResolvedValue(Buffer.alloc(0));
    await compileExport(
      job({
        skipFinalReview: true,
        contentRevision: 4,
        [DETACHED_FROM_PROJECT_LIFECYCLE]: true,
        [EXPORT_REPAIR_FORMAT]: "docx"
      })
    );

    expect(mocks.strategy.generatePdf).not.toHaveBeenCalled();
    expect(mocks.generateBookEpub).not.toHaveBeenCalled();
    expect(mocks.generateBookDocx).toHaveBeenCalledWith(
      publishedMarkdown,
      expect.objectContaining({ outputPath: expect.stringContaining(".book-test.docx"), projectId: "project-1" })
    );
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({
        repairFormat: "docx",
        companionsProduced: { epub: true, docx: true },
        ownsProjectStatus: false
      })
    );
    // A Word repair renders no PDF, so it owes the stored page map nothing.
    expect(mocks.publishCompiledExports.mock.calls[0]?.[0]).not.toHaveProperty("pdfPageMap");
  });

  it("rethrows a StopRequestedError from the first EPUB render without publishing", async () => {
    const stop = new StopRequestedError();
    mocks.generateBookEpub.mockRejectedValue(stop);
    mocks.generateBookDocx.mockResolvedValue(Buffer.alloc(0));

    await expect(compileExport(job({ contentRevision: 4, skipFinalReview: true }))).rejects.toBe(stop);

    expect(mocks.generateBookEpub).toHaveBeenCalledTimes(1);
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
    const reports = mocks.prisma.generationJob.update.mock.calls
      .map(([call]) => (call as { data?: { qualityReport?: { issues?: { code: string }[] } } }).data?.qualityReport)
      .filter((report) => report !== undefined);
    const codes = reports.at(-1)?.issues?.map((issue) => issue.code) ?? [];
    expect(codes).not.toContain("EPUB_EXPORT_FAILED");
  });

  it("rethrows a StopRequestedError from the EPUB retry without publishing", async () => {
    const stop = new StopRequestedError();
    mocks.generateBookEpub
      .mockRejectedValueOnce(new Error("epub converter failed"))
      .mockRejectedValueOnce(stop);
    mocks.generateBookDocx.mockResolvedValue(Buffer.alloc(0));

    await expect(compileExport(job({ contentRevision: 4, skipFinalReview: true }))).rejects.toBe(stop);

    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
  });

  it("rethrows a StopRequestedError from the first Word render without publishing", async () => {
    const stop = new StopRequestedError();
    mocks.generateBookEpub.mockResolvedValue(Buffer.alloc(0));
    mocks.generateBookDocx.mockRejectedValue(stop);

    await expect(compileExport(job({ contentRevision: 4, skipFinalReview: true }))).rejects.toBe(stop);

    expect(mocks.generateBookEpub).toHaveBeenCalledTimes(1);
    expect(mocks.generateBookDocx).toHaveBeenCalledTimes(1);
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
    const reports = mocks.prisma.generationJob.update.mock.calls
      .map(([call]) => (call as { data?: { qualityReport?: { issues?: { code: string }[] } } }).data?.qualityReport)
      .filter((report) => report !== undefined);
    const codes = reports.at(-1)?.issues?.map((issue) => issue.code) ?? [];
    expect(codes).not.toContain("DOCX_EXPORT_FAILED");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "bullmq";

vi.mock("./compileFinalization.js", async () => (await import("./testing/compileExportMocks.js")).compileFinalizationModuleMock());
vi.mock("../generation/finalizationIllustrations.js", async () => (await import("./testing/compileExportMocks.js")).finalizationIllustrationsModuleMock());
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
import { isDefaultCompileQualityFeature, mocks } from "./testing/compileExportMocks.js";

describe("compile final-QA repair fence replacement handoff", () => {
  const input = {
    title: "The Long Walk",
    prompt: "A book about walking home.",
    category: "fiction",
    targetPages: 2,
    complexity: 3,
    temperature: 0.6,
    language: "en",
    // The defect screen and its scoped repair are the compile's one review and repair.
    mediaSettings: { modelTier: "fast" }
  };
  const plan = { title: input.title, premise: "A walk home.", audience: "adults", chapters: [] };
  const version = new Date("2026-01-01T00:00:00.000Z");
  const pages = [1, 2].map((index) => ({
    id: `page-${index}`,
    index,
    title: `Page ${index}`,
    markdown: `Original prose for page ${index}.`,
    summary: `Original summary for page ${index}.`,
    imagePrompt: index === 1 ? "The old scene." : null,
    revision: 1,
    status: "COMPLETED",
    updatedAt: version,
    images: [],
    chapter: null
  }));
  const storageDirs: string[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    const storage = await mkdtemp(join(tmpdir(), "compile-export-fence-handoff-"));
    storageDirs.push(storage);
    mocks.config.BOOK_STORAGE_DIR = storage;
    mocks.config.IMAGE_STORAGE_DIR = join(storage, "images");
    mocks.inputForPlanVersion.mockReturnValue(input);
    mocks.prisma.planVersion.findUnique.mockResolvedValue({
      id: "plan-1",
      planningPackage: plan,
      inputSnapshot: null
    });
    mocks.prisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      title: input.title,
      status: "GENERATING",
      contentRevision: 4,
      authorName: null,
      mediaSettings: {},
      pages,
      images: [],
      research: []
    });
    mocks.prisma.continuityNote.findMany.mockResolvedValue([]);
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "balanced", enabled: isDefaultCompileQualityFeature });
    mocks.generateJsonWithRetry.mockResolvedValue({ data: { issues: [] } });
    mocks.reviewQuickDraftManuscript.mockResolvedValue({ approved: false, score: 60, notes: "Focused screen.",
      issues: ["Page 1: The walk starts twice."], requiredFixes: ["Page 1: Start it once."],
      focusedReview: { rejectedFindings: 0, repairGroups: [[1]], findings: [{ targets: [1], kind: "duplicate",
        problem: "The walk starts twice.", fix: "Start it once.",
        evidence: [{ pageIndex: 1, quote: "Original prose for page 1." }, { pageIndex: 2, quote: "Original prose for page 2." }] }] } } as never);
    mocks.repairQuickDraftPages.mockReset().mockImplementation(async ({ pages: book }) =>
      book.map((page) => page.index === 1 ? { ...page, markdown: "Repaired prose for page 1." } : page));
    Object.assign(mocks.strategy, { shouldIllustratePage: () => true });
    mocks.prisma.page.update.mockImplementation(async ({ where, data }) => ({
      ...pages.find((page) => page.id === where.id),
      ...data,
      revision: 2
    }));

    let barriersCleared = 0;
    let databaseUnreachable = true;
    const barrierAnswer = async (): Promise<boolean> => {
      if (barriersCleared < 2) {
        barriersCleared += 1;
        return false;
      }
      if (databaseUnreachable) throw new Error("Connection terminated unexpectedly");
      return false;
    };
    mocks.exportPublicationSuperseded.mockImplementation(barrierAnswer);
    mocks.prisma.project.updateMany.mockImplementation(async () => ({ count: (await barrierAnswer()) ? 0 : 1 }));
    // The scoped repair publishes its group in one transaction, so a fence that goes dark at its
    // claim leaves the manuscript exactly as it was read.
    mocks.loadPagesForExport.mockImplementation(async () => {
      databaseUnreachable = false;
      return pages;
    });
    mocks.loadPageTextSnapshot.mockResolvedValue(
      pages.map(({ index, title, markdown, revision }) => ({
        index,
        title,
        markdown,
        revision
      }))
    );
  });

  afterEach(async () => {
    for (const key of ["shouldIllustratePage"]) {
      delete (mocks.strategy as Record<string, unknown>)[key];
    }
    await Promise.all(storageDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    storageDirs.length = 0;
  });

  it("defers final illustrations after a repair fence outage, writing no page, and hands the compile to a successor", async () => {
    mocks.enqueueFinalizationIllustrations.mockResolvedValueOnce({ kind: "ready", pendingJobIds: ["image-job-1"], missingPageIndexes: [] });
    const warnings: unknown[][] = [];
    const logged = vi.spyOn(console, "warn").mockImplementation((...args) => warnings.push(args));
    const job = {
      id: "bull-1",
      name: "compile-export",
      data: {
        projectId: "project-1",
        planId: "plan-1",
        generationJobId: "compile-predecessor",
        contentRevision: 4,
        exportPublicationProjectStatus: "GENERATING"
      }
    } as unknown as Job;

    try {
      const completion = await compileExport(job);
      expect(completion).toMatchObject({ lifecycleSettlement: "defer-to-successor" });
      expect(completion.afterJobCompleted).toEqual(expect.any(Function));
      expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
      await completion.afterJobCompleted?.();
    } finally {
      logged.mockRestore();
    }

    expect(mocks.prisma.generationJob.upsert).not.toHaveBeenCalled();
    expect(mocks.dispatchWorkerGenerationJob).not.toHaveBeenCalled();
    expect(mocks.enqueueFinalizationIllustrations).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1", planId: "plan-1", contentRevision: 4
    }));
    expect(mocks.repairQuickDraftPages).toHaveBeenCalledOnce();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(mocks.loadPagesForExport).toHaveBeenCalledWith("project-1");
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
    expect(mocks.strategy.compileMarkdown).not.toHaveBeenCalled();
    expect(warnings.map(([message]) => message)).toEqual(expect.arrayContaining([
      "Export compile stopped repairing: its ownership fence could not be read"
    ]));
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith(
      "project-1",
      "plan-1",
      {
        review: { skipFinalReview: false, withoutQualityVerdict: false },
        expectedProjectStatus: "GENERATING",
        ownership: { kind: "outcome" }
      },
      { contentRevision: 4, completedPredecessorId: "compile-predecessor" }
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "bullmq";

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
    mediaSettings: { finalReview: true }
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
  const repairedPageOne = {
    ...pages[0]!,
    title: "Repaired page 1",
    markdown: "Repaired prose for page 1.",
    summary: "Repaired summary for page 1.",
    imagePrompt: "The repaired scene.",
    revision: 2,
    updatedAt: new Date("2026-01-01T00:00:00.002Z")
  };
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
    mocks.strategy.runFinalBookQa.mockResolvedValue({
      approved: false,
      issues: [],
      requiredFixes: [],
      repairPageIndexes: [1, 2]
    });
    mocks.revisePageDraftWithRestart.mockResolvedValue({
      title: repairedPageOne.title,
      markdown: repairedPageOne.markdown,
      summary: repairedPageOne.summary,
      imagePrompt: repairedPageOne.imagePrompt,
      continuityNotes: []
    });
    Object.assign(mocks.strategy, {
      reviewPageDraft: vi.fn().mockResolvedValue({
        approved: true,
        score: 90,
        issues: [],
        requiredRevisions: [],
        notes: "",
        checks: { repetitionOk: true, progressionOk: true }
      }),
      revisePageDraft: vi.fn(),
      repairPageBrief: vi.fn(),
      shouldIllustratePage: () => true
    });
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
    mocks.loadPagesForExport.mockImplementation(async () => {
      databaseUnreachable = false;
      return [repairedPageOne, pages[1]!];
    });
    mocks.loadPageTextSnapshot.mockResolvedValue(
      [repairedPageOne, pages[1]!].map(({ index, title, markdown, revision }) => ({
        index,
        title,
        markdown,
        revision
      }))
    );
  });

  afterEach(async () => {
    for (const key of ["reviewPageDraft", "revisePageDraft", "repairPageBrief", "shouldIllustratePage"]) {
      delete (mocks.strategy as Record<string, unknown>)[key];
    }
    await Promise.all(storageDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    storageDirs.length = 0;
  });

  it("stands down and defers settlement when page 1 queued an image before page 2's fence failed", async () => {
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

    expect(mocks.prisma.generationJob.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchWorkerGenerationJob).toHaveBeenCalledWith("image-job-1");
    expect(mocks.loadPagesForExport).toHaveBeenCalledWith("project-1");
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
    expect(mocks.strategy.compileMarkdown).not.toHaveBeenCalled();
    expect(warnings.map(([message]) => message)).toEqual(expect.arrayContaining([
      "Export compile stopped repairing: its ownership fence could not be read",
      "Export compile superseded before publication"
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

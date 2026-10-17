import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "bullmq";
import type { ReaderChapter } from "@book-maker/core";

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
import { pendingExportPaths } from "../generation/exportArtifacts.js";
import {
  DETACHED_FROM_PROJECT_LIFECYCLE,
  EXPORT_REPAIR_FORMAT,
  bandhaRecapPages,
  PRESENTATION_ONLY_RECOMPILE,
  PRESENTATION_RECOMPILE_FALLBACK_STATUS,
  compilePolicyPayload,
  freeEditRecompilePolicy
} from "@book-maker/core";
import { isDefaultCompileQualityFeature, mocks } from "./testing/compileExportMocks.js";

describe("compileExport publication policy", () => {
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
  const pages = Array.from({ length: 12 }, (_, position) => {
    const index = position + 1;
    return {
      id: `page-${index}`,
      index,
      title: `Page ${index}`,
      markdown: `Page ${index} prose about the long walk home and everything seen along it.`,
      summary: `Page ${index} summary.`,
      imagePrompt: null,
      status: "COMPLETED",
      images: [],
      chapter: null
    };
  });
  const projectRecord = (status = "COMPLETE") => ({
    id: "project-1",
    title: plan.title,
    status,
    contentRevision: 4,
    authorName: null,
    mediaSettings: {},
    pages,
    images: [],
    research: []
  });
  const job = (payload: Record<string, unknown> = {}) =>
    ({
      data: { projectId: "project-1", planId: "plan-1", generationJobId: "gj-1", ...payload }
    }) as unknown as Job;
  const modelChapters: ReaderChapter[] = [
    { index: 1, title: "Setting Out", summary: "The road begins.", startPageIndex: 1, endPageIndex: 6 },
    { index: 2, title: "Coming Home", summary: "The road ends.", startPageIndex: 7, endPageIndex: 12 }
  ];

  beforeEach(async () => {
    vi.clearAllMocks();
    const storage = await mkdtemp(join(tmpdir(), "compile-export-policy-"));
    dirs.push(storage);
    mocks.config.BOOK_STORAGE_DIR = storage;
    mocks.config.IMAGE_STORAGE_DIR = join(storage, "images");
    await mkdir(join(storage, "project-1"), { recursive: true });
    await writeFile(join(storage, "project-1", "book.md"), "# Published layout\n\nExact compiled prose.\n", "utf8");
    mocks.inputForPlanVersion.mockReturnValue(input);
    mocks.prisma.planVersion.findUnique.mockResolvedValue({
      id: "plan-1",
      planningPackage: plan,
      inputSnapshot: null
    });
    mocks.prisma.project.findUnique.mockResolvedValue(projectRecord());
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
      enabled: isDefaultCompileQualityFeature
    });
    mocks.strategy.executionMode = "whole-book";
    mocks.parallelPageWaveSize.mockReturnValue(1);
  });

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs.length = 0;
  });

  it("claims COMPLETE for an unstamped skip-review compile of a COMPLETE book", async () => {
    // Dispatch stamps expectedProjectStatus from normalizedCompilePublicationPolicy.
    // The handler used to ignore that and treat skipFinalReview as EDITING when
    // the stamp was missing, so an unstamped edit-style compile of a finished
    // book would CAS against the wrong row.
    await compileExport(job({ contentRevision: 4, skipFinalReview: true }));

    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedProjectStatus: "COMPLETE",
        ownsProjectStatus: true,
        status: "COMPLETE"
      })
    );
  });

  it("claims EDITING for an unstamped full-review compile of an EDITING book", async () => {
    mocks.prisma.project.findUnique.mockResolvedValue(projectRecord("EDITING"));

    await compileExport(job({ contentRevision: 4 }));

    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedProjectStatus: "EDITING",
        ownsProjectStatus: true
      })
    );
  });

  it.each(["whole-book", "composed-chapters"])("runs one focused Quick Draft screen for %s without optional final review", async (executionMode) => {
    mocks.inputForPlanVersion.mockReturnValue({ ...input, mediaSettings: { modelTier: "fast", finalReview: false } });
    mocks.strategy.executionMode = executionMode;
    await compileExport(job({ contentRevision: 4 }));
    expect(mocks.reviewQuickDraftManuscript).toHaveBeenCalledTimes(1);
    expect(mocks.reviewQuickDraftManuscript).toHaveBeenCalledWith(expect.objectContaining({ pages }));
    expect(mocks.generateJsonWithRetry).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).toHaveBeenCalled();
  });

  it("screens a Balanced book composed by chapters the way it screens Quick Draft, and only behind finalBookQa", async () => {
    mocks.inputForPlanVersion.mockReturnValue({ ...input, mediaSettings: { modelTier: "balanced", finalReview: false } });
    mocks.strategy.executionMode = "composed-chapters";
    await compileExport(job({ contentRevision: 4 }));
    expect(mocks.reviewQuickDraftManuscript).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "balanced",
      enabled: (feature: string) => isDefaultCompileQualityFeature(feature) && feature !== "finalBookQa" });
    await compileExport(job({ contentRevision: 4 }));
    expect(mocks.reviewQuickDraftManuscript).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).toHaveBeenCalled();
  });

  it("does not charge a Quick Draft skip-review recompile for a manuscript review", async () => {
    mocks.inputForPlanVersion.mockReturnValue({ ...input, mediaSettings: { modelTier: "fast", finalReview: true } });
    await compileExport(job({ contentRevision: 4, skipFinalReview: true }));
    expect(mocks.reviewQuickDraftManuscript).not.toHaveBeenCalled();
    expect(mocks.generateJsonWithRetry).not.toHaveBeenCalled();
  });

  // 2026-10-16: a short or per-page book off Quick Draft is printed as drafted. Neither the retired
  // `finalReview` flag nor parallel-wave drafting buys it a model review any more (H7b).
  it.each([
    { executionMode: "whole-book", finalReview: true, waves: 1 },
    { executionMode: "sequential-pages", finalReview: true, waves: 4 },
    { executionMode: "sequential-pages", finalReview: false, waves: 4 },
    { executionMode: "draft-then-polish", finalReview: undefined, waves: 1 }
  ])("runs no model review on a Balanced $executionMode book (finalReview $finalReview, waves $waves)", async ({ executionMode, finalReview, waves }) => {
    mocks.strategy.executionMode = executionMode;
    mocks.parallelPageWaveSize.mockReturnValue(waves);
    mocks.inputForPlanVersion.mockReturnValue({ ...input, mediaSettings: finalReview === undefined ? {} : { finalReview } });

    await compileExport(job({ contentRevision: 4 }));

    expect(mocks.reviewQuickDraftManuscript).not.toHaveBeenCalled();
    expect(mocks.generateJsonWithRetry).not.toHaveBeenCalled();
    expect(mocks.revisePageDraftWithRestart).not.toHaveBeenCalled();
    expect(mocks.runDeterministicManuscriptChecks).toHaveBeenCalledWith(
      expect.objectContaining({ language: "en", expectedPageCount: 12 })
    );
    expect(mocks.strategy.generatePdf).toHaveBeenCalled();
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(expect.objectContaining({ status: "COMPLETE" }));
  });

  it("compiles a free edit's recompile exactly as the edit recompile it used to be", async () => {
    // Only its failure is not the book's (`runtime/jobLifecycle.ts`): what it
    // reviews, the status its verdict publishes, the edit it fences on and the
    // character pass are the outcome compile's (launch review B3).
    mocks.prisma.project.findUnique.mockResolvedValue(projectRecord("EDITING"));
    await compileExport(job({ contentRevision: 4, skipFinalReview: true, exportPublicationProjectStatus: "EDITING" }));
    await compileExport(job({ contentRevision: 4, ...compilePolicyPayload(freeEditRecompilePolicy("REVIEW_REQUIRED"), "EDITING") }));

    // Everything but the per-run scratch directory the two renders wrote into.
    const [edit, free] = mocks.publishCompiledExports.mock.calls.map((call) => {
      const { pending: _scratch, ...publication } = call[0] as Record<string, unknown>;
      return publication;
    });
    expect(free).toEqual(edit);
    expect(free).toMatchObject({ expectedProjectStatus: "EDITING", ownsProjectStatus: true, status: "COMPLETE" });
  });

  it("lets detached ownership win when a payload also claims to be a presentation reprint", async () => {
    await compileExport(
      job({
        contentRevision: 4,
        skipFinalReview: true,
        [DETACHED_FROM_PROJECT_LIFECYCLE]: true,
        [EXPORT_REPAIR_FORMAT]: "pdf",
        [PRESENTATION_ONLY_RECOMPILE]: true,
        [PRESENTATION_RECOMPILE_FALLBACK_STATUS]: "REVIEW_REQUIRED"
      })
    );

    expect(mocks.reviewQuickDraftManuscript).not.toHaveBeenCalled();
    expect(mocks.createReaderChaptersForExport).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({
        ownsProjectStatus: false,
        repairFormat: "pdf",
        status: "COMPLETE",
        characterPreparation: null
      })
    );
  });

  function persistedQualityReport(): {
    state: string;
    issues: Array<{ code: string; severity: string; source: string }>;
  } {
    const qualityUpdate = mocks.prisma.generationJob.update.mock.calls.find(
      (call) => (call[0] as { data?: { qualityReport?: { state?: string } } }).data?.qualityReport
    );
    if (!qualityUpdate) {
      throw new Error("expected compile to persist a qualityReport");
    }
    return (
      qualityUpdate[0] as {
        data: { qualityReport: { state: string; issues: Array<{ code: string; severity: string; source: string }> } };
      }
    ).data.qualityReport;
  }

  // Three pages that restate one establishment with explicit recap cues, so
  // the deterministic audit raises a RECAP_BACKTRACKING cluster. No model
  // adjudicates it since 2026-10-16: the defect screen reads for duplication,
  // and the adjudicator's findings fixed nothing (console only).
  function withRecapManuscript(): void {
    const recapPages = bandhaRecapPages().map((page) => ({
      id: `page-${page.index}`,
      index: page.index,
      title: page.title,
      markdown: page.markdown,
      summary: `Summary of page ${page.index}.`,
      imagePrompt: null,
      status: "COMPLETED",
      images: [],
      chapter: { id: "ch-1", index: page.chapterIndex ?? 1 }
    }));
    mocks.inputForPlanVersion.mockReturnValue({ ...input, targetPages: 3 });
    mocks.prisma.project.findUnique.mockResolvedValue({
      ...projectRecord(),
      pages: recapPages
    });
  }

  it.each([{ skipFinalReview: false }, { skipFinalReview: true }])(
    "keeps a deterministic structural cluster on the console with no model adjudication (skip $skipFinalReview)",
    async ({ skipFinalReview }) => {
      withRecapManuscript();

      await compileExport(job({ contentRevision: 4, ...(skipFinalReview ? { skipFinalReview } : {}) }));

      const purposes = mocks.generateJsonWithRetry.mock.calls.map(
        (call) => (call[1] as { purpose?: string } | undefined)?.purpose
      );
      expect(purposes).not.toContain("review-manuscript-structure");
      const report = persistedQualityReport();
      expect(report.issues.map((issue) => issue.code)).toContain("RECAP_BACKTRACKING");
      // Kept for the console; a recap cluster is not a reader finding.
      expect(report.state).toBe("passed");
      expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
        expect.objectContaining({ status: "COMPLETE" })
      );
    }
  );

  it("runs manuscript integrity when every optional quality feature is disabled", async () => {
    withRecapManuscript();
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "balanced",
      enabled: () => false
    });

    await compileExport(job({ contentRevision: 4 }));

    expect(mocks.runDeterministicManuscriptChecks).toHaveBeenCalled();
    expect(mocks.generateJsonWithRetry).not.toHaveBeenCalled();
    expect(persistedQualityReport().issues.map((issue) => issue.code)).toContain("RECAP_BACKTRACKING");
  });
});

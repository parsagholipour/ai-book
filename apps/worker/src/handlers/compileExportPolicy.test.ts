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
import {
  CORROBORATED_STRUCTURAL_DUPLICATION,
  DETACHED_FROM_PROJECT_LIFECYCLE,
  EXPORT_REPAIR_FORMAT,
  fourParaphrasedIndusWeightPages,
  MANUSCRIPT_STRUCTURAL_REVIEW_PURPOSE,
  PRESENTATION_ONLY_RECOMPILE,
  PRESENTATION_RECOMPILE_FALLBACK_STATUS
} from "@book-maker/core";
import { StopRequestedError } from "../runtime/jobTypes.js";
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
    mocks.pendingExportPaths.mockImplementation((projectDir: string) => ({
      markdown: join(projectDir, ".book-test.md"),
      pdf: join(projectDir, ".book-test.pdf"),
      epub: join(projectDir, ".book-test.epub")
    }));
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

  it("passes the local-page gate through to final book QA", async () => {
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "balanced",
      enabled: (feature: string) =>
        isDefaultCompileQualityFeature(feature) && feature !== "pageLocalQa"
    });

    await compileExport(job({ contentRevision: 4 }));

    expect(mocks.strategy.runFinalBookQa).toHaveBeenCalledWith(
      expect.objectContaining({ skipLocalChecks: true })
    );
  });

  it("honors an explicit final review even when the preset disables automatic final QA", async () => {
    mocks.strategy.executionMode = "sequential-pages";
    mocks.parallelPageWaveSize.mockReturnValue(4);
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "balanced",
      enabled: (feature: string) =>
        isDefaultCompileQualityFeature(feature) && feature !== "finalBookQa"
    });

    await compileExport(job({ contentRevision: 4 }));

    expect(mocks.strategy.runFinalBookQa).toHaveBeenCalledTimes(1);
    expect(mocks.generateJsonWithRetry).toHaveBeenCalledTimes(1);
    expect(mocks.revisePageDraftWithRestart).not.toHaveBeenCalled();
    expect(mocks.runDeterministicManuscriptChecks).toHaveBeenCalled();
    expect(mocks.runDeterministicManuscriptChecks).toHaveBeenCalledWith(
      expect.objectContaining({ language: "en", expectedPageCount: 12 })
    );
    expect(mocks.strategy.generatePdf).toHaveBeenCalled();
  });

  it("lets the preset disable automatic final QA when the project did not request it", async () => {
    mocks.strategy.executionMode = "sequential-pages";
    mocks.parallelPageWaveSize.mockReturnValue(4);
    mocks.inputForPlanVersion.mockReturnValue({
      ...input,
      mediaSettings: { ...input.mediaSettings, finalReview: false }
    });
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "balanced",
      enabled: (feature: string) =>
        isDefaultCompileQualityFeature(feature) && feature !== "finalBookQa"
    });

    await compileExport(job({ contentRevision: 4 }));

    expect(mocks.strategy.runFinalBookQa).not.toHaveBeenCalled();
    expect(mocks.generateJsonWithRetry).not.toHaveBeenCalled();
    expect(mocks.runDeterministicManuscriptChecks).toHaveBeenCalled();
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

    expect(mocks.strategy.runFinalBookQa).not.toHaveBeenCalled();
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

  function withIndusManuscript(): void {
    const indusPages = fourParaphrasedIndusWeightPages().map((page) => ({
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
    mocks.inputForPlanVersion.mockReturnValue({ ...input, targetPages: 4 });
    mocks.prisma.project.findUnique.mockResolvedValue({
      ...projectRecord(),
      pages: indusPages
    });
  }

  function mockJsonByPurpose(structural: Record<string, unknown>): void {
    mocks.generateJsonWithRetry.mockImplementation(async (_model: unknown, options?: { purpose?: string }) => {
      if (options?.purpose === MANUSCRIPT_STRUCTURAL_REVIEW_PURPOSE) {
        return { data: structural };
      }
      return { data: { issues: [] } };
    });
  }

  const duplicatedWeightsCluster = {
    canonicalPageIndex: 1,
    duplicatePageIndexes: [2, 3, 4],
    repeatedSubject: "Cubical chert weights as the same Indus administrative control of trade",
    repeatedEvidence: "The 13.63 gram unit, granary cubes, and matching balance pans recur on each page",
    repeatedConclusion: "Each page closes on administrative control of Indus trade through those weights",
    confidence: "high" as const,
    recommendedAction: "review" as const
  };

  it("still produces exports when a corroborated structural issue blocks publication", async () => {
    withIndusManuscript();
    mockJsonByPurpose({ clusters: [duplicatedWeightsCluster] });

    await compileExport(job({ contentRevision: 4 }));

    const report = persistedQualityReport();
    expect(report.state).toBe("blocked");
    expect(report.issues.map((issue) => issue.code)).toContain(CORROBORATED_STRUCTURAL_DUPLICATION);
    expect(mocks.strategy.generatePdf).toHaveBeenCalled();
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({ status: "REVIEW_REQUIRED" })
    );
  });

  it("keeps advisory structural findings COMPLETE with review_recommended", async () => {
    withIndusManuscript();
    mockJsonByPurpose({
      clusters: [{ ...duplicatedWeightsCluster, confidence: "medium" }]
    });

    await compileExport(job({ contentRevision: 4 }));

    expect(persistedQualityReport().state).toBe("review_recommended");
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({ status: "COMPLETE" })
    );
  });

  it("makes no structural-review call on a clean manuscript", async () => {
    await compileExport(job({ contentRevision: 4 }));

    const purposes = mocks.generateJsonWithRetry.mock.calls.map(
      (call) => (call[1] as { purpose?: string } | undefined)?.purpose
    );
    expect(purposes).not.toContain(MANUSCRIPT_STRUCTURAL_REVIEW_PURPOSE);
  });

  it("skips structural review when skipFinalReview is set", async () => {
    withIndusManuscript();
    await compileExport(job({ contentRevision: 4, skipFinalReview: true }));

    const purposes = mocks.generateJsonWithRetry.mock.calls.map(
      (call) => (call[1] as { purpose?: string } | undefined)?.purpose
    );
    expect(purposes).not.toContain(MANUSCRIPT_STRUCTURAL_REVIEW_PURPOSE);
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({ status: "COMPLETE" })
    );
  });

  it("preserves deterministic findings when structural review fails and still exports", async () => {
    withIndusManuscript();
    mocks.generateJsonWithRetry.mockImplementation(async (_model: unknown, options?: { purpose?: string }) => {
      if (options?.purpose === MANUSCRIPT_STRUCTURAL_REVIEW_PURPOSE) {
        throw new Error("model outage");
      }
      return { data: { issues: [] } };
    });

    await compileExport(job({ contentRevision: 4 }));

    const report = persistedQualityReport();
    expect(report.issues.map((issue) => issue.code)).toContain("SAME_CHAPTER_TREATMENT_REPETITION");
    expect(report.issues.map((issue) => issue.code)).not.toContain(CORROBORATED_STRUCTURAL_DUPLICATION);
    expect(report.state).not.toBe("passed");
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({ status: "COMPLETE" })
    );
  });

  it("lets a structural-review stop request escape", async () => {
    withIndusManuscript();
    mocks.generateJsonWithRetry.mockImplementation(async (_model: unknown, options?: { purpose?: string }) => {
      if (options?.purpose === MANUSCRIPT_STRUCTURAL_REVIEW_PURPOSE) {
        throw new StopRequestedError();
      }
      return { data: { issues: [] } };
    });

    await expect(compileExport(job({ contentRevision: 4 }))).rejects.toBeInstanceOf(StopRequestedError);
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
  });
});

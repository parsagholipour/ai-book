import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "bullmq";

const coverageReview = vi.hoisted(() => vi.fn());
const inventoryReview = vi.hoisted(() => vi.fn());
const operationReviews = vi.hoisted(() => new Map<string, unknown>());

// One finalization operation shared by both deliveries, as the durable row is:
// its review answers the successor from memory.
vi.mock("./compileFinalization.js", async () => {
  const actual = await vi.importActual<typeof import("./compileFinalization.js")>("./compileFinalization.js");
  const base = (await import("./testing/compileExportMocks.js")).compileFinalizationModuleMock();
  return { ...actual, ...base, openCompileFinalization: async (options: Parameters<typeof actual.openCompileFinalization>[0]) => {
    const operation = await base.openCompileFinalization(options);
    return { ...operation, state: { ...operation.state, key: "operation1", inputFingerprint: "configuration1" },
      review: async (stage: string, pages: unknown[], compute: () => Promise<unknown>) => {
        const key = `${stage}:${JSON.stringify(pages.map((page) => {
          const { images: _images, ...prose } = page as { images?: unknown }; return prose;
        }))}`;
        if (!operationReviews.has(key)) operationReviews.set(key, await compute());
        return operationReviews.get(key);
      },
    };
  } };
});
vi.mock("../generation/finalizationIllustrations.js", async () => (await import("./testing/compileExportMocks.js")).finalizationIllustrationsModuleMock());
vi.mock("@book-maker/db", async () => (await import("./testing/compileExportMocks.js")).dbModuleMock());
vi.mock("../runtime/config.js", async () => (await import("./testing/compileExportMocks.js")).configModuleMock());
vi.mock("../generation/projectInput.js", async () => (await import("./testing/compileExportMocks.js")).projectInputModuleMock());
vi.mock("../generation/exportPublication.js", async () => (await import("./testing/compileExportMocks.js")).exportPublicationModuleMock());
vi.mock("../runtime/dispatch.js", async () => (await import("./testing/compileExportMocks.js")).dispatchModuleMock());
vi.mock("../runtime/jobLifecycle.js", async () => (await import("./testing/compileExportMocks.js")).jobLifecycleModuleMock());
vi.mock("../providers/loggedAdapters.js", async () => (await import("./testing/compileExportMocks.js")).loggedAdaptersModuleMock());
vi.mock("../generation/embeddingWrites.js", async () => (await import("./testing/compileExportMocks.js")).embeddingWritesModuleMock());
vi.mock("../generation/entityState.js", async () => (await import("./testing/compileExportMocks.js")).entityStateModuleMock());
vi.mock("./characters.js", async () => (await import("./testing/compileExportMocks.js")).charactersModuleMock());
vi.mock("../generation/bookHelpers.js", async () => {
  const base = (await import("./testing/compileExportMocks.js")).bookHelpersModuleMock();
  return { ...base, strategyForInput: () => ({ ...base.strategyForInput(), shouldIllustratePage: () => true }) };
});
vi.mock("../generation/storyStateStore.js", async () => (await import("./testing/compileExportMocks.js")).storyStateStoreModuleMock());
vi.mock("../generation/qualityEnrichment.js", async () => (await import("./testing/compileExportMocks.js")).qualityEnrichmentModuleMock());
vi.mock("../generation/qualitySettings.js", async () => (await import("./testing/compileExportMocks.js")).qualitySettingsModuleMock());
vi.mock("../generation/pageReview.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/pageReview.js")>("../generation/pageReview.js");
  return (await import("./testing/compileExportMocks.js")).pageReviewModuleMock(actual);
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return { ...(await import("./testing/compileExportMocks.js")).coreModuleMock(actual),
    reviewManuscriptCoverage: coverageReview, inventoryManuscriptRequirements: inventoryReview };
});

import { compileExport } from "./compileExport.js";
import { pendingExportPaths } from "../generation/exportArtifacts.js";
import { isDefaultCompileQualityFeature, mocks } from "./testing/compileExportMocks.js";

/** A promise the test settles by hand, to hold one model call open while the compile carries on. */
function gate<T>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { open = resolve; });
  return { promise, open };
}

describe("a compile's verdict beside its other work", () => {
  let storage: string;
  // The 10-page illustrated story the timings were measured on: written page by
  // page, no chapter rows. On Balanced it has no model review since 2026-10-16
  // (H7b); the brief coverage read runs only where a revision lists it, which
  // `isDefaultCompileQualityFeature` does.
  const input = { prompt: "Rabbit and Turtle find a lantern in the woods.", category: "STORY", subcategory: "short_story",
    targetPages: 10, complexity: 5, temperature: 0.65, language: "en",
    mediaSettings: { finalReview: true, fullIllustrations: true, generationStrategy: "auto", modelTier: "balanced" } };
  const plan = { title: "The Lantern", premise: "Two friends find a light.", audience: "children", chapters: [] };
  const pages = Array.from({ length: 10 }, (_, position) => ({ id: `page-${position + 1}`, index: position + 1,
    title: `Scene ${position + 1}`, markdown: `Rabbit and Turtle carry the lantern past tree ${position + 1}.`,
    summary: "They walk on.", imagePrompt: "The two friends with a lantern.", status: "COMPLETED", images: [], chapter: null }));
  const projectRecord = () => ({ id: "project-1", title: plan.title, status: "GENERATING", contentRevision: 4,
    authorName: null, mediaSettings: {}, pages, images: [], research: [] });
  const job = (payload: Record<string, unknown> = {}) => ({ data: {
    projectId: "project-1", planId: "plan-1", generationJobId: "gj-1", contentRevision: 4, ...payload
  } }) as unknown as Job;
  const reportWrites = () => mocks.prisma.generationJob.update.mock.calls
    .filter((call) => (call[0] as { data?: { qualityReport?: unknown } }).data?.qualityReport);
  const reviewed = { status: "reviewed", assessmentComplete: true, requirements: [], issues: [] };

  beforeEach(async () => {
    vi.clearAllMocks();
    operationReviews.clear();
    storage = await mkdtemp(join(tmpdir(), "compile-concurrent-verdict-"));
    mocks.config.BOOK_STORAGE_DIR = storage;
    mocks.config.IMAGE_STORAGE_DIR = join(storage, "images");
    await mkdir(join(storage, "project-1"), { recursive: true });
    mocks.strategy.executionMode = "draft-then-polish";
    mocks.inputForPlanVersion.mockReturnValue(input);
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", planningPackage: plan, inputSnapshot: null });
    mocks.prisma.project.findUnique.mockResolvedValue(projectRecord());
    mocks.strategy.compileMarkdown.mockReturnValue("# The Lantern\n\nProse.\n");
    mocks.createReaderChaptersForExport.mockResolvedValue({ source: "model", chapters: [] });
    mocks.generateJsonWithRetry.mockResolvedValue({ data: { issues: [] } });
    mocks.exportPublicationSuperseded.mockResolvedValue(false);
    mocks.pendingExportPaths.mockImplementation((projectDir: string) => pendingExportPaths(projectDir, "test"));
    mocks.publishCompiledExports.mockResolvedValue({ published: true, characterPreparationJobId: null });
    mocks.enqueueFinalizationIllustrations.mockResolvedValue({ kind: "ready", pendingJobIds: [], missingPageIndexes: [] });
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "balanced", enabled: isDefaultCompileQualityFeature });
    coverageReview.mockResolvedValue(reviewed);
    inventoryReview.mockImplementation(async ({ brief }: { brief: string }) => ({ status: "available", brief, complete: true, requirements: [] }));
  });
  afterEach(async () => {
    mocks.strategy.executionMode = "whole-book";
    mocks.enqueueFinalizationIllustrations.mockResolvedValue({ kind: "ready", pendingJobIds: [], missingPageIndexes: [] });
    await rm(storage, { recursive: true, force: true });
  });

  it("makes no brief call and no model review for a Balanced per-page book while the coverage gate is off", async () => {
    // `briefCoverageReview` is off on every tier by default, for per-page books as for composed ones.
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "balanced",
      enabled: (feature: string) => isDefaultCompileQualityFeature(feature) && feature !== "briefCoverageReview" });

    await expect(compileExport(job())).resolves.toMatchObject({ durableCompletionCommitted: true });
    expect(inventoryReview).not.toHaveBeenCalled();
    expect(coverageReview).not.toHaveBeenCalled();
    expect(mocks.reviewQuickDraftManuscript).not.toHaveBeenCalled();
    // Its pictures are still made sure of: a book of the previous release deferred them to a review it no longer gets.
    expect(mocks.enqueueFinalizationIllustrations).toHaveBeenCalledOnce();
    expect(reportWrites()[0]![0]).not.toMatchObject({ data: { qualityReport: { briefCoverage: expect.anything() } } });
  });

  it("renders the PDF while the brief is still being checked, and publishes only once the verdict is recorded", async () => {
    const read = gate<typeof reviewed>();
    coverageReview.mockImplementation(() => read.promise);

    const compiling = compileExport(job());
    await vi.waitFor(() => expect(mocks.strategy.generatePdf).toHaveBeenCalledOnce());
    expect(reportWrites()).toHaveLength(0);
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();

    read.open(reviewed);
    await expect(compiling).resolves.toMatchObject({ durableCompletionCommitted: true });
    const recorded = mocks.prisma.generationJob.update.mock.invocationCallOrder[
      mocks.prisma.generationJob.update.mock.calls.findIndex((call) => (call[0] as { data?: { qualityReport?: unknown } }).data?.qualityReport)]!;
    expect(recorded).toBeLessThan(mocks.publishCompiledExports.mock.invocationCallOrder[0]!);
    expect(reportWrites()[0]![0]).toMatchObject({ data: { qualityReport: { briefCoverage: expect.any(Object) } } });
  });

  it("consults a failed render only after its verdict is recorded, as the serial compile did", async () => {
    mocks.strategy.generatePdf.mockRejectedValueOnce(new Error("Chromium went away"));

    await expect(compileExport(job())).rejects.toThrow("Chromium went away");
    expect(coverageReview).toHaveBeenCalledOnce();
    expect(reportWrites()).toHaveLength(1);
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
  });

  it("stands down without publishing when an edit lands during the read, and only after the render it started is drained", async () => {
    const read = gate<typeof reviewed>();
    coverageReview.mockImplementation(() => read.promise);
    let rendered = false;
    mocks.strategy.generatePdf.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); rendered = true; });
    mocks.discardPendingExports.mockImplementation(async () => { expect(rendered).toBe(true); });

    const compiling = compileExport(job());
    await vi.waitFor(() => expect(mocks.strategy.generatePdf).toHaveBeenCalledOnce());
    // The reader's edit commits while the brief is read; the next supersede read sees it.
    mocks.exportPublicationSuperseded.mockResolvedValue(true);
    read.open(reviewed);

    await expect(compiling).resolves.toEqual({});
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
    expect(mocks.discardPendingExports).toHaveBeenCalledOnce();
    expect(reportWrites().length).toBeGreaterThan(0);
  });

  it("makes neither brief call for a Quick Draft book written page by page", async () => {
    mocks.inputForPlanVersion.mockReturnValue({ ...input, mediaSettings: { ...input.mediaSettings, finalReview: false, modelTier: "fast" } });
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "fast" as unknown as "balanced", enabled: isDefaultCompileQualityFeature });

    await expect(compileExport(job())).resolves.toMatchObject({ durableCompletionCommitted: true });
    expect(mocks.reviewQuickDraftManuscript).toHaveBeenCalledOnce();
    expect(inventoryReview).not.toHaveBeenCalled();
    expect(coverageReview).not.toHaveBeenCalled();
    expect(reportWrites()[0]![0]).not.toMatchObject({ data: { qualityReport: { briefCoverage: expect.anything() } } });
  });
});

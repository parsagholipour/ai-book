import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "bullmq";
import { bookPlanSchema, createProjectSchema, pageQualityReportSchema, pictureBookReviewFingerprint } from "@book-maker/core";

const coverageReview = vi.hoisted(() => vi.fn());
const inventoryReview = vi.hoisted(() => vi.fn());
const finalizationPhase = vi.hoisted(() => vi.fn(async () => {}));
const operationChecks = vi.hoisted(() => new Map<string, unknown>());
const operationReviews = vi.hoisted(() => new Map<string, unknown>());

vi.mock("./compileFinalization.js", async () => {
  const actual = await vi.importActual<typeof import("./compileFinalization.js")>("./compileFinalization.js");
  const base = (await import("./testing/compileExportMocks.js")).compileFinalizationModuleMock();
  return { ...actual, ...base, openCompileFinalization: async (options: Parameters<typeof actual.openCompileFinalization>[0]) => {
    const operation = await base.openCompileFinalization(options);
    return { ...operation, state: { ...operation.state, key: "operation1", inputFingerprint: "configuration1" },
      phase: finalizationPhase,
      review: async (stage: string, pages: unknown[], compute: () => Promise<unknown>) => {
        const key = `${stage}:${JSON.stringify(pages.map((page) => {
          const { images: _images, ...prose } = page as { images?: unknown }; return prose;
        }))}`;
        if (!operationReviews.has(key)) operationReviews.set(key, await compute());
        return operationReviews.get(key);
      },
      exportCheck: async <T>(request: { slot: string; fingerprint: string; compute: () => Promise<T> }) => {
        const key = `${request.slot}:${request.fingerprint}`;
        if (!operationChecks.has(key)) operationChecks.set(key, await request.compute());
        return operationChecks.get(key) as T;
      } };
  } };
});
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
  async () => {
    const shared = await import("./testing/compileExportMocks.js");
    const base = shared.bookHelpersModuleMock();
    return { ...base, strategyForInput: () => ({ ...base.strategyForInput(),
      shouldIllustratePage: () => shared.mocks.inputForPlanVersion().category === "KIDS" }) };
  }
);
// One export of one module, over the real rest of it: which pages the final-QA
// repair redrafts is a test hook, while the per-message extractor behind the
// reader's quality card and the page bound both questions are asked in stay
// real, so the card assertions below measure the actual mapping.
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
  return { ...(await import("./testing/compileExportMocks.js")).coreModuleMock(actual),
    reviewManuscriptCoverage: coverageReview, inventoryManuscriptRequirements: inventoryReview };
});

import { compileExport } from "./compileExport.js";
import { pendingExportPaths } from "../generation/exportArtifacts.js";
import { isDefaultCompileQualityFeature, mocks } from "./testing/compileExportMocks.js";

describe("brief coverage at publication", () => {
  let storage: string;
  const input = { prompt: "A book about cryptography.", category: "SCIENCE", targetPages: 12,
    complexity: 7, temperature: 0.8, language: "en", mediaSettings: { finalReview: true } };
  const plan = { title: "Public Keys", premise: "Public key cryptography.", audience: "adults", chapters: [] };
  const pages = Array.from({ length: 12 }, (_, index) => ({ id: `page-${index + 1}`, index: index + 1,
    title: `Page ${index + 1}`, markdown: "", summary: "An explanation.", imagePrompt: null,
    status: "COMPLETED", images: [], chapter: null }));
  const projectRecord = () => ({ id: "project-1", title: plan.title, status: "COMPLETE", contentRevision: 4,
    authorName: null, mediaSettings: {}, pages, images: [], research: [] });
  const job = (payload: Record<string, unknown>) => ({ data: {
    projectId: "project-1", planId: "plan-1", generationJobId: "gj-1", ...payload
  } }) as unknown as Job;
  const persistedQualityReport = () => {
    const update = mocks.prisma.generationJob.update.mock.calls.find((call) => call[0].data?.qualityReport);
    return update![0].data.qualityReport as { state: string; issues: Array<{ code: string; severity: string }> };
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    operationChecks.clear(); operationReviews.clear();
    mocks.strategy.executionMode = "composed-chapters";
    mocks.createReaderChaptersForExport.mockResolvedValue({ source: "deterministic", chapters: [] });
    coverageReview.mockResolvedValue({ status: "reviewed", requirements: [], issues: [] });
    inventoryReview.mockImplementation(async ({ brief }: { brief: string }) => ({ status: "available", brief, complete: true, requirements: [] }));
    mocks.enqueueFinalizationIllustrations.mockResolvedValue({ kind: "ready", pendingJobIds: [], missingPageIndexes: [] });
    storage = await mkdtemp(join(tmpdir(), "compile-chapter-length-"));
    mocks.config.BOOK_STORAGE_DIR = storage;
    mocks.config.IMAGE_STORAGE_DIR = join(storage, "images");
    await mkdir(join(storage, "project-1"), { recursive: true });
    mocks.inputForPlanVersion.mockReturnValue(input);
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", planningPackage: plan, inputSnapshot: null });
    mocks.strategy.runFinalBookQa.mockResolvedValue({ approved: true, issues: [], requiredFixes: [], repairPageIndexes: [] });
    mocks.strategy.compileMarkdown.mockReturnValue("# Public Keys\n\nProse.\n");
    mocks.generateJsonWithRetry.mockResolvedValue({ data: { issues: [] } });
    mocks.exportPublicationSuperseded.mockResolvedValue(false);
    mocks.pendingExportPaths.mockImplementation((projectDir: string) => pendingExportPaths(projectDir, "test"));
    mocks.publishCompiledExports.mockResolvedValue({ published: true, characterPreparationJobId: null });
    mocks.loadProjectStoryState.mockResolvedValue({ promises: [], facts: [], entities: {}, unanswered: [] });
    mocks.rebuildProjectStoryState.mockResolvedValue({ promises: [], facts: [], entities: {}, unanswered: [] });
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "balanced", enabled: isDefaultCompileQualityFeature });
  });
  afterEach(async () => { mocks.strategy.executionMode = "whole-book";
    mocks.enqueueFinalizationIllustrations.mockResolvedValue({ kind: "ready", pendingJobIds: [], missingPageIndexes: [] });
    await rm(storage, { recursive: true, force: true }); });

  it.each(["ordinary", "superseded", "deferred_media"])("verifies final prose during image fan-out with %s state", async (mode) => {
    mocks.strategy.executionMode = "whole-book";
    const requirement = "Exactly 10 interior illustrations, on story pages 3, 6, 9, 12, 15, 18, 21, 24, 27, 30.";
    const brief = `Rabbit and Turtle find lanterns. ${requirement}`;
    mocks.inputForPlanVersion.mockReturnValue({ ...input, category: "KIDS", prompt: brief, targetPages: 30,
      mediaSettings: { finalReview: true, fullIllustrations: true, generationStrategy: "auto" } });
    const finalPages = Array.from({ length: 30 }, (_, position) => ({ ...pages[0], id: `p${position + 1}`, index: position + 1,
      title: `Scene ${position + 1}`, markdown: "Rabbit and Turtle carry a lantern together.",
      chapter: { index: Math.floor(position / 5) + 1, title: `Current section ${Math.floor(position / 5) + 1}`, summary: "The next part." } }));
    const savedPages = finalPages.map((page) => mode === "deferred_media" && page.index % 3 === 0 ? { ...page,
      status: "FAILED_QA", qualityReport: { approved: true, score: 86, groundedOk: true, groundingStatus: "not_applicable",
        unsupportedClaims: [], issues: [], requiredRevisions: [],
        checks: { placeholderFree: true, promptLeakFree: true, titleClean: true, repetitionOk: true, progressionOk: true, styleNatural: true },
        deferredMedia: { stage: "before_illustrations", brief, pageIndex: page.index, draftMarkdown: page.markdown,
          requirements: [{ kind: "interior_illustration", pageIndex: page.index, requirementQuote: requirement, quote: page.markdown }] }
      } } : page);
    mocks.prisma.project.findUnique.mockResolvedValue({ ...projectRecord(), pages: savedPages });
    const imageJobs = Array.from({ length: 30 }, (_, index) => `image${index + 1}`);
    mocks.enqueueFinalizationIllustrations.mockResolvedValue({ kind: "ready", pendingJobIds: imageJobs, missingPageIndexes: [] });
    coverageReview.mockImplementation(async ({ pages: reviewed, chapters, evidenceContext }) => {
      expect(mocks.enqueueFinalizationIllustrations).toHaveBeenCalledOnce();
      expect(reviewed.map((page: { markdown: string }) => page.markdown)).toEqual(finalPages.map((page) => page.markdown));
      expect(chapters).toHaveLength(6);
      expect(evidenceContext.illustratedPageIndexes).toEqual([]);
      return { status: "reviewed", assessmentComplete: true, requirements: [], issues: [] };
    });
    if (mode === "superseded") {
      mocks.exportPublicationSuperseded.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      expect(await compileExport(job({ contentRevision: 4 }))).toEqual({});
      expect(coverageReview).not.toHaveBeenCalled();
      expect(mocks.loadPageTextSnapshot).toHaveBeenCalledWith("project-1");
      expect(persistedQualityReport()).toMatchObject({ state: "passed" });
      expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
      expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
      return;
    }
    expect(await compileExport(job({ contentRevision: 4 }))).toMatchObject({ lifecycleSettlement: "defer-to-successor" });
    expect(inventoryReview).toHaveBeenCalledOnce();
    expect(inventoryReview.mock.invocationCallOrder[0]).toBeLessThan(mocks.strategy.runFinalBookQa.mock.invocationCallOrder[0]!);
    expect(coverageReview).toHaveBeenCalledOnce();
    expect(finalizationPhase).toHaveBeenCalledWith("coverage", imageJobs);
    expect(mocks.strategy.runFinalBookQa).toHaveBeenCalledOnce();
    expect(mocks.revisePageDraftWithRestart).not.toHaveBeenCalled();
    expect(mocks.createReaderChaptersForExport).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
    mocks.enqueueFinalizationIllustrations.mockResolvedValue({ kind: "ready", pendingJobIds: [], missingPageIndexes: [] });
    mocks.prisma.project.findUnique.mockResolvedValue({ ...projectRecord(), pages: savedPages.map((page) => ({ ...page,
      images: [{ type: "SCENE_ILLUSTRATION", path: `scene-${page.index}.png` }] })) });
    await compileExport(job({ contentRevision: 4, generationJobId: "gj-successor" }));
    expect(inventoryReview).toHaveBeenCalledOnce();
    expect(coverageReview).toHaveBeenCalledOnce();
    expect(mocks.strategy.runFinalBookQa).toHaveBeenCalledOnce();
    expect(mocks.createReaderChaptersForExport).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).toHaveBeenCalledOnce();
  });

  it("passes current grouped requirement findings to coverage even without chronological extraction", async () => {
    mocks.strategy.executionMode = "whole-book";
    const brief = "Turtle compares the two lantern locations.";
    const currentInput = createProjectSchema.parse({ ...input, category: "KIDS", prompt: brief, targetPages: 30,
      mediaSettings: { finalReview: true, fullIllustrations: true, generationStrategy: "auto" } });
    const currentPlan = bookPlanSchema.parse(plan);
    const finalPages = Array.from({ length: 30 }, (_, position) => ({ ...pages[0]!, id: `p${position + 1}`, index: position + 1,
      title: `Scene ${position + 1}`, markdown: `Rabbit and Turtle carry a lantern from post ${position + 1}.`,
      chapter: { index: Math.floor(position / 5) + 1, title: `Section ${Math.floor(position / 5) + 1}`, summary: "The next part." } }));
    const checks = { pageModelReview: true, storyExtractAudit: false, styleAuditor: false };
    const finding = { domain: "prose", basis: "missing_requirement", requirementQuote: brief, category: "brief",
      message: "The locations are never compared.", guidance: "Connect both locations in a comparison.",
      quote: finalPages[9]!.markdown, relatedEvidence: [] };
    mocks.inputForPlanVersion.mockReturnValue(currentInput);
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "balanced", enabled: (feature: string) => feature === "pageModelReview" });
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", planningPackage: currentPlan, inputSnapshot: null });
    mocks.prisma.project.findUnique.mockResolvedValue({ ...projectRecord(), pages: finalPages });
    mocks.prisma.generationJob.findUnique.mockResolvedValue({ projectId: "project-1", type: "COMPILE_EXPORT", status: "ACTIVE", payload: {
      pictureBookReview: { fingerprint: pictureBookReviewFingerprint({ input: currentInput, plan: currentPlan, pages: finalPages, checks }),
        reviews: finalPages.map(page => ({ pageIndex: page.index, draftMarkdown: page.markdown, completedChecks: checks,
          storyExtract: null, styleAudit: null, findings: page.index === 10 ? [finding] : [],
          report: pageQualityReportSchema.parse({ approved: page.index !== 10, score: 90, issues: page.index === 10 ? [finding.message] : [], requiredRevisions: [] }) })) }
    } });
    await compileExport(job({ contentRevision: 4 }));
    expect(coverageReview).toHaveBeenCalledWith(expect.objectContaining({ requirementTargets: [expect.objectContaining({
      pageIndex: 10, requirementQuote: brief, acceptanceCriteria: finding.guidance, evidence: [{ pageIndex: 10, quote: finding.quote }]
    })] }));
  });

  it("flags Balanced's explicitly requested comparison table when extraction is disabled", async () => {
    mocks.inputForPlanVersion.mockReturnValue({ ...input, prompt: "Explain public keys. Include at least one useful comparison table." });
    mocks.prisma.project.findUnique.mockResolvedValue({ ...projectRecord(), pages: pages.map((page) => ({ ...page, markdown: `A different explanation on page ${page.index}.` })) });
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "balanced", enabled: () => false });
    coverageReview.mockResolvedValue({ status: "reviewed", requirements: [], issues: [{
      code: "MISSING_BRIEF_REQUIREMENT", severity: "warning", source: "model",
      message: "The requested comparison table is missing.", guidance: "Add the requested comparison table.", affectedPageIndexes: []
    }] });
    await compileExport(job({ contentRevision: 4 }));
    expect(persistedQualityReport().issues).toContainEqual(expect.objectContaining({ code: "MISSING_BRIEF_REQUIREMENT" }));
    expect(coverageReview).toHaveBeenCalledWith(expect.objectContaining({ brief: expect.stringContaining("comparison table"), pages: expect.any(Array) }));
  });

  it("does not accuse Premium of an unpaid promise after the manuscript review finds its payoff", async () => {
    const promise = "Clearly explain the conceptual difference between the discrete logarithm problem and integer factorization.";
    const state = { promises: [{ id: "plan-1", text: promise, status: "open" as const, openedAtPage: 0 }], facts: [], entities: {}, unanswered: [] };
    mocks.rebuildProjectStoryState.mockResolvedValue(state);
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", planningPackage: { ...plan, promises: [promise] }, inputSnapshot: null });
    mocks.prisma.project.findUnique.mockResolvedValue({ ...projectRecord(), pages: pages.map((page) => ({ ...page, markdown: "Factoring recovers prime factors of a composite; a discrete logarithm recovers an exponent in a group." })) });
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "balanced", enabled: () => true });
    await compileExport(job({ contentRevision: 4 }));
    expect(persistedQualityReport().issues.map((issue) => issue.code)).not.toContain("UNPAID_PROMISE");
    expect(coverageReview).toHaveBeenCalledWith(expect.objectContaining({ promises: expect.arrayContaining([promise]) }));
  });
  it("records manuscript-reviewed missing promises as warnings and publishes the available book", async () => {
    mocks.prisma.project.findUnique.mockResolvedValue({ ...projectRecord(), pages: pages.map((page) => ({ ...page, markdown: "An explanation of public keys." })) });
    coverageReview.mockResolvedValue({ status: "reviewed", requirements: [], issues: [{
      code: "UNPAID_PROMISE", severity: "warning", source: "model",
      message: "The promised forward secrecy explanation is missing.", guidance: "Add the explanation.", affectedPageIndexes: []
    }] });
    await compileExport(job({ contentRevision: 4 }));
    expect(persistedQualityReport()).toMatchObject({ state: "review_recommended", issues: expect.arrayContaining([
      expect.objectContaining({ code: "UNPAID_PROMISE", severity: "warning", source: "model" })
    ]) });
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(expect.objectContaining({ status: "COMPLETE" }));
  });

  it.each([2, 6])("reviews and exports the current %i chapters even when the plan proposed four", async (count) => {
    const currentPages = pages.map((page, position) => ({ ...page, markdown: `Final prose on page ${page.index}.`,
      chapter: { index: Math.floor(position / (12 / count)) + 1,
        title: `Revised division ${Math.floor(position / (12 / count)) + 1}`, summary: "Current grouping." } }));
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", planningPackage: { ...plan,
      chapters: Array.from({ length: 4 }, (_, index) => ({ index: index + 1, title: `Initial ${index + 1}`,
        summary: "Provisional grouping.", targetPages: 3, keyBeats: [] })) }, inputSnapshot: null });
    mocks.prisma.project.findUnique.mockResolvedValue({ ...projectRecord(), pages: currentPages });
    await compileExport(job({ contentRevision: 4 }));
    const exported = mocks.strategy.compileMarkdown.mock.calls[0]![0].readerChapters;
    const reviewed = coverageReview.mock.calls[0]![0].chapters;
    expect(reviewed).toHaveLength(count);
    expect(reviewed).toEqual(exported.map(({ summary: _summary, ...chapter }: { summary: string }) => chapter));
    expect(reviewed[0]).toMatchObject({ title: "Revised division 1", startPageIndex: 1, endPageIndex: 12 / count });
    expect(mocks.createReaderChaptersForExport).not.toHaveBeenCalled();
  });

  it("resolves a per-page book's final grouping once and shares it with review and export", async () => {
    mocks.strategy.executionMode = "whole-book";
    const chapters = [
      { index: 1, title: "Current opening", summary: "Opening.", startPageIndex: 1, endPageIndex: 6 },
      { index: 2, title: "Current ending", summary: "Ending.", startPageIndex: 7, endPageIndex: 12 }
    ];
    mocks.createReaderChaptersForExport.mockResolvedValue({ source: "model", chapters });
    mocks.prisma.project.findUnique.mockResolvedValue({ ...projectRecord(), pages: pages.map((page) => ({ ...page, markdown: `Final prose on page ${page.index}.` })) });
    await compileExport(job({ contentRevision: 4 }));
    expect(mocks.createReaderChaptersForExport).toHaveBeenCalledOnce();
    expect(coverageReview.mock.calls[0]![0].chapters).toEqual(chapters.map(({ summary: _summary, ...chapter }) => chapter));
    expect(mocks.strategy.compileMarkdown.mock.calls[0]![0].readerChapters).toEqual(chapters);
  });

});

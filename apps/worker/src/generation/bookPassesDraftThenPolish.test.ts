import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterSetup } from "../runtime/jobTypes.js";
import { shouldIllustratePage } from "@book-maker/core";

const mocks = vi.hoisted(() => ({
  prisma: {
    project: { update: vi.fn() },
    page: { updateMany: vi.fn() },
    continuityNote: { createMany: vi.fn() },
    researchSource: { findMany: vi.fn() },
    generationJob: { findUnique: vi.fn(), update: vi.fn() },
    $transaction: vi.fn()
  },
  enqueueWorkerJob: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  maybeEnqueueCover: vi.fn(),
  reviewAndSaveGeneratedPage: vi.fn(),
  ensureCharacterReferenceAssets: vi.fn(),
  loadDirectResumeContext: vi.fn(),
  directResumeStateForContext: vi.fn(),
  rebuildChapterSetupsFromStored: vi.fn(),
  priorPageContextsFromStored: vi.fn(),
  prepareChapterSetups: vi.fn(),
  resetBookForDirectGeneration: vi.fn(),
  checkpointWholeBookDraftPages: vi.fn(),
  effectiveWholeBookDraftContext: vi.fn(),
  persistAcceptedWholeBookTarget: vi.fn(),
  reportAcceptedWholeBookDraft: vi.fn(),
  chapterSetupsForPlan: vi.fn(),
  reviewWholeBookDraftPages: vi.fn(),
  persistKeeperStoryDelta: vi.fn(),
  storeEmbedding: vi.fn(),
  updateEntityStateFromPage: vi.fn(),
  groupReview: vi.fn(),
  assertJobNotStopped: vi.fn(),
  qualityEnabled: vi.fn((_feature?: string): boolean => false),
  styleExcerptsForPage: vi.fn(
    async (options: { quality: { enabled: (feature: string) => boolean } }): Promise<string[]> =>
      options.quality.enabled("styleExcerpts") ? ["opening-voice"] : []
  )
}));

vi.mock("@book-maker/core", async (original) => ({ ...await original<object>(), reviewPictureBookManuscript: mocks.groupReview }));
vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  Prisma: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../runtime/dispatch.js", () => ({
  enqueueWorkerJob: mocks.enqueueWorkerJob,
  maybeEnqueueCompile: mocks.maybeEnqueueCompile,
  maybeEnqueueCover: mocks.maybeEnqueueCover
}));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn(), updateJobProgress: vi.fn(), assertJobNotStopped: mocks.assertJobNotStopped }));
vi.mock("./bookState.js", () => ({
  checkpointWholeBookDraftPages: mocks.checkpointWholeBookDraftPages,
  directResumeStateForContext: mocks.directResumeStateForContext,
  effectiveWholeBookDraftContext: mocks.effectiveWholeBookDraftContext,
  loadDirectResumeContext: mocks.loadDirectResumeContext,
  persistAcceptedWholeBookTarget: mocks.persistAcceptedWholeBookTarget,
  prepareChapterSetups: mocks.prepareChapterSetups,
  priorPageContextsFromStored: mocks.priorPageContextsFromStored,
  rebuildChapterSetupsFromStored: mocks.rebuildChapterSetupsFromStored,
  reportAcceptedWholeBookDraft: mocks.reportAcceptedWholeBookDraft,
  resetBookForDirectGeneration: mocks.resetBookForDirectGeneration
}));
vi.mock("./characterReferences.js", () => ({
  ensureCharacterReferenceAssets: mocks.ensureCharacterReferenceAssets
}));
vi.mock("./bookHelpers.js", () => ({
  chapterSetupsForPlan: mocks.chapterSetupsForPlan,
  styleExcerptsForPage: mocks.styleExcerptsForPage
}));
vi.mock("./wholeBookPageReview.js", () => ({ reviewWholeBookDraftPages: mocks.reviewWholeBookDraftPages }));
vi.mock("./generationContext.js", async () => {
  const actual = await vi.importActual<typeof import("./generationContext.js")>("./generationContext.js");
  return {
    chapterSetupForPage: actual.chapterSetupForPage,
    loadContinuityNotes: async () => [],
    loadResearchNotesForGeneration: async () => []
  };
});
vi.mock("./pageReview.js", () => ({ reviewAndSaveGeneratedPage: mocks.reviewAndSaveGeneratedPage }));
vi.mock("./qualityEnrichment.js", () => ({
  persistKeeperStoryDelta: mocks.persistKeeperStoryDelta
}));
vi.mock("./qualitySettings.js", () => ({
  loadQualityContext: async () => ({
    settings: {},
    tier: "balanced",
    enabled: (feature: string) => mocks.qualityEnabled(feature)
  }),
  applyPlanThinkingBoost: vi.fn()
}));
vi.mock("./embeddingWrites.js", () => ({
  storeEmbedding: mocks.storeEmbedding,
  // Mirrors the real predicate: the direct passes are never sequential-pages,
  // so their books skip semantic-memory writes nothing would ever read.
  strategyUsesSemanticMemory: (strategy: { executionMode?: string }) =>
    strategy?.executionMode === "sequential-pages"
}));
vi.mock("./entityState.js", () => ({ updateEntityStateFromPage: mocks.updateEntityStateFromPage }));

import { generateBookDraftThenPolish } from "./bookPasses.js";

function chapterSetup(index: number, startPage: number, endPage: number): ChapterSetup {
  return {
    chapter: { index, title: `Chapter ${index}`, summary: `Summary ${index}`, targetPages: endPage - startPage + 1, keyBeats: [] },
    startPage,
    endPage,
    brief: undefined
  } as unknown as ChapterSetup;
}

const twoChapterSetups = () => [chapterSetup(1, 1, 2), chapterSetup(2, 3, 4)];

const pageDraft = (index: number) => ({
  index,
  title: `Page ${index}`,
  markdown: `Page ${index} text.`,
  summary: `Page ${index} summary.`,
  continuityNotes: [] as string[]
});

type TestStrategy = {
  id: string;
  shouldIllustratePage: ReturnType<typeof vi.fn>;
  generateChapterDraft: ReturnType<typeof vi.fn>;
  generateBatchDraft: ReturnType<typeof vi.fn>;
  generateWholeBookDraft: ReturnType<typeof vi.fn>;
  polishPageDraft: ReturnType<typeof vi.fn>;
  generatePageDraft: ReturnType<typeof vi.fn>;
  batchSize?: number;
  createChapterBriefs?: undefined;
};

const baseStrategy = (): TestStrategy => ({
  id: "test-strategy",
  shouldIllustratePage: vi.fn().mockReturnValue(false),
  generateChapterDraft: vi.fn(),
  generateBatchDraft: vi.fn(),
  generateWholeBookDraft: vi.fn(),
  polishPageDraft: vi.fn(),
  generatePageDraft: vi.fn()
});

function baseOptions(strategy: ReturnType<typeof baseStrategy>) {
  return {
    projectId: "project-1",
    planId: "plan-1",
    // `temperature` is required on CreateProjectInput and defaulted to 0.8 by the
    // schema, so every input a handler builds carries one. Omitting it here made
    // this fixture NaN its way through the best-of ladder, whose zero-width-band
    // guard then read the duplicate rungs as "this book asked for temperature 0"
    // and skipped page 1's second polish — silently, and only in this suite.
    input: { targetPages: 4, temperature: 0.8, mediaSettings: {} },
    plan: { title: "Book", chapters: [] },
    providers: { text: {}, embedding: {} },
    strategy,
    generationJobId: "gj-1"
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.groupReview.mockReset();
  mocks.qualityEnabled.mockReturnValue(false);
  mocks.assertJobNotStopped.mockResolvedValue(undefined);
  mocks.prisma.generationJob.findUnique.mockResolvedValue({ payload: {} });
  mocks.prisma.generationJob.update.mockResolvedValue({});
  mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(mocks.prisma));
  mocks.loadDirectResumeContext.mockResolvedValue({ chapters: [], pages: [] });
  mocks.directResumeStateForContext.mockReturnValue({ kind: "fresh" });
  mocks.prepareChapterSetups.mockResolvedValue(twoChapterSetups());
  mocks.resetBookForDirectGeneration.mockResolvedValue(new Map([[1, "ch-1"], [2, "ch-2"]]));
  mocks.rebuildChapterSetupsFromStored.mockReturnValue({
    chapterSetups: twoChapterSetups(),
    chapterIds: new Map([[1, "ch-1"], [2, "ch-2"]])
  });
  mocks.priorPageContextsFromStored.mockReturnValue([]);
  mocks.ensureCharacterReferenceAssets.mockResolvedValue([]);
  mocks.reviewAndSaveGeneratedPage.mockImplementation(async ({ draft }: { draft: { index: number; title: string; markdown: string; summary: string } }) => ({
    page: {
      index: draft.index,
      title: draft.title,
      markdown: draft.markdown,
      summary: draft.summary
    }
  }));
  mocks.chapterSetupsForPlan.mockReturnValue(twoChapterSetups());
  mocks.prisma.researchSource.findMany.mockResolvedValue([]);
  mocks.prisma.project.update.mockResolvedValue({});
  mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
  mocks.enqueueWorkerJob.mockResolvedValue({ id: "image-job" });
});

describe("generateBookDraftThenPolish", () => {
  function draftThenPolishStrategy() {
    const strategy = baseStrategy();
    strategy.createChapterBriefs = undefined;
    strategy.generateWholeBookDraft.mockResolvedValue({
      pages: [pageDraft(1), pageDraft(2), pageDraft(3), pageDraft(4)]
    });
    strategy.polishPageDraft.mockImplementation(
      async ({ draft }: { draft: { index: number } }) => ({ ...pageDraft(draft.index), title: `Polished ${draft.index}` })
    );
    return strategy;
  }

  beforeEach(() => {
    mocks.effectiveWholeBookDraftContext.mockImplementation(
      (input: unknown, plan: unknown) => ({ input, plan, chapterSetups: twoChapterSetups() })
    );
  });

  function pictureBookOptions() {
    const strategy = draftThenPolishStrategy();
    strategy.shouldIllustratePage.mockReturnValue(true);
    strategy.generateWholeBookDraft.mockResolvedValue({ pages: Array.from({ length: 30 }, (_, i) => pageDraft(i + 1)) });
    const options: Parameters<typeof generateBookDraftThenPolish>[0] = baseOptions(strategy);
    Object.assign(options.input, { category: "KIDS", targetPages: 30, mediaSettings: {
      fullIllustrations: true, finalReview: true, generationStrategy: "auto", modelTier: "balanced"
    } });
    mocks.qualityEnabled.mockReturnValue(true);
    mocks.groupReview.mockImplementation(async ({ pages, checks }: { pages: ReturnType<typeof pageDraft>[]; checks: object }) => pages.map((page) => ({
      pageIndex: page.index, draftMarkdown: page.markdown,
      report: { approved: true, score: 95, issues: [], requiredRevisions: [], notes: "" },
      storyExtract: { storyDelta: {}, contradictions: [] }, styleAudit: { styleOk: true, styleIssues: [] }, completedChecks: checks
    })));
    return { options, strategy };
  }

  it("reviews a clean 30-page picture-book manuscript once with every configured check and no unconditional polish", async () => {
    const { options, strategy } = pictureBookOptions();
    const snapshots: unknown[] = [];
    mocks.reviewAndSaveGeneratedPage.mockImplementation(async (value) => {
      snapshots.push(structuredClone({ draft: value.draft, previousPages: value.previousPages, nextPages: value.nextPages, deferRepairsUntilFinalization: value.deferRepairsUntilFinalization, precomputedReview: value.precomputedReview }));
      return { page: value.draft };
    });
    await generateBookDraftThenPolish(options);
    expect(strategy.polishPageDraft).not.toHaveBeenCalled();
    expect(mocks.groupReview).toHaveBeenCalledTimes(1);
    expect(mocks.groupReview.mock.calls[0]![0]).toMatchObject({ checks: { pageModelReview: true, storyExtractAudit: true, styleAuditor: true } });
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(30);
    expect(snapshots[0]).toMatchObject({ nextPages: [{ index: 2, markdown: "Page 2 text." }, ...Array.from({ length: 28 }, (_, i) => expect.objectContaining({ index: i + 3 }))],
      deferRepairsUntilFinalization: true, precomputedReview: { completedChecks: { pageModelReview: true, storyExtractAudit: true, styleAuditor: true } } });
    expect(snapshots[29]).toMatchObject({ draft: pageDraft(30), previousPages: Array.from({ length: 29 }, (_, i) => expect.objectContaining({ index: i + 1, markdown: pageDraft(i + 1).markdown })), nextPages: [] });
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");
  });

  it("preserves a concrete failed page and its full frozen neighbors for finalization repair", async () => {
    const { options, strategy } = pictureBookOptions();
    const original = mocks.groupReview.getMockImplementation()!;
    mocks.groupReview.mockImplementation(async (value) => {
      const reviews = await original(value);
      reviews[14].report = { approved: false, score: 45, issues: ["The lantern recovery repeats page 12."], requiredRevisions: ["Count the already recovered lantern and advance to the second."], notes: "" };
      return reviews;
    });
    await generateBookDraftThenPolish(options);
    expect(strategy.polishPageDraft).not.toHaveBeenCalled();
    expect(mocks.reviewAndSaveGeneratedPage.mock.calls[14]![0]).toMatchObject({ draft: pageDraft(15), deferRepairsUntilFinalization: true,
      precomputedReview: { report: { approved: false, requiredRevisions: ["Count the already recovered lantern and advance to the second."] },
        manuscriptPages: Array.from({ length: 30 }, (_, i) => expect.objectContaining({ index: i + 1, markdown: pageDraft(i + 1).markdown })) } });
    expect(mocks.reviewAndSaveGeneratedPage.mock.calls[15]![0].draft.markdown).toBe(pageDraft(16).markdown);
  });

  it.each(["fast", "balanced", "premium"] as const)("uses one complete prose review for a %s text-only story and retains genuine defects", async (modelTier) => {
    const { options, strategy } = pictureBookOptions();
    Object.assign(options.input.mediaSettings, { modelTier, fullIllustrations: false, illustrationCadence: "manual", includeCover: false, coverArtSource: "none" });
    strategy.shouldIllustratePage.mockImplementation(shouldIllustratePage);
    const original = mocks.groupReview.getMockImplementation()!;
    mocks.groupReview.mockImplementation(async (value) => {
      const reviews = await original(value);
      reviews[29].report = { approved: false, score: 45, issues: ["Turtle's requested growth is missing."], requiredRevisions: ["Give Turtle a consequential changed choice."], notes: "" };
      return reviews;
    });
    await generateBookDraftThenPolish(options);
    expect(strategy.generateWholeBookDraft).toHaveBeenCalledTimes(1);
    expect(strategy.polishPageDraft).not.toHaveBeenCalled();
    expect(mocks.groupReview).toHaveBeenCalledTimes(1);
    expect(mocks.groupReview.mock.calls[0]![0]).toMatchObject({
      pages: Array.from({ length: 30 }, (_, i) => expect.objectContaining({ index: i + 1, markdown: pageDraft(i + 1).markdown })),
      checks: { pageModelReview: true, storyExtractAudit: true, styleAuditor: true }
    });
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(30);
    for (const [request] of mocks.reviewAndSaveGeneratedPage.mock.calls) expect(request.precomputedReview).toBeDefined();
    expect(mocks.reviewAndSaveGeneratedPage.mock.calls[29]![0]).toMatchObject({ deferRepairsUntilFinalization: true,
      precomputedReview: { report: { approved: false, requiredRevisions: ["Give Turtle a consequential changed choice."] } } });
    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");
  });

  it("reviews all thirty text pages once with ten illustration slots and retains an unillustrated page's defect", async () => {
    const { options, strategy } = pictureBookOptions();
    options.input.mediaSettings.illustrationCadence = "every-third-page";
    strategy.shouldIllustratePage.mockImplementation(shouldIllustratePage);
    const original = mocks.groupReview.getMockImplementation()!;
    mocks.groupReview.mockImplementation(async (value) => {
      const reviews = await original(value);
      reviews[1].report = { approved: false, score: 45, issues: ["The search repeats an already recovered lantern."], requiredRevisions: ["Preserve the recovered count."], notes: "" };
      return reviews;
    });
    await generateBookDraftThenPolish(options);
    expect(strategy.polishPageDraft).not.toHaveBeenCalled();
    expect(mocks.groupReview).toHaveBeenCalledTimes(1);
    expect(mocks.groupReview.mock.calls[0]![0].pages).toHaveLength(30);
    expect(mocks.reviewAndSaveGeneratedPage.mock.calls.map(([value]) => value.draft.index)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(mocks.reviewAndSaveGeneratedPage.mock.calls[1]![0]).toMatchObject({
      draft: pageDraft(2), deferRepairsUntilFinalization: true,
      precomputedReview: { report: { approved: false, requiredRevisions: ["Preserve the recovered count."] } }
    });
    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");
  });

  it("resumes only pending pages against the same complete saved manuscript", async () => {
    const { options, strategy } = pictureBookOptions();
    mocks.directResumeStateForContext.mockReturnValue({ kind: "resume", firstMissingPageIndex: 16 });
    const pages = Array.from({ length: 30 }, (_, i) => ({ ...pageDraft(i + 1), status: i < 15 ? "COMPLETED" : "PENDING" }));
    mocks.loadDirectResumeContext.mockResolvedValue({ chapters: [], pages });
    mocks.priorPageContextsFromStored.mockReturnValue(pages.slice(0, 15));
    await generateBookDraftThenPolish(options);
    expect(strategy.generateWholeBookDraft).not.toHaveBeenCalled();
    expect(strategy.polishPageDraft).not.toHaveBeenCalled();
    expect(mocks.resetBookForDirectGeneration).not.toHaveBeenCalled();
    expect(mocks.groupReview.mock.calls[0]![0].pages).toHaveLength(30);
    expect(mocks.reviewAndSaveGeneratedPage.mock.calls.map(([value]) => value.draft.index)).toEqual(Array.from({ length: 15 }, (_, i) => i + 16));
  });

  it("does not publish or queue export when cancellation happens during the grouped review", async () => {
    const { options } = pictureBookOptions();
    mocks.groupReview.mockRejectedValueOnce(Object.assign(new Error("stopped"), { name: "AbortError" }));
    await expect(generateBookDraftThenPolish(options)).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("publishes no pages until the real grouped reviewer has completed its one-page recovery", async () => {
    const { options, strategy } = pictureBookOptions();
    const core = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
    const snapshots: number[][] = [];
    let calls = 0;
    const textModel = { generateJson: async <T,>(request: import("@book-maker/core").GenerateJsonOptions<T>) => {
      core.consumeTextAttempt(request);
      const context = JSON.parse(request.messages.find((message) => message.role === "user")!.content);
      snapshots.push(context.reviewPageIndexes);
      expect(context.pages).toHaveLength(30);
      expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
      calls += 1;
      const rows = context.reviewPageIndexes.map((index: number) => ({ pageIndex: index, score: 94,
        findings: calls === 1 && index === 18 ? [{ domain: "prose", basis: "missing_requirement", requirementQuote: "Internal plan beat only.", category: "brief", message: "Missing beat", guidance: "Change page.", quote: "Not actual manuscript prose", relatedEvidence: [] }] : [],
        storyExtract: "no_changes", styleAudit: "clean" }));
      return { data: request.schema.parse({ pages: rows }), text: "", model: "fixture", provider: "fixture" };
    } } as unknown as import("@book-maker/core").TextModelAdapter;
    options.input.prompt = "A lantern story.";
    mocks.groupReview.mockImplementation((request) => core.reviewPictureBookManuscript({ ...request, textModel }));
    await generateBookDraftThenPolish(options);
    expect(snapshots).toEqual([Array.from({ length: 30 }, (_, i) => i + 1), [18]]);
    expect(strategy.polishPageDraft).not.toHaveBeenCalled();
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(30);
    for (const [request] of mocks.reviewAndSaveGeneratedPage.mock.calls) {
      expect(request.precomputedReview).toBeDefined();
      expect(request.deferRepairsUntilFinalization).toBe(true);
    }
  });

  it.each([true, false])("never cascades to individual page checks after group failure with fullIllustrations=%s", async (fullIllustrations) => {
    const { options, strategy } = pictureBookOptions();
    options.input.mediaSettings.fullIllustrations = fullIllustrations;
    strategy.shouldIllustratePage.mockImplementation(shouldIllustratePage);
    mocks.groupReview.mockRejectedValueOnce(Object.assign(new Error("OpenAI response was incomplete: max_output_tokens."), { name: "OpenAIResponseError" }));
    await expect(generateBookDraftThenPolish(options)).rejects.toMatchObject({ name: "OpenAIResponseError" });
    expect(strategy.polishPageDraft).not.toHaveBeenCalled();
    expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("overlaps reference setup with group review only after checkpoint, and drains failures before publishing", async () => {
    const { options } = pictureBookOptions();
    let releaseReferences!: () => void;
    const references = new Promise<void>((resolve) => { releaseReferences = resolve; });
    let reviewStarted!: () => void;
    const started = new Promise<void>((resolve) => { reviewStarted = resolve; });
    mocks.ensureCharacterReferenceAssets.mockImplementationOnce(async () => { await references; return []; });
    const failure = new Error("reference storage unavailable");
    mocks.groupReview.mockImplementationOnce(async () => { reviewStarted(); throw failure; });
    const run = generateBookDraftThenPolish(options);
    let settled = false;
    const checked = expect(run).rejects.toBe(failure).finally(() => { settled = true; });
    await started;
    expect(mocks.checkpointWholeBookDraftPages).toHaveBeenCalled();
    expect(mocks.ensureCharacterReferenceAssets).toHaveBeenCalled();
    expect(settled).toBe(false);
    releaseReferences();
    await checked;
    expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("drafts once, checkpoints before polishing, then polishes every page", async () => {
    const strategy = draftThenPolishStrategy();
    const order: string[] = [];
    mocks.checkpointWholeBookDraftPages.mockImplementation(async () => {
      order.push("checkpoint");
    });
    mocks.persistAcceptedWholeBookTarget.mockImplementation(async () => {
      order.push("persist-target");
    });
    strategy.polishPageDraft.mockImplementation(async ({ draft }: { draft: { index: number } }) => {
      order.push(`polish-${draft.index}`);
      return pageDraft(draft.index);
    });

    await generateBookDraftThenPolish(baseOptions(strategy));

    expect(strategy.generateWholeBookDraft).toHaveBeenCalledTimes(1);
    // The checkpoint and the accepted-target write both land before the first
    // polish, so a failure mid-polish resumes instead of redrafting the book.
    expect(order.slice(0, 2)).toEqual(["checkpoint", "persist-target"]);
    expect(order.filter((step) => step.startsWith("polish-"))).toEqual([
      // Page 1 polishes twice: this harness leaves the tier unset (balanced),
      // and the first page best-ofs by tier (`firstPageCandidateCount`).
      "polish-1",
      "polish-1",
      "polish-2",
      "polish-3",
      "polish-4"
    ]);
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(4);
    expect(mocks.reviewAndSaveGeneratedPage.mock.calls[0]![0].nextPages).toHaveLength(3);
  });

  it("defers every illustrated page to the requested final manuscript review", async () => {
    const strategy = draftThenPolishStrategy();
    const options: Parameters<typeof generateBookDraftThenPolish>[0] = baseOptions(strategy);
    options.input.mediaSettings.finalReview = true;

    await generateBookDraftThenPolish(options);

    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(4);
    for (const [saved] of mocks.reviewAndSaveGeneratedPage.mock.calls) {
      expect(saved).toMatchObject({ deferIllustrations: true });
    }
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");
  });

  it("resumes polishing only the PENDING pages without repeating the draft call", async () => {
    mocks.directResumeStateForContext.mockReturnValue({ kind: "resume", firstMissingPageIndex: 3 });
    mocks.loadDirectResumeContext.mockResolvedValue({
      chapters: [],
      pages: [
        { index: 1, status: "COMPLETED", title: "Page 1", markdown: "One.", summary: "S1", imagePrompt: null },
        { index: 2, status: "COMPLETED", title: "Page 2", markdown: "Two.", summary: "S2", imagePrompt: null },
        { index: 3, status: "PENDING", title: "Page 3", markdown: "Three.", summary: "S3", imagePrompt: null },
        { index: 4, status: "PENDING", title: "Page 4", markdown: "Four.", summary: "S4", imagePrompt: null }
      ]
    });
    const strategy = draftThenPolishStrategy();

    await generateBookDraftThenPolish(baseOptions(strategy));

    expect(strategy.generateWholeBookDraft).not.toHaveBeenCalled();
    expect(mocks.resetBookForDirectGeneration).not.toHaveBeenCalled();
    expect(strategy.polishPageDraft).toHaveBeenCalledTimes(2);
    expect(strategy.polishPageDraft.mock.calls.map((call) => (call[0] as { pageIndex: number }).pageIndex)).toEqual([3, 4]);
  });

  it("skips everything when the book is already polished", async () => {
    mocks.directResumeStateForContext.mockReturnValue({ kind: "already-complete" });
    const strategy = draftThenPolishStrategy();

    await generateBookDraftThenPolish(baseOptions(strategy));

    expect(strategy.generateWholeBookDraft).not.toHaveBeenCalled();
    expect(strategy.polishPageDraft).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");
  });
});

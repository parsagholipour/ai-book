import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterSetup } from "../runtime/jobTypes.js";
import { shouldIllustratePage, inputWithSelectedPageCount } from "@book-maker/core";

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
  // The grouped picture-book review no generation path calls since 2026-10-16 (E4); kept as a sentinel.
  assertJobNotStopped: vi.fn(),
  qualityEnabled: vi.fn((_feature?: string): boolean => false),
  styleExcerptsForPage: vi.fn(
    async (options: { quality: { enabled: (feature: string) => boolean } }): Promise<string[]> =>
      options.quality.enabled("styleExcerpts") ? ["opening-voice"] : []
  )
}));

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
const draftIllustrations = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock("./draftIllustrations.js", () => ({ enqueueDraftPageIllustrations: draftIllustrations.enqueue }));
const storyDeltas = vi.hoisted(() => ({ persist: vi.fn(), rows: vi.fn(async () => [] as unknown[]) }));
vi.mock("./bookStoryDeltas.js", () => ({ persistBookStoryDeltas: storyDeltas.persist, storyDeltaPagesFromRows: storyDeltas.rows }));

import { generateBookDraftThenPolish } from "./draftThenPolish.js";

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
  generatePageDraft: vi.fn()
});

function baseOptions(strategy: ReturnType<typeof baseStrategy>) {
  return {
    projectId: "project-1",
    planId: "plan-1",
    // `temperature` is required on CreateProjectInput and defaulted to 0.8 by the
    // schema, so every input a handler builds carries one.
    input: { targetPages: 4, temperature: 0.8, mediaSettings: {} },
    plan: { title: "Book", chapters: [] },
    providers: { text: {}, embedding: {} },
    strategy,
    generationJobId: "gj-1"
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
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
    return { options, strategy };
  }

  it.each(["balanced", "premium"])("saves a %s picture book's pages as drafted with local checks only: no grouped call and no model page review", async (modelTier) => {
    // E4 (2026-10-16): the grouped review, its repairs and the compile's final review against the draft went
    // 7 / 19 / 2 with three blind readers per order; no generated page is read by a model since then (E5 took the
    // rest), which `reviewAndSaveGeneratedPage` holds for every caller.
    const { options } = pictureBookOptions();
    Object.assign((options as unknown as { input: { mediaSettings: object } }).input.mediaSettings, { modelTier });
    const snapshots: unknown[] = [];
    mocks.reviewAndSaveGeneratedPage.mockImplementation(async (value) => {
      snapshots.push(structuredClone({ draft: value.draft, previousPages: value.previousPages, nextPages: value.nextPages }));
      return { page: value.draft };
    });
    await generateBookDraftThenPolish(options);
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(30);
    for (const [request] of mocks.reviewAndSaveGeneratedPage.mock.calls) {
      expect(request).not.toHaveProperty("precomputedReview");
    }
    expect(snapshots[0]).toMatchObject({ draft: { index: 1, markdown: pageDraft(1).markdown },
      nextPages: [{ index: 2, markdown: "Page 2 text." }, ...Array.from({ length: 28 }, (_, i) => expect.objectContaining({ index: i + 3 }))] });
    expect(snapshots[29]).toMatchObject({ draft: pageDraft(30), previousPages: Array.from({ length: 29 }, (_, i) => expect.objectContaining({ index: i + 1, markdown: pageDraft(i + 1).markdown })), nextPages: [] });
    expect(draftIllustrations.enqueue).toHaveBeenCalledTimes(1);
    expect(draftIllustrations.enqueue.mock.calls[0]![0]).not.toHaveProperty("reviews");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");
  });

  it("saves a Quick Draft picture book's pages as drafted with no grouped call: the compile's screen is its one review", async () => {
    const { options } = pictureBookOptions();
    Object.assign((options as unknown as { input: { mediaSettings: object } }).input.mediaSettings, { finalReview: false, modelTier: "fast" });
    await generateBookDraftThenPolish(options);
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(30);
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");
  });

  it("prints a Quick Draft picture book as drafted when the operator has its compile screen switched off", async () => {
    // The per-page polish this used to fall back to lost to the unpolished draft
    // (E4, 2026-10-16), so "no review" is the measured outcome, not a gap.
    const { options } = pictureBookOptions();
    Object.assign((options as unknown as { input: { mediaSettings: object } }).input.mediaSettings, { finalReview: false, modelTier: "fast" });
    mocks.qualityEnabled.mockReturnValue(false);
    await generateBookDraftThenPolish(options);
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(30);
    expect(mocks.reviewAndSaveGeneratedPage.mock.calls[0]![0].draft).toMatchObject({ index: 1, markdown: pageDraft(1).markdown });
    expect(draftIllustrations.enqueue).toHaveBeenCalledTimes(1);
  });

  it("drafts and persists the map's chapter allocation before reviewing the manuscript", async () => {
    const { options, strategy } = pictureBookOptions();
    options.plan.chapters = [12, 18].map((targetPages, i) => ({ index: i + 1, targetPages,
      title: `Search ${i + 1}`, summary: `Search stage ${i + 1}.`, keyBeats: [] }));
    const setups = options.plan.chapters.map((chapter, i) => ({
      chapter: { ...chapter, targetPages: i === 0 ? 20 : 10 }, startPage: i === 0 ? 1 : 21, endPage: i === 0 ? 20 : 30,
      brief: { chapterIndex: chapter.index, title: chapter.title, summary: chapter.summary, continuityFocus: [],
        pages: Array.from({ length: i === 0 ? 20 : 10 }, (_, p) => ({ pageIndex: p + (i === 0 ? 1 : 21), chapterIndex: chapter.index,
          purpose: `New discovery ${i}-${p}`, beat: `Follow the next clue ${i}-${p}`, requiredContinuity: [], endingPressure: "Continue the search." })) }
    }));
    options.strategy = { ...options.strategy, createChapterBriefs: vi.fn() };
    mocks.prepareChapterSetups.mockResolvedValue(setups);
    mocks.effectiveWholeBookDraftContext.mockImplementation((input, plan) => ({ input, plan, chapterSetups: setups }));
    await generateBookDraftThenPolish(options);
    expect(strategy.generateWholeBookDraft.mock.calls[0]![0].plan.chapters.map((chapter: { targetPages: number }) => chapter.targetPages)).toEqual([20, 10]);
    expect(mocks.persistAcceptedWholeBookTarget.mock.calls[0]![0]).toMatchObject({ chapterAllocationChanged: true,
      plan: { chapters: [{ targetPages: 20 }, { targetPages: 10 }] } });
    expect(mocks.persistAcceptedWholeBookTarget.mock.invocationCallOrder[0]).toBeLessThan(mocks.reviewAndSaveGeneratedPage.mock.invocationCallOrder[0]!);
    expect(options.plan.chapters.map(chapter => chapter.targetPages)).toEqual([12, 18]);
  });

  it("uses and checkpoints all 33 selected pages before review for a 30-page request", async () => {
    const { options, strategy } = pictureBookOptions();
    const brief = { chapterIndex: 1, title: "Lantern path", summary: "The friends return home.", continuityFocus: [],
      pages: Array.from({ length: 33 }, (_, i) => ({ pageIndex: i + 1, chapterIndex: 1,
        purpose: `Discover clue ${i + 1}.`, beat: `Follow clue ${i + 1}.`, requiredContinuity: [], endingPressure: "Continue the search." })) };
    const setups = [{ chapter: { index: 1, title: brief.title, summary: brief.summary, targetPages: 33, keyBeats: [] }, startPage: 1, endPage: 33, brief }];
    options.strategy = { ...options.strategy, createChapterBriefs: vi.fn() };
    mocks.prepareChapterSetups.mockResolvedValue(setups);
    strategy.generateWholeBookDraft.mockResolvedValue({ pages: Array.from({ length: 33 }, (_, i) => pageDraft(i + 1)) });
    mocks.effectiveWholeBookDraftContext.mockImplementation((input, plan) => ({ input: inputWithSelectedPageCount(input, 33), plan, chapterSetups: setups }));
    await generateBookDraftThenPolish(options);
    expect(strategy.generateWholeBookDraft.mock.calls[0]![0].input).toMatchObject({ targetPages: 33,
      mediaSettings: { generationPageCount: { requestedPages: 30, selectedPages: 33 } } });
    expect(mocks.persistAcceptedWholeBookTarget.mock.calls[0]![0]).toMatchObject({ originalTargetPages: 30,
      input: { targetPages: 33 }, plan: { chapters: [{ targetPages: 33 }] } });
    expect(mocks.checkpointWholeBookDraftPages.mock.calls[0]![0].pages).toHaveLength(33);
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(33);
  });

  it.each(["balanced", "premium"] as const)("saves a %s text-only children's story as drafted, with no model review of the whole or of a page", async (modelTier) => {
    const { options, strategy } = pictureBookOptions();
    Object.assign(options.input.mediaSettings, { modelTier, fullIllustrations: false, illustrationCadence: "manual", includeCover: false, coverArtSource: "none" });
    strategy.shouldIllustratePage.mockImplementation(shouldIllustratePage);
    await generateBookDraftThenPolish(options);
    expect(strategy.generateWholeBookDraft).toHaveBeenCalledTimes(1);
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(30);
    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");
  });

  it("resumes only pending pages without repeating the draft", async () => {
    const { options, strategy } = pictureBookOptions();
    mocks.directResumeStateForContext.mockReturnValue({ kind: "resume", firstMissingPageIndex: 16 });
    const pages = Array.from({ length: 30 }, (_, i) => ({ ...pageDraft(i + 1), status: i < 15 ? "COMPLETED" : "PENDING" }));
    mocks.loadDirectResumeContext.mockResolvedValue({ chapters: [], pages });
    mocks.priorPageContextsFromStored.mockReturnValue(pages.slice(0, 15));
    await generateBookDraftThenPolish(options);
    expect(strategy.generateWholeBookDraft).not.toHaveBeenCalled();
    expect(mocks.resetBookForDirectGeneration).not.toHaveBeenCalled();
    expect(mocks.reviewAndSaveGeneratedPage.mock.calls.map(([value]) => value.draft.index)).toEqual(Array.from({ length: 15 }, (_, i) => i + 16));
  });

  it("drafts once, checkpoints before the page loop, then saves every page as drafted", async () => {
    const strategy = draftThenPolishStrategy();
    const order: string[] = [];
    mocks.checkpointWholeBookDraftPages.mockImplementation(async () => {
      order.push("checkpoint");
    });
    mocks.persistAcceptedWholeBookTarget.mockImplementation(async () => {
      order.push("persist-target");
    });
    mocks.reviewAndSaveGeneratedPage.mockImplementation(async ({ draft }: { draft: { index: number; title: string; markdown: string; summary: string } }) => {
      order.push(`save-${draft.index}`);
      return { page: draft };
    });

    await generateBookDraftThenPolish(baseOptions(strategy));

    expect(strategy.generateWholeBookDraft).toHaveBeenCalledTimes(1);
    // The checkpoint and the accepted-target write both land before the first
    // save, so a failure mid-loop resumes instead of redrafting the book.
    expect(order).toEqual(["checkpoint", "persist-target", "save-1", "save-2", "save-3", "save-4"]);
    // No page is polished (E4, 2026-10-16): each save gets the whole-book draft's page.
    expect(mocks.reviewAndSaveGeneratedPage.mock.calls.map(([saved]) => saved.draft)).toEqual([1, 2, 3, 4].map((index) => expect.objectContaining({ index, markdown: pageDraft(index).markdown })));
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(4);
    expect(mocks.reviewAndSaveGeneratedPage.mock.calls[0]![0].nextPages).toHaveLength(3);
    // No story pass: a generated book pays for no story memory (E6, 2026-10-16).
    expect(storyDeltas.persist).not.toHaveBeenCalled();
  });

  it("publishes every page's picture with the page, whatever the retired final-review flag says", async () => {
    // 2026-10-16: no compile review rewrites these pages off Quick Draft, and Quick Draft's
    // screen redraws a page it repairs at finalization, so no picture waits for the compile.
    const strategy = draftThenPolishStrategy();
    const options: Parameters<typeof generateBookDraftThenPolish>[0] = baseOptions(strategy);
    options.input.mediaSettings.finalReview = true;

    await generateBookDraftThenPolish(options);

    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(4);
    for (const [saved] of mocks.reviewAndSaveGeneratedPage.mock.calls) {
      expect(saved).not.toHaveProperty("deferIllustrations");
    }
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");
  });

  it("resumes saving only the PENDING pages without repeating the draft call", async () => {
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
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(2);
    expect(mocks.reviewAndSaveGeneratedPage.mock.calls.map(([saved]) => saved.draft.index)).toEqual([3, 4]);
  });

  it("skips everything when the book is already saved", async () => {
    mocks.directResumeStateForContext.mockReturnValue({ kind: "already-complete" });
    const strategy = draftThenPolishStrategy();

    await generateBookDraftThenPolish(baseOptions(strategy));

    expect(strategy.generateWholeBookDraft).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");
    expect(storyDeltas.persist).not.toHaveBeenCalled();
  });

  it("starts a picture book's pictures once its sheets are committed, before it saves a page", async () => {
    const { options } = pictureBookOptions();
    const order: string[] = [];
    mocks.ensureCharacterReferenceAssets.mockImplementationOnce(async () => { order.push("sheets"); return []; });
    draftIllustrations.enqueue.mockImplementationOnce(async () => { order.push("pictures"); return 30; });
    mocks.reviewAndSaveGeneratedPage.mockImplementation(async ({ draft }) => { order.push(`save-${draft.index}`); return { page: draft }; });
    await generateBookDraftThenPolish(options);
    expect(order.slice(0, 3)).toEqual(["sheets", "pictures", "save-1"]);
    const request = draftIllustrations.enqueue.mock.calls[0]![0];
    expect(request).toMatchObject({ projectId: "project-1", planId: "plan-1", strategy: options.strategy, input: options.input });
    expect(request.pages.map((page: { index: number }) => page.index)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(request).not.toHaveProperty("reviews");
  });

  it("draws no early picture for a book off the picture-book path: its pages are drawn at publication", async () => {
    const strategy = draftThenPolishStrategy();
    strategy.shouldIllustratePage.mockReturnValue(true);
    await generateBookDraftThenPolish(baseOptions(strategy));
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(4);
    expect(draftIllustrations.enqueue).not.toHaveBeenCalled();
    // And decides no sheet cast: off the path every page job draws against the whole cast, as before.
    expect(mocks.ensureCharacterReferenceAssets.mock.calls[0]![0]).not.toHaveProperty("decideCastFromDraft");
  });

  it("hands a picture book's whole draft to the sheet pass, so its cast is decided from every picture", async () => {
    const { options } = pictureBookOptions();
    const prompted = Array.from({ length: 30 }, (_, i) => ({ ...pageDraft(i + 1), imagePrompt: `Scene ${i + 1}` }));
    (options.strategy as unknown as TestStrategy).generateWholeBookDraft.mockResolvedValue({ pages: prompted });
    await generateBookDraftThenPolish(options);
    const request = mocks.ensureCharacterReferenceAssets.mock.calls[0]![0];
    expect(request.decideCastFromDraft.map((page: { index: number; imagePrompt: string }) => [page.index, page.imagePrompt]))
      .toEqual(prompted.map((page) => [page.index, page.imagePrompt]));
  });

  it("decides a resumed picture book's cast from every checkpointed row, the saved ones included", async () => {
    const { options } = pictureBookOptions();
    mocks.directResumeStateForContext.mockReturnValue({ kind: "resume", firstMissingPageIndex: 16 });
    const pages = Array.from({ length: 30 }, (_, i) => ({ ...pageDraft(i + 1), imagePrompt: `Scene ${i + 1}`,
      status: i < 15 ? "COMPLETED" : "PENDING" }));
    mocks.loadDirectResumeContext.mockResolvedValue({ chapters: [], pages });
    mocks.priorPageContextsFromStored.mockReturnValue(pages.slice(0, 15));
    await generateBookDraftThenPolish(options);
    const request = mocks.ensureCharacterReferenceAssets.mock.calls[0]![0];
    expect(request.decideCastFromDraft.map((page: { index: number }) => page.index)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(request.decideCastFromDraft[0]).toMatchObject({ imagePrompt: "Scene 1" });
    // The pictures still queue from the rows left to save, each carrying its prompt.
    expect(draftIllustrations.enqueue.mock.calls[0]![0].pages.map((page: { imagePrompt: string }) => page.imagePrompt))
      .toEqual(Array.from({ length: 15 }, (_, i) => `Scene ${i + 16}`));
  });
});

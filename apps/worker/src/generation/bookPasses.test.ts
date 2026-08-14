import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterSetup } from "../runtime/jobTypes.js";

const mocks = vi.hoisted(() => ({
  prisma: {
    project: { update: vi.fn() },
    researchSource: { findMany: vi.fn() },
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
  storeEmbedding: vi.fn(),
  updateEntityStateFromPage: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("../runtime/dispatch.js", () => ({
  enqueueWorkerJob: mocks.enqueueWorkerJob,
  maybeEnqueueCompile: mocks.maybeEnqueueCompile,
  maybeEnqueueCover: mocks.maybeEnqueueCover
}));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn(), updateJobProgress: vi.fn() }));
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
  reviewWholeBookDraftPages: mocks.reviewWholeBookDraftPages
}));
vi.mock("./generationContext.js", async () => {
  const actual = await vi.importActual<typeof import("./generationContext.js")>("./generationContext.js");
  return {
    chapterSetupForPage: actual.chapterSetupForPage,
    loadContinuityNotes: async () => [],
    loadResearchNotesForGeneration: async () => []
  };
});
vi.mock("./pageReview.js", () => ({ reviewAndSaveGeneratedPage: mocks.reviewAndSaveGeneratedPage }));
vi.mock("./qualitySettings.js", () => ({
  loadQualityContext: async () => ({
    settings: {},
    tier: "balanced",
    enabled: () => false
  }),
  applyPlanThinkingBoost: vi.fn()
}));
vi.mock("./semanticMemory.js", () => ({
  storeEmbedding: mocks.storeEmbedding,
  updateEntityStateFromPage: mocks.updateEntityStateFromPage,
  // Mirrors the real predicate: the direct passes are never sequential-pages,
  // so their books skip semantic-memory writes nothing would ever read.
  strategyUsesSemanticMemory: (strategy: { executionMode?: string }) =>
    strategy?.executionMode === "sequential-pages"
}));

import {
  generateBookBatchWindow,
  generateBookChapterWholePass,
  generateBookDraftThenPolish,
  generateBookWholePass,
  isRecoverableBatchDraftRangeError
} from "./bookPasses.js";

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
    input: { targetPages: 4, mediaSettings: {} },
    plan: { title: "Book", chapters: [] },
    providers: { text: {}, embedding: {} },
    strategy,
    generationJobId: "gj-1"
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
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
    index: draft.index,
    title: draft.title,
    markdown: draft.markdown,
    summary: draft.summary
  }));
  mocks.chapterSetupsForPlan.mockReturnValue(twoChapterSetups());
  mocks.prisma.researchSource.findMany.mockResolvedValue([]);
  mocks.prisma.project.update.mockResolvedValue({});
});

describe("generateBookChapterWholePass", () => {
  it("requires the strategy to support chapter drafting", async () => {
    const strategy = baseStrategy();
    strategy.generateChapterDraft = undefined as never;

    await expect(generateBookChapterWholePass(baseOptions(strategy))).rejects.toThrow(
      /does not support chapter whole-pass/
    );
  });

  it("skips straight to the export when every page already exists", async () => {
    mocks.directResumeStateForContext.mockReturnValue({ kind: "already-complete" });
    const strategy = baseStrategy();

    await generateBookChapterWholePass(baseOptions(strategy));

    expect(strategy.generateChapterDraft).not.toHaveBeenCalled();
    expect(mocks.resetBookForDirectGeneration).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");
  });

  it("drafts every chapter from a fresh start and saves each page", async () => {
    const strategy = baseStrategy();
    strategy.generateChapterDraft.mockImplementation(async ({ chapter }: { chapter: { index: number } }) => ({
      pages: chapter.index === 1 ? [pageDraft(1), pageDraft(2)] : [pageDraft(3), pageDraft(4)]
    }));

    await generateBookChapterWholePass(baseOptions(strategy));

    expect(mocks.prepareChapterSetups).toHaveBeenCalled();
    expect(mocks.resetBookForDirectGeneration).toHaveBeenCalled();
    expect(strategy.generateChapterDraft).toHaveBeenCalledTimes(2);
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(4);
    expect(mocks.maybeEnqueueCover).toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");
  });

  it("resumes at the chapter holding the first missing page instead of wiping the book", async () => {
    mocks.directResumeStateForContext.mockReturnValue({ kind: "resume", firstMissingPageIndex: 3 });
    mocks.priorPageContextsFromStored.mockReturnValue([pageDraft(1), pageDraft(2)]);
    const strategy = baseStrategy();
    const draftCalls: Array<{ chapterIndex: number; previousPageIndexes: number[] }> = [];
    strategy.generateChapterDraft.mockImplementation(
      async ({ chapter, previousPages }: { chapter: { index: number }; previousPages: Array<{ index: number }> }) => {
        // Snapshot: the pass mutates previousPages in place as pages save.
        draftCalls.push({ chapterIndex: chapter.index, previousPageIndexes: previousPages.map((page) => page.index) });
        return { pages: [pageDraft(3), pageDraft(4)] };
      }
    );

    await generateBookChapterWholePass(baseOptions(strategy));

    // Chapter 1 (pages 1-2) is settled; only chapter 2 is redrafted, with the
    // settled pages as context, and nothing is deleted.
    expect(mocks.resetBookForDirectGeneration).not.toHaveBeenCalled();
    expect(draftCalls).toEqual([{ chapterIndex: 2, previousPageIndexes: [1, 2] }]);
    expect(mocks.prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "GENERATING" }
    });
  });
});

describe("generateBookBatchWindow", () => {
  it("drafts the book in batch windows and saves every page", async () => {
    const strategy = baseStrategy();
    strategy.batchSize = 2;
    strategy.generateBatchDraft.mockImplementation(async ({ pageStart, pageEnd }: { pageStart: number; pageEnd: number }) => ({
      pages: Array.from({ length: pageEnd - pageStart + 1 }, (_, offset) => pageDraft(pageStart + offset))
    }));

    await generateBookBatchWindow(baseOptions(strategy));

    expect(strategy.generateBatchDraft).toHaveBeenCalledTimes(2);
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(4);
    expect(strategy.generatePageDraft).not.toHaveBeenCalled();
  });

  it("drafts an omitted page individually instead of losing it", async () => {
    const strategy = baseStrategy();
    strategy.batchSize = 2;
    strategy.generateBatchDraft.mockImplementation(async ({ pageStart, pageEnd }: { pageStart: number; pageEnd: number }) => ({
      // The first window omits page 2.
      pages: pageStart === 1 ? [pageDraft(1)] : [pageDraft(pageStart), pageDraft(pageEnd)]
    }));
    strategy.generatePageDraft.mockResolvedValue(pageDraft(2));

    await generateBookBatchWindow(baseOptions(strategy));

    expect(strategy.generatePageDraft).toHaveBeenCalledTimes(1);
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(4);
  });

  it("falls back to per-page drafting when the batch returns an invalid page set", async () => {
    const strategy = baseStrategy();
    strategy.batchSize = 4;
    strategy.generateBatchDraft.mockRejectedValue(
      new Error("Page batch returned an invalid page set: duplicate indexes")
    );
    strategy.generatePageDraft.mockImplementation(async ({ pageIndex }: { pageIndex: number }) => pageDraft(pageIndex));

    await generateBookBatchWindow(baseOptions(strategy));

    expect(strategy.generatePageDraft).toHaveBeenCalledTimes(4);
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(4);
  });

  it("rethrows anything that is not a recoverable batch-range failure", async () => {
    const strategy = baseStrategy();
    strategy.generateBatchDraft.mockRejectedValue(new Error("provider exploded"));

    await expect(generateBookBatchWindow(baseOptions(strategy))).rejects.toThrow("provider exploded");
    expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
  });

  it("recognizes only the batch-range error shapes", () => {
    expect(isRecoverableBatchDraftRangeError(new Error("Page batch returned an invalid page set: x"))).toBe(true);
    expect(
      isRecoverableBatchDraftRangeError(new Error("Page batch returned pages out of order or outside the requested range"))
    ).toBe(true);
    expect(isRecoverableBatchDraftRangeError(new Error("anything else"))).toBe(false);
    expect(isRecoverableBatchDraftRangeError("not an error")).toBe(false);
  });
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
      "polish-1",
      "polish-2",
      "polish-3",
      "polish-4"
    ]);
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(4);
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

describe("generateBookWholePass", () => {
  it("saves reviewed pages in one transaction and queues illustrations for pages that want them", async () => {
    const strategy = baseStrategy();
    strategy.generateWholeBookDraft.mockResolvedValue({ pages: [pageDraft(1), pageDraft(2)] });
    strategy.shouldIllustratePage.mockReturnValue(true);
    mocks.effectiveWholeBookDraftContext.mockImplementation(
      (input: unknown, plan: unknown) => ({ input, plan, chapterSetups: [chapterSetup(1, 1, 2)] })
    );
    mocks.reviewWholeBookDraftPages.mockResolvedValue([
      { draft: { ...pageDraft(1), imagePrompt: "A fox" }, revision: 1, qualityReport: { approved: true, score: 90 } },
      { draft: pageDraft(2), revision: 2, qualityReport: { approved: true, score: 88 } }
    ]);
    const txPageCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: `row-${data.index}`,
      index: data.index,
      summary: data.summary,
      imagePrompt: data.imagePrompt,
      revision: data.revision
    }));
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        imageAsset: { deleteMany: vi.fn() },
        page: { deleteMany: vi.fn(), create: txPageCreate },
        chapter: { deleteMany: vi.fn(), create: vi.fn(async () => ({ id: "ch-1" })) },
        continuityNote: { deleteMany: vi.fn(), createMany: vi.fn() },
        embedding: { deleteMany: vi.fn() },
        project: { update: vi.fn() }
      })
    );

    await generateBookWholePass(baseOptions(strategy));

    expect(txPageCreate).toHaveBeenCalledTimes(2);
    // The whole-book pass never runs page jobs, so its embeddings were pure
    // write-only cost; the pass now skips them.
    expect(mocks.storeEmbedding).not.toHaveBeenCalled();
    // Only page 1 carries an image prompt, so only it gets an image job.
    const imageJobs = mocks.enqueueWorkerJob.mock.calls
      .map((call) => call[0] as { type: string; payload: Record<string, unknown> })
      .filter((options) => options.type === "GENERATE_IMAGE");
    expect(imageJobs).toHaveLength(1);
    expect(imageJobs[0]!.payload).toMatchObject({ pageId: "row-1", prompt: "A fox" });
    expect(mocks.persistAcceptedWholeBookTarget).toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");
  });

  it("requires whole-book drafting support", async () => {
    const strategy = baseStrategy();
    strategy.generateWholeBookDraft = undefined as never;

    await expect(generateBookWholePass(baseOptions(strategy))).rejects.toThrow(/does not support whole-book/);
  });
});

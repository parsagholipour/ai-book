import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterSetup } from "../runtime/jobTypes.js";

const mocks = vi.hoisted(() => ({
  prisma: {
    project: { update: vi.fn() },
    page: { updateMany: vi.fn() },
    continuityNote: { createMany: vi.fn() },
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
  persistKeeperStoryDelta: vi.fn(),
  storeEmbedding: vi.fn(),
  updateEntityStateFromPage: vi.fn(),
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
  reviewWholeBookDraftPages: mocks.reviewWholeBookDraftPages,
  styleExcerptsForPage: mocks.styleExcerptsForPage
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

import {
  generateBookBatchWindow,
  generateBookChapterWholePass,
  generateBookDraftThenPolish,
  generateBookWholePass,
  isRecoverableBatchDraftRangeError
} from "./bookPasses.js";
import { GeneratedPagePublicationClaimLostError } from "./pagePublication.js";

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
  mocks.qualityEnabled.mockReturnValue(false);
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
    expect(mocks.resetBookForDirectGeneration).toHaveBeenCalledWith("project-1", expect.anything(), []);
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

  it("replaces a completed page inside the chapter regenerated by a partial resume", async () => {
    mocks.directResumeStateForContext.mockReturnValue({ kind: "resume", firstMissingPageIndex: 4 });
    mocks.loadDirectResumeContext.mockResolvedValue({
      chapters: [],
      pages: [{ ...pageDraft(3), status: "COMPLETED", imagePrompt: null }]
    });
    mocks.priorPageContextsFromStored.mockReturnValue([pageDraft(1), pageDraft(2)]);
    const strategy = baseStrategy();
    strategy.generateChapterDraft.mockResolvedValue({ pages: [pageDraft(3), pageDraft(4)] });

    await generateBookChapterWholePass(baseOptions(strategy));

    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: expect.objectContaining({ index: 3 }),
        settledPageToReplace: expect.objectContaining({ index: 3, markdown: "Page 3 text." })
      })
    );
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

  it("replaces a completed page inside the batch regenerated by a partial resume", async () => {
    mocks.directResumeStateForContext.mockReturnValue({ kind: "resume", firstMissingPageIndex: 2 });
    mocks.loadDirectResumeContext.mockResolvedValue({
      chapters: [],
      pages: [{ ...pageDraft(1), status: "COMPLETED", imagePrompt: null }]
    });
    const strategy = baseStrategy();
    strategy.batchSize = 2;
    strategy.generateBatchDraft.mockImplementation(async ({ pageStart, pageEnd }: { pageStart: number; pageEnd: number }) => ({
      pages: Array.from({ length: pageEnd - pageStart + 1 }, (_, offset) => pageDraft(pageStart + offset))
    }));

    await generateBookBatchWindow(baseOptions(strategy));

    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: expect.objectContaining({ index: 1 }),
        settledPageToReplace: expect.objectContaining({ index: 1, markdown: "Page 1 text." })
      })
    );
  });

  it("briefs the rest of a chapter from a repaired brief the save hands back", async () => {
    // The batch pass reads its chapter setup per page, so an accepted brief
    // repair on page 1 has to reach page 2 through the setup itself — the
    // per-chapter brief is one object every page of that chapter is briefed
    // from, and `reviewAndSaveGeneratedPage` answers with a replacement for it
    // only for a page that kept a draft the repair briefed. The end-to-end
    // property is `pageReviewChapterBriefCarry.test.ts`'s; this is the wiring.
    const repaired = { chapterIndex: 1, pages: [{ pageIndex: 1, beat: "Fresh beat for page 1" }] };
    const strategy = baseStrategy();
    strategy.batchSize = 2;
    strategy.generateBatchDraft.mockImplementation(async ({ pageStart, pageEnd }: { pageStart: number; pageEnd: number }) => ({
      pages: Array.from({ length: pageEnd - pageStart + 1 }, (_, offset) => pageDraft(pageStart + offset))
    }));
    mocks.reviewAndSaveGeneratedPage.mockImplementation(async ({ draft }: { draft: { index: number } }) => ({
      page: { index: draft.index, title: "T", markdown: "M", summary: "S" },
      ...(draft.index === 1 ? { repairedChapterBrief: repaired } : {})
    }));

    await generateBookBatchWindow(baseOptions(strategy));

    const briefFor = (index: number) =>
      mocks.reviewAndSaveGeneratedPage.mock.calls
        .map((call) => call[0] as { draft: { index: number }; chapterBrief: unknown })
        .find((call) => call.draft.index === index)?.chapterBrief;
    expect(briefFor(2)).toBe(repaired);
    // And no further: page 3 is another chapter's, with its own brief.
    expect(briefFor(3)).toBeUndefined();
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

  it("passes the style lock into chapter, batch and fallback drafts when the gate is on", async () => {
    mocks.qualityEnabled.mockImplementation((feature?: string) => feature === "styleExcerpts");
    const chapterStrategy = baseStrategy();
    chapterStrategy.generateChapterDraft.mockImplementation(async ({ chapter }: { chapter: { index: number } }) => ({
      pages: chapter.index === 1 ? [pageDraft(1), pageDraft(2)] : [pageDraft(3), pageDraft(4)]
    }));

    await generateBookChapterWholePass(baseOptions(chapterStrategy));

    expect(chapterStrategy.generateChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({ styleExcerpts: ["opening-voice"] })
    );

    const batchStrategy = baseStrategy();
    batchStrategy.batchSize = 2;
    batchStrategy.generateBatchDraft.mockImplementation(
      async ({ pageStart, pageEnd }: { pageStart: number; pageEnd: number }) => ({
        pages: pageStart === 1 ? [pageDraft(1)] : [pageDraft(pageStart), pageDraft(pageEnd)]
      })
    );
    batchStrategy.generatePageDraft.mockResolvedValue(pageDraft(2));

    await generateBookBatchWindow(baseOptions(batchStrategy));

    expect(batchStrategy.generateBatchDraft).toHaveBeenCalledWith(
      expect.objectContaining({ styleExcerpts: ["opening-voice"] })
    );
    expect(batchStrategy.generatePageDraft).toHaveBeenCalledWith(
      expect.objectContaining({ styleExcerpts: ["opening-voice"] })
    );
  });

  it("omits style excerpts from chapter and fallback drafts when the gate is off", async () => {
    const chapterStrategy = baseStrategy();
    chapterStrategy.generateChapterDraft.mockImplementation(async ({ chapter }: { chapter: { index: number } }) => ({
      pages: chapter.index === 1 ? [pageDraft(1), pageDraft(2)] : [pageDraft(3), pageDraft(4)]
    }));

    await generateBookChapterWholePass(baseOptions(chapterStrategy));

    expect(chapterStrategy.generateChapterDraft.mock.calls[0]![0]).not.toHaveProperty("styleExcerpts");

    const batchStrategy = baseStrategy();
    batchStrategy.batchSize = 2;
    batchStrategy.generateBatchDraft.mockImplementation(
      async ({ pageStart, pageEnd }: { pageStart: number; pageEnd: number }) => ({
        pages: pageStart === 1 ? [pageDraft(1)] : [pageDraft(pageStart), pageDraft(pageEnd)]
      })
    );
    batchStrategy.generatePageDraft.mockResolvedValue(pageDraft(2));

    await generateBookBatchWindow(baseOptions(batchStrategy));

    expect(batchStrategy.generateBatchDraft.mock.calls[0]![0]).not.toHaveProperty("styleExcerpts");
    expect(batchStrategy.generatePageDraft.mock.calls[0]![0]).not.toHaveProperty("styleExcerpts");
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
      // Page 1 polishes twice: this harness leaves the tier unset (balanced),
      // and the first page best-ofs by tier (`firstPageCandidateCount`).
      "polish-1",
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
  const installPublicationState = (
    reviewed: Array<{ draft: ReturnType<typeof pageDraft> & { imagePrompt?: string }; revision: number; qualityReport: { approved: boolean; score: number } }>
  ) => {
    const durablePages = new Map<string, Record<string, unknown>>();
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        imageAsset: { deleteMany: vi.fn() },
        page: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn(),
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            const row = { id: `row-${data.index}`, ...data };
            durablePages.set(row.id, row);
            return row;
          }),
          updateMany: vi.fn()
        },
        chapter: { deleteMany: vi.fn(), create: vi.fn(async () => ({ id: "ch-1" })) },
        continuityNote: { deleteMany: vi.fn(), createMany: vi.fn() },
        embedding: { deleteMany: vi.fn() },
        project: { update: vi.fn() }
      })
    );
    mocks.prisma.page.updateMany.mockImplementation(async ({ where, data }) => {
      const row = durablePages.get(where.id as string);
      if (
        !row ||
        row.status !== where.status ||
        row.index !== where.index ||
        !(row.updatedAt instanceof Date) ||
        !(where.updatedAt instanceof Date) ||
        row.updatedAt.getTime() !== where.updatedAt.getTime() ||
        row.title !== where.title ||
        row.markdown !== where.markdown ||
        row.summary !== where.summary ||
        row.imagePrompt !== where.imagePrompt ||
        row.revision !== where.revision
      ) {
        return { count: 0 };
      }
      Object.assign(row, data);
      return { count: 1 };
    });
    const strategy = baseStrategy();
    strategy.generateWholeBookDraft.mockResolvedValue({ pages: reviewed.map((page) => page.draft) });
    strategy.shouldIllustratePage.mockReturnValue(true);
    mocks.effectiveWholeBookDraftContext.mockImplementation((input: unknown, plan: unknown) => ({
      input,
      plan,
      chapterSetups: [chapterSetup(1, 1, reviewed.length)]
    }));
    mocks.reviewWholeBookDraftPages.mockResolvedValue(reviewed);
    return { durablePages, strategy };
  };

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
      title: data.title,
      markdown: data.markdown,
      summary: data.summary,
      imagePrompt: data.imagePrompt,
      revision: data.revision
    }));
    const txProjectUpdate = vi.fn();
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        imageAsset: { deleteMany: vi.fn() },
        page: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn(),
          create: txPageCreate,
          updateMany: vi.fn()
        },
        chapter: { deleteMany: vi.fn(), create: vi.fn(async () => ({ id: "ch-1" })) },
        continuityNote: { deleteMany: vi.fn(), createMany: vi.fn() },
        embedding: { deleteMany: vi.fn() },
        project: { update: txProjectUpdate }
      })
    );

    await generateBookWholePass(baseOptions(strategy));

    expect(txPageCreate).toHaveBeenCalledTimes(2);
    expect(txPageCreate.mock.calls.map((call) => (call[0] as { data: { status: string } }).data.status)).toEqual([
      "GENERATING",
      "COMPLETED"
    ]);
    expect(txProjectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "GENERATING", storyState: expect.objectContaining({ promises: [] }) })
      })
    );
    expect(mocks.persistKeeperStoryDelta).toHaveBeenCalledTimes(2);
    // The whole-book pass never runs page jobs, so its embeddings were pure
    // write-only cost; the pass now skips them.
    expect(mocks.storeEmbedding).not.toHaveBeenCalled();
    // Only page 1 carries an image prompt, so only it gets an image job.
    const imageJobs = mocks.enqueueWorkerJob.mock.calls
      .map((call) => call[0] as { type: string; payload: Record<string, unknown> })
      .filter((options) => options.type === "GENERATE_IMAGE");
    expect(imageJobs).toHaveLength(1);
    expect(imageJobs[0]!.payload).toMatchObject({
      pageId: "row-1",
      prompt: "A fox",
      keeperToken: expect.stringMatching(/^v2-[0-9a-f]{24}$/)
    });
    expect(
      (mocks.enqueueWorkerJob.mock.calls
        .map((call) => call[0] as { type: string; dedupeKey?: string })
        .find((options) => options.type === "GENERATE_IMAGE")?.dedupeKey)
    ).toMatch(/^generate-image:row-1:plan-1:1:v2-[0-9a-f]{24}$/);
    expect(mocks.persistAcceptedWholeBookTarget).toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");
  });

  it("never exposes an illustrated terminal page before that keeper's durable job exists", async () => {
    const reviewed = [
      { draft: { ...pageDraft(1), imagePrompt: "A fox" }, revision: 1, qualityReport: { approved: true, score: 90 } },
      { draft: { ...pageDraft(2), imagePrompt: "A lantern" }, revision: 1, qualityReport: { approved: true, score: 91 } }
    ];
    const { durablePages, strategy } = installPublicationState(reviewed);
    const durableImageJobs = new Set<string>();
    mocks.enqueueWorkerJob.mockImplementation(async ({ payload }: { payload: Record<string, unknown> }) => {
      // This is the observer interleaving that used to fire compile: every
      // terminal illustrated keeper visible while another enqueue starts must
      // already have its own durable job.
      for (const row of durablePages.values()) {
        if (row.status === "COMPLETED" && row.imagePrompt) {
          expect(durableImageJobs.has(row.id as string)).toBe(true);
        }
      }
      durableImageJobs.add(payload.pageId as string);
      return { id: `image-${payload.pageId}` };
    });

    await generateBookWholePass(baseOptions(strategy));

    expect([...durablePages.values()].map((page) => page.status)).toEqual(["COMPLETED", "COMPLETED"]);
    expect(durableImageJobs).toEqual(new Set(["row-1", "row-2"]));
    expect(mocks.enqueueWorkerJob.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.persistKeeperStoryDelta.mock.invocationCallOrder[0]!
    );
    expect(mocks.persistAcceptedWholeBookTarget.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.enqueueWorkerJob.mock.invocationCallOrder[0]!
    );
  });

  it("leaves an illustrated keeper non-terminal when durable enqueue fails", async () => {
    const queueFailure = new Error("generation job store unavailable");
    const { durablePages, strategy } = installPublicationState([
      { draft: { ...pageDraft(1), imagePrompt: "A fox" }, revision: 1, qualityReport: { approved: true, score: 90 } }
    ]);
    mocks.enqueueWorkerJob.mockRejectedValueOnce(queueFailure);

    await expect(generateBookWholePass(baseOptions(strategy))).rejects.toBe(queueFailure);

    expect(durablePages.get("row-1")).toMatchObject({ status: "GENERATING", imagePrompt: "A fox" });
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
    expect(mocks.persistKeeperStoryDelta).not.toHaveBeenCalled();
    expect(mocks.ensureCharacterReferenceAssets).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("retries when a stable page is reindexed after image enqueue", async () => {
    const { durablePages, strategy } = installPublicationState([
      { draft: { ...pageDraft(1), imagePrompt: "A fox" }, revision: 1, qualityReport: { approved: true, score: 90 } }
    ]);
    mocks.enqueueWorkerJob.mockImplementationOnce(async () => {
      Object.assign(durablePages.get("row-1")!, {
        // Structural ordering preserves the keeper fields and updatedAt; the
        // stable row simply occupies a new numeric position.
        index: 2
      });
      return { id: "image-row-1" };
    });

    await expect(generateBookWholePass(baseOptions(strategy))).rejects.toBeInstanceOf(
      GeneratedPagePublicationClaimLostError
    );

    expect(durablePages.get("row-1")).toMatchObject({ status: "GENERATING", index: 2, title: "Page 1" });
    expect(mocks.persistKeeperStoryDelta).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("keeps a retry's stable page id and same-keeper illustration asset", async () => {
    const keeperDraft = { ...pageDraft(1), imagePrompt: "A fox" };
    const existing = {
      id: "stable-page-1",
      index: 1,
      status: "GENERATING",
      title: keeperDraft.title,
      markdown: keeperDraft.markdown,
      summary: keeperDraft.summary,
      imagePrompt: keeperDraft.imagePrompt,
      revision: 1,
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    };
    const txImageDelete = vi.fn();
    const txPageCreate = vi.fn();
    const txPageDelete = vi.fn();
    const txPageUpdate = vi.fn().mockResolvedValue({ count: 1 });
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        imageAsset: { deleteMany: txImageDelete },
        page: {
          findMany: vi.fn().mockResolvedValue([existing]),
          deleteMany: txPageDelete,
          create: txPageCreate,
          updateMany: txPageUpdate
        },
        chapter: { deleteMany: vi.fn(), create: vi.fn(async () => ({ id: "ch-1" })) },
        continuityNote: { deleteMany: vi.fn(), createMany: vi.fn() },
        embedding: { deleteMany: vi.fn() },
        project: { update: vi.fn() }
      })
    );
    const strategy = baseStrategy();
    strategy.generateWholeBookDraft.mockResolvedValue({ pages: [keeperDraft] });
    strategy.shouldIllustratePage.mockReturnValue(true);
    mocks.effectiveWholeBookDraftContext.mockImplementation((input: unknown, plan: unknown) => ({
      input,
      plan,
      chapterSetups: [chapterSetup(1, 1, 1)]
    }));
    mocks.reviewWholeBookDraftPages.mockResolvedValue([
      { draft: keeperDraft, revision: 1, qualityReport: { approved: true, score: 90 } }
    ]);

    await generateBookWholePass(baseOptions(strategy));

    expect(txPageCreate).not.toHaveBeenCalled();
    expect(txPageDelete).not.toHaveBeenCalled();
    expect(txPageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "stable-page-1", index: 1, status: "GENERATING", updatedAt: existing.updatedAt }
      })
    );
    expect(txImageDelete).toHaveBeenCalledTimes(1);
    expect(txImageDelete).toHaveBeenCalledWith({ where: { projectId: "project-1", pageId: null } });
    expect(mocks.enqueueWorkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ pageId: "stable-page-1" }) })
    );
  });

  it("requires whole-book drafting support", async () => {
    const strategy = baseStrategy();
    strategy.generateWholeBookDraft = undefined as never;

    await expect(generateBookWholePass(baseOptions(strategy))).rejects.toThrow(/does not support whole-book/);
  });
});

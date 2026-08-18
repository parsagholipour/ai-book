import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterBrief, PageProductionBeat, PageQualityReport } from "@book-maker/core";

const mocks = vi.hoisted(() => ({
  prisma: {
    page: { upsert: vi.fn() },
    continuityNote: { createMany: vi.fn() },
    chapter: { findUnique: vi.fn(), updateMany: vi.fn() }
  },
  enqueueWorkerJob: vi.fn(),
  updateJobProgress: vi.fn(),
  prepareEmbedding: vi.fn(),
  writePreparedEmbedding: vi.fn(),
  updateEntityStateFromPage: vi.fn(),
  loadContinuityNotes: vi.fn(),
  keeperStoryExtractForSave: vi.fn(),
  persistStoryExtract: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("../runtime/dispatch.js", () => ({ enqueueWorkerJob: mocks.enqueueWorkerJob }));
vi.mock("../runtime/jobLifecycle.js", () => ({ updateJobProgress: mocks.updateJobProgress }));
vi.mock("./semanticMemory.js", () => ({
  prepareEmbedding: mocks.prepareEmbedding,
  writePreparedEmbedding: mocks.writePreparedEmbedding,
  updateEntityStateFromPage: mocks.updateEntityStateFromPage,
  // Mirrors the real predicate so fixtures choose their mode explicitly.
  retrieveSemanticResearchNotes: async () => [],
  strategyUsesSemanticMemory: (strategy: { executionMode?: string }) =>
    strategy?.executionMode === "sequential-pages"
}));
vi.mock("./generationContext.js", () => ({
  loadContinuityNotes: mocks.loadContinuityNotes,
  loadResearchNotesForGeneration: async () => []
}));
vi.mock("./qualitySettings.js", () => ({
  loadQualityContext: async () => ({
    settings: {},
    tier: "balanced",
    enabled: () => false
  }),
  applyPlanThinkingBoost: vi.fn()
}));
vi.mock("./qualityEnrichment.js", () => ({
  enrichPageQualityReport: async ({ report }: { report: unknown }) => ({
    report,
    extract: null,
    storyState: { promises: [], facts: [], entities: {}, unanswered: [] },
    styleExcerpts: []
  }),
  keeperStoryExtractForSave: mocks.keeperStoryExtractForSave,
  persistStoryExtract: mocks.persistStoryExtract
}));
vi.mock("./bookHelpers.js", () => ({
  formatQualityFailure: () => "quality failure detail",
  parseChapterBrief: (value: unknown) => (value ? value : undefined)
}));

import {
  bestDraftCandidate,
  pageRevisionMessage,
  pageRewriteReport,
  repairPageBriefForRecovery,
  replacePageBriefInChapterBrief,
  reviewAndSaveGeneratedPage,
  revisePageDraftWithRestart,
  shouldRepairPageBriefForRecovery
} from "./pageReview.js";
import { MAX_PAGE_QA_CANDIDATES, PAGE_QA_RECOVERY_CANDIDATE } from "./tuning.js";

const report = (score: number, overrides: Partial<PageQualityReport> = {}): PageQualityReport =>
  ({
    approved: false,
    score,
    issues: [],
    requiredRevisions: [],
    notes: "",
    checks: { repetitionOk: true, progressionOk: true },
    ...overrides
  }) as unknown as PageQualityReport;

const draftNamed = (name: string) => ({
  title: name,
  markdown: `${name} text.`,
  summary: `${name} summary.`,
  continuityNotes: [] as string[]
});

describe("bestDraftCandidate", () => {
  it("keeps the higher-scoring draft and keeps the incumbent on a tie", () => {
    const first = { draft: draftNamed("First"), revision: 1, report: report(60) };
    const second = { draft: draftNamed("Second"), revision: 2, report: report(70) };
    const tie = { draft: draftNamed("Tie"), revision: 3, report: report(70) };

    expect(bestDraftCandidate(first, second)).toBe(second);
    expect(bestDraftCandidate(second, first)).toBe(second);
    expect(bestDraftCandidate(second, tie)).toBe(second);
  });
});

describe("pageRevisionMessage", () => {
  it("announces plain revising before the recovery candidate and recovery after", () => {
    expect(pageRevisionMessage(3, PAGE_QA_RECOVERY_CANDIDATE - 1, 6)).toBe("Revising page 3 (rewrite 2/6)");
    expect(pageRevisionMessage(3, PAGE_QA_RECOVERY_CANDIDATE, 6)).toBe(
      `Quality recovery rewrite page 3 (rewrite ${PAGE_QA_RECOVERY_CANDIDATE - 1}/6)`
    );
  });
});

describe("pageRewriteReport", () => {
  it("passes the report through untouched below the recovery candidate", () => {
    const original = report(40);
    expect(pageRewriteReport(original, PAGE_QA_RECOVERY_CANDIDATE - 1)).toBe(original);
  });

  it("escalates to a structural-replacement briefing at the recovery candidate", () => {
    const original = report(40, { issues: ["Too repetitive"], requiredRevisions: ["Vary it"], notes: "Meh." });
    const escalated = pageRewriteReport(original, PAGE_QA_RECOVERY_CANDIDATE);

    expect(escalated).not.toBe(original);
    expect(escalated.issues).toContain("Too repetitive");
    expect(escalated.issues).toContain("Earlier generated replacements for this page were still rejected by QA.");
    expect(escalated.requiredRevisions.length).toBeGreaterThan(original.requiredRevisions.length);
    expect(escalated.notes).toContain("Quality recovery mode");
  });

  it("honors a caller-supplied recovery threshold", () => {
    // The final-QA loop counts attempts from the first rewrite, one later than
    // the page loops count candidates, so it passes the threshold minus one to
    // enter recovery at the same third rewrite.
    const original = report(40);
    expect(pageRewriteReport(original, PAGE_QA_RECOVERY_CANDIDATE - 1, PAGE_QA_RECOVERY_CANDIDATE - 1)).not.toBe(original);
    expect(pageRewriteReport(original, PAGE_QA_RECOVERY_CANDIDATE - 2, PAGE_QA_RECOVERY_CANDIDATE - 1)).toBe(original);
  });
});

describe("shouldRepairPageBriefForRecovery", () => {
  const brief = { pageIndex: 3, goal: "Introduce the robin" } as unknown as PageProductionBeat;

  it("requires a brief and the recovery candidate", () => {
    expect(shouldRepairPageBriefForRecovery(PAGE_QA_RECOVERY_CANDIDATE, report(40), undefined)).toBe(false);
    expect(shouldRepairPageBriefForRecovery(PAGE_QA_RECOVERY_CANDIDATE - 1, report(40), brief)).toBe(false);
  });

  it("repairs on failed repetition or progression checks", () => {
    expect(
      shouldRepairPageBriefForRecovery(
        PAGE_QA_RECOVERY_CANDIDATE,
        report(40, { checks: { repetitionOk: false, progressionOk: true } } as never),
        brief
      )
    ).toBe(true);
    expect(
      shouldRepairPageBriefForRecovery(
        PAGE_QA_RECOVERY_CANDIDATE,
        report(40, { checks: { repetitionOk: true, progressionOk: false } } as never),
        brief
      )
    ).toBe(true);
  });

  it("repairs when the feedback text blames the brief, and not otherwise", () => {
    expect(
      shouldRepairPageBriefForRecovery(
        PAGE_QA_RECOVERY_CANDIDATE,
        report(40, { issues: ["This page repeats the same argument as page 2."] }),
        brief
      )
    ).toBe(true);
    expect(
      shouldRepairPageBriefForRecovery(PAGE_QA_RECOVERY_CANDIDATE, report(40, { issues: ["Weak verbs."] }), brief)
    ).toBe(false);
  });
});

describe("replacePageBriefInChapterBrief", () => {
  const baseBrief = (): ChapterBrief =>
    ({
      chapterIndex: 1,
      pages: [
        { pageIndex: 1, requiredContinuity: [] },
        { pageIndex: 2, requiredContinuity: [] }
      ],
      continuityFocus: ["the robin's name"]
    }) as unknown as ChapterBrief;

  it("returns undefined without a chapter brief", () => {
    expect(replacePageBriefInChapterBrief(undefined, { pageIndex: 1 } as never)).toBeUndefined();
  });

  it("replaces a matching page brief in place and merges continuity focus", () => {
    const chapterBrief = baseBrief();
    const repaired = { pageIndex: 2, requiredContinuity: ["the storm", "the robin's name"] } as unknown as PageProductionBeat;

    const updated = replacePageBriefInChapterBrief(chapterBrief, repaired);

    expect(updated?.pages.map((page) => page.pageIndex)).toEqual([1, 2]);
    expect(updated?.pages[1]).toBe(repaired);
    expect(updated?.continuityFocus).toEqual(["the robin's name", "the storm"]);
    // The caller keeps using its original reference, so the update is also
    // written through onto it.
    expect(chapterBrief.pages[1]).toBe(repaired);
  });

  it("inserts an unknown page brief in index order", () => {
    const chapterBrief = baseBrief();
    const inserted = { pageIndex: 0, requiredContinuity: [] } as unknown as PageProductionBeat;

    const updated = replacePageBriefInChapterBrief(chapterBrief, inserted);

    expect(updated?.pages.map((page) => page.pageIndex)).toEqual([0, 1, 2]);
  });
});

describe("repairPageBriefForRecovery", () => {
  const chapterBriefFixture = (): ChapterBrief =>
    ({
      chapterIndex: 1,
      pages: [
        { pageIndex: 5, requiredContinuity: [] },
        { pageIndex: 6, requiredContinuity: [] }
      ],
      continuityFocus: []
    }) as unknown as ChapterBrief;

  const repairedBeat = (): PageProductionBeat =>
    ({ pageIndex: 6, requiredContinuity: ["fresh angle"] }) as unknown as PageProductionBeat;

  const strategy = { repairPageBrief: vi.fn() };

  const callOptions = () =>
    ({
      strategy,
      input: {},
      plan: {},
      chapterBrief: chapterBriefFixture(),
      chapterId: "chapter-1",
      pageBrief: { pageIndex: 6, requiredContinuity: [] },
      pageIndex: 6,
      draft: draftNamed("Six"),
      qualityReport: report(40),
      previousPages: [],
      continuityNotes: [],
      textModel: {},
      context: "Page 6"
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    strategy.repairPageBrief.mockResolvedValue(repairedBeat());
  });

  it("merges the repair into a freshly-read chapter brief and writes it back conditionally", async () => {
    mocks.prisma.chapter.findUnique.mockResolvedValue({ productionBrief: chapterBriefFixture() });
    mocks.prisma.chapter.updateMany.mockResolvedValue({ count: 1 });

    await repairPageBriefForRecovery(callOptions());

    expect(mocks.prisma.chapter.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.chapter.updateMany).toHaveBeenCalledWith({
      where: { id: "chapter-1", productionBrief: { equals: chapterBriefFixture() } },
      data: { productionBrief: expect.objectContaining({ pages: expect.arrayContaining([repairedBeat()]) }) }
    });
  });

  it("retries against the winner's brief instead of clobbering it when a concurrent repair lands first", async () => {
    // A sibling page's repair (for page 7) committed between our read and our
    // write: the CAS misses, and the retry must fold page 6's repair onto the
    // *winner's* brief — including page 7's repair — not overwrite it.
    const staleBrief = chapterBriefFixture();
    const winnerBrief: ChapterBrief = {
      ...staleBrief,
      pages: [...staleBrief.pages, { pageIndex: 7, requiredContinuity: ["sibling repair"] } as never]
    };
    mocks.prisma.chapter.findUnique
      .mockResolvedValueOnce({ productionBrief: staleBrief })
      .mockResolvedValueOnce({ productionBrief: winnerBrief });
    mocks.prisma.chapter.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    await repairPageBriefForRecovery(callOptions());

    expect(mocks.prisma.chapter.updateMany).toHaveBeenCalledTimes(2);
    const secondCall = mocks.prisma.chapter.updateMany.mock.calls[1]![0] as {
      where: { productionBrief: { equals: ChapterBrief } };
      data: { productionBrief: ChapterBrief };
    };
    expect(secondCall.where.productionBrief.equals).toBe(winnerBrief);
    expect(secondCall.data.productionBrief.pages.map((page) => page.pageIndex)).toEqual([5, 6, 7]);
  });

  it("does not persist the repaired brief when ownership went during the repair call", async () => {
    // The one write on the drafting side of the page save, and the chapter's
    // other pages read it back — so a delivery that lost the book across the
    // repair call must not leave its opinion of the beats behind.
    mocks.prisma.chapter.findUnique.mockResolvedValue({ productionBrief: chapterBriefFixture() });
    const assertOwnership = vi.fn().mockRejectedValue(new Error("lost its durable lease"));

    await expect(repairPageBriefForRecovery({ ...(callOptions() as object), assertOwnership } as never)).rejects.toThrow(
      "lost its durable lease"
    );

    expect(strategy.repairPageBrief).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.chapter.updateMany).not.toHaveBeenCalled();
  });

  it("gives up and logs rather than looping forever when every attempt loses the race", async () => {
    mocks.prisma.chapter.findUnique.mockResolvedValue({ productionBrief: chapterBriefFixture() });
    mocks.prisma.chapter.updateMany.mockResolvedValue({ count: 0 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await repairPageBriefForRecovery(callOptions());

    expect(result).toEqual(repairedBeat());
    expect(mocks.prisma.chapter.updateMany).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("lost the CAS race"));
    warn.mockRestore();
  });
});

describe("revisePageDraftWithRestart", () => {
  const strategyWith = (revise: ReturnType<typeof vi.fn>) => ({ revisePageDraft: revise }) as never;

  beforeEach(() => vi.clearAllMocks());

  it("returns the first successful revision", async () => {
    const revise = vi.fn().mockResolvedValue(draftNamed("Fixed"));

    await expect(
      revisePageDraftWithRestart({ strategy: strategyWith(revise), reviseOptions: {} as never, context: "Page 1" })
    ).resolves.toMatchObject({ title: "Fixed" });
    expect(revise).toHaveBeenCalledTimes(1);
  });

  it("restarts after failures and surfaces the last error when the budget runs out", async () => {
    const revise = vi.fn().mockRejectedValue(new Error("provider hiccup"));

    await expect(
      revisePageDraftWithRestart({
        strategy: strategyWith(revise),
        reviseOptions: {} as never,
        context: "Page 1",
        maxRestarts: 2
      })
    ).rejects.toThrow("provider hiccup");
    expect(revise).toHaveBeenCalledTimes(3);
    expect(mocks.updateJobProgress).toHaveBeenCalledTimes(2);
  });

  it("succeeds on a restart within the budget", async () => {
    const revise = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider hiccup"))
      .mockResolvedValueOnce(draftNamed("Recovered"));

    await expect(
      revisePageDraftWithRestart({
        strategy: strategyWith(revise),
        reviseOptions: {} as never,
        context: "Page 1",
        maxRestarts: 1
      })
    ).resolves.toMatchObject({ title: "Recovered" });
  });
});

describe("reviewAndSaveGeneratedPage", () => {
  const strategy = {
    id: "test-strategy",
    // Sequential-pages: the one mode whose jobs read semantic memory, so the
    // embedding/entity-state assertions below exercise a real write path.
    executionMode: "sequential-pages",
    reviewPageDraft: vi.fn(),
    revisePageDraft: vi.fn(),
    repairPageBrief: vi.fn(),
    shouldIllustratePage: vi.fn()
  };

  const baseOptions = () =>
    ({
      projectId: "project-1",
      planId: "plan-1",
      input: { mediaSettings: {} },
      plan: { title: "Book", chapters: [] },
      providers: { text: {}, embedding: {} },
      strategy,
      draft: { ...draftNamed("First"), index: 3 },
      chapterId: null,
      previousPages: [],
      generationJobId: "gj-1"
    }) as never;

  const storyExtract = { storyDelta: { facts: ["The robin flew."] }, contradictions: [] };
  const preparedVector = { vectorLiteral: "[0.1,0.2]", error: null };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadContinuityNotes.mockResolvedValue([]);
    mocks.prisma.page.upsert.mockResolvedValue({ id: "page-row-1", revision: 1 });
    strategy.shouldIllustratePage.mockReturnValue(false);
    mocks.keeperStoryExtractForSave.mockResolvedValue(storyExtract);
    mocks.prepareEmbedding.mockResolvedValue(preparedVector);
  });

  it("saves an approved first draft as COMPLETED at revision 1", async () => {
    strategy.reviewPageDraft.mockResolvedValue(report(90, { approved: true }));

    const context = await reviewAndSaveGeneratedPage(baseOptions());

    expect(strategy.revisePageDraft).not.toHaveBeenCalled();
    expect(mocks.prisma.page.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId_index: { projectId: "project-1", index: 3 } },
        create: expect.objectContaining({ status: "COMPLETED", revision: 1, title: "First" }),
        update: expect.objectContaining({ status: "COMPLETED", revision: 1, title: "First" })
      })
    );
    expect(mocks.prepareEmbedding).toHaveBeenCalledWith("First summary.", expect.anything());
    expect(mocks.writePreparedEmbedding).toHaveBeenCalledWith(
      "project-1",
      "page:3",
      "page-row-1",
      "First summary.",
      preparedVector
    );
    expect(context).toEqual({ index: 3, title: "First", markdown: "First text.", summary: "First summary." });
  });

  it("records continuity notes and queues the illustration for an approved page", async () => {
    strategy.reviewPageDraft.mockResolvedValue(report(90, { approved: true }));
    strategy.shouldIllustratePage.mockReturnValue(true);
    mocks.prisma.page.upsert.mockResolvedValue({ id: "page-row-1", revision: 2 });
    const options = baseOptions() as {
      draft: ReturnType<typeof draftNamed> & { index: number; imagePrompt?: string }
    };
    options.draft.imagePrompt = "A robin on a branch";
    options.draft.continuityNotes = ["The robin is named Pip."];

    await reviewAndSaveGeneratedPage(options as never);

    expect(mocks.prisma.continuityNote.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          projectId: "project-1",
          pageId: "page-row-1",
          scope: "page:3",
          body: "The robin is named Pip.",
          tags: ["page", "3", "test-strategy"]
        })
      ]
    });
    expect(mocks.updateEntityStateFromPage).toHaveBeenCalledWith("project-1", 3, ["The robin is named Pip."]);
    expect(mocks.enqueueWorkerJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "GENERATE_IMAGE",
        payload: { pageId: "page-row-1", planId: "plan-1", prompt: "A robin on a branch" },
        dedupeKey: "generate-image:page-row-1:plan-1:2"
      })
    );
  });

  it("keeps the best draft, not the last, when no rewrite is approved", async () => {
    // Scores 40 → 70 → 55…: the sixth-rewrite-worse-than-second shape. The
    // page must be saved FAILED_QA at the score-70 draft, and the flagged page
    // must skip continuity, embedding, and illustration until it is repaired.
    let rewrite = 1;
    strategy.revisePageDraft.mockImplementation(async () => draftNamed(`Rewrite ${(rewrite += 1)}`));
    strategy.reviewPageDraft
      .mockResolvedValueOnce(report(40))
      .mockResolvedValueOnce(report(70))
      .mockResolvedValue(report(55));

    const context = await reviewAndSaveGeneratedPage(baseOptions());

    expect(strategy.reviewPageDraft).toHaveBeenCalledTimes(MAX_PAGE_QA_CANDIDATES);
    expect(mocks.prisma.page.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "FAILED_QA",
          revision: 2,
          title: "Rewrite 2",
          qualityReport: expect.objectContaining({ score: 70 })
        })
      })
    );
    expect(mocks.prepareEmbedding).not.toHaveBeenCalled();
    expect(mocks.writePreparedEmbedding).not.toHaveBeenCalled();
    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
    expect(mocks.prisma.continuityNote.createMany).not.toHaveBeenCalled();
    // A flagged page still publishes its story delta: the final review rewrites
    // the page and needs the state the keeper actually left behind.
    expect(mocks.persistStoryExtract).toHaveBeenCalledTimes(1);
    expect(context).toMatchObject({ index: 3, title: "Rewrite 2" });
  });
});

describe("reviewAndSaveGeneratedPage ownership fence", () => {
  // The structural-insert shape: a delivery drafting under a durable lease that
  // a replacement can take over mid-page. Everything the save publishes after
  // the page row — the story delta, the continuity notes, the entity state and
  // the embedding — is read back by *later* pages, so a delivery that has lost
  // the book must leave none of it behind. The page row itself is the winner's
  // to redo: it is keyed on project+index and the winner drafts the same ids.
  const strategy = {
    id: "test-strategy",
    executionMode: "sequential-pages",
    reviewPageDraft: vi.fn(),
    revisePageDraft: vi.fn(),
    repairPageBrief: vi.fn(),
    shouldIllustratePage: vi.fn()
  };

  const storyExtract = { storyDelta: { facts: ["The robin flew."] }, contradictions: [] };

  const fencedOptions = (assertOwnership: () => Promise<void>) =>
    ({
      projectId: "project-1",
      planId: "plan-1",
      input: { mediaSettings: {} },
      plan: { title: "Book", chapters: [] },
      providers: { text: {}, embedding: {} },
      strategy,
      draft: { ...draftNamed("First"), index: 3, imagePrompt: "A robin", continuityNotes: ["The robin is named Pip."] },
      chapterId: null,
      previousPages: [],
      generationJobId: "gj-1",
      assertOwnership
    }) as never;

  /** Every write the page save publishes for later pages to read back. */
  const expectNothingPublished = () => {
    expect(mocks.persistStoryExtract).not.toHaveBeenCalled();
    expect(mocks.prisma.continuityNote.createMany).not.toHaveBeenCalled();
    expect(mocks.updateEntityStateFromPage).not.toHaveBeenCalled();
    expect(mocks.writePreparedEmbedding).not.toHaveBeenCalled();
    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
  };

  /** Holds for the first `holdFor` barriers, then reports takeover. */
  const fenceLostAfter = (holdFor: number) => {
    let barriers = 0;
    return vi.fn(async () => {
      barriers += 1;
      if (barriers > holdFor) {
        throw new Error("Structural page edit delivery lost its durable lease");
      }
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadContinuityNotes.mockResolvedValue([]);
    mocks.prisma.page.upsert.mockResolvedValue({ id: "page-row-1", revision: 1 });
    strategy.shouldIllustratePage.mockReturnValue(true);
    strategy.reviewPageDraft.mockResolvedValue(report(90, { approved: true }));
    mocks.keeperStoryExtractForSave.mockResolvedValue(storyExtract);
    mocks.prepareEmbedding.mockResolvedValue({ vectorLiteral: "[0.1,0.2]", error: null });
  });

  it("publishes the whole tail while the fence holds, and asks it three times", async () => {
    const fence = fenceLostAfter(Number.POSITIVE_INFINITY);

    await reviewAndSaveGeneratedPage(fencedOptions(fence));

    // Before the page upsert, before the provider calls, and before the writes.
    expect(fence).toHaveBeenCalledTimes(3);
    expect(mocks.persistStoryExtract).toHaveBeenCalledWith(expect.objectContaining({ extract: storyExtract }));
    expect(mocks.prisma.continuityNote.createMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateEntityStateFromPage).toHaveBeenCalledTimes(1);
    expect(mocks.writePreparedEmbedding).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueWorkerJob).toHaveBeenCalledTimes(1);
  });

  it("spends no provider call and publishes nothing when ownership goes right after the page upsert", async () => {
    // Lost before the story extract: the barrier after the upsert is what stops
    // a delivery that no longer owns the book paying for state it may not write.
    const fence = fenceLostAfter(1);

    await expect(reviewAndSaveGeneratedPage(fencedOptions(fence))).rejects.toThrow("lost its durable lease");

    expect(mocks.prisma.page.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.keeperStoryExtractForSave).not.toHaveBeenCalled();
    expect(mocks.prepareEmbedding).not.toHaveBeenCalled();
    expectNothingPublished();
  });

  it("publishes nothing when ownership goes during the provider calls, after the model answered", async () => {
    // Lost after the model call, before the write: the extract and the vector
    // are in hand, and the publish barrier is what keeps them out of the book.
    const fence = fenceLostAfter(2);

    await expect(reviewAndSaveGeneratedPage(fencedOptions(fence))).rejects.toThrow("lost its durable lease");

    expect(mocks.keeperStoryExtractForSave).toHaveBeenCalledTimes(1);
    expect(mocks.prepareEmbedding).toHaveBeenCalledTimes(1);
    expectNothingPublished();
  });

  it("does not even save the page when ownership is already gone before the upsert", async () => {
    const fence = fenceLostAfter(0);

    await expect(reviewAndSaveGeneratedPage(fencedOptions(fence))).rejects.toThrow("lost its durable lease");

    expect(mocks.prisma.page.upsert).not.toHaveBeenCalled();
    expect(mocks.keeperStoryExtractForSave).not.toHaveBeenCalled();
    expectNothingPublished();
  });
});

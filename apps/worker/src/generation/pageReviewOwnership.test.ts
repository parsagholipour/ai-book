import { beforeEach, describe, expect, it, vi } from "vitest";
import { mocks, report, draftNamed } from "./testing/pageReviewHarness.js";
import { reviewAndSaveGeneratedPage, runPageQualityLoop } from "./pageReview.js";

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

  const fencedOptions = (assertOwnership: () => Promise<void>, overrides: Record<string, unknown> = {}) =>
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
      assertOwnership,
      ...overrides
    }) as never;

  const recoveryBeat = (beat: string) => ({
    pageIndex: 3,
    chapterIndex: 1,
    purpose: beat,
    beat,
    requiredContinuity: [] as string[],
    endingPressure: ""
  });

  const keptBriefRepairOptions = (assertOwnership: () => Promise<void>) => {
    const originalBeat = recoveryBeat("Repeat the opening");
    const repairedBeat = recoveryBeat("Reveal the hidden stair");
    const chapterBrief = {
      chapterIndex: 1,
      title: "The stair",
      summary: "A hidden route opens.",
      continuityFocus: [] as string[],
      pages: [originalBeat]
    };
    const rejected = report(40, { checks: { repetitionOk: false, progressionOk: true } as never });
    strategy.reviewPageDraft
      // Initial review, then both ordinary rewrites: all still blame the brief.
      .mockResolvedValueOnce(rejected)
      .mockResolvedValueOnce(rejected)
      .mockResolvedValueOnce(rejected)
      // Balanced recovery is candidate four; this is the kept repaired draft.
      .mockResolvedValueOnce(report(90, { approved: true }));
    strategy.revisePageDraft.mockResolvedValue(draftNamed("Recovered"));
    strategy.repairPageBrief.mockResolvedValue(repairedBeat);
    return {
      options: fencedOptions(assertOwnership, { chapterId: "chapter-1", chapterBrief }),
      chapterBrief,
      repairedBeat
    };
  };

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
    mocks.prisma.$transaction.mockImplementation(
      async (run: (tx: typeof mocks.prisma) => Promise<unknown>) => run(mocks.prisma)
    );
    mocks.loadContinuityNotes.mockResolvedValue([]);
    mocks.prisma.page.findUnique.mockResolvedValue(null);
    mocks.prisma.page.create.mockResolvedValue({ id: "page-row-1", revision: 1 });
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    mocks.enqueueWorkerJob.mockResolvedValue({ id: "image-job" });
    strategy.shouldIllustratePage.mockReturnValue(true);
    strategy.reviewPageDraft.mockResolvedValue(report(90, { approved: true }));
    mocks.keeperStoryExtractForSave.mockResolvedValue(storyExtract);
    mocks.prepareEmbedding.mockResolvedValue({ vectorLiteral: "[0.1,0.2]", error: null });
  });

  it("publishes the whole tail while the fence holds, and asks it three times", async () => {
    const fence = fenceLostAfter(Number.POSITIVE_INFINITY);

    await reviewAndSaveGeneratedPage(fencedOptions(fence));

    // Before the page stage, before the provider calls, and before the writes.
    expect(fence).toHaveBeenCalledTimes(3);
    expect(mocks.persistStoryExtract).toHaveBeenCalledWith(expect.objectContaining({ extract: storyExtract }));
    expect(mocks.prisma.continuityNote.createMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateEntityStateFromPage).toHaveBeenCalledTimes(1);
    expect(mocks.writePreparedEmbedding).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueWorkerJob).toHaveBeenCalledTimes(1);
  });

  it("spends no provider call and publishes nothing when ownership goes right after the page stage", async () => {
    // Lost before the story extract: the barrier after the stage is what stops
    // a delivery that no longer owns the book paying for state it may not write.
    const fence = fenceLostAfter(1);

    await expect(reviewAndSaveGeneratedPage(fencedOptions(fence))).rejects.toThrow("lost its durable lease");

    expect(mocks.prisma.page.create).toHaveBeenCalledTimes(1);
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

  it("does not even save the page when ownership is already gone before the stage", async () => {
    const fence = fenceLostAfter(0);

    await expect(reviewAndSaveGeneratedPage(fencedOptions(fence))).rejects.toThrow("lost its durable lease");

    expect(mocks.prisma.page.create).not.toHaveBeenCalled();
    expect(mocks.keeperStoryExtractForSave).not.toHaveBeenCalled();
    expectNothingPublished();
  });

  it("keeps both the repaired chapter brief and page behind the publication fence", async () => {
    // This is the old split-write window. The repair's post-model stand-down
    // succeeds, then a replacement takes the structural lease before the page
    // publication barrier. Previously the loop had already committed the
    // chapter CAS here, leaving its repaired assignment durable while this
    // delivery's page never landed.
    const fence = fenceLostAfter(1);
    const { options } = keptBriefRepairOptions(fence);

    await expect(reviewAndSaveGeneratedPage(options)).rejects.toThrow("lost its durable lease");

    expect(strategy.repairPageBrief).toHaveBeenCalledTimes(1);
    expect(fence).toHaveBeenCalledTimes(2);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.prisma.page.create).not.toHaveBeenCalled();
    expect(mocks.prisma.chapter.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.chapter.updateMany).not.toHaveBeenCalled();
    expectNothingPublished();
  });

  it("publishes a kept page and its repaired chapter brief on one transaction client", async () => {
    const fence = fenceLostAfter(Number.POSITIVE_INFINITY);
    const { options, chapterBrief, repairedBeat } = keptBriefRepairOptions(fence);
    const tx = {
      page: { create: vi.fn().mockResolvedValue({ id: "page-row-1", revision: 4 }) },
      chapter: {
        findUnique: vi.fn().mockResolvedValue({ productionBrief: chapterBrief }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      }
    };
    mocks.prisma.$transaction.mockImplementationOnce(
      async (run: (client: typeof tx) => Promise<unknown>) => run(tx)
    );

    const saved = await reviewAndSaveGeneratedPage(options);

    expect(saved.repairedChapterBrief?.pages).toEqual([repairedBeat]);
    expect(tx.page.create).toHaveBeenCalledTimes(1);
    expect(tx.chapter.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.chapter.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.page.create.mock.invocationCallOrder[0]!).toBeLessThan(
      tx.chapter.findUnique.mock.invocationCallOrder[0]!
    );
    // Neither half escapes onto the root client around the transaction.
    expect(mocks.prisma.page.create).not.toHaveBeenCalled();
    expect(mocks.prisma.chapter.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.chapter.updateMany).not.toHaveBeenCalled();
  });

  it("rolls the kept page back when the repaired brief loses every transaction CAS", async () => {
    const fence = fenceLostAfter(Number.POSITIVE_INFINITY);
    const { options, chapterBrief } = keptBriefRepairOptions(fence);
    const movingBrief = (label: string) => ({ ...chapterBrief, continuityFocus: [label] });
    let stagedPage: Record<string, unknown> | null = null;
    let durablePage: Record<string, unknown> | null = null;
    const tx = {
      page: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          stagedPage = data;
          return { id: "page-row-1", revision: 4 };
        })
      },
      chapter: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ productionBrief: movingBrief("Sibling A") })
          .mockResolvedValueOnce({ productionBrief: movingBrief("Sibling B") })
          .mockResolvedValueOnce({ productionBrief: movingBrief("Sibling C") }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 })
      }
    };
    mocks.prisma.$transaction.mockImplementationOnce(
      async (run: (client: typeof tx) => Promise<unknown>) => {
        const result = await run(tx);
        durablePage = stagedPage;
        return result;
      }
    );

    const save = reviewAndSaveGeneratedPage(options);

    await expect(save).rejects.toMatchObject({
      name: "ChapterBriefPublicationRejectedError",
      chapterId: "chapter-1",
      outcome: "lost-race"
    });
    expect(tx.page.create).toHaveBeenCalledTimes(1);
    expect(tx.chapter.updateMany).toHaveBeenCalledTimes(3);
    expect(durablePage).toBeNull();
    // Rejection means there is no returned `repairedChapterBrief` for a caller
    // to adopt, and neither half escaped through the root client.
    expect(mocks.prisma.page.create).not.toHaveBeenCalled();
    expect(mocks.prisma.chapter.updateMany).not.toHaveBeenCalled();
    expectNothingPublished();
  });
});

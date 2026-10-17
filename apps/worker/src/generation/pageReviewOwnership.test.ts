import { beforeEach, describe, expect, it, vi } from "vitest";
import { mocks, report, draftNamed } from "./testing/pageReviewHarness.js";
import { reviewAndSaveGeneratedPage } from "./pageReview.js";

describe("reviewAndSaveGeneratedPage ownership fence", () => {
  // The structural-insert shape: a delivery drafting under a durable lease that
  // a replacement can take over mid-page. Everything the save publishes after
  // the page row — the continuity notes, the entity state and the embedding —
  // is read back by *later* pages, so a delivery that has lost
  // the book must leave none of it behind. The page row itself is the winner's
  // to redo: it is keyed on project+index and the winner drafts the same ids.
  const strategy = {
    id: "test-strategy",
    executionMode: "sequential-pages",
    reviewPageDraft: vi.fn(),
    revisePageDraft: vi.fn(),
    shouldIllustratePage: vi.fn()
  };

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

  /** Every write the page save publishes for later pages to read back. */
  const expectNothingPublished = () => {
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
    // The page's local checks pass.
    mocks.reviewPage.mockResolvedValue(report(90, { approved: true }));
    mocks.prepareEmbedding.mockResolvedValue({ vectorLiteral: "[0.1,0.2]", error: null });
  });

  it("publishes the whole tail while the fence holds, and asks it three times", async () => {
    const fence = fenceLostAfter(Number.POSITIVE_INFINITY);

    await reviewAndSaveGeneratedPage(fencedOptions(fence));

    // Before the page stage, before the provider calls, and before the writes.
    expect(fence).toHaveBeenCalledTimes(3);
    expect(mocks.prisma.continuityNote.createMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateEntityStateFromPage).toHaveBeenCalledTimes(1);
    expect(mocks.writePreparedEmbedding).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueWorkerJob).toHaveBeenCalledTimes(1);
  });

  it("spends no provider call and publishes nothing when ownership goes right after the page stage", async () => {
    // Lost before the embedding: the barrier after the stage is what stops a
    // delivery that no longer owns the book paying for memory it may not write.
    const fence = fenceLostAfter(1);

    await expect(reviewAndSaveGeneratedPage(fencedOptions(fence))).rejects.toThrow("lost its durable lease");

    expect(mocks.prisma.page.create).toHaveBeenCalledTimes(1);
    expect(mocks.prepareEmbedding).not.toHaveBeenCalled();
    expectNothingPublished();
  });

  it("publishes nothing when ownership goes during the provider calls, after the model answered", async () => {
    // Lost after the provider call, before the write: the vector is in hand,
    // and the publish barrier is what keeps it out of the book.
    const fence = fenceLostAfter(2);

    await expect(reviewAndSaveGeneratedPage(fencedOptions(fence))).rejects.toThrow("lost its durable lease");

    expect(mocks.prepareEmbedding).toHaveBeenCalledTimes(1);
    expectNothingPublished();
  });

  it("does not even save the page when ownership is already gone before the stage", async () => {
    const fence = fenceLostAfter(0);

    await expect(reviewAndSaveGeneratedPage(fencedOptions(fence))).rejects.toThrow("lost its durable lease");

    expect(mocks.prisma.page.create).not.toHaveBeenCalled();
    expectNothingPublished();
  });
});

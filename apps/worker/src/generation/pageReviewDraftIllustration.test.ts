import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageQualityReport } from "@book-maker/core";
import { balancedPageQaQualityContext } from "../testing/qualityGateFixtures.js";

/**
 * A picture queued from the checkpointed draft (`draftIllustrations.ts`) against the real
 * staging and publication its page's save runs: one durable job for an unchanged keeper,
 * and a retired picture plus a new keeper when the page changed before it was published.
 */
const mocks = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    page: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    imageAsset: { findMany: vi.fn(), deleteMany: vi.fn(), update: vi.fn() },
    continuityNote: { createMany: vi.fn() },
    chapter: { findUnique: vi.fn(), updateMany: vi.fn() }
  },
  enqueueWorkerJob: vi.fn(),
  // The page's local checks: the only review a generated page gets (`withoutPageReview`).
  reviewPage: vi.fn(),
  prepareEmbedding: vi.fn(),
  writePreparedEmbedding: vi.fn(),
  updateEntityStateFromPage: vi.fn()
}));

vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  Prisma: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../runtime/dispatch.js", () => ({ enqueueWorkerJob: mocks.enqueueWorkerJob }));
vi.mock("../runtime/jobLifecycle.js", () => ({ updateJobProgress: vi.fn() }));
vi.mock("./generationContext.js", () => ({
  loadContinuityNotes: async () => [],
  loadResearchNotesForGeneration: async () => []
}));
vi.mock("./qualitySettings.js", () => ({
  loadQualityContext: async () => balancedPageQaQualityContext(),
  applyPlanThinkingBoost: vi.fn()
}));
vi.mock("./qualityEnrichment.js", () => ({
  revisedDraftStyleAuditor: () => undefined
}));
vi.mock("./pageQualityGateReview.js", () => ({
  reviewPageWithQualityGates: mocks.reviewPage,
  pageReviewPassesFor: () => ({ localEnabled: true, smartUnslopEnabled: false, modelEnabled: false, anyConfiguredPassEnabled: true })
}));
vi.mock("./embeddingWrites.js", () => ({
  strategyUsesSemanticMemory: () => true,
  prepareEmbedding: mocks.prepareEmbedding,
  writePreparedEmbedding: mocks.writePreparedEmbedding
}));
vi.mock("./entityState.js", () => ({ updateEntityStateFromPage: mocks.updateEntityStateFromPage }));
vi.mock("./researchMemory.js", () => ({ retrieveSemanticResearchNotes: async () => [] }));
vi.mock("./bookHelpers.js", () => ({
  formatQualityFailure: () => "quality failure detail",
  styleExcerptsForPage: async () => []
}));

import { enqueueDraftPageIllustrations } from "./draftIllustrations.js";
import { currentGenerationAttemptId, runWithGenerationAttempt } from "../runtime/generationAttemptContext.js";
import { reviewAndSaveGeneratedPage } from "./pageReview.js";

const approvedReport = {
  approved: true,
  score: 90,
  issues: [],
  requiredRevisions: [],
  notes: "",
  checks: { repetitionOk: true, progressionOk: true }
} as unknown as PageQualityReport;

const strategy = {
  id: "test-strategy",
  executionMode: "sequential-pages",
  reviewPageDraft: vi.fn(),
  revisePageDraft: vi.fn(),
  shouldIllustratePage: vi.fn()
};

const baseOptions = (imagePrompt?: string) =>
  ({
    projectId: "project-1",
    planId: "plan-1",
    input: { mediaSettings: {} },
    plan: { title: "Book", chapters: [] },
    providers: { text: {}, embedding: {} },
    strategy,
    draft: {
      index: 3,
      title: "First",
      markdown: "First text.",
      summary: "First summary.",
      continuityNotes: [],
      ...(imagePrompt ? { imagePrompt } : {})
    },
    chapterId: null,
    previousPages: []
  }) as unknown as Parameters<typeof reviewAndSaveGeneratedPage>[0];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(
    async (run: (tx: typeof mocks.prisma) => Promise<unknown>) => run(mocks.prisma)
  );
  mocks.prisma.page.create.mockResolvedValue({ id: "page-row-1" });
  mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.imageAsset.findMany.mockResolvedValue([]);
  mocks.enqueueWorkerJob.mockResolvedValue({ id: "image-job" });
  mocks.prepareEmbedding.mockResolvedValue({ vectorLiteral: "[0.1,0.2]", error: null });
  mocks.reviewPage.mockResolvedValue(approvedReport);
});

describe("a picture queued from the checkpointed draft", () => {
  // The PENDING row `checkpointWholeBookDraftPages` writes for baseOptions' draft.
  const pending = { id: "page-row-1", index: 3, status: "PENDING", title: "First", markdown: "First text.",
    summary: "First summary.", imagePrompt: "A robin on a branch", revision: 1, updatedAt: new Date("2026-01-01T00:00:00.000Z") };
  const queueFromDraft = async () => {
    await enqueueDraftPageIllustrations({ projectId: "project-1", planId: "plan-1", input: { mediaSettings: {} } as never,
      plan: { chapters: [] } as never, strategy: strategy as never, pages: [{ index: 3, markdown: pending.markdown, imagePrompt: pending.imagePrompt }] });
    return mocks.enqueueWorkerJob.mock.calls[0]![0] as { dedupeKey: string; payload: { keeperToken: string } };
  };

  beforeEach(() => {
    strategy.shouldIllustratePage.mockReturnValue(true);
    mocks.prisma.page.findMany.mockResolvedValue([pending]);
    mocks.prisma.page.findUnique.mockResolvedValue(pending);
  });

  it("is the job an unchanged page's publication finds, so the picture is bought once", async () => {
    const early = await queueFromDraft();
    await reviewAndSaveGeneratedPage(baseOptions("A robin on a branch"));

    expect(mocks.enqueueWorkerJob).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueWorkerJob.mock.calls[1]![0]).toEqual(early);
    expect(mocks.prisma.imageAsset.deleteMany).not.toHaveBeenCalled();
    expect(mocks.prisma.page.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) })
    );
  });

  it("loses its picture and its keeper when the page is published in other words", async () => {
    const early = await queueFromDraft();
    mocks.prisma.imageAsset.findMany.mockResolvedValue([{ id: "early-asset",
      path: `/assets/images/project-1/page-page-row-1-${early.payload.keeperToken}.jpg`,
      metadata: { keeperToken: early.payload.keeperToken, keeperProjectId: "project-1", keeperPageId: "page-row-1" } }]);
    const options = baseOptions("A robin on a branch");
    await reviewAndSaveGeneratedPage({ ...options, draft: { ...options.draft, markdown: "First text, polished." } });

    expect(mocks.prisma.imageAsset.deleteMany).toHaveBeenCalledWith({ where: expect.objectContaining({ id: { in: ["early-asset"] } }) });
    const replacement = mocks.enqueueWorkerJob.mock.calls[1]![0] as typeof early;
    expect(replacement.dedupeKey).not.toBe(early.dedupeKey);
    expect(replacement.payload.keeperToken).not.toBe(early.payload.keeperToken);
  });

  describe.each(["STORY", "KIDS"] as const)("on a Quick Draft %s book, where publication queues pictures too", (category) => {
    // `deferIllustrations` is false here, so the page's own save enqueues
    // again: both have to be one durable row, attempt suffix included.
    const input = { category, targetPages: 10, mediaSettings: { modelTier: "fast", finalReview: false } };
    const rows = new Map<string, { id: string }>();
    const drawn = async (draft: Parameters<typeof reviewAndSaveGeneratedPage>[0]["draft"]) => {
      await runWithGenerationAttempt("book-attempt", async () => {
        await enqueueDraftPageIllustrations({ projectId: "project-1", planId: "plan-1", input: input as never,
          plan: { chapters: [] } as never, strategy: strategy as never, pages: [{ index: 3, markdown: pending.markdown, imagePrompt: pending.imagePrompt }] });
        await reviewAndSaveGeneratedPage({ ...baseOptions(), input, draft } as never);
      });
      return [...rows.values()];
    };

    beforeEach(async () => {
      // The real local checks: whether they flag the page is what these cases are about.
      const actual = await vi.importActual<typeof import("./pageQualityGateReview.js")>("./pageQualityGateReview.js");
      mocks.reviewPage.mockImplementation(actual.reviewPageWithQualityGates);
      rows.clear();
      // `enqueueWorkerJob`'s identity: the key plus the delivery's attempt, one row per identity.
      mocks.enqueueWorkerJob.mockImplementation(async ({ dedupeKey }: { dedupeKey: string }) => {
        const attempt = currentGenerationAttemptId();
        const key = attempt ? `${dedupeKey}:attempt:${attempt}` : dedupeKey;
        const row = rows.get(key) ?? { id: `image-job-${rows.size + 1}` };
        rows.set(key, row);
        return row;
      });
    });

    it("draws an unchanged page once: its save lands on the draft-time job", async () => {
      expect(await drawn(baseOptions("A robin on a branch").draft)).toEqual([{ id: "image-job-1" }]);
      expect(mocks.enqueueWorkerJob).toHaveBeenCalledTimes(2);
      expect(mocks.enqueueWorkerJob.mock.calls[1]![0]).toEqual(mocks.enqueueWorkerJob.mock.calls[0]![0]);
      // A generated page's review is local and buys no rewrite, so the keeper cannot move.
      expect(strategy.reviewPageDraft).not.toHaveBeenCalled();
      expect(strategy.revisePageDraft).not.toHaveBeenCalled();
      expect(mocks.prisma.imageAsset.deleteMany).not.toHaveBeenCalled();
      expect(mocks.prisma.page.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) })
      );
    });

    it("keeps the one picture on a page its local review flags, since nothing rewrites it", async () => {
      const flagged = { ...pending, markdown: "First text. This is a placeholder page for the robin." };
      mocks.prisma.page.findMany.mockResolvedValue([flagged]);
      mocks.prisma.page.findUnique.mockResolvedValue(flagged);
      const options = baseOptions("A robin on a branch");
      expect(await drawn({ ...options.draft, markdown: flagged.markdown })).toEqual([{ id: "image-job-1" }]);
      expect(mocks.enqueueWorkerJob).toHaveBeenCalledTimes(1);
      expect(mocks.prisma.page.updateMany.mock.calls[0]![0]).toMatchObject({ data: { status: "FAILED_QA", markdown: flagged.markdown, revision: 1 } });
      expect(mocks.prisma.imageAsset.deleteMany).not.toHaveBeenCalled();
    });
  });
});

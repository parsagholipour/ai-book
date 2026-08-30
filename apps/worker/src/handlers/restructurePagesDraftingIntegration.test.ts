import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projectRow: { id: "project-1", currentPlanId: "plan-1", status: "EDITING", targetPages: 6, contentRevision: 7 },
  prisma: {
    bookEditOperation: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    project: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    planVersion: { findUnique: vi.fn() },
    page: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      createMany: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn()
    },
    chapter: { updateMany: vi.fn() },
    imageAsset: { updateMany: vi.fn() },
    $transaction: vi.fn()
  },
  applyStructuralPageChange: vi.fn(),
  leaseClaim: { outcome: "acquired", phase: "tail", application: null } as Record<string, unknown>,
  waitForStructuralPageLease: vi.fn(async () => mocks.leaseClaim),
  waitForStructuralPageLeaseCompletion: vi.fn(),
  heartbeatAssertHeld: vi.fn(),
  heartbeatStop: vi.fn(),
  startStructuralPageLeaseHeartbeat: vi.fn(() => ({ assertHeld: mocks.heartbeatAssertHeld, stop: mocks.heartbeatStop })),
  completeStructuralPageLease: vi.fn(),
  markStructuralPageLeaseApplied: vi.fn(),
  settleSkippedStructuralPageLeaseTx: vi.fn(),
  renewStructuralPageLeaseTx: vi.fn(),
  claimAppliedEditPublication: vi.fn(),
  restoreEditProjectStatus: vi.fn(),
  reviewAndSaveGeneratedPage: vi.fn(),
  reviewAppliedBookEdit: vi.fn(),
  generatePageDraft: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  invalidateProjectExports: vi.fn(),
  compensateStructuralPageChangeTx: vi.fn(),
  revertStructuralPageChange: vi.fn(),
  rebuildProjectStoryState: vi.fn(),
  rebuildRolledBackProjectStoryState: vi.fn(),
  refundSkippedEditOperation: vi.fn(),
  refundUnwrittenEditPages: vi.fn(),
  releaseStructuralPageLease: vi.fn(),
  redeliverWorkerGenerationJob: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: { DbNull: Symbol("DbNull") },
  PAGE_RESTRUCTURE_TRANSACTION_OPTIONS: { timeout: 30_000, maxWait: 10_000 },
  compensateStructuralPageChangeTx: mocks.compensateStructuralPageChangeTx,
  revertStructuralPageChange: mocks.revertStructuralPageChange
}));
vi.mock("../generation/pageRestructure.js", () => ({
  applyStructuralPageChange: mocks.applyStructuralPageChange
}));
vi.mock("../generation/structuralPageLease.js", () => ({
  waitForStructuralPageLease: mocks.waitForStructuralPageLease,
  waitForStructuralPageLeaseCompletion: mocks.waitForStructuralPageLeaseCompletion,
  startStructuralPageLeaseHeartbeat: mocks.startStructuralPageLeaseHeartbeat,
  completeStructuralPageLease: mocks.completeStructuralPageLease,
  markStructuralPageLeaseApplied: mocks.markStructuralPageLeaseApplied,
  settleSkippedStructuralPageLeaseTx: mocks.settleSkippedStructuralPageLeaseTx,
  renewStructuralPageLeaseTx: mocks.renewStructuralPageLeaseTx,
  releaseStructuralPageLease: mocks.releaseStructuralPageLease,
  StructuralPageLeaseLostError: class StructuralPageLeaseLostError extends Error {},
  isStructuralPageLeaseLostError: () => false
}));
vi.mock("../generation/editProjectStatus.js", () => ({
  claimAppliedEditPublication: mocks.claimAppliedEditPublication,
  restoreEditProjectStatus: mocks.restoreEditProjectStatus
}));
vi.mock("../generation/pageReview.js", () => ({
  reviewAndSaveGeneratedPage: mocks.reviewAndSaveGeneratedPage
}));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: async () => ({ ...mocks.projectRow }),
  invalidateProjectExports: mocks.invalidateProjectExports,
  strategyForInput: () => ({ generatePageDraft: mocks.generatePageDraft }),
  styleExcerptsForPage: async () => [],
  toPriorPageContext: (page: { index: number; title: string; markdown: string; summary: string }) => ({
    index: page.index,
    title: page.title,
    markdown: page.markdown,
    summary: page.summary
  })
}));
vi.mock("../generation/generationContext.js", () => ({
  loadContinuityNotes: async () => [],
  loadResearchNotesForGeneration: async () => []
}));
vi.mock("../generation/embeddingWrites.js", () => ({
  prepareEmbedding: vi.fn(),
  strategyUsesSemanticMemory: () => false,
  writePreparedEmbedding: vi.fn()
}));
vi.mock("../generation/qualityEnrichment.js", () => ({
  keeperStoryExtractForSave: async () => null,
  persistStoryExtract: vi.fn()
}));
vi.mock("../generation/projectInput.js", () => ({ inputForPlanVersion: () => ({ targetPages: 6 }) }));
vi.mock("../generation/qualitySettings.js", () => ({ loadQualityContext: async () => ({ enabled: () => false }) }));
vi.mock("../generation/storyStateStore.js", () => ({
  loadProjectStoryState: async () => ({}),
  rebuildProjectStoryState: mocks.rebuildProjectStoryState,
  rebuildRolledBackProjectStoryState: mocks.rebuildRolledBackProjectStoryState
}));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ text: {} }) }));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../runtime/dispatch.js", () => ({
  maybeEnqueueCompile: mocks.maybeEnqueueCompile,
  redeliverWorkerGenerationJob: mocks.redeliverWorkerGenerationJob
}));
vi.mock("../runtime/jobLifecycle.js", () => ({
  advanceJobStep: vi.fn(),
  refundSkippedEditOperation: mocks.refundSkippedEditOperation,
  refundUnwrittenEditPages: mocks.refundUnwrittenEditPages
}));
vi.mock("../runtime/durableEditCompletion.js", () => ({
  claimDurableEditCompletionTx: vi.fn(async () => true),
  settleDurableEditAttemptTx: vi.fn(async () => true)
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    bookPlanSchema: { parse: () => ({ chapters: [], promises: [] }) },
    createProviders: () => ({}),
    reviewAppliedBookEdit: mocks.reviewAppliedBookEdit
  };
});

import { restructurePages } from "./restructurePages.js";

const job = (data: Record<string, unknown>) => ({ data, id: "job-1" }) as unknown as Job;

const insertJob = (payload: Record<string, unknown> = {}) =>
  job({
    projectId: "project-1",
    operationId: "op-1",
    request: "Add 2 pages after page 3",
    planId: "plan-1",
    structuralEdit: { action: "insert", anchorPageIndex: 3, pageIndexes: [], pageCount: 2 },
    ...payload
  });

const pages = (count: number) =>
  Array.from({ length: count }, (_value, offset) => ({
    id: `page-${offset + 1}`,
    index: offset + 1,
    chapterId: null
  }));

const approvedReport = {
  approved: true,
  score: 90,
  issues: [],
  requiredRevisions: [],
  notes: "Approved",
  groundedOk: true,
  unsupportedClaims: [],
  checks: {
    placeholderFree: true,
    promptLeakFree: true,
    titleClean: true,
    repetitionOk: true,
    progressionOk: true,
    styleNatural: true
  }
};

const application = () => ({
  action: "insert",
  pageOrderBefore: pages(6).map((page) => ({ pageId: page.id, index: page.index, chapterId: page.chapterId })),
  insertedPageIds: ["page-new-1", "page-new-2"],
  removedPages: [],
  basePlanVersionId: "plan-1",
  newPlanVersionId: "plan-2",
  previousTargetPages: 6,
  previousChapterTargetPages: {},
  appliedAt: "2026-08-15T00:00:00.000Z"
});

describe("restructurePages drafting and publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectRow.status = "EDITING";
    mocks.projectRow.contentRevision = 7;
    mocks.prisma.project.update.mockImplementation(async ({ data }: { data: { status?: string; contentRevision?: { increment: number } } }) => {
      if (typeof data.status === "string") mocks.projectRow.status = data.status;
      if (data.contentRevision) mocks.projectRow.contentRevision += data.contentRevision.increment;
      return { ...mocks.projectRow };
    });
    mocks.prisma.project.findUnique.mockImplementation(async () => ({ ...mocks.projectRow }));
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(mocks.prisma));
    mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1",
      status: "ACTIVE",
      classifier: {},
      publicationRevision: 7
    });
    mocks.prisma.planVersion.findUnique.mockResolvedValue({
      id: "plan-1",
      inputSnapshot: {},
      planningPackage: {}
    });
    mocks.prisma.page.findMany.mockResolvedValue(pages(6));
    mocks.prisma.page.count.mockResolvedValue(2);
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.page.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      index: where.id.endsWith("1") ? 4 : 5,
      chapterId: null,
      chapter: null
    }));
    mocks.applyStructuralPageChange.mockResolvedValue({ outcome: "applied", application: application() });
    mocks.leaseClaim = { outcome: "acquired", phase: "tail", application: null };
    mocks.completeStructuralPageLease.mockResolvedValue(true);
    mocks.markStructuralPageLeaseApplied.mockResolvedValue(8);
    mocks.renewStructuralPageLeaseTx.mockResolvedValue({
      status: "ACTIVE",
      classifier: { structuralApplication: application() }
    });
    mocks.claimAppliedEditPublication.mockResolvedValue(true);
    mocks.restoreEditProjectStatus.mockResolvedValue(true);
    mocks.generatePageDraft.mockResolvedValue({ title: "New", markdown: "Body.", summary: "S.", continuityNotes: [] });
    mocks.reviewAndSaveGeneratedPage.mockImplementation(async ({ draft }) => ({
      page: { index: draft.index, title: draft.title, markdown: draft.markdown, summary: draft.summary },
      candidate: { draft, qualityReport: approvedReport }
    }));
    mocks.reviewAppliedBookEdit.mockResolvedValue({
      satisfied: true,
      confidence: 0.99,
      missingRequirements: [],
      contradictions: [],
      pageIndexesToRevise: []
    });
    mocks.maybeEnqueueCompile.mockResolvedValue("compile");
    mocks.compensateStructuralPageChangeTx.mockResolvedValue({ outcome: "compensated", currentPlanId: "plan-1" });
    mocks.revertStructuralPageChange.mockResolvedValue({ currentPlanId: "plan-1" });
    mocks.rebuildProjectStoryState.mockResolvedValue({});
    mocks.rebuildRolledBackProjectStoryState.mockResolvedValue({});
    mocks.prisma.project.updateMany.mockImplementation(
      async ({ where, data }: { where: { status?: string | { not: string } }; data: { status?: string } }) => {
        const wanted = where.status;
        const matches =
          wanted === undefined
            ? true
            : typeof wanted === "string"
              ? mocks.projectRow.status === wanted
              : mocks.projectRow.status !== wanted.not;
        if (!matches) return { count: 0 };
        if (typeof data.status === "string") mocks.projectRow.status = data.status;
        return { count: 1 };
      }
    );
    mocks.refundSkippedEditOperation.mockResolvedValue(undefined);
    mocks.refundUnwrittenEditPages.mockResolvedValue(undefined);
  });

  it("shifts once, writes the new pages, and hands the book to the recompile", async () => {
    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.applyStructuralPageChange).toHaveBeenCalledTimes(1);
    expect(mocks.applyStructuralPageChange.mock.calls[0]?.[0].plan).toMatchObject({
      action: "insert",
      insertAfterIndex: 3,
      newPageIndexes: [4, 5]
    });
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(2);
    expect(mocks.markStructuralPageLeaseApplied).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "op-1" },
        data: expect.objectContaining({ status: "APPLIED", publicationRevision: 8 })
      })
    );
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-2", undefined, {
      contentRevision: 8,
      requireContentRevisionMatch: true
    });
  });

  it("never publishes or marks an insert applied when deferred review omits its candidate", async () => {
    mocks.reviewAndSaveGeneratedPage.mockResolvedValueOnce({
      page: { index: 4, title: "New", markdown: "Body.", summary: "S." }
    });

    await expect(
      restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} })
    ).rejects.toThrow("Deferred review for inserted page 4 returned no candidate");

    expect(mocks.reviewAppliedBookEdit).not.toHaveBeenCalled();
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
    expect(mocks.markStructuralPageLeaseApplied).not.toHaveBeenCalled();
  });

  it.each([
    { label: "none", remainingIds: [] as string[], missing: 2 },
    { label: "only part", remainingIds: ["page-new-1"], missing: 1 }
  ])("rolls back when $label of the recorded inserted pages remain", async ({ remainingIds, missing }) => {
    const remaining = new Set(remainingIds);
    mocks.prisma.page.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      remaining.has(where.id)
        ? {
            id: where.id,
            index: where.id.endsWith("1") ? 4 : 5,
            chapterId: null,
            chapter: null
          }
        : null
    );

    await expect(
      restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} })
    ).rejects.toThrow(`Structural insert is missing ${missing} of 2 recorded pages`);

    expect(mocks.generatePageDraft).not.toHaveBeenCalled();
    expect(mocks.reviewAppliedBookEdit).not.toHaveBeenCalled();
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
    expect(mocks.markStructuralPageLeaseApplied).not.toHaveBeenCalled();
    expect(mocks.refundUnwrittenEditPages).not.toHaveBeenCalled();
    expect(mocks.compensateStructuralPageChangeTx).toHaveBeenCalledOnce();
  });

  it("keeps the durable edit instruction authoritative over a stale queue payload", async () => {
    await restructurePages(insertJob({ editInstruction: "Stale queue instruction." }), {
      id: "op-1",
      status: "QUEUED",
      classifier: {},
      editInstruction: "Use the approved durable instruction."
    });

    expect(mocks.generatePageDraft).toHaveBeenCalledTimes(2);
    for (const [options] of mocks.generatePageDraft.mock.calls) {
      expect(options).toMatchObject({ editInstruction: "Use the approved durable instruction." });
    }
  });

  it("uses the queue instruction for a legacy operation with a blank durable value", async () => {
    await restructurePages(insertJob({ editInstruction: "Recovered queue instruction." }), {
      id: "op-1",
      status: "QUEUED",
      classifier: {},
      editInstruction: "   "
    });

    expect(mocks.generatePageDraft).toHaveBeenCalledTimes(2);
    for (const [options] of mocks.generatePageDraft.mock.calls) {
      expect(options).toMatchObject({ editInstruction: "Recovered queue instruction." });
    }
  });

  it("gives an inserted page the prose that already follows it", async () => {
    mocks.prisma.page.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      const index = where.index as Record<string, number> | undefined;
      if (index?.lt !== undefined) return [{ index: 3, title: "Before", markdown: "Ends here.", summary: "s" }];
      if (index?.gt !== undefined) return [{ index: 6, title: "After", markdown: "Starts here.", summary: "s" }];
      if (where.id !== undefined) return [{ index: 4 }, { index: 5 }];
      return pages(6);
    });

    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.generatePageDraft.mock.calls[0]?.[0].nextPages).toEqual([
      expect.objectContaining({ index: 6, markdown: "Starts here." })
    ]);
    expect(mocks.reviewAndSaveGeneratedPage.mock.calls[0]?.[0].nextPages).toEqual([
      expect.objectContaining({ index: 6 })
    ]);
    expect(mocks.reviewAndSaveGeneratedPage.mock.calls[0]?.[0].illustrate).toBe(false);
  });
});

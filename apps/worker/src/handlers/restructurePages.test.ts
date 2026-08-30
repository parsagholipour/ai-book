import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

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
vi.mock("../runtime/durableEditCompletion.js", () => ({ claimDurableEditCompletionTx: async () => true, settleDurableEditAttemptTx: async () => true }));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    bookPlanSchema: { parse: () => ({ chapters: [], promises: [] }) },
    createProviders: () => ({}),
    reviewAppliedBookEdit: mocks.reviewAppliedBookEdit
  };
});

import { PRE_EDIT_PROJECT_STATUS } from "@book-maker/core";
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

const application = (overrides: Record<string, unknown> = {}) => ({
  action: "insert",
  pageOrderBefore: pages(6).map((page) => ({ pageId: page.id, index: page.index, chapterId: page.chapterId })),
  insertedPageIds: ["page-new-1", "page-new-2"],
  removedPages: [],
  basePlanVersionId: "plan-1",
  newPlanVersionId: "plan-2",
  previousTargetPages: 6,
  previousChapterTargetPages: {},
  appliedAt: "2026-08-15T00:00:00.000Z",
  ...overrides
});

const unshiftedClaim = { outcome: "acquired", phase: "draft", application: null };

const expectSettled = (reason: string) => {
  expect(mocks.settleSkippedStructuralPageLeaseTx).toHaveBeenCalledWith(mocks.prisma, "op-1", expect.any(String));
  expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: { classifier: expect.objectContaining({ structuralSkipped: reason }) } })
  );
};

describe("restructurePages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectRow.status = "EDITING";
    mocks.projectRow.contentRevision = 7;
    mocks.prisma.project.update.mockImplementation(async ({ data }: { data: { status?: string; contentRevision?: { increment: number } } }) => {
      if (typeof data.status === "string") {
        mocks.projectRow.status = data.status;
      }
      if (data.contentRevision) mocks.projectRow.contentRevision += data.contentRevision.increment;
      return { ...mocks.projectRow };
    });
    mocks.prisma.project.findUnique.mockImplementation(async () => ({ ...mocks.projectRow }));
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run(mocks.prisma)
    );
    mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1", status: "ACTIVE", classifier: {}, publicationRevision: 7
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
      id: where.id, index: where.id.endsWith("1") ? 4 : 5, chapterId: null, chapter: null
    }));
    mocks.applyStructuralPageChange.mockResolvedValue({
      outcome: "applied",
      application: application()
    });
    mocks.leaseClaim = { outcome: "acquired", phase: "tail", application: null };
    mocks.completeStructuralPageLease.mockResolvedValue(true);
    mocks.markStructuralPageLeaseApplied.mockImplementation(async ({ affectedPageIndexes }) => {
      await mocks.prisma.bookEditOperation.update({
        where: { id: "op-1" },
        data: { status: "APPLIED", affectedPageIndexes, appliedAt: new Date() }
      });
      return 8;
    });
    mocks.settleSkippedStructuralPageLeaseTx.mockResolvedValue({ classifier: {} });
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
        if (typeof data.status === "string") {
          mocks.projectRow.status = data.status;
        }
        return { count: 1 };
      }
    );
    mocks.refundSkippedEditOperation.mockResolvedValue(undefined);
    mocks.refundUnwrittenEditPages.mockResolvedValue(undefined);
  });
  afterEach(() => vi.clearAllMocks());

  it("never shifts twice when a redelivery finds the stamp already committed", async () => {
    // The dangerous case. The stamp is written in the same transaction as the
    // shift, so finding it means the shift landed — and shifting again would
    // scatter the pages with nothing able to work out where they belonged.
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1",
      status: "ACTIVE",
      classifier: { structuralApplication: application() }
    });
    mocks.leaseClaim = { outcome: "acquired", phase: "draft", application: application() };

    await restructurePages(insertJob(), { id: "op-1", status: "ACTIVE", classifier: {} });

    expect(mocks.applyStructuralPageChange).not.toHaveBeenCalled();
    // It resumes at drafting, against the page *ids* the stamp recorded.
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(2);
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalled();
  });

  it("waits for the winning delivery instead of drafting or settling its pages", async () => {
    // The concurrent half of the fence, which the read above cannot answer: two
    // deliveries in flight, both past the ACTIVE claim (ACTIVE matches ACTIVE),
    // both having read a classifier with no stamp on it. The loser blocks on the
    // operation row inside `applyStructuralPageChange`'s transaction and comes
    // back `already-applied` rather than shifting the book a second time — which
    // for "add 2 pages" would have moved the tail down four and left four blanks.
    mocks.applyStructuralPageChange.mockResolvedValue({
      outcome: "already-applied",
      application: application(),
      retryAt: new Date("2026-08-18T00:03:00.000Z")
    });
    mocks.leaseClaim = { outcome: "completed" };

    await restructurePages(insertJob(), { id: "op-1", status: "ACTIVE", classifier: {} });

    expect(mocks.waitForStructuralPageLease).toHaveBeenCalledTimes(1);
    expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
    expect(mocks.markStructuralPageLeaseApplied).not.toHaveBeenCalled();
    expect(mocks.compensateStructuralPageChangeTx).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("hands the book to the recompile when the shift's claim finds the operation settled", async () => {
    // The other thing that claim can report: the row went APPLIED or CANCELED
    // while this delivery was resolving its plan. Nothing was shifted here, so
    // the only thing owed is whatever the winner may have died before doing.
    mocks.applyStructuralPageChange.mockResolvedValue({ outcome: "settled" });
    // Unstamped when this delivery looked, settled by the time its claim ran.
    mocks.prisma.bookEditOperation.findUnique
      .mockResolvedValueOnce({ id: "op-1", status: "ACTIVE", classifier: {} })
      .mockResolvedValue({
        id: "op-1",
        status: "APPLIED",
        classifier: { structuralApplication: application() },
        publicationRevision: 7
      });

    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
    expect(mocks.revertStructuralPageChange).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", undefined, {
      contentRevision: 7,
      requireContentRevisionMatch: true
    });
  });

  it("leaves a delivered no-op alone when the shift's claim finds it settled", async () => {
    mocks.applyStructuralPageChange.mockResolvedValue({ outcome: "settled" });
    mocks.prisma.bookEditOperation.findUnique
      .mockResolvedValueOnce({ id: "op-1", status: "ACTIVE", classifier: {} })
      .mockResolvedValue({
        id: "op-1",
        status: "APPLIED",
        classifier: { structuralSkipped: "unknown_pages" }
      });

    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("re-runs only the idempotent tail for an operation that already finished", async () => {
    await restructurePages(insertJob(), { id: "op-1", status: "APPLIED", classifier: {} });

    expect(mocks.applyStructuralPageChange).not.toHaveBeenCalled();
    expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", undefined, {
      contentRevision: 7,
      requireContentRevisionMatch: true
    });
  });

  it("leaves a delivered no-op exactly where it found it when the job comes back", async () => {
    // The other row that wears APPLIED. This one shifted nothing — the resolver
    // refused, the charge went back, the book was put down as it was found — so
    // the tail above is not idempotent here, it is the only thing in the whole
    // delivery that would change the book.
    await restructurePages(insertJob(), {
      id: "op-1",
      status: "APPLIED",
      classifier: { structuralSkipped: "unknown_pages" }
    });

    expect(mocks.applyStructuralPageChange).not.toHaveBeenCalled();
    // The published PDF still describes this manuscript and the map measured
    // from it still describes that PDF: deleting one and bumping past the other
    // costs a full unbilled compile whose review can hand a COMPLETE book back
    // as REVIEW_REQUIRED.
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
  });

  it("stands down when a racing delivery settled the operation as a no-op", async () => {
    // The reachable door: two deliveries in flight, the first settles the skip
    // while the second is still between its own read and its ACTIVE claim.
    mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1",
      status: "APPLIED",
      classifier: { structuralSkipped: "unknown_pages" }
    });

    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
  });

  it("still refreshes the exports when the redelivered edit really moved pages", async () => {
    // The contrast the marker draws: a stamped operation shifted the book, so
    // its exports are gone and the recompile the first delivery may have died
    // before queueing has to be queued again.
    await restructurePages(insertJob(), {
      id: "op-1",
      status: "APPLIED",
      classifier: { structuralApplication: application() }
    });

    expect(mocks.applyStructuralPageChange).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", undefined, {
      contentRevision: 7,
      requireContentRevisionMatch: true
    });
  });

  it("puts the book back in the same transaction that marks a skipped edit APPLIED", async () => {
    mocks.leaseClaim = unshiftedClaim;
    // What makes the stand-down above safe: the marker a redelivery reads as
    // "settled, nothing left to finish" may not land before the write that
    // takes the book out of EDITING, or the pair would strand a project no
    // sweep reaches behind a marker telling its own retry to do nothing.
    mocks.prisma.page.findMany.mockResolvedValue([]);

    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.bookEditOperation.update.mock.invocationCallOrder[0]!).toBeGreaterThan(
      mocks.prisma.$transaction.mock.invocationCallOrder[0]!
    );
    expect(mocks.prisma.project.update.mock.calls.at(-1)?.[0]).toMatchObject({
      data: { status: "COMPLETE" }
    });
  });

  it("stands down when another actor already settled the operation", async () => {
    mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({ id: "op-1", status: "CANCELED", classifier: {} });

    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.applyStructuralPageChange).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("settles for free when the book changed out from under the card", async () => {
    mocks.leaseClaim = unshiftedClaim;
    // "Delete page 9" of a book that now has six pages. Failing here would mark
    // a finished book FAILED; the edit simply has nothing to do.
    const stale = job({
      projectId: "project-1",
      operationId: "op-1",
      request: "Delete page 9",
      planId: "plan-1",
      structuralEdit: { action: "delete", anchorPageIndex: 0, pageIndexes: [9], pageCount: 0 }
    });

    await restructurePages(stale, { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.applyStructuralPageChange).not.toHaveBeenCalled();
    expectSettled("unknown_pages");
    expect(mocks.prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "COMPLETE" } })
    );
    // Asked for even though a delete is free: the settlement is a no-op on an
    // operation with no ledger entry, and closing the attempt is what stops a
    // redelivery re-running an edit nobody is paying for.
    expect(mocks.refundSkippedEditOperation).toHaveBeenCalledWith(stale, expect.stringContaining("unknown_pages"));
  });

  it("settles a skipped edit back to REVIEW_REQUIRED rather than finishing the book", async () => {
    mocks.leaseClaim = unshiftedClaim;
    // The same no-op settlement for a book the reader still has to look at. This
    // is the path where the handler writes the terminal status itself, with no
    // compile coming to correct it.
    const stale = job({
      projectId: "project-1",
      operationId: "op-1",
      request: "Delete page 9",
      planId: "plan-1",
      structuralEdit: { action: "delete", anchorPageIndex: 0, pageIndexes: [9], pageCount: 0 },
      [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED"
    });

    await restructurePages(stale, { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "REVIEW_REQUIRED" } })
    );
  });

  it("hands the credits back before settling a skipped insert", async () => {
    mocks.leaseClaim = unshiftedClaim;
    // The one insert refusal that can survive a card: the pages the anchor was
    // resolved against are gone. Nothing will be written, and the pages were
    // paid for when the edit was queued — so the refund has to be made here,
    // because returning normally is what marks the attempt SUCCEEDED and
    // commits the charge for good.
    mocks.prisma.page.findMany.mockResolvedValue([]);
    const insert = insertJob();

    await restructurePages(insert, { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.applyStructuralPageChange).not.toHaveBeenCalled();
    expect(mocks.refundSkippedEditOperation).toHaveBeenCalledWith(insert, expect.stringContaining("no_pages"));
    // Refunded *before* the operation is claimed APPLIED: a settlement that
    // throws has to leave behind the ACTIVE row `failEditOperation` claims.
    expect(mocks.refundSkippedEditOperation.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.prisma.bookEditOperation.update.mock.invocationCallOrder[0]!
    );
    expectSettled("no_pages");
  });

  it("refunds nothing and skips nothing when the winning delivery already applied the edit", async () => {
    // The pre-flight read is taken outside every claim, and a book the winner
    // has just shifted answers the resolver exactly as a book that moved under
    // the card does: the pages the request names are gone because the winner
    // deleted them. Settling on that read handed the charge back, marked the row
    // APPLIED with `structuralSkipped` and put the book down in its pre-edit
    // status — under a delivery that had already shifted it, whose own APPLIED
    // write then failed (`markStructuralPageLeaseApplied` claims ACTIVE) and
    // whose rollback could not run either, because it opens by renewing the
    // lease this settlement had just cleared. The claim is asked first now.
    mocks.prisma.page.findMany.mockResolvedValue([]);
    mocks.leaseClaim = { outcome: "completed" };
    const insert = insertJob();

    await restructurePages(insert, { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.waitForStructuralPageLease).toHaveBeenCalledTimes(1);
    expect(mocks.refundSkippedEditOperation).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
  });

  it("drafts the pages a dead winner's stamp recorded instead of settling its refusal", async () => {
    // The same stale refusal, and a winner that shifted and then died: the claim
    // hands its expired stamp to this delivery, so what read as "nothing to do"
    // is a paid insert whose pages are still blank.
    mocks.prisma.page.findMany.mockResolvedValue([]);
    mocks.leaseClaim = { outcome: "acquired", phase: "draft", application: application() };

    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.refundSkippedEditOperation).not.toHaveBeenCalled();
    expect(mocks.applyStructuralPageChange).not.toHaveBeenCalled();
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(2);
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-2", undefined, {
      contentRevision: 8,
      requireContentRevisionMatch: true
    });
  });

  it("settles for free when the claim finds a book the plan no longer fits", async () => {
    // The refusal the pre-flight read cannot give. `resolveStructuralPageEdit`
    // answered against a read taken before the plan-version reads, the provider
    // construction and the transaction's own start, so a page created or deleted
    // in that window leaves the ordering naming a book that is not there — a
    // `23505` when a parked row lands on an index a live page still holds, and a
    // hole in `1..N` a later compile refuses when it misses. The shift asks the
    // resolver's question again under the operation row's lock, writes nothing,
    // and reports `stale`; that settles exactly as the refusal above does rather
    // than failing a book that is fine.
    mocks.applyStructuralPageChange.mockResolvedValue({ outcome: "stale", reason: "nothing_to_do" });
    const raced = job({
      projectId: "project-1",
      operationId: "op-1",
      request: "Delete page 2",
      planId: "plan-1",
      structuralEdit: { action: "delete", anchorPageIndex: 0, pageIndexes: [2], pageCount: 0 }
    });

    await restructurePages(raced, { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
    expect(mocks.refundSkippedEditOperation).toHaveBeenCalledWith(raced, expect.stringContaining("nothing_to_do"));
    expectSettled("nothing_to_do");
    expect(mocks.prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "COMPLETE" } })
    );
  });

  it("reads the request off the classifier when the payload arrives without one", async () => {
    // `applyBookEdit` forks on the operation's `kind`, so this delivery is
    // reachable: a requeue or a reconciler can rebuild the payload without
    // `structuralEdit`, and the Apply wrote the same request onto the classifier
    // for exactly that case.
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1",
      status: "ACTIVE",
      classifier: { structuralEdit: { action: "insert", anchorPageIndex: 3, pageIndexes: [], pageCount: 2 } }
    });
    const payloadless = job({
      projectId: "project-1",
      operationId: "op-1",
      request: "Add 2 pages after page 3",
      planId: "plan-1"
    });

    await restructurePages(payloadless, { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.applyStructuralPageChange).toHaveBeenCalledTimes(1);
    expect(mocks.applyStructuralPageChange.mock.calls[0]?.[0].plan).toMatchObject({
      action: "insert",
      insertAfterIndex: 3,
      newPageIndexes: [4, 5]
    });
    expect(mocks.refundSkippedEditOperation).not.toHaveBeenCalled();
  });

  it("refunds and settles a structural job that carries no request at all", async () => {
    mocks.leaseClaim = unshiftedClaim;
    // Both copies gone. There is nothing to resolve and nothing a retry could
    // find, so it settles like a refusal rather than throwing — a throw fails a
    // book that is otherwise finished and leaves the row recoverable, so the
    // retry lane would charge again for a request that is still not there.
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1",
      status: "ACTIVE",
      classifier: { kind: "restructure_pages" }
    });
    const requestless = job({
      projectId: "project-1",
      operationId: "op-1",
      request: "Add 2 pages after page 3",
      planId: "plan-1",
      [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED"
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await restructurePages(requestless, { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.applyStructuralPageChange).not.toHaveBeenCalled();
    expect(mocks.refundSkippedEditOperation).toHaveBeenCalledWith(
      requestless,
      expect.stringContaining("missing_request")
    );
    expect(mocks.refundSkippedEditOperation.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.prisma.bookEditOperation.update.mock.invocationCallOrder[0]!
    );
    expectSettled("missing_request");
    // The marker and the status restore land together, and the status comes off
    // the payload — a book still asking for attention is not quietly finished.
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.project.update.mock.calls.at(-1)?.[0]).toMatchObject({
      data: { status: "REVIEW_REQUIRED" }
    });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("leaves a skipped edit unsettled when the refund itself fails", async () => {
    mocks.leaseClaim = unshiftedClaim;
    mocks.prisma.page.findMany.mockResolvedValue([]);
    mocks.refundSkippedEditOperation.mockRejectedValue(new Error("ledger unavailable"));

    await expect(restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} })).rejects.toThrow(
      "ledger unavailable"
    );

    // Never APPLIED: markFailed must still be able to claim and refund ACTIVE.
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    expect(mocks.revertStructuralPageChange).not.toHaveBeenCalled();
  });

  it("puts the book back and fails the operation when drafting dies", async () => {
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run(mocks.prisma)
    );
    mocks.generatePageDraft.mockRejectedValue(new Error("model outage"));

    await expect(restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} })).rejects.toThrow(
      "model outage"
    );

    expect(mocks.compensateStructuralPageChangeTx).toHaveBeenCalledWith(mocks.prisma, {
      projectId: "project-1",
      operationId: "op-1",
      expectedLeaseToken: expect.any(String),
      expectedAppliedAt: "2026-08-15T00:00:00.000Z"
    });
    expect(mocks.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30_000, maxWait: 10_000 });
    expect(mocks.prisma.bookEditOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "op-1", status: "APPLIED" } })
    );
  });

  it("does not let a stale delivery roll back after another owner takes over", async () => {
    mocks.generatePageDraft.mockRejectedValue(new Error("old delivery resumed"));
    mocks.compensateStructuralPageChangeTx.mockResolvedValue({ outcome: "lost" });

    await expect(restructurePages(insertJob(), { id: "op-1", status: "ACTIVE", classifier: {} })).resolves.toEqual({});

    expect(mocks.revertStructuralPageChange).not.toHaveBeenCalled();
    expect(mocks.compensateStructuralPageChangeTx).toHaveBeenCalledOnce();
    expect(mocks.waitForStructuralPageLeaseCompletion).toHaveBeenCalledWith("op-1");
  });

  it("settles rather than requeueing when nothing is left to resume", async () => {
    mocks.generatePageDraft.mockRejectedValue(new Error("old delivery resumed"));
    mocks.compensateStructuralPageChangeTx.mockResolvedValue({ outcome: "lost" });
    // Nothing settles it and no stamp is left to resume, so a requeue would only
    // reproduce this verdict forever with the charge never handed back.
    mocks.waitForStructuralPageLeaseCompletion.mockResolvedValue("abandoned");

    await expect(restructurePages(insertJob({ generationJobId: "gj-1" }), {
      id: "op-1", status: "ACTIVE", classifier: {}
    })).rejects.toThrow("old delivery resumed");
    expect(mocks.redeliverWorkerGenerationJob).not.toHaveBeenCalled();
  });
  it("hands the exact stamp and lease to the shared durable compensation", async () => {
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run(mocks.prisma)
    );
    mocks.prisma.bookEditOperation.findUnique
      .mockResolvedValueOnce({ id: "op-1", status: "ACTIVE", classifier: { structuralEdit: { action: "insert" } } })
      .mockResolvedValue({
        id: "op-1",
        status: "ACTIVE",
        classifier: { structuralEdit: { action: "insert" }, structuralApplication: application() }
      });
    mocks.generatePageDraft.mockRejectedValue(new Error("model outage"));

    await expect(restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} })).rejects.toThrow(
      "model outage"
    );

    expect(mocks.compensateStructuralPageChangeTx).toHaveBeenCalledWith(mocks.prisma, {
      projectId: "project-1",
      operationId: "op-1",
      expectedLeaseToken: expect.any(String),
      expectedAppliedAt: "2026-08-15T00:00:00.000Z"
    });
  });

  it("keeps the stamp when the revert itself fails, because nothing was put back", async () => {
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run(mocks.prisma)
    );
    mocks.compensateStructuralPageChangeTx.mockRejectedValueOnce(new Error("deadlock"));
    mocks.generatePageDraft.mockRejectedValue(new Error("model outage"));

    await expect(
      restructurePages(insertJob({ generationJobId: "gj-1" }), { id: "op-1", status: "QUEUED", classifier: {} })
    ).rejects.toThrow(/requeued to resume/);

    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    expect(mocks.releaseStructuralPageLease).toHaveBeenCalledWith("op-1", expect.any(String));
    expect(mocks.redeliverWorkerGenerationJob).toHaveBeenCalledWith("gj-1");
  });

  it("keeps a delivered edit when the recompile cannot be queued", async () => {
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run(mocks.prisma)
    );
    mocks.maybeEnqueueCompile.mockRejectedValue(new Error("Redis is down"));

    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.compensateStructuralPageChangeTx).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "APPLIED" }) })
    );
    expect(mocks.restoreEditProjectStatus).toHaveBeenCalledWith(
      mocks.prisma, "project-1", "op-1", "COMPLETE"
    );
  });

  it("does not fail a finished book when a redelivery cannot queue the recompile", async () => {
    mocks.maybeEnqueueCompile.mockRejectedValue(new Error("Redis is down"));

    await restructurePages(insertJob(), { id: "op-1", status: "APPLIED", classifier: {} });

    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.prisma.project.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contentRevision: { increment: 1 } }) })
    );
    expect(mocks.restoreEditProjectStatus).toHaveBeenCalledWith(
      mocks.prisma, "project-1", "op-1", "COMPLETE"
    );
  });

  it("rolls back a partly surviving insert instead of settling a partial page set", async () => {
    // A five-page insert whose first delivery died mid-drafting, and whose
    // interrupted attempt left only two of the five rows in the book. The
    // recorded set is indivisible: a subset is not a live stamp, and reviewing
    // or settling only the survivors would claim adherence for an edit that
    // was never fully applied.
    const partial = application({ insertedPageIds: ["new-1", "new-2", "new-3", "new-4", "new-5"] });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1",
      status: "ACTIVE",
      classifier: { structuralApplication: partial }
    });
    mocks.applyStructuralPageChange.mockResolvedValue({
      outcome: "resumed",
      phase: "draft",
      application: partial
    });
    mocks.prisma.page.count.mockResolvedValue(2);
    mocks.prisma.page.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "new-1" || where.id === "new-2"
        ? { id: where.id, index: where.id === "new-1" ? 4 : 5, chapterId: null, chapter: null }
        : null
    );
    mocks.prisma.page.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.id === undefined ? pages(6) : [{ index: 4 }, { index: 5 }]
    );
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      restructurePages(insertJob(), { id: "op-1", status: "ACTIVE", classifier: {} })
    ).rejects.toThrow("Structural insert is missing 3 of 5 recorded pages");

    // The unlocked classifier refuses the subset; the locked look answers
    // `resumed` (stamp still on the row) rather than shifting twice.
    expect(mocks.waitForStructuralPageLease).not.toHaveBeenCalled();
    expect(mocks.applyStructuralPageChange).toHaveBeenCalledTimes(1);
    expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
    expect(mocks.reviewAppliedBookEdit).not.toHaveBeenCalled();
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
    expect(mocks.refundUnwrittenEditPages).not.toHaveBeenCalled();
    expect(mocks.markStructuralPageLeaseApplied).not.toHaveBeenCalled();
    expect(mocks.compensateStructuralPageChangeTx).toHaveBeenCalledWith(mocks.prisma, {
      projectId: "project-1",
      operationId: "op-1",
      expectedLeaseToken: expect.any(String),
      expectedAppliedAt: partial.appliedAt
    });
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "APPLIED" }) })
    );
    // The run log is the debugging artifact: three ids the book no longer holds
    // may not be skipped in silence, and a subset is not logged as a live stamp.
    expect(
      logged.mock.calls.filter((call) => String(call[0]).includes("no longer holds")).length
    ).toBe(3);
    expect(logged.mock.calls.some((call) => String(call[0]).includes("survives only in part"))).toBe(false);
    logged.mockRestore();
  });

  it("does not refund a second time when that settlement is redelivered", async () => {
    // The redelivery of an APPLIED insert takes the idempotent tail and nothing
    // else — no drafting, and so no second look at what the pages cost. The
    // ledger holds the same guarantee underneath (`reversesEntryId` is claimed
    // once), but the handler must not be relying on it.
    const partial = application({ insertedPageIds: ["new-1", "new-2", "new-3", "new-4", "new-5"] });

    await restructurePages(insertJob(), {
      id: "op-1",
      status: "APPLIED",
      classifier: { structuralApplication: partial }
    });

    expect(mocks.refundUnwrittenEditPages).not.toHaveBeenCalled();
    expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", undefined, {
      contentRevision: 7,
      requireContentRevisionMatch: true
    });
  });

  it("never settles an insert as a partial delivery", async () => {
    // No shortfall to price: the recorded set is indivisible (see above), so an
    // insert delivers every page it billed or none, and the one that cannot is
    // refunded *whole* by `markFailed` rather than by the difference.
    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(2);
    expect(mocks.refundUnwrittenEditPages).not.toHaveBeenCalled();
  });

  it("asks again under the lock when a stamp outlived the pages it recorded", async () => {
    // Belt to the transaction's braces: a stamp whose inserted pages are gone
    // is not resumed on its own word. It goes back through the shift's own
    // transaction, where the lease CAS decides under the operation row's lock.
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1",
      status: "ACTIVE",
      classifier: { structuralApplication: application() }
    });
    mocks.prisma.page.count.mockResolvedValue(0);

    await restructurePages(insertJob(), { id: "op-1", status: "ACTIVE", classifier: {} });

    expect(mocks.applyStructuralPageChange).toHaveBeenCalledTimes(1);
    expect(mocks.reviewAndSaveGeneratedPage).toHaveBeenCalledTimes(2);
  });
});

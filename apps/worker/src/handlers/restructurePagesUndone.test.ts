import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

/**
 * The redelivery that arrives after the reader has already undone the edit.
 *
 * Its own file because `restructurePages.test.ts` is at the size budget, and
 * this is a seam of its own: every case here is about the one marker
 * `undoLastBookEdit` leaves behind, and none of them reaches the shift, the
 * drafting loop or the rollback the sibling file exercises.
 */

const mocks = vi.hoisted(() => ({
  prisma: {
    bookEditOperation: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    project: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    planVersion: { findUnique: vi.fn() },
    page: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
    $transaction: vi.fn()
  },
  applyStructuralPageChange: vi.fn(),
  waitForStructuralPageLease: vi.fn(),
  waitForStructuralPageLeaseCompletion: vi.fn(),
  completeStructuralPageLease: vi.fn(),
  markStructuralPageLeaseApplied: vi.fn(),
  renewStructuralPageLeaseTx: vi.fn(),
  claimAppliedEditPublication: vi.fn(),
  reviewAndSaveGeneratedPage: vi.fn(),
  invalidateProjectExports: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  revertStructuralPageChange: vi.fn(),
  refundSkippedEditOperation: vi.fn(),
  refundUnwrittenEditPages: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: { DbNull: Symbol("DbNull") },
  PAGE_RESTRUCTURE_TRANSACTION_OPTIONS: {},
  revertStructuralPageChange: mocks.revertStructuralPageChange
}));
vi.mock("../generation/pageRestructure.js", () => ({
  applyStructuralPageChange: mocks.applyStructuralPageChange
}));
vi.mock("../generation/structuralPageLease.js", () => ({
  waitForStructuralPageLease: mocks.waitForStructuralPageLease,
  waitForStructuralPageLeaseCompletion: mocks.waitForStructuralPageLeaseCompletion,
  startStructuralPageLeaseHeartbeat: () => ({ assertHeld: vi.fn(), stop: vi.fn() }),
  completeStructuralPageLease: mocks.completeStructuralPageLease,
  markStructuralPageLeaseApplied: mocks.markStructuralPageLeaseApplied,
  renewStructuralPageLeaseTx: mocks.renewStructuralPageLeaseTx,
  releaseStructuralPageLease: vi.fn(),
  StructuralPageLeaseLostError: class StructuralPageLeaseLostError extends Error {},
  isStructuralPageLeaseLostError: () => false
}));
vi.mock("../generation/editProjectStatus.js", () => ({
  claimAppliedEditPublication: mocks.claimAppliedEditPublication,
  restoreEditProjectStatus: vi.fn()
}));
vi.mock("../generation/pageReview.js", () => ({ reviewAndSaveGeneratedPage: mocks.reviewAndSaveGeneratedPage }));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: async () => ({ id: "project-1", currentPlanId: "plan-1", status: "EDITING", targetPages: 6 }),
  invalidateProjectExports: mocks.invalidateProjectExports,
  strategyForInput: () => ({ generatePageDraft: vi.fn() }),
  styleExcerptsForPage: async () => [],
  toPriorPageContext: (page: unknown) => page
}));
vi.mock("../generation/generationContext.js", () => ({
  loadContinuityNotes: async () => [],
  loadResearchNotesForGeneration: async () => []
}));
vi.mock("../generation/projectInput.js", () => ({ inputForPlanVersion: () => ({ targetPages: 6 }) }));
vi.mock("../generation/qualitySettings.js", () => ({ loadQualityContext: async () => ({ enabled: () => false }) }));
vi.mock("../generation/storyStateStore.js", () => ({
  rebuildProjectStoryState: vi.fn(),
  rebuildRolledBackProjectStoryState: vi.fn()
}));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ text: {} }) }));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../runtime/dispatch.js", () => ({
  maybeEnqueueCompile: mocks.maybeEnqueueCompile,
  redeliverWorkerGenerationJob: vi.fn()
}));
vi.mock("../runtime/jobLifecycle.js", () => ({
  advanceJobStep: vi.fn(),
  refundSkippedEditOperation: mocks.refundSkippedEditOperation,
  refundUnwrittenEditPages: mocks.refundUnwrittenEditPages
}));
vi.mock("../runtime/serialization.js", () => ({ errorMessage: (error: unknown) => String(error) }));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return { ...actual, bookPlanSchema: { parse: () => ({ chapters: [], promises: [] }) }, createProviders: () => ({}) };
});

import { restructurePages } from "./restructurePages.js";

const pages = Array.from({ length: 6 }, (_value, offset) => ({
  id: `page-${offset + 1}`,
  index: offset + 1,
  chapterId: null
}));

const application = {
  action: "insert",
  pageOrderBefore: pages.map((page) => ({ pageId: page.id, index: page.index, chapterId: page.chapterId })),
  insertedPageIds: ["page-new-1", "page-new-2"],
  removedPages: [],
  basePlanVersionId: "plan-1",
  newPlanVersionId: "plan-2",
  previousTargetPages: 6,
  previousChapterTargetPages: {},
  appliedAt: "2026-08-15T00:00:00.000Z"
};

const insertJob = () =>
  ({
    data: {
      projectId: "project-1",
      operationId: "op-1",
      request: "Add 2 pages after page 3",
      planId: "plan-1",
      structuralEdit: { action: "insert", anchorPageIndex: 3, pageIndexes: [], pageCount: 2 }
    },
    id: "job-1"
  }) as unknown as Job;

/** What the reader's Undo leaves on the row: the stamp kept, plus `undoneAt`. */
const undoneClassifier = { structuralApplication: application, undoneAt: "2026-08-18T00:00:00.000Z" };

const changedNothing = () => {
  expect(mocks.applyStructuralPageChange).not.toHaveBeenCalled();
  expect(mocks.reviewAndSaveGeneratedPage).not.toHaveBeenCalled();
  expect(mocks.revertStructuralPageChange).not.toHaveBeenCalled();
  expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
  expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  // No refund and no pre-edit status restore: Undo is allowed as soon as the
  // row is APPLIED, while the attempt is still ACTIVE, so a skip-settle here
  // would hand the credits back and overwrite the Undo's EDITING +
  // contentRevision bump. `bookPageMapForProject` then refuses the behind map.
  expect(mocks.prisma.project.update).not.toHaveBeenCalled();
  expect(mocks.refundSkippedEditOperation).not.toHaveBeenCalled();
  expect(mocks.refundUnwrittenEditPages).not.toHaveBeenCalled();
  // And nothing is written to the row, which is what keeps `undoneAt` in place:
  // `canUndoBookEdit` reads exactly that field, so a classifier rewritten from
  // here would offer the reader a second Undo of an edit already back.
  expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
};

describe("restructurePages after an undo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(mocks.prisma));
    mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1", status: "ACTIVE", classifier: {}, publicationRevision: 7
    });
    mocks.prisma.project.findUnique.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
    mocks.prisma.project.update.mockResolvedValue({ id: "project-1" });
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", inputSnapshot: {}, planningPackage: {} });
    mocks.prisma.page.findMany.mockResolvedValue(pages);
    mocks.prisma.page.count.mockResolvedValue(0);
    mocks.waitForStructuralPageLease.mockResolvedValue({ outcome: "acquired", phase: "tail", application: null });
    mocks.completeStructuralPageLease.mockResolvedValue(true);
    mocks.claimAppliedEditPublication.mockResolvedValue(true);
    mocks.renewStructuralPageLeaseTx.mockResolvedValue({ status: "APPLIED", classifier: {} });
    mocks.maybeEnqueueCompile.mockResolvedValue("compile");
  });

  it("settles a redelivery of an undone edit as a no-op", async () => {
    // The first delivery died between the APPLIED write and the lease's
    // completion, so the row is still claimable; the reader tapped Undo, which
    // replays the revert and stamps `undoneAt` while deliberately keeping
    // `structuralApplication`; then BullMQ redelivered. The stamp still reads
    // "the shift landed", and the tail it would open deletes the PDF the undo's
    // own recompile just published and bumps `contentRevision` past the
    // revision that compile is waiting to claim.
    await restructurePages(insertJob(), { id: "op-1", status: "APPLIED", classifier: undoneClassifier });

    expect(mocks.waitForStructuralPageLease).not.toHaveBeenCalled();
    changedNothing();
  });

  it("settles when the undo lands after the delivery's first read of the row", async () => {
    // The narrow half: another delivery marked the row APPLIED and the reader
    // undid it between `applyBookEdit`'s read and the claim here. The claim
    // skips APPLIED — the only status an undo runs against — so the row is
    // untouched, and the re-read is the first thing that can see the undo.
    mocks.prisma.bookEditOperation.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      id: "op-1",
      status: "APPLIED",
      classifier: undoneClassifier
    });

    await restructurePages(insertJob(), { id: "op-1", status: "ACTIVE", classifier: {} });

    expect(mocks.waitForStructuralPageLease).not.toHaveBeenCalled();
    changedNothing();
  });

  it("keeps an undo that lands while the delivery is on its way to settling", async () => {
    // The window `settleRefusedRestructure` used to skip-settle. The row is
    // read once near the top, then the plan-version reads, the provider
    // construction and the resolver all run after it — so the reader can tap
    // Undo on the APPLIED row, have the revert commit `undoneAt`, and still be
    // behind a delivery that flipped the row ACTIVE and is now settling a
    // refusal because the undo put the pages back. Skip-settling refunds an
    // attempt that is still ACTIVE (Undo is allowed as soon as the row is
    // APPLIED, before the winner returns and `markCompleted` succeeds it) and
    // overwrites the Undo's EDITING + contentRevision bump with the pre-edit
    // COMPLETE. `bookPageMapForProject` then refuses the behind map, and chat
    // falls back to model indexes while the reader still has the old PDF.
    // The early undoneAt branches write nothing, including no refund; this is
    // the same stand-down.
    mocks.prisma.bookEditOperation.findUnique
      .mockResolvedValueOnce({ id: "op-1", status: "ACTIVE", classifier: { structuralApplication: application } })
      .mockResolvedValue({ id: "op-1", status: "APPLIED", classifier: undoneClassifier });
    // The undo deleted the pages the stamp recorded, so it no longer describes
    // the book and the delivery re-resolves against what is left — which is
    // nothing the insert can anchor to.
    mocks.prisma.page.findMany.mockResolvedValue([]);

    await restructurePages(insertJob(), { id: "op-1", status: "QUEUED", classifier: {} });

    // Reached the refusal claim, then stood down: not the early `undoneAt`
    // return, and not a skip-settle either.
    expect(mocks.waitForStructuralPageLease).toHaveBeenCalled();
    changedNothing();
  });

  it("still finishes the tail of a delivered edit nobody has undone", async () => {
    // The contrast the marker draws, and the reason this branch keys on
    // `undoneAt` rather than on the stamp: an APPLIED row whose edit is still
    // in the book owes the recompile its first delivery may have died before
    // queueing.
    await restructurePages(insertJob(), {
      id: "op-1",
      status: "APPLIED",
      classifier: { structuralApplication: application }
    });

    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1", undefined, {
      contentRevision: 7,
      requireContentRevisionMatch: true
    });
  });
});

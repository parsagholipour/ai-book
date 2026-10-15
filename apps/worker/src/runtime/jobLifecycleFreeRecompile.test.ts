import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A free edit's recompile — a manual Edit Mode save, Undo, Redo, a Writing
 * Studio publish or takeover — on a book that was delivered and paid for
 * before the edit. It used to own the book's outcome: one failed render marked
 * a downloaded, paid book FAILED, and `refundFailedProjectCredits` followed its
 * `planId` to the book's own generation charge (launch review 2026-10-13, B3).
 * It now fails and stops alone, back to the settled status it carries.
 */

const mocks = vi.hoisted(() => ({
  generationJobFindUnique: vi.fn(),
  generationJobFindMany: vi.fn(),
  generationJobUpdate: vi.fn(),
  generationJobUpdateMany: vi.fn(),
  projectUpdate: vi.fn(),
  projectUpdateMany: vi.fn(),
  failGenerationAttempt: vi.fn(),
  refundCreditLedgerEntry: vi.fn(),
  refundLatestProjectOperationCredits: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  Prisma: {},
  planRevisionRetryDelayMs: () => 1_000,
  prisma: {
    generationJob: {
      findUnique: mocks.generationJobFindUnique,
      findMany: mocks.generationJobFindMany,
      update: mocks.generationJobUpdate,
      updateMany: mocks.generationJobUpdateMany
    },
    project: { update: mocks.projectUpdate, updateMany: mocks.projectUpdateMany }
  }
}));

vi.mock("@book-maker/db/billing", () => ({
  failGenerationAttempt: mocks.failGenerationAttempt,
  markGenerationAttemptActive: vi.fn(),
  markGenerationAttemptSucceeded: vi.fn(),
  refundCreditLedgerEntry: mocks.refundCreditLedgerEntry,
  refundCreditLedgerEntryPortion: vi.fn(),
  refundLatestProjectOperationCredits: mocks.refundLatestProjectOperationCredits
}));

import { compilePolicyPayload, editRecompilePolicy, freeEditRecompilePolicy } from "@book-maker/core";
import { markFailed, markStopped } from "./jobLifecycle.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generationJobFindUnique.mockResolvedValue({ steps: [] });
  mocks.generationJobUpdate.mockResolvedValue({});
  mocks.generationJobUpdateMany.mockResolvedValue({ count: 1 });
  mocks.projectUpdate.mockResolvedValue({});
  mocks.projectUpdateMany.mockResolvedValue({ count: 1 });
  // The book's own run, which the old walk followed the compile's planId to.
  mocks.generationJobFindMany.mockResolvedValue([
    { payload: { planId: "plan-1", billingLedgerEntryId: "entry-book" } }
  ]);
});

describe("a free edit's recompile", () => {
  it.each(["COMPLETE", "REVIEW_REQUIRED"] as const)(
    "puts the book back to %s and refunds nothing when it fails",
    async (fallback) => {
      await markFailed(job(fallback), new Error("render failed"));

      expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
        where: { id: "project-1", status: "EDITING", contentRevision: 9 },
        data: { status: fallback }
      });
      expect(mocks.projectUpdate).not.toHaveBeenCalled();
      expect(mocks.failGenerationAttempt).not.toHaveBeenCalled();
      expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
      expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
    }
  );

  it.each(["COMPLETE", "REVIEW_REQUIRED"] as const)(
    "puts the book back to %s and refunds nothing when it is stopped",
    async (fallback) => {
      await markStopped(job(fallback));

      expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
        where: { id: "project-1", status: "EDITING", contentRevision: 9 },
        data: { status: fallback }
      });
      expect(mocks.projectUpdate).not.toHaveBeenCalled();
      expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
      expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
    }
  );

  it("leaves the generation's own failed compile owning the book, as before", async () => {
    await markFailed(
      { ...(job("COMPLETE") as Record<string, unknown>), data: { projectId: "project-1", generationJobId: "job-compile", planId: "plan-1" } } as never,
      new Error("compile failed")
    );

    expect(mocks.projectUpdate).toHaveBeenCalledWith({ where: { id: "project-1" }, data: { status: "FAILED" } });
    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("entry-book", "compile failed");
  });
});

/**
 * A paid chat edit's recompile — a page rewrite, an added picture, a page
 * insert, a continuation — queued after the edit published its pages and its
 * attempt went SUCCEEDED in that same transaction. It carries the edit's
 * attempt, and it used to own the book's outcome: one failed render marked a
 * delivered, readable book FAILED ("needs attention") although the edit's
 * charge had settled correctly. It is an edit's recompile now
 * (`editRecompilePolicy`), so it fails alone back to the pre-edit status.
 */
describe("a paid edit's recompile", () => {
  it.each([
    ["a page rewrite", { skipFinalReview: true, withoutQualityVerdict: false }],
    ["an added picture", { skipFinalReview: true, withoutQualityVerdict: true }],
    ["a page insert or a continuation", { skipFinalReview: false, withoutQualityVerdict: false }]
  ] as const)("after %s puts the book back to its pre-edit status, settles nothing, and leaves the book charge alone", async (_kind, review) => {
    for (const fallback of ["COMPLETE", "REVIEW_REQUIRED"] as const) {
      vi.clearAllMocks();
      mocks.generationJobUpdateMany.mockResolvedValue({ count: 1 });
      mocks.projectUpdateMany.mockResolvedValue({ count: 1 });
      await markFailed(paidEditJob(fallback, review), new Error("render timed out"));

      expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
        where: { id: "project-1", status: "EDITING", contentRevision: 9 },
        data: { status: fallback }
      });
      expect(mocks.projectUpdate).not.toHaveBeenCalled();
      // The edit's charge settled when its pages published; the render owns none of it.
      expect(mocks.failGenerationAttempt).not.toHaveBeenCalled();
      expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
      expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
      // Nothing else of the edit's attempt is stopped on the render's account.
      expect(mocks.generationJobUpdateMany).toHaveBeenCalledTimes(1);
    }
  });

  it("is restored the same way when the reader stops it", async () => {
    await markStopped(paidEditJob("REVIEW_REQUIRED", { skipFinalReview: true, withoutQualityVerdict: false }));

    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING", contentRevision: 9 },
      data: { status: "REVIEW_REQUIRED" }
    });
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
    expect(mocks.failGenerationAttempt).not.toHaveBeenCalled();
  });

  it("leaves a paid generation's own failed compile failing the book through its attempt", async () => {
    mocks.failGenerationAttempt.mockResolvedValue(undefined);
    await markFailed(
      {
        name: "compile-export",
        data: {
          projectId: "project-1",
          generationJobId: "job-compile",
          planId: "plan-1",
          attemptId: "attempt-book",
          contentRevision: 3,
          exportPublicationProjectStatus: "GENERATING"
        },
        attemptsMade: 0,
        opts: { attempts: 1 }
      } as never,
      new Error("compile failed")
    );

    expect(mocks.failGenerationAttempt).toHaveBeenCalledWith("attempt-book", "compile failed");
    expect(mocks.projectUpdate).toHaveBeenCalledWith({ where: { id: "project-1" }, data: { status: "FAILED" } });
    // The attempt's own settlement refunds its charge; no walk reaches past it.
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
  });
});

function paidEditJob(
  fallback: "COMPLETE" | "REVIEW_REQUIRED",
  review: { skipFinalReview: boolean; withoutQualityVerdict: boolean }
) {
  return {
    name: "compile-export",
    data: {
      projectId: "project-1",
      generationJobId: "job-edit-compile",
      planId: "plan-1",
      // The paid edit's attempt rides the recompile the edit queued.
      attemptId: "attempt-edit",
      contentRevision: 9,
      ...compilePolicyPayload(editRecompilePolicy(fallback, review), "EDITING")
    },
    attemptsMade: 0,
    opts: { attempts: 1 }
  } as never;
}

function job(fallback: "COMPLETE" | "REVIEW_REQUIRED") {
  return {
    name: "compile-export",
    data: {
      projectId: "project-1",
      generationJobId: "job-compile",
      planId: "plan-1",
      contentRevision: 9,
      ...compilePolicyPayload(freeEditRecompilePolicy(fallback), "EDITING")
    },
    attemptsMade: 0,
    opts: { attempts: 3 }
  } as never;
}

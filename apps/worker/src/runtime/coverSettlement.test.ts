import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A revision-owned cover's exits through the shared lifecycle — a Writing
 * Studio publish's designed cover, an AI cover the author bought, a replan's
 * cover — against the generation-time cover whose failure still owns the book.
 * The compile release those failures need is `maybeCompileAfterFailedJob`
 * (dispatch), pinned in `dispatchStudioPublish.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  generationJobFindUnique: vi.fn(),
  generationJobFindMany: vi.fn(),
  generationJobUpdate: vi.fn(),
  generationJobUpdateMany: vi.fn(),
  projectUpdate: vi.fn(),
  projectUpdateMany: vi.fn(),
  failGenerationAttempt: vi.fn(),
  markGenerationAttemptActive: vi.fn(),
  markGenerationAttemptSucceeded: vi.fn(),
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
    project: { update: mocks.projectUpdate, updateMany: mocks.projectUpdateMany },
    bookEditOperation: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() }
  }
}));
vi.mock("@book-maker/db/billing", () => ({
  failGenerationAttempt: mocks.failGenerationAttempt,
  markGenerationAttemptActive: mocks.markGenerationAttemptActive,
  markGenerationAttemptSucceeded: mocks.markGenerationAttemptSucceeded,
  refundCreditLedgerEntry: mocks.refundCreditLedgerEntry,
  refundCreditLedgerEntryPortion: vi.fn(),
  refundLatestProjectOperationCredits: mocks.refundLatestProjectOperationCredits,
  releaseManuscriptImportUse: vi.fn()
}));

import { COVER_PURCHASE, EXPORT_PUBLICATION_PROJECT_STATUS, PRESENTATION_ONLY_RECOMPILE } from "@book-maker/core";
import { markCompleted, markFailed, markStopped } from "./jobLifecycle.js";

function job(name: string, data: Record<string, unknown>) {
  return {
    id: "bull-1",
    name,
    data: { projectId: "project-1", planId: "plan-1", generationJobId: "gj-cover", ...data },
    attemptsMade: 0,
    opts: {}
  } as never;
}

const revisionCover = {
  assetType: "COVER",
  contentRevision: 4,
  [EXPORT_PUBLICATION_PROJECT_STATUS]: "EDITING"
};
const publishCover = () => job("generate-image", revisionCover);
const purchasedCover = () =>
  job("generate-image", {
    ...revisionCover,
    [COVER_PURCHASE]: true,
    billingLedgerEntryId: "ledger-cover",
    attemptId: "attempt-cover"
  });

/** Every status write the lifecycle made, to the job rows and to the project. */
const statusWrites = () => mocks.generationJobUpdateMany.mock.calls.map(([args]) => (args as { data: { status: string } }).data.status);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generationJobFindUnique.mockResolvedValue({ steps: [], status: "ACTIVE", qualityReport: null, message: null });
  mocks.generationJobFindMany.mockResolvedValue([]);
  mocks.generationJobUpdate.mockResolvedValue({});
  mocks.generationJobUpdateMany.mockResolvedValue({ count: 1 });
  mocks.projectUpdate.mockResolvedValue({});
  mocks.projectUpdateMany.mockResolvedValue({ count: 0 });
  mocks.failGenerationAttempt.mockResolvedValue(undefined);
  mocks.markGenerationAttemptSucceeded.mockResolvedValue(undefined);
  mocks.refundCreditLedgerEntry.mockResolvedValue({});
  mocks.refundLatestProjectOperationCredits.mockResolvedValue({});
});

describe("a revision-owned cover that fails outright", () => {
  it("fails its own row and leaves a published Studio book, and every charge on it, alone", async () => {
    await markFailed(publishCover(), new Error("Chromium could not render the cover"));

    expect(statusWrites()).toEqual(["FAILED"]);
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
    expect(mocks.projectUpdateMany).not.toHaveBeenCalled();
    // The book-run walk from `planId` is what used to refund a taken-over book's generation.
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.failGenerationAttempt).not.toHaveBeenCalled();
  });

  it("refunds a purchased AI cover through its own attempt without stopping the reprint beside it", async () => {
    await markFailed(purchasedCover(), new Error("image provider outage"));

    expect(mocks.failGenerationAttempt.mock.calls).toEqual([["attempt-cover", "image provider outage", "FAILED"]]);
    // Only the cover's own row: no sibling is marked stopped, so a reprint still
    // queued behind the cover survives to put the book back down.
    expect(statusWrites()).toEqual(["FAILED"]);
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
    expect(mocks.projectUpdateMany).not.toHaveBeenCalled();
  });

  it("leaves a replan's attempt to the compile that finishes the replan", async () => {
    await markFailed(job("generate-image", { ...revisionCover, attemptId: "attempt-replan" }), new Error("render failed"));

    expect(mocks.failGenerationAttempt).not.toHaveBeenCalled();
    expect(statusWrites()).toEqual(["FAILED"]);
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
  });

  it("settles nothing on a redelivery whose row already holds a verdict", async () => {
    mocks.generationJobUpdateMany.mockResolvedValue({ count: 0 });

    await markFailed(purchasedCover(), new Error("late failure"));

    expect(mocks.failGenerationAttempt).not.toHaveBeenCalled();
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
  });

  it("still fails the book a generation-time cover belongs to, exactly as before", async () => {
    await markFailed(job("generate-image", { assetType: "COVER", attemptId: "attempt-book" }), new Error("render failed"));

    expect(mocks.failGenerationAttempt).toHaveBeenCalledWith("attempt-book", "render failed");
    expect(statusWrites()).toEqual(["FAILED", "FAILED"]);
    expect(mocks.projectUpdate).toHaveBeenCalledWith({ where: { id: "project-1" }, data: { status: "FAILED" } });
  });
});

describe("a revision-owned cover that is stopped", () => {
  it("cancels and refunds a purchase and leaves the project to the API's stop", async () => {
    await markStopped(purchasedCover());

    expect(mocks.failGenerationAttempt).toHaveBeenCalledWith("attempt-cover", "Stopped by user", "CANCELED");
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
  });

  it("never walks an attempt-less publish cover to the book's charge", async () => {
    await markStopped(publishCover());

    expect(mocks.failGenerationAttempt).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
  });
});

describe("a purchased cover's attempt", () => {
  it("is committed by the cover job that stored the artwork, and by nothing else it shares a book with", async () => {
    await markCompleted(purchasedCover());
    await markCompleted(job("generate-image", { ...revisionCover, attemptId: "attempt-replan" }));
    await markCompleted(job("generate-image", { pageId: "page-1", prompt: "a harbour", attemptId: "attempt-book" }));

    expect(mocks.markGenerationAttemptSucceeded.mock.calls).toEqual([["attempt-cover"]]);
  });

  it("is settled exactly once when the reprint after a delivered cover fails", async () => {
    await markCompleted(purchasedCover());
    // A reprint row written before the compile stopped carrying the purchase.
    await markFailed(
      job("compile-export", {
        generationJobId: "gj-reprint",
        contentRevision: 4,
        attemptId: "attempt-cover",
        [PRESENTATION_ONLY_RECOMPILE]: true,
        presentationRecompileFallbackStatus: "COMPLETE"
      }),
      new Error("Chromium crashed")
    );

    expect(mocks.markGenerationAttemptSucceeded.mock.calls).toEqual([["attempt-cover"]]);
    expect(mocks.failGenerationAttempt).not.toHaveBeenCalled();
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    // The failed reprint puts the book back to the status it was born under.
    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING", contentRevision: 4 },
      data: { status: "COMPLETE" }
    });
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
  });
});

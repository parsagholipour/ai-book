import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Stopping — or deleting, which stops first — a book while a free edit's
 * recompile is open: a manual Edit Mode save, Undo, Redo, a Writing Studio
 * publish or takeover. Generate, download the PDF, make a one-word edit, delete:
 * every credit came back, because the attempt-less recompile owned the book's
 * outcome and `settleLegacyStoppedJobs` followed its `planId` to the delivered
 * book's `FULL_BOOK_GENERATION` charge (launch review 2026-10-13, B3). It now
 * settles nothing and puts the book back to the status it carries.
 */

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  transaction: vi.fn(),
  projectUpdate: vi.fn(),
  projectUpdateMany: vi.fn(),
  bookEditOperationFindMany: vi.fn(),
  bookEditOperationUpdateMany: vi.fn(),
  generationJobFindManyOutside: vi.fn(),
  refundCreditLedgerEntry: vi.fn(),
  refundLatestProjectOperationCredits: vi.fn(),
  failGenerationAttempt: vi.fn(),
  generationAttemptUpdateMany: vi.fn(),
  queryRawUnsafe: vi.fn()
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add = vi.fn();
    getJob = vi.fn();
    close = vi.fn();
  }
}));
vi.mock("ioredis", () => ({
  Redis: class {
    quit = vi.fn();
  }
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return { ...actual, loadConfig: () => ({ REDIS_URL: "redis://test" }) };
});
vi.mock("@book-maker/db", () => ({
  Prisma: { JsonNull: null },
  PAGE_RESTRUCTURE_TRANSACTION_OPTIONS: { timeout: 30_000, maxWait: 10_000 },
  prisma: {
    $transaction: mocks.transaction,
    generationJob: { findMany: mocks.generationJobFindManyOutside, updateMany: mocks.updateMany },
    project: { update: mocks.projectUpdate, updateMany: mocks.projectUpdateMany },
    audiobook: { updateMany: vi.fn() },
    bookEditOperation: {
      findUnique: vi.fn(),
      findMany: mocks.bookEditOperationFindMany,
      updateMany: mocks.bookEditOperationUpdateMany
    }
  }
}));
vi.mock("@book-maker/db/billing", () => ({
  recordUserStopSettlementTx: vi.fn(),
  refundCreditLedgerEntry: mocks.refundCreditLedgerEntry,
  refundLatestProjectOperationCredits: mocks.refundLatestProjectOperationCredits,
  failGenerationAttempt: mocks.failGenerationAttempt,
  GenerationAttemptJobClaimError: class GenerationAttemptJobClaimError extends Error {}
}));

import { compilePolicyPayload, editRecompilePolicy, freeEditRecompilePolicy } from "@book-maker/core";
import { stopProjectGenerationJobs } from "./queue.js";

describe("stopping a free edit's recompile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectUpdate.mockResolvedValue({ status: "EDITING", contentRevision: 9 });
    mocks.projectUpdateMany.mockResolvedValue({ count: 1 });
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        project: { update: mocks.projectUpdate, updateMany: mocks.projectUpdateMany },
        generationJob: { findMany: mocks.findMany, updateMany: mocks.updateMany },
        bookEditOperation: { findMany: mocks.bookEditOperationFindMany, updateMany: mocks.bookEditOperationUpdateMany },
        generationAttempt: { updateMany: mocks.generationAttemptUpdateMany },
        $queryRawUnsafe: mocks.queryRawUnsafe
      })
    );
    mocks.generationAttemptUpdateMany.mockResolvedValue({ count: 1 });
    mocks.bookEditOperationFindMany.mockResolvedValue([]);
    mocks.bookEditOperationUpdateMany.mockResolvedValue({ count: 0 });
    mocks.queryRawUnsafe.mockResolvedValue([]);
    mocks.refundCreditLedgerEntry.mockResolvedValue({});
    mocks.refundLatestProjectOperationCredits.mockResolvedValue({});
    mocks.failGenerationAttempt.mockResolvedValue(undefined);
    // The delivered book's own run, which the legacy walk followed the planId to.
    mocks.generationJobFindManyOutside.mockResolvedValue([
      { payload: { planId: "plan-1", billingLedgerEntryId: "entry-book" } }
    ]);
  });

  it.each(["COMPLETE", "REVIEW_REQUIRED"] as const)(
    "refunds nothing and puts the book back to %s",
    async (fallback) => {
      mocks.findMany.mockResolvedValue([
        compileRow({ ...compilePolicyPayload(freeEditRecompilePolicy(fallback), "EDITING") })
      ]);

      await stopProjectGenerationJobs("project-1");

      expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
      expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
      expect(mocks.failGenerationAttempt).not.toHaveBeenCalled();
      expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
        where: { id: "project-1", status: "EDITING" },
        data: { status: fallback }
      });
      expect(mocks.projectUpdateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: "FAILED" } })
      );
      // The row itself is still stopped; only the settlement is skipped.
      expect(mocks.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "job-compile", status: { in: ["QUEUED", "ACTIVE"] } } })
      );
    }
  );

  it("treats a paid edit's recompile the same way: its attempt was settled when the edit published", async () => {
    mocks.findMany.mockResolvedValue([
      {
        ...compileRow({
          ...compilePolicyPayload(
            editRecompilePolicy("REVIEW_REQUIRED", { skipFinalReview: false, withoutQualityVerdict: false }),
            "EDITING"
          )
        }),
        attemptId: "attempt-edit"
      }
    ]);

    await stopProjectGenerationJobs("project-1");

    // The edit's SUCCEEDED attempt is not this render's to settle, and no walk reaches the book's charge.
    expect(mocks.generationAttemptUpdateMany).not.toHaveBeenCalled();
    expect(mocks.failGenerationAttempt).not.toHaveBeenCalled();
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "REVIEW_REQUIRED" }
    });
    expect(mocks.projectUpdateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: { status: "FAILED" } }));
  });

  it("still settles a legacy generation compile against the run's charge, as before", async () => {
    // The other half: an attempt-less compile of a run that never finished owns
    // that run. Should its charge's attempt have SUCCEEDED, the ledger itself
    // refuses the reversal (`billingLedger.ts`).
    mocks.projectUpdate.mockResolvedValue({ status: "GENERATING", contentRevision: 1 });
    mocks.findMany.mockResolvedValue([compileRow({})]);

    await stopProjectGenerationJobs("project-1");

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("entry-book", "Stopped by user");
    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: { notIn: ["COMPLETE", "REVIEW_REQUIRED"] } },
      data: { status: "FAILED" }
    });
  });
});

function compileRow(policyPayload: Record<string, unknown>) {
  return {
    id: "job-compile",
    bullJobId: null,
    status: "QUEUED",
    type: "COMPILE_EXPORT",
    attemptId: null,
    payload: { planId: "plan-1", contentRevision: 9, ...policyPayload }
  };
}

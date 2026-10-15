import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Stopping a book whose revision-owned cover is in flight — a Writing Studio
 * publish's designed cover, or the AI cover an author bought. The cover owns no
 * book (`isRevisionOwnedCoverPayload`), so its row is never a legacy book-run
 * row whose `planId` walks to the book's own generation charge; but a purchase
 * carries its own attempt, and a stop (the delete routes stop first) still
 * settles and refunds it, as the worker's `markStopped` does.
 */

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  transaction: vi.fn(),
  projectUpdate: vi.fn(),
  projectUpdateMany: vi.fn(),
  bookEditOperationFindMany: vi.fn(),
  bookEditOperationUpdateMany: vi.fn(),
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
    generationJob: { findMany: mocks.findMany, updateMany: mocks.updateMany },
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

import { COVER_PURCHASE, EXPORT_PUBLICATION_PROJECT_STATUS, PRESENTATION_ONLY_RECOMPILE } from "@book-maker/core";
import { stopProjectGenerationJobs } from "./queue.js";

const revisionCover = (extra: Record<string, unknown> = {}) => ({
  planId: "plan-1",
  assetType: "COVER",
  contentRevision: 4,
  [EXPORT_PUBLICATION_PROJECT_STATUS]: "EDITING",
  ...extra
});

describe("stopping a revision-owned cover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectUpdate.mockResolvedValue({ status: "EDITING" });
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
    mocks.failGenerationAttempt.mockResolvedValue(undefined);
  });

  it("refunds a purchased cover through its own attempt and puts the book back down, never touching the book's charge", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "job-reprint",
        bullJobId: null,
        status: "QUEUED",
        type: "COMPILE_EXPORT",
        attemptId: null,
        payload: {
          planId: "plan-1",
          contentRevision: 4,
          [PRESENTATION_ONLY_RECOMPILE]: true,
          presentationRecompileFallbackStatus: "COMPLETE"
        }
      },
      {
        id: "job-cover",
        bullJobId: null,
        status: "ACTIVE",
        type: "GENERATE_IMAGE",
        attemptId: "attempt-cover",
        payload: revisionCover({ [COVER_PURCHASE]: true, billingLedgerEntryId: "ledger-cover" })
      }
    ]);

    await stopProjectGenerationJobs("project-1");

    expect(mocks.failGenerationAttempt.mock.calls).toEqual([["attempt-cover", "Stopped by user", "CANCELED"]]);
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
    // The cover owns no book, so the stopped reprint's restore decides the status.
    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "COMPLETE" }
    });
  });

  it("never walks an attempt-less publish cover to the book's own generation charge", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "job-cover", bullJobId: null, status: "QUEUED", type: "GENERATE_IMAGE", attemptId: null, payload: revisionCover() }
    ]);

    await stopProjectGenerationJobs("project-1");

    expect(mocks.failGenerationAttempt).not.toHaveBeenCalled();
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
    // The row is still stopped; only the settlement is skipped.
    expect(mocks.updateMany).toHaveBeenCalled();
  });
});

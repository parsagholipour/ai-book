import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  projectUpdate: vi.fn(),
  projectUpdateMany: vi.fn(),
  generationJobFindMany: vi.fn(),
  generationJobUpdateMany: vi.fn(),
  operationFindMany: vi.fn(),
  operationUpdateMany: vi.fn(),
  generationAttemptUpdateMany: vi.fn(),
  failGenerationAttempt: vi.fn(),
  refundCreditLedgerEntry: vi.fn(),
  refundLatestProjectOperationCredits: vi.fn()
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add = vi.fn();
    getJob = vi.fn();
    close = vi.fn();
  }
}));
vi.mock("ioredis", () => ({ Redis: class { disconnect = vi.fn(); } }));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return { ...actual, loadConfig: () => ({ REDIS_URL: "redis://test" }) };
});
vi.mock("@book-maker/db", () => ({
  Prisma: { JsonNull: null, PrismaClientKnownRequestError: class extends Error {} },
  PAGE_RESTRUCTURE_TRANSACTION_OPTIONS: { timeout: 30_000, maxWait: 10_000 },
  prisma: {
    $transaction: mocks.transaction,
    generationJob: { findMany: mocks.generationJobFindMany },
    bookEditOperation: { findUnique: vi.fn() },
    audiobook: { updateMany: vi.fn() }
  }
}));
vi.mock("@book-maker/db/billing", () => ({
  failGenerationAttempt: mocks.failGenerationAttempt,
  refundCreditLedgerEntry: mocks.refundCreditLedgerEntry,
  refundLatestProjectOperationCredits: mocks.refundLatestProjectOperationCredits
}));

import { stopProjectGenerationJobs } from "./queue.js";

const paidRun = {
  id: "job-book",
  bullJobId: null,
  status: "ACTIVE",
  type: "GENERATE_BOOK",
  payload: { planId: "plan-1" },
  attemptId: "attempt-book"
};

/**
 * Where a stopped run's charge is settled, and why it is two writes.
 *
 * The stop's own transaction is Read Committed and touches the whole book, so
 * it may not carry the ledger: `refundCreditLedgerEntryTx` reads the entry and
 * the account without `FOR UPDATE` and applies its increments from that
 * snapshot, and the reversal row it writes is unique on `reversesEntryId`. What
 * commits with the stop is the *obligation* — a terminal attempt with
 * `refundPending` — and `failGenerationAttempt` settles it serializably after.
 */
describe("settling a stopped run's paid attempt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectUpdate.mockResolvedValue({ status: "GENERATING" });
    mocks.projectUpdateMany.mockResolvedValue({ count: 1 });
    mocks.generationJobFindMany.mockResolvedValue([paidRun]);
    mocks.generationJobUpdateMany.mockResolvedValue({ count: 1 });
    mocks.operationFindMany.mockResolvedValue([]);
    mocks.operationUpdateMany.mockResolvedValue({ count: 0 });
    mocks.generationAttemptUpdateMany.mockResolvedValue({ count: 1 });
    mocks.failGenerationAttempt.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        project: { update: mocks.projectUpdate, updateMany: mocks.projectUpdateMany },
        generationJob: { findMany: mocks.generationJobFindMany, updateMany: mocks.generationJobUpdateMany },
        bookEditOperation: { findMany: mocks.operationFindMany, updateMany: mocks.operationUpdateMany },
        generationAttempt: { updateMany: mocks.generationAttemptUpdateMany }
      })
    );
  });

  it("commits the refund obligation with the stop and settles the ledger after it", async () => {
    const order: string[] = [];
    mocks.generationAttemptUpdateMany.mockImplementation(async () => {
      order.push("obligation");
      return { count: 1 };
    });
    mocks.failGenerationAttempt.mockImplementation(async () => {
      order.push("settle");
    });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      const result = await callback({
        project: { update: mocks.projectUpdate, updateMany: mocks.projectUpdateMany },
        generationJob: { findMany: mocks.generationJobFindMany, updateMany: mocks.generationJobUpdateMany },
        bookEditOperation: { findMany: mocks.operationFindMany, updateMany: mocks.operationUpdateMany },
        generationAttempt: { updateMany: mocks.generationAttemptUpdateMany }
      });
      order.push("commit");
      return result;
    });

    await stopProjectGenerationJobs("project-1");

    expect(order).toEqual(["obligation", "commit", "settle"]);
    // Exactly the row `reconcileGenerationAttemptRefunds` sweeps, so a crash
    // between the two writes still ends in a refund.
    expect(mocks.generationAttemptUpdateMany).toHaveBeenCalledWith({
      where: { id: "attempt-book", status: { in: ["QUEUED", "ACTIVE"] } },
      data: {
        status: "CANCELED",
        error: "Stopped by user",
        finishedAt: expect.any(Date),
        refundPending: true
      }
    });
    expect(mocks.failGenerationAttempt).toHaveBeenCalledWith("attempt-book", "Stopped by user", "CANCELED");
  });

  it("keeps the stop's verdict when the ledger settlement itself fails", async () => {
    // A settled charge is reversed by a row unique on `reversesEntryId`, so a
    // settlement racing the worker's own raises. Inside the stop that rolled
    // back every job, operation and project write beside it — the book stayed
    // GENERATING with its jobs open, and every retry hit the same conflict.
    mocks.failGenerationAttempt.mockRejectedValue(new Error("duplicate key value violates unique constraint"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await stopProjectGenerationJobs("project-1");

    expect(result.stoppedJobs).toBe(1);
    expect(mocks.generationJobUpdateMany).toHaveBeenCalledWith({
      where: { id: "job-book", status: { in: ["QUEUED", "ACTIVE"] } },
      data: expect.objectContaining({ status: "FAILED" })
    });
    expect(mocks.generationAttemptUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ refundPending: true }) })
    );
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });
});

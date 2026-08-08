import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  projectUpdate: vi.fn(),
  refundCreditLedgerEntry: vi.fn(),
  refundLatestProjectOperationCredits: vi.fn(),
  failGenerationAttempt: vi.fn()
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add = mocks.add;
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
  prisma: {
    generationJob: {
      findUnique: mocks.findUnique,
      findMany: mocks.findMany,
      create: mocks.create,
      update: mocks.update,
      updateMany: mocks.updateMany
    },
    project: { update: mocks.projectUpdate }
  }
}));
vi.mock("@book-maker/db/billing", () => ({
  refundCreditLedgerEntry: mocks.refundCreditLedgerEntry,
  refundLatestProjectOperationCredits: mocks.refundLatestProjectOperationCredits,
  failGenerationAttempt: mocks.failGenerationAttempt
}));

import { dispatchGenerationJob, reconcileUndispatchedGenerationJobs, stopProjectGenerationJobs } from "./queue.js";

describe("durable generation outbox", () => {
  const durableJob = {
    id: "job-durable-1",
    projectId: "project-1",
    type: "PLAN_BOOK",
    status: "QUEUED",
    payload: { planId: "plan-1" },
    bullJobId: null,
    dispatchAttempts: 0
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue(durableJob);
    mocks.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...durableJob, ...data }));
  });

  it("keeps Redis failures durable and reconciles with the database job ID", async () => {
    mocks.add.mockRejectedValueOnce(new Error("Redis unavailable"));

    const waiting = await dispatchGenerationJob(durableJob.id);

    expect(waiting).toMatchObject({ status: "QUEUED", dispatchAttempts: 1, message: "Waiting for the generation queue" });
    const failedDispatchUpdate = mocks.update.mock.calls[0]![0].data;
    expect(failedDispatchUpdate.nextDispatchAt).toBeInstanceOf(Date);
    expect((failedDispatchUpdate.nextDispatchAt as Date).getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60_000);

    mocks.findMany.mockResolvedValue([{ id: durableJob.id }]);
    mocks.add.mockResolvedValue({ id: durableJob.id });
    await reconcileUndispatchedGenerationJobs();

    expect(mocks.add).toHaveBeenLastCalledWith(
      "plan-book",
      expect.objectContaining({ projectId: "project-1", generationJobId: durableJob.id }),
      expect.objectContaining({ jobId: durableJob.id })
    );
  });

  it("dispatches generate-book with an automatic retry budget for network recovery", async () => {
    mocks.findUnique.mockResolvedValue({ ...durableJob, type: "GENERATE_BOOK" });
    mocks.add.mockResolvedValue({ id: durableJob.id });

    await dispatchGenerationJob(durableJob.id);

    expect(mocks.add).toHaveBeenCalledWith(
      "generate-book",
      expect.anything(),
      expect.objectContaining({ attempts: 2, backoff: expect.objectContaining({ type: "exponential" }) })
    );
  });

  it("dispatches one-shot job types without retry options", async () => {
    mocks.findUnique.mockResolvedValue({ ...durableJob, type: "COMPILE_EXPORT" });
    mocks.add.mockResolvedValue({ id: durableJob.id });

    await dispatchGenerationJob(durableJob.id);

    const options = mocks.add.mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(options.attempts).toBeUndefined();
  });
});

describe("stopping a run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectUpdate.mockResolvedValue({});
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.refundCreditLedgerEntry.mockResolvedValue({});
    mocks.refundLatestProjectOperationCredits.mockResolvedValue({});
    mocks.failGenerationAttempt.mockResolvedValue(undefined);
  });

  it("refunds the charge stamped on the stopped run's own GENERATE_BOOK payload", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "job-book",
        bullJobId: null,
        status: "ACTIVE",
        type: "GENERATE_BOOK",
        payload: { planId: "plan-1", billingLedgerEntryId: "entry-own" }
      }
    ]);

    await stopProjectGenerationJobs("project-1");

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("entry-own", "Stopped by user");
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
  });

  it("resolves a fan-out job's charge through its plan's GENERATE_BOOK row, never a newer run's", async () => {
    mocks.findMany
      .mockResolvedValueOnce([
        { id: "job-page", bullJobId: null, status: "QUEUED", type: "GENERATE_PAGE", payload: { planId: "plan-1" } }
      ])
      .mockResolvedValueOnce([
        { payload: { planId: "plan-2", billingLedgerEntryId: "entry-2" } },
        { payload: { planId: "plan-1", billingLedgerEntryId: "entry-1" } }
      ]);

    await stopProjectGenerationJobs("project-1");

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("entry-1", "Stopped by user");
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
  });

  it("falls back to the latest FULL_BOOK_GENERATION charge when no payload is stamped", async () => {
    mocks.findMany
      .mockResolvedValueOnce([
        { id: "job-page", bullJobId: null, status: "QUEUED", type: "GENERATE_PAGE", payload: { planId: "plan-1" } }
      ])
      .mockResolvedValueOnce([{ payload: { planId: "plan-1" } }]);

    await stopProjectGenerationJobs("project-1");

    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).toHaveBeenCalledWith({
      projectId: "project-1",
      operation: "FULL_BOOK_GENERATION",
      reason: "Stopped by user"
    });
  });

  it("settles each stopped attempt through the attempt ledger instead of the legacy charge walk", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "job-book",
        bullJobId: null,
        status: "ACTIVE",
        type: "GENERATE_BOOK",
        payload: { planId: "plan-1", billingLedgerEntryId: "entry-book" },
        attemptId: "attempt-book"
      },
      {
        id: "job-page",
        bullJobId: null,
        status: "QUEUED",
        type: "GENERATE_PAGE",
        payload: { planId: "plan-1" },
        attemptId: "attempt-book"
      },
      {
        id: "job-audiobook",
        bullJobId: null,
        status: "QUEUED",
        type: "GENERATE_AUDIOBOOK",
        payload: { audiobookId: "audio-1", billingLedgerEntryId: "entry-audio" },
        attemptId: "attempt-audiobook"
      }
    ]);

    await stopProjectGenerationJobs("project-1");

    // One settlement per distinct attempt: the attempt refunds its own entry,
    // so the API must not also refund from the payload or the latest charge.
    expect(mocks.failGenerationAttempt.mock.calls).toEqual([
      ["attempt-book", "Stopped by user", "CANCELED"],
      ["attempt-audiobook", "Stopped by user", "CANCELED"]
    ]);
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
  });

  it("does not refund anything when a stop cancels no open jobs", async () => {
    mocks.findMany.mockResolvedValue([]);

    await stopProjectGenerationJobs("project-1");

    expect(mocks.failGenerationAttempt).not.toHaveBeenCalled();
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
  });
});

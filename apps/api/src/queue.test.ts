import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  transaction: vi.fn(),
  projectUpdate: vi.fn(),
  projectUpdateMany: vi.fn(),
  audiobookUpdateMany: vi.fn(),
  bookEditOperationFindUnique: vi.fn(),
  bookEditOperationUpdateMany: vi.fn(),
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
    $transaction: mocks.transaction,
    generationJob: {
      findUnique: mocks.findUnique,
      findMany: mocks.findMany,
      create: mocks.create,
      update: mocks.update,
      updateMany: mocks.updateMany
    },
    project: { update: mocks.projectUpdate, updateMany: mocks.projectUpdateMany },
    audiobook: { updateMany: mocks.audiobookUpdateMany },
    bookEditOperation: {
      findUnique: mocks.bookEditOperationFindUnique,
      updateMany: mocks.bookEditOperationUpdateMany
    }
  }
}));
vi.mock("@book-maker/db/billing", () => ({
  refundCreditLedgerEntry: mocks.refundCreditLedgerEntry,
  refundLatestProjectOperationCredits: mocks.refundLatestProjectOperationCredits,
  failGenerationAttempt: mocks.failGenerationAttempt
}));

import { DETACHED_FROM_PROJECT_LIFECYCLE, PRESENTATION_ONLY_RECOMPILE } from "@book-maker/core";
import {
  dispatchGenerationJob,
  enqueueGenerationJob,
  reconcileUndispatchedGenerationJobs,
  stopProjectGenerationJobs
} from "./queue.js";

describe("who owns a book's quality verdict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "job-1", ...data }));
  });

  async function enqueueCompile(payload: Record<string, unknown>) {
    await enqueueGenerationJob({
      projectId: "project-1",
      type: "COMPILE_EXPORT",
      payload,
      dispatch: false
    });
    return (mocks.create.mock.calls.at(-1)![0] as { data: Record<string, unknown> }).data;
  }

  it("stamps the owning compile so the read side never has to scan for it", async () => {
    expect((await enqueueCompile({ planId: "plan-1" })).ownsQualityVerdict).toBe(true);
  });

  it("refuses a detached export repair and a presentation-only reprint", async () => {
    // Both run with skipFinalReview, so both report the deterministic checks
    // alone. Reading either as the book's verdict deletes the model QA findings
    // — and the page indexes the quality card's "Fix page N" button needs.
    const repair = await enqueueCompile({
      planId: "plan-1",
      skipFinalReview: true,
      [DETACHED_FROM_PROJECT_LIFECYCLE]: true
    });
    const reprint = await enqueueCompile({
      planId: "plan-1",
      skipFinalReview: true,
      [PRESENTATION_ONLY_RECOMPILE]: true
    });

    expect(repair.ownsQualityVerdict).toBe(false);
    expect(reprint.ownsQualityVerdict).toBe(false);
  });

  it("leaves the column false for jobs that report no manuscript verdict", async () => {
    await enqueueGenerationJob({
      projectId: "project-1",
      type: "GENERATE_AUDIOBOOK",
      payload: { audiobookId: "audio-1" },
      dispatch: false
    });

    expect((mocks.create.mock.calls.at(-1)![0] as { data: Record<string, unknown> }).data.ownsQualityVerdict).toBe(
      false
    );
  });
});

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
    mocks.projectUpdateMany.mockResolvedValue({ count: 1 });
    mocks.projectUpdate.mockResolvedValue({ status: "GENERATING" });
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        project: { update: mocks.projectUpdate, updateMany: mocks.projectUpdateMany },
        generationJob: { findMany: mocks.findMany, updateMany: mocks.updateMany }
      })
    );
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

  it("does not refund an attempt after publication already committed its job COMPLETED", async () => {
    mocks.projectUpdate.mockResolvedValue({ status: "COMPLETE" });
    // The publication transaction terminalized the compile row before releasing
    // the project lock, so the stop's open-row read cannot see that attempt.
    mocks.findMany.mockResolvedValue([]);

    await stopProjectGenerationJobs("project-1");

    expect(mocks.failGenerationAttempt).not.toHaveBeenCalled();
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
    // The FAILED write is issued, but its own where-clause is the guard: a
    // settled status is excluded, so the finished book keeps COMPLETE.
    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: { notIn: ["COMPLETE", "REVIEW_REQUIRED"] } },
      data: { status: "FAILED" }
    });
  });

  it("fails a stranded project even when the stop claims no open jobs", async () => {
    // A crash can leave a book GENERATING with no QUEUED/ACTIVE rows at all.
    // Stop is the one lever the user has to move it back to a retryable
    // FAILED, so the status write must not be gated on something having been
    // stopped — only on the status itself.
    mocks.projectUpdate.mockResolvedValue({ status: "GENERATING" });
    mocks.findMany.mockResolvedValue([]);

    await stopProjectGenerationJobs("project-1");

    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: { notIn: ["COMPLETE", "REVIEW_REQUIRED"] } },
      data: { status: "FAILED" }
    });
  });

  it("settles a legacy audiobook job against its own charge, never the book's", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "job-audiobook",
        bullJobId: null,
        status: "QUEUED",
        type: "GENERATE_AUDIOBOOK",
        payload: { audiobookId: "audio-1", billingLedgerEntryId: "entry-audio" }
      }
    ]);

    await stopProjectGenerationJobs("project-1");

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("entry-audio", "Stopped by user");
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
    // The worker never sees a queued job the stop removed, so the row it would
    // have failed must be failed here or narration stays blocked forever.
    expect(mocks.audiobookUpdateMany).toHaveBeenCalledWith({
      where: { generationJobId: { in: ["job-audiobook"] }, status: "GENERATING" },
      data: { status: "FAILED", error: "Stopped by user" }
    });
  });

  it("does not refund the book when a stop cancels only a detached export repair", async () => {
    // A repair is attempt-less, typed COMPILE_EXPORT, and carries the finished
    // book's own planId — so the book-run walk would find that book's
    // GENERATE_BOOK charge and give it back because a rebuild of a missing file
    // was cancelled. Deleting a finished book reaches this: the status poll
    // queues a repair as soon as the PDF is missing, and both delete routes stop
    // the project's open jobs first.
    mocks.findMany.mockResolvedValue([
      {
        id: "job-repair",
        bullJobId: null,
        status: "QUEUED",
        type: "COMPILE_EXPORT",
        payload: {
          planId: "plan-1",
          skipFinalReview: true,
          contentRevision: 7,
          detachedFromProjectLifecycle: true
        }
      }
    ]);

    await stopProjectGenerationJobs("project-1");

    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
    // The row is still stopped; only the settlement is skipped.
    expect(mocks.updateMany).toHaveBeenCalled();
  });

  it("restores a stopped presentation reprint to its prior settled status without refunding", async () => {
    mocks.projectUpdate.mockResolvedValue({ status: "EDITING" });
    mocks.findMany.mockResolvedValue([
      {
        id: "job-presentation",
        bullJobId: null,
        status: "ACTIVE",
        type: "COMPILE_EXPORT",
        payload: {
          planId: "plan-1",
          contentRevision: 9,
          presentationOnlyRecompile: true,
          presentationRecompileFallbackStatus: "REVIEW_REQUIRED"
        }
      }
    ]);

    await stopProjectGenerationJobs("project-1");

    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "REVIEW_REQUIRED" }
    });
    expect(mocks.failGenerationAttempt).not.toHaveBeenCalled();
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
  });

  it("cannot fail a project that is already finished", async () => {
    // The stop's project write is guarded on the *status*, never on what was
    // stopped. A repair, a narration or an edit that has not started yet is
    // queued against a COMPLETE book routinely — the operator console offers
    // Stop for any of them, since it draws the button for any QUEUED or ACTIVE
    // job — and marking that book FAILED is terminal: `ensureExportRepairQueued`
    // only queues for COMPLETE/REVIEW_REQUIRED and `canRecoverGenerationJob`
    // refuses detached rows, so neither the self-repair lane nor a resume route
    // can move it back. Real in-flight work is GENERATING or EDITING, so the
    // same write still fails the runs it should.
    mocks.projectUpdate.mockResolvedValue({ status: "COMPLETE" });
    mocks.findMany.mockResolvedValue([
      {
        id: "job-repair",
        bullJobId: null,
        status: "QUEUED",
        type: "COMPILE_EXPORT",
        payload: { planId: "plan-1", detachedFromProjectLifecycle: true }
      }
    ]);

    await stopProjectGenerationJobs("project-1");

    // Every FAILED write carries the settled-status guard in its where-clause;
    // an unguarded write anywhere here is the delivered-book-failed bug.
    for (const call of mocks.projectUpdateMany.mock.calls) {
      const args = call[0] as { where: Record<string, unknown>; data: Record<string, unknown> };
      if ((args.data as { status?: string }).status === "FAILED") {
        expect(args.where).toMatchObject({ status: { notIn: ["COMPLETE", "REVIEW_REQUIRED"] } });
      }
    }
  });

  it("still settles the run when a detached repair is stopped alongside real work", async () => {
    // The other half: excluding detached rows must not swallow a genuine
    // in-flight run that happens to be stopped in the same call.
    mocks.findMany.mockResolvedValue([
      {
        id: "job-repair",
        bullJobId: null,
        status: "QUEUED",
        type: "COMPILE_EXPORT",
        payload: { planId: "plan-1", detachedFromProjectLifecycle: true }
      },
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

  it("settles a legacy edit job against its operation's charge and closes the operation", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "job-edit",
        bullJobId: null,
        status: "QUEUED",
        type: "APPLY_BOOK_EDIT",
        payload: { operationId: "op-1", planId: "plan-1" }
      }
    ]);
    mocks.bookEditOperationFindUnique.mockResolvedValue({ ledgerEntryId: "ledger-op" });
    mocks.bookEditOperationUpdateMany.mockResolvedValue({ count: 1 });

    await stopProjectGenerationJobs("project-1");

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("ledger-op", "Stopped by user");
    // Never the plan walk: the edit's planId must not route the refund to the
    // book's FULL_BOOK_GENERATION entry.
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
    expect(mocks.bookEditOperationUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["op-1"] }, status: { in: ["QUEUED", "ACTIVE"] } },
      data: { status: "CANCELED", error: "Stopped by user" }
    });
  });
});

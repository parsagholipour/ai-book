import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  classifier: {} as unknown,
  project: {
    status: "EDITING",
    currentPlanId: "plan-new",
    contentRevision: 7,
    // The barrier `publishContinuation` stamped with the revision it created.
    exportInvalidationRevision: 7 as number | null
  },
  prisma: {
    bookEditOperation: { findUnique: vi.fn() },
    project: { updateMany: vi.fn() },
    $transaction: vi.fn(),
    $queryRawUnsafe: vi.fn()
  },
  tx: {
    project: { update: vi.fn(), updateMany: vi.fn() },
    bookEditOperation: { update: vi.fn(), count: vi.fn() }
  },
  invalidateProjectExports: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  assertTextEditLeaseTx: vi.fn(),
  completeTextEditLease: vi.fn(),
  releaseTextEditTailLease: vi.fn(),
  startTextEditLeaseHeartbeat: vi.fn(),
  waitForTextEditLeaseCompletion: vi.fn(),
  heartbeatAssertHeld: vi.fn(),
  heartbeatStop: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: {},
  MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS: { timeout: 30_000, maxWait: 10_000 }
}));
vi.mock("./bookHelpers.js", () => ({ invalidateProjectExports: mocks.invalidateProjectExports }));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));
vi.mock("./textEditLease.js", () => ({
  assertTextEditLeaseTx: mocks.assertTextEditLeaseTx,
  completeTextEditLease: mocks.completeTextEditLease,
  releaseTextEditTailLease: mocks.releaseTextEditTailLease,
  startTextEditLeaseHeartbeat: mocks.startTextEditLeaseHeartbeat,
  waitForTextEditLeaseCompletion: mocks.waitForTextEditLeaseCompletion
}));

import {
  continuationFollowUpClassifier,
  continuationFollowUpCompletion
} from "./continuationFollowUp.js";

const identity = {
  projectId: "project-1",
  operationId: "operation-1",
  planVersionId: "plan-new",
  publicationRevision: 7,
  fallbackStatus: "REVIEW_REQUIRED" as const
};

/** Models the one column both barrier writes compare-and-clear. */
async function clearBarrierIfMatched({ where }: { where: Record<string, unknown> }): Promise<{ count: number }> {
  if (where.exportInvalidationRevision === undefined) return { count: 1 };
  if (mocks.project.exportInvalidationRevision !== where.exportInvalidationRevision) return { count: 0 };
  mocks.project.exportInvalidationRevision = null;
  return { count: 1 };
}

/** Project.updateMany writes that carry a status — the fallback restore, not the barrier clear. */
const statusRestores = (): unknown[] =>
  mocks.tx.project.updateMany.mock.calls.filter(
    (call) => (call[0] as { data?: { status?: unknown } }).data?.status !== undefined
  );

function completion(ownerToken = "owner-1") {
  return continuationFollowUpCompletion(identity, ownerToken);
}

function classifierWith(
  completedSteps: string[],
  compileOutcome?: string
): Record<string, unknown> {
  // The exports step is what clears the barrier, so a classifier that already
  // carries it describes a project whose barrier is gone.
  if (completedSteps.includes("exports")) mocks.project.exportInvalidationRevision = null;
  const classifier = continuationFollowUpClassifier({}, identity) as Record<string, unknown>;
  const state = classifier.continuationFollowUp as Record<string, unknown>;
  return {
    ...classifier,
    continuationFollowUp: { ...state, completedSteps, ...(compileOutcome ? { compileOutcome } : {}) }
  };
}

/** Nesting depth of the mocked interactive transaction, for lock-order assertions. */
let openTransactions = 0;
let unlinkedUnderProjectLock = false;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.classifier = continuationFollowUpClassifier({}, identity);
  openTransactions = 0;
  unlinkedUnderProjectLock = false;
  mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => {
    openTransactions += 1;
    try {
      return await run(mocks.tx);
    } finally {
      openTransactions -= 1;
    }
  });
  mocks.prisma.bookEditOperation.findUnique.mockImplementation(async () => ({ classifier: mocks.classifier }));
  mocks.assertTextEditLeaseTx.mockImplementation(async () => ({ status: "APPLIED", classifier: mocks.classifier }));
  mocks.project = {
    status: "EDITING",
    currentPlanId: "plan-new",
    contentRevision: 7,
    exportInvalidationRevision: 7
  };
  mocks.tx.project.update.mockImplementation(async () => ({ ...mocks.project }));
  mocks.tx.project.updateMany.mockImplementation(clearBarrierIfMatched);
  mocks.prisma.project.updateMany.mockImplementation(clearBarrierIfMatched);
  // No newer edit unless a test says otherwise.
  mocks.tx.bookEditOperation.count.mockResolvedValue(0);
  mocks.tx.bookEditOperation.update.mockImplementation(async ({ data }: { data: { classifier: unknown } }) => {
    mocks.classifier = data.classifier;
    return {};
  });
  mocks.invalidateProjectExports.mockImplementation(async () => {
    unlinkedUnderProjectLock = unlinkedUnderProjectLock || openTransactions > 0;
  });
  mocks.maybeEnqueueCompile.mockResolvedValue("compile");
  mocks.completeTextEditLease.mockResolvedValue(true);
  mocks.waitForTextEditLeaseCompletion.mockResolvedValue("completed");
  mocks.releaseTextEditTailLease.mockResolvedValue(true);
  mocks.startTextEditLeaseHeartbeat.mockReturnValue({
    assertHeld: mocks.heartbeatAssertHeld,
    stop: mocks.heartbeatStop
  });
  mocks.heartbeatAssertHeld.mockResolvedValue(undefined);
  mocks.heartbeatStop.mockResolvedValue(undefined);
});

describe("continuation publication follow-up", () => {
  it("releases only the APPLIED tail lease when export invalidation fails", async () => {
    mocks.invalidateProjectExports.mockRejectedValueOnce(new Error("storage unavailable"));

    const result = completion();
    await expect(result.afterJobCompleted?.()).rejects.toThrow("storage unavailable");

    expect(result).toMatchObject({
      durableCompletionCommitted: true,
      lifecycleCompletionCommitted: true,
      retryFollowUpOnRedelivery: true
    });
    expect(mocks.releaseTextEditTailLease).toHaveBeenCalledWith("operation-1", "owner-1");
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.completeTextEditLease).not.toHaveBeenCalled();

    await expect(completion("owner-2").afterJobCompleted?.()).resolves.toBeUndefined();
    expect(mocks.invalidateProjectExports).toHaveBeenCalledTimes(2);
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledTimes(1);
    expect(mocks.completeTextEditLease).toHaveBeenCalledWith("operation-1", "owner-2");
  });

  it("settles a compile enqueue outage as not-ready rather than retrying the delivered tail", async () => {
    // The exports are already unlinked when the enqueue throws. Rethrowing
    // spends Bull's two tail attempts and never reaches the status step, so
    // the book keeps its chapters, loses its exports and sits EDITING with no
    // COMPILE_EXPORT row behind it.
    mocks.maybeEnqueueCompile.mockRejectedValue(new Error("queue unavailable"));

    await expect(completion("owner-1").afterJobCompleted?.()).resolves.toBeUndefined();

    expect(mocks.invalidateProjectExports).toHaveBeenCalledTimes(1);
    expect(mocks.releaseTextEditTailLease).not.toHaveBeenCalled();
    expect(mocks.tx.project.updateMany).toHaveBeenCalledWith({
      where: {
        id: "project-1",
        currentPlanId: "plan-new",
        status: "EDITING",
        contentRevision: 7
      },
      data: { status: "REVIEW_REQUIRED" }
    });
    expect(mocks.classifier).toMatchObject({
      continuationFollowUp: {
        compileOutcome: "not-ready",
        completedSteps: ["exports", "compile", "status"]
      }
    });
    expect(mocks.completeTextEditLease).toHaveBeenCalledWith("operation-1", "owner-1");
  });

  it("replays only the uncheckpointed steps", async () => {
    mocks.classifier = classifierWith(["exports"]);

    await completion().afterJobCompleted?.();

    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledTimes(1);
    expect(mocks.completeTextEditLease).toHaveBeenCalledWith("operation-1", "owner-1");
  });

  it("unlinks the stale exports outside the Project row lock", async () => {
    // Project is the root of the edit lock order, so a slow storage mount
    // inside the transaction blocks Stop and every concurrent publication —
    // and a P2028 rolls the checkpoint back after the files are already gone.
    await completion().afterJobCompleted?.();

    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(unlinkedUnderProjectLock).toBe(false);
  });

  it("leaves EDITING to a newer edit that is already open on the project", async () => {
    // This tail's durable job was COMPLETED in the publication transaction, so
    // `hasOpenProjectWork` says "no open work" and the reader may start the
    // next edit while the tail is still running — under the same revision, plan
    // and EDITING this restore proves ownership with.
    mocks.maybeEnqueueCompile.mockResolvedValue("not-ready");
    mocks.tx.bookEditOperation.count.mockResolvedValue(1);

    await completion().afterJobCompleted?.();

    expect(mocks.tx.bookEditOperation.count).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        id: { not: "operation-1" },
        status: { in: ["QUEUED", "ACTIVE"] }
      }
    });
    expect(statusRestores()).toHaveLength(0);
    expect(mocks.completeTextEditLease).toHaveBeenCalledWith("operation-1", "owner-1");
  });

  it("clears its own export barrier in the transaction that checkpoints the unlink", async () => {
    // `publishContinuation` stamps it with the revision it created, so a
    // compile claiming that revision stands down for the whole gap between the
    // manuscript commit and this unlink.
    await completion().afterJobCompleted?.();

    expect(mocks.tx.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", exportInvalidationRevision: 7 },
      data: { exportInvalidationRevision: null }
    });
    expect(mocks.project.exportInvalidationRevision).toBeNull();
  });

  it("deletes nothing when the barrier on the project belongs to a newer tail", async () => {
    mocks.project.exportInvalidationRevision = 9;

    await completion().afterJobCompleted?.();

    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.project.exportInvalidationRevision).toBe(9);
    expect(mocks.completeTextEditLease).toHaveBeenCalledWith("operation-1", "owner-1");
  });

  it("abandons its barrier when it gives up and hands the lease back", async () => {
    // Nothing sweeps the column, and every export publisher stands down while
    // it is set — so a tail Bull stops retrying would fence this book out of
    // every later compile and out of the repair lane that would heal it.
    mocks.invalidateProjectExports.mockRejectedValue(new Error("storage unavailable"));

    await expect(completion().afterJobCompleted?.()).rejects.toThrow("storage unavailable");

    expect(mocks.releaseTextEditTailLease).toHaveBeenCalledWith("operation-1", "owner-1");
    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", exportInvalidationRevision: 7 },
      data: { exportInvalidationRevision: null }
    });
  });

  it("hands the tail lease back when the completion marker itself fails", async () => {
    // Swallowing it reported success to Bull over a row still holding this
    // token with no completion marker: nothing retries it, nothing releases it,
    // and a concurrent loser polls for that marker until its own deadline.
    mocks.completeTextEditLease.mockRejectedValue(new Error("lease write unavailable"));

    await expect(completion().afterJobCompleted?.()).rejects.toThrow("lease write unavailable");

    expect(mocks.releaseTextEditTailLease).toHaveBeenCalledWith("operation-1", "owner-1");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledTimes(1);
  });

  it("waits out a compare-and-set miss instead of treating it as a failed completion", async () => {
    mocks.completeTextEditLease.mockResolvedValue(false);

    await expect(completion().afterJobCompleted?.()).resolves.toBeUndefined();

    expect(mocks.waitForTextEditLeaseCompletion).toHaveBeenCalledWith("operation-1");
    expect(mocks.releaseTextEditTailLease).not.toHaveBeenCalled();
  });

  it("throws unowned when the completion wait is abandoned", async () => {
    mocks.completeTextEditLease.mockResolvedValue(false);
    mocks.waitForTextEditLeaseCompletion.mockResolvedValue("abandoned");

    await expect(completion().afterJobCompleted?.()).rejects.toMatchObject({
      name: "UnownedTextEditDeliveryError"
    });

    expect(mocks.releaseTextEditTailLease).toHaveBeenCalledWith("operation-1", "owner-1");
  });

  it("queues an exact EDITING-owned compile and leaves final status to that compile", async () => {
    await completion().afterJobCompleted?.();

    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith(
      "project-1",
      "plan-new",
      expect.objectContaining({ expectedProjectStatus: "EDITING" }),
      { contentRevision: 7, requireContentRevisionMatch: true }
    );
    expect(statusRestores()).toHaveLength(0);
    expect(mocks.completeTextEditLease).toHaveBeenCalledTimes(1);
  });

  it("restores the stamped status only after a not-ready compile handoff is checkpointed", async () => {
    mocks.maybeEnqueueCompile.mockResolvedValue("not-ready");

    await completion().afterJobCompleted?.();

    expect(mocks.tx.project.updateMany).toHaveBeenCalledWith({
      where: {
        id: "project-1",
        // Scoped on the plan, like both siblings: a structural shift installs
        // its own plan version before the transaction that bumps the revision,
        // so the revision alone does not name this publication.
        currentPlanId: "plan-new",
        status: "EDITING",
        contentRevision: 7
      },
      data: { status: "REVIEW_REQUIRED" }
    });
    expect(mocks.tx.bookEditOperation.update.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(
      mocks.tx.project.updateMany.mock.invocationCallOrder.at(-1)!
    );
  });

  it("leaves a project whose plan moved at the same revision alone before the status step", async () => {
    // Resumed at `status` from a checkpointed not-ready compile, onto a project
    // a structural shift has since re-pointed at its own plan version without
    // yet bumping the revision.
    mocks.classifier = classifierWith(["exports", "compile"], "not-ready");
    mocks.project = {
      status: "EDITING",
      currentPlanId: "plan-structural",
      contentRevision: 7,
      exportInvalidationRevision: null
    };

    await completion().afterJobCompleted?.();

    expect(statusRestores()).toHaveLength(0);
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.completeTextEditLease).toHaveBeenCalledWith("operation-1", "owner-1");
  });

  it("re-asks whether it still owns the project before a replayed compile step", async () => {
    mocks.classifier = classifierWith(["exports"]);
    mocks.project = {
      status: "EDITING",
      currentPlanId: "plan-new",
      contentRevision: 8,
      exportInvalidationRevision: null
    };

    await completion().afterJobCompleted?.();

    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(statusRestores()).toHaveLength(0);
    expect(mocks.completeTextEditLease).toHaveBeenCalledWith("operation-1", "owner-1");
  });
});

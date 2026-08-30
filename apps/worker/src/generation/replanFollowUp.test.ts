import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  classifier: {} as Record<string, unknown>,
  project: {
    currentPlanId: "plan-new",
    contentRevision: 7,
    status: "EDITING",
    // The barrier `publishReplannedBook` stamped with the revision it created.
    exportInvalidationRevision: 7 as number | null
  },
  prisma: {
    bookEditOperation: { findUnique: vi.fn() },
    project: { updateMany: vi.fn() },
    $transaction: vi.fn()
  },
  tx: {
    project: { update: vi.fn(), updateMany: vi.fn() },
    bookEditOperation: { update: vi.fn(), count: vi.fn() }
  },
  invalidateProjectExports: vi.fn(),
  ensureCharacterReferenceAssets: vi.fn(),
  maybeEnqueueCover: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  assertReplanEditLeaseTx: vi.fn(),
  completeReplanEditLease: vi.fn(),
  releaseReplanEditTailLease: vi.fn(),
  waitForReplanEditLeaseCompletion: vi.fn(),
  heartbeatAssertHeld: vi.fn(),
  heartbeatStop: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: {},
  MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS: { timeout: 30_000, maxWait: 10_000 }
}));
vi.mock("./bookHelpers.js", () => ({ invalidateProjectExports: mocks.invalidateProjectExports }));
vi.mock("./characterReferences.js", () => ({
  ensureCharacterReferenceAssets: mocks.ensureCharacterReferenceAssets
}));
vi.mock("../runtime/dispatch.js", () => ({
  maybeEnqueueCompile: mocks.maybeEnqueueCompile
}));
vi.mock("./replanCoverDispatch.js", () => ({
  maybeEnqueueRevisionOwnedReplanCover: mocks.maybeEnqueueCover
}));
vi.mock("./replanEditLease.js", () => {
  class ReplanEditLeaseLostError extends Error {}
  return {
    assertReplanEditLeaseTx: mocks.assertReplanEditLeaseTx,
    completeReplanEditLease: mocks.completeReplanEditLease,
    releaseReplanEditTailLease: mocks.releaseReplanEditTailLease,
    ReplanEditLeaseLostError,
    startReplanEditTailLeaseHeartbeat: () => ({
      assertHeld: mocks.heartbeatAssertHeld,
      stop: mocks.heartbeatStop
    }),
    waitForReplanEditLeaseCompletion: mocks.waitForReplanEditLeaseCompletion
  };
});

import {
  replanFollowUpClassifier,
  replannedBookFollowUpCompletion,
  type ReplanFollowUpIdentity
} from "./replanFollowUp.js";

const identity: ReplanFollowUpIdentity = {
  projectId: "project-1",
  operationId: "operation-1",
  planVersionId: "plan-new",
  publicationRevision: 7
};
const options = {
  projectId: "project-1",
  planId: "plan-new",
  operationId: "operation-1",
  input: { mediaSettings: {} } as never,
  plan: {} as never,
  providers: {} as never,
  strategy: {} as never
};

/** Models the one column both barrier writes compare-and-clear. */
async function clearBarrierIfMatched({ where }: { where: Record<string, unknown> }): Promise<{ count: number }> {
  if (where.exportInvalidationRevision === undefined) return { count: 1 };
  if (mocks.project.exportInvalidationRevision !== where.exportInvalidationRevision) return { count: 0 };
  mocks.project.exportInvalidationRevision = null;
  return { count: 1 };
}

function classifierWith(completedSteps: string[]) {
  // The exports step is what clears the barrier, so a classifier that already
  // carries it describes a project whose barrier is gone.
  if (completedSteps.includes("exports")) mocks.project.exportInvalidationRevision = null;
  const classifier = replanFollowUpClassifier({}, identity) as Record<string, unknown>;
  const state = classifier.replanFollowUp as Record<string, unknown>;
  return { ...classifier, replanFollowUp: { ...state, completedSteps } };
}

/** Project.updateMany writes that carry a status — the fallback restore, not the barrier clear. */
const statusRestores = (): unknown[] =>
  mocks.tx.project.updateMany.mock.calls.filter(
    (call) => (call[0] as { data?: { status?: unknown } }).data?.status !== undefined
  );

function completion(ownerToken = "owner-1") {
  return replannedBookFollowUpCompletion(options, identity, ownerToken);
}

/** Nesting depth of the mocked interactive transaction, for lock-order assertions. */
let openTransactions = 0;
let unlinkedUnderProjectLock = false;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.project = {
    currentPlanId: "plan-new",
    contentRevision: 7,
    status: "EDITING",
    exportInvalidationRevision: 7
  };
  mocks.classifier = classifierWith([]);
  mocks.prisma.project.updateMany.mockImplementation(clearBarrierIfMatched);
  openTransactions = 0;
  unlinkedUnderProjectLock = false;
  mocks.prisma.bookEditOperation.findUnique.mockImplementation(async () => ({ classifier: mocks.classifier }));
  mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => {
    openTransactions += 1;
    try {
      return await run(mocks.tx);
    } finally {
      openTransactions -= 1;
    }
  });
  mocks.invalidateProjectExports.mockImplementation(async () => {
    unlinkedUnderProjectLock = unlinkedUnderProjectLock || openTransactions > 0;
  });
  mocks.tx.project.update.mockImplementation(async () => ({ ...mocks.project }));
  mocks.tx.project.updateMany.mockImplementation(clearBarrierIfMatched);
  // No newer edit unless a test says otherwise.
  mocks.tx.bookEditOperation.count.mockResolvedValue(0);
  mocks.assertReplanEditLeaseTx.mockImplementation(async () => ({
    status: "APPLIED",
    classifier: mocks.classifier
  }));
  mocks.tx.bookEditOperation.update.mockImplementation(async ({ data }: { data: { classifier: Record<string, unknown> } }) => {
    mocks.classifier = data.classifier;
    return {};
  });
  mocks.maybeEnqueueCompile.mockResolvedValue("compile");
  mocks.completeReplanEditLease.mockResolvedValue(true);
  mocks.waitForReplanEditLeaseCompletion.mockResolvedValue("completed");
  mocks.releaseReplanEditTailLease.mockResolvedValue(true);
  mocks.heartbeatAssertHeld.mockResolvedValue(undefined);
  mocks.heartbeatStop.mockResolvedValue(undefined);
});

describe("replan publication follow-up ownership", () => {
  it("runs every step only for the exact APPLIED plan, revision and EDITING owner", async () => {
    await completion().afterJobCompleted?.();

    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(mocks.ensureCharacterReferenceAssets).toHaveBeenCalledTimes(1);
    expect(mocks.maybeEnqueueCover).toHaveBeenCalledWith(
      "project-1",
      "plan-new",
      options.input,
      { contentRevision: 7, expectedProjectStatus: "EDITING", requireContentRevisionMatch: true }
    );
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith(
      "project-1",
      "plan-new",
      expect.objectContaining({ expectedProjectStatus: "EDITING" }),
      { contentRevision: 7, requireContentRevisionMatch: true }
    );
    expect(mocks.classifier).toMatchObject({
      replanFollowUp: { planVersionId: "plan-new", publicationRevision: 7, completedSteps: ["exports", "characters", "cover", "compile"] }
    });
    expect(mocks.completeReplanEditLease).toHaveBeenCalledWith(identity, "owner-1");
  });

  it.each([
    ["exports", []],
    ["characters", ["exports"]],
    ["cover", ["exports", "characters"]],
    ["compile", ["exports", "characters", "cover"]]
  ])("stands down on a newer revision before the %s step", async (_step, completedSteps) => {
    mocks.classifier = classifierWith(completedSteps);
    mocks.project = { currentPlanId: "plan-newer", contentRevision: 8, status: "EDITING", exportInvalidationRevision: 8 };

    await completion().afterJobCompleted?.();

    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.ensureCharacterReferenceAssets).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCover).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.completeReplanEditLease).toHaveBeenCalledWith(identity, "owner-1");
  });

  it("replays only uncheckpointed steps", async () => {
    mocks.classifier = classifierWith(["exports", "characters"]);

    await completion().afterJobCompleted?.();

    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.ensureCharacterReferenceAssets).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCover).toHaveBeenCalledTimes(1);
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledTimes(1);
  });

  it("does not redispatch or delete newer exports after a crash post-enqueue and pre-checkpoint", async () => {
    mocks.classifier = classifierWith(["exports", "characters", "cover"]);
    mocks.tx.bookEditOperation.update.mockRejectedValueOnce(new Error("crash before compile checkpoint"));

    await expect(completion("owner-1").afterJobCompleted?.()).rejects.toThrow("crash before compile checkpoint");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledTimes(1);
    expect(mocks.releaseReplanEditTailLease).toHaveBeenCalledWith(identity, "owner-1");

    mocks.project = { currentPlanId: "plan-newer", contentRevision: 8, status: "EDITING", exportInvalidationRevision: 8 };
    await completion("owner-2").afterJobCompleted?.();

    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.completeReplanEditLease).toHaveBeenCalledWith(identity, "owner-2");
  });

  it("restores status only for an exact not-ready handoff", async () => {
    mocks.classifier = classifierWith(["exports", "characters", "cover"]);
    mocks.maybeEnqueueCompile.mockResolvedValue("not-ready");

    await completion().afterJobCompleted?.();

    expect(mocks.tx.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", currentPlanId: "plan-new", contentRevision: 7, status: "EDITING" },
      data: { status: "REVIEW_REQUIRED" }
    });
  });

  it("settles a compile enqueue outage as not-ready rather than retrying the delivered tail", async () => {
    // The replanned manuscript is committed and the old exports are already
    // unlinked. Rethrowing spends Bull's two tail attempts and never restores
    // the status, leaving the book EDITING with no COMPILE_EXPORT row.
    mocks.classifier = classifierWith(["exports", "characters", "cover"]);
    mocks.maybeEnqueueCompile.mockRejectedValue(new Error("queue unavailable"));

    await expect(completion().afterJobCompleted?.()).resolves.toBeUndefined();

    expect(mocks.releaseReplanEditTailLease).not.toHaveBeenCalled();
    expect(mocks.tx.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", currentPlanId: "plan-new", contentRevision: 7, status: "EDITING" },
      data: { status: "REVIEW_REQUIRED" }
    });
    expect(mocks.classifier).toMatchObject({
      replanFollowUp: { completedSteps: ["exports", "characters", "cover", "compile"] }
    });
    expect(mocks.completeReplanEditLease).toHaveBeenCalledWith(identity, "owner-1");
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
    mocks.classifier = classifierWith(["exports", "characters", "cover"]);
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
    expect(mocks.completeReplanEditLease).toHaveBeenCalledWith(identity, "owner-1");
  });

  it("clears its own export barrier in the transaction that checkpoints the unlink", async () => {
    // `publishReplannedBook` stamps it with the revision it created, so a
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
    expect(mocks.completeReplanEditLease).toHaveBeenCalledWith(identity, "owner-1");
  });

  it("abandons its barrier when it gives up and hands the lease back", async () => {
    // Nothing sweeps the column, and every export publisher stands down while
    // it is set — so a tail Bull stops retrying would fence this book out of
    // every later compile and out of the repair lane that would heal it.
    mocks.invalidateProjectExports.mockRejectedValue(new Error("storage unavailable"));

    await expect(completion().afterJobCompleted?.()).rejects.toThrow("storage unavailable");

    expect(mocks.releaseReplanEditTailLease).toHaveBeenCalledWith(identity, "owner-1");
    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", exportInvalidationRevision: 7 },
      data: { exportInvalidationRevision: null }
    });
  });

  it("hands the tail lease back when the completion marker itself fails", async () => {
    // Swallowing it reported success to Bull over a row still holding this
    // token with no completion marker: nothing retries it, nothing releases it,
    // and a concurrent loser polls for that marker until its own deadline.
    mocks.completeReplanEditLease.mockRejectedValue(new Error("lease write unavailable"));

    await expect(completion().afterJobCompleted?.()).rejects.toThrow("lease write unavailable");

    expect(mocks.releaseReplanEditTailLease).toHaveBeenCalledWith(identity, "owner-1");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledTimes(1);
  });

  it("waits out a compare-and-set miss instead of treating it as a failed completion", async () => {
    mocks.completeReplanEditLease.mockResolvedValue(false);

    await expect(completion().afterJobCompleted?.()).resolves.toBeUndefined();

    expect(mocks.waitForReplanEditLeaseCompletion).toHaveBeenCalledWith("operation-1");
    expect(mocks.releaseReplanEditTailLease).not.toHaveBeenCalled();
  });

  it("throws unowned when the completion wait is abandoned", async () => {
    mocks.completeReplanEditLease.mockResolvedValue(false);
    mocks.waitForReplanEditLeaseCompletion.mockResolvedValue("abandoned");

    await expect(completion().afterJobCompleted?.()).rejects.toMatchObject({
      name: "UnownedReplanDeliveryError"
    });

    expect(mocks.releaseReplanEditTailLease).toHaveBeenCalledWith(identity, "owner-1");
  });
});

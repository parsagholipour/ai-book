import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tx: {
    project: { findUnique: vi.fn() }
  },
  prisma: { $transaction: vi.fn() },
  claimAppliedEditPublication: vi.fn(),
  restoreEditProjectStatus: vi.fn(),
  invalidateProjectExports: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma }));
vi.mock("./bookHelpers.js", () => ({
  invalidateProjectExports: mocks.invalidateProjectExports
}));
vi.mock("./editProjectStatus.js", () => ({
  claimAppliedEditPublication: mocks.claimAppliedEditPublication,
  restoreEditProjectStatus: mocks.restoreEditProjectStatus
}));

import { publishAppliedEditTail } from "./appliedEditPublication.js";

const baseOptions = () => ({
  projectId: "project-1",
  operationId: "op-1",
  fallbackStatus: "REVIEW_REQUIRED" as const,
  missingPlanMessage: "missing publication plan",
  enqueueFailureMessage: "publication enqueue failed:"
});

describe("APPLIED edit publication tail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(
      async (run: (tx: typeof mocks.tx) => Promise<unknown>) => run(mocks.tx)
    );
    mocks.claimAppliedEditPublication.mockResolvedValue(true);
    mocks.restoreEditProjectStatus.mockResolvedValue(true);
    mocks.tx.project.findUnique.mockResolvedValue({ currentPlanId: "plan-8" });
  });

  it("stands down before resolving, invalidating, or enqueueing when the claim is stale", async () => {
    mocks.claimAppliedEditPublication.mockResolvedValue(false);
    const afterClaim = vi.fn();
    const enqueue = vi.fn();

    await publishAppliedEditTail({ ...baseOptions(), afterClaim, enqueue });

    expect(afterClaim).not.toHaveBeenCalled();
    expect(mocks.tx.project.findUnique).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(mocks.restoreEditProjectStatus).not.toHaveBeenCalled();
  });

  it("logs a missing plan and restores only through the claimed operation", async () => {
    mocks.tx.project.findUnique.mockResolvedValue({ currentPlanId: null });
    mocks.restoreEditProjectStatus.mockRejectedValue(new Error("restore unavailable"));
    const enqueue = vi.fn();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      publishAppliedEditTail({ ...baseOptions(), enqueue })
    ).resolves.toBeUndefined();

    expect(mocks.claimAppliedEditPublication.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.tx.project.findUnique.mock.invocationCallOrder[0]!
    );
    expect(mocks.restoreEditProjectStatus).toHaveBeenCalledWith(
      mocks.tx,
      "project-1",
      "op-1",
      "REVIEW_REQUIRED"
    );
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith("missing publication plan");
    logged.mockRestore();
  });

  it("propagates lease loss before identity resolution or publication effects", async () => {
    const leaseLost = new Error("lease lost");
    const enqueue = vi.fn();

    await expect(
      publishAppliedEditTail({
        ...baseOptions(),
        afterClaim: async () => {
          throw leaseLost;
        },
        enqueue
      })
    ).rejects.toBe(leaseLost);

    expect(mocks.tx.project.findUnique).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(mocks.restoreEditProjectStatus).not.toHaveBeenCalled();
  });

  it("logs enqueue failure and treats fallback restoration as best effort", async () => {
    const queueError = new Error("queue unavailable");
    const enqueue = vi.fn().mockRejectedValue(queueError);
    mocks.restoreEditProjectStatus.mockRejectedValue(new Error("restore unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      publishAppliedEditTail({ ...baseOptions(), planVersionId: "plan-stamped", enqueue })
    ).resolves.toBeUndefined();

    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(enqueue).toHaveBeenCalledWith({ planVersionId: "plan-stamped" });
    expect(mocks.restoreEditProjectStatus).toHaveBeenCalledWith(
      mocks.tx,
      "project-1",
      "op-1",
      "REVIEW_REQUIRED"
    );
    expect(logged).toHaveBeenCalledWith("publication enqueue failed:", queueError);
    logged.mockRestore();
  });

  it("publishes the resolved plan and required revision under variant transaction options", async () => {
    const afterClaim = vi.fn(async () => undefined);
    const resolveRevision = vi.fn(async () => 12);
    const enqueue = vi.fn(async () => "compile" as const);

    await publishAppliedEditTail({
      ...baseOptions(),
      transactionOptions: { timeout: 30_000, maxWait: 10_000 },
      afterClaim,
      publicationRevision: {
        resolve: resolveRevision,
        missingMessage: "missing publication revision"
      },
      enqueue
    });

    expect(mocks.prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 30_000, maxWait: 10_000 }
    );
    expect(afterClaim).toHaveBeenCalledWith(mocks.tx);
    expect(resolveRevision).toHaveBeenCalledWith(mocks.tx);
    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(enqueue).toHaveBeenCalledWith({
      planVersionId: "plan-8",
      publicationRevision: 12
    });
    expect(mocks.restoreEditProjectStatus).not.toHaveBeenCalled();
  });
});

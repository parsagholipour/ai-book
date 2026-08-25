import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tx: {
    project: { findUnique: vi.fn() },
    bookEditOperation: { findUnique: vi.fn() }
  },
  prisma: { $transaction: vi.fn(), project: { update: vi.fn() } },
  claimAppliedEditPublication: vi.fn(),
  restoreEditProjectStatus: vi.fn(),
  renewStructuralPageLeaseTx: vi.fn(),
  invalidateProjectExports: vi.fn(),
  maybeEnqueueCompile: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  PAGE_RESTRUCTURE_TRANSACTION_OPTIONS: { timeout: 30_000, maxWait: 10_000 }
}));
vi.mock("../generation/bookHelpers.js", () => ({
  invalidateProjectExports: mocks.invalidateProjectExports
}));
vi.mock("../generation/editProjectStatus.js", () => ({
  claimAppliedEditPublication: mocks.claimAppliedEditPublication,
  restoreEditProjectStatus: mocks.restoreEditProjectStatus
}));
vi.mock("../generation/structuralPageLease.js", () => ({
  renewStructuralPageLeaseTx: mocks.renewStructuralPageLeaseTx,
  StructuralPageLeaseLostError: class StructuralPageLeaseLostError extends Error {
    constructor() {
      super("lost structural lease");
      this.name = "StructuralPageLeaseLostError";
    }
  }
}));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));

import { queueRestructureCompile, replayAppliedRestructure } from "./restructurePagesPublication.js";

describe("APPLIED structural publication replay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: typeof mocks.tx) => Promise<unknown>) =>
      run(mocks.tx)
    );
    mocks.tx.project.findUnique.mockResolvedValue({ currentPlanId: "plan-8" });
    mocks.tx.bookEditOperation.findUnique.mockResolvedValue({ publicationRevision: 8 });
    mocks.claimAppliedEditPublication.mockResolvedValue(true);
    mocks.restoreEditProjectStatus.mockResolvedValue(true);
    mocks.renewStructuralPageLeaseTx.mockResolvedValue({ status: "APPLIED", classifier: {} });
    mocks.maybeEnqueueCompile.mockResolvedValue("compile");
  });

  it.each(["insert", "delete", "move"])(
    "replays an applied %s tail without advancing the manuscript revision",
    async (action) => {
      mocks.renewStructuralPageLeaseTx.mockResolvedValue({ status: "APPLIED", classifier: { action } });

      await replayAppliedRestructure("project-1", "op-1", "owner-2", "COMPLETE");

      expect(mocks.claimAppliedEditPublication).toHaveBeenCalledWith(
        mocks.tx, "project-1", "op-1", "COMPLETE"
      );
      expect(mocks.renewStructuralPageLeaseTx).toHaveBeenCalledWith(mocks.tx, "op-1", "owner-2");
      expect(mocks.prisma.project.update).not.toHaveBeenCalled();
      expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
      expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-8", undefined, {
        contentRevision: 8,
        requireContentRevisionMatch: true
      });
    }
  );

  it("stands down before invalidation when a queued compile or newer edit owns the lifecycle", async () => {
    mocks.claimAppliedEditPublication.mockResolvedValue(false);

    await replayAppliedRestructure("project-1", "op-old", "owner-2", "REVIEW_REQUIRED");

    expect(mocks.renewStructuralPageLeaseTx).not.toHaveBeenCalled();
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(mocks.restoreEditProjectStatus).not.toHaveBeenCalled();
  });

  it("does not invalidate or enqueue after losing the APPLIED tail lease", async () => {
    mocks.renewStructuralPageLeaseTx.mockResolvedValue(null);

    await expect(
      replayAppliedRestructure("project-1", "op-1", "expired-owner", "COMPLETE")
    ).rejects.toMatchObject({ name: "StructuralPageLeaseLostError" });

    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("restores only through the stamped operation when no compile can be queued", async () => {
    mocks.maybeEnqueueCompile.mockRejectedValue(new Error("queue unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await queueRestructureCompile("project-1", "plan-8", "op-1", 8, "REVIEW_REQUIRED");

    expect(mocks.restoreEditProjectStatus).toHaveBeenCalledWith(
      mocks.tx, "project-1", "op-1", "REVIEW_REQUIRED"
    );
  });
});

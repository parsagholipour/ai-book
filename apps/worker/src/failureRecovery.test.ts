import { describe, expect, it, vi } from "vitest";
import { restoreProjectAfterFailedPlanRevision, type FailedPlanRevisionRecoveryDb } from "./failureRecovery.js";

describe("restoreProjectAfterFailedPlanRevision", () => {
  it("restores a stuck planning project with a current plan", async () => {
    const db = fakeDb({
      updateCount: 1,
      currentPlanId: "plan-1"
    });

    await expect(restoreProjectAfterFailedPlanRevision(db, "project-1")).resolves.toBe(true);

    expect(db.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "PLANNING", currentPlanId: { not: null } },
      data: { status: "PLAN_READY" }
    });
    expect(db.project.findUnique).not.toHaveBeenCalled();
  });

  it("treats already-settled projects with a current plan as recovered without changing them", async () => {
    const db = fakeDb({
      updateCount: 0,
      currentPlanId: "plan-1"
    });

    await expect(restoreProjectAfterFailedPlanRevision(db, "project-1")).resolves.toBe(true);

    expect(db.project.findUnique).toHaveBeenCalledWith({
      where: { id: "project-1" },
      select: { currentPlanId: true }
    });
  });

  it("returns false when there is no current plan to restore", async () => {
    const db = fakeDb({
      updateCount: 0,
      currentPlanId: null
    });

    await expect(restoreProjectAfterFailedPlanRevision(db, "project-1")).resolves.toBe(false);
  });

  it("does not claim recovery when the restore update fails", async () => {
    const db = fakeDb({
      updateCount: 0,
      currentPlanId: "plan-1"
    });
    vi.mocked(db.project.updateMany).mockRejectedValueOnce(new Error("database unavailable"));

    await expect(restoreProjectAfterFailedPlanRevision(db, "project-1")).resolves.toBe(false);

    expect(db.project.findUnique).not.toHaveBeenCalled();
  });
});

function fakeDb(options: { updateCount: number; currentPlanId: string | null }): FailedPlanRevisionRecoveryDb {
  return {
    project: {
      updateMany: vi.fn().mockResolvedValue({ count: options.updateCount }),
      findUnique: vi.fn().mockResolvedValue({ currentPlanId: options.currentPlanId })
    }
  };
}

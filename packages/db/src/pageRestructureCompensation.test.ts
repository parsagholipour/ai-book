import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ revert: vi.fn() }));

vi.mock("./pageRestructureRevert.ts", () => ({
  revertStructuralPageChange: mocks.revert
}));

import { compensateStructuralPageChangeTx } from "./pageRestructureCompensation.ts";

const stamp = (overrides: Record<string, unknown> = {}) => ({
  action: "insert",
  pageOrderBefore: [{ pageId: "page-1", index: 1 }],
  insertedPageIds: ["placeholder-1"],
  removedPages: [],
  basePlanVersionId: "plan-1",
  newPlanVersionId: "plan-2",
  previousTargetPages: 1,
  previousChapterTargetPages: {},
  baseContentRevision: 7,
  appliedAt: "2026-08-29T00:00:00.000Z",
  ...overrides
});

function transaction(options: {
  status?: string;
  classifier?: unknown;
  leaseToken?: string | null;
  leaseHeld?: boolean;
  publicationRevision?: number | null;
  contentRevision?: number;
  currentPlanId?: string | null;
} = {}) {
  const order: string[] = [];
  const updateOperation = vi.fn(async (_args: unknown) => {
    order.push("operation.update");
    return {};
  });
  const row = {
    id: "op-1",
    projectId: "project-1",
    kind: "RESTRUCTURE_PAGES",
    status: options.status ?? "ACTIVE",
    classifier: options.classifier ?? { keep: true, structuralApplication: stamp() },
    structuralLeaseToken: options.leaseToken === undefined ? "worker-1" : options.leaseToken,
    // The SQL computes this against `CURRENT_TIMESTAMP`; the fixture states the
    // answer the database would have given.
    leaseHeld: options.leaseHeld ?? true,
    publicationRevision: options.publicationRevision ?? null
  };
  return {
    order,
    updateOperation,
    tx: {
      project: {
        update: vi.fn(async () => {
          order.push("project.lock");
          return {
            contentRevision: options.contentRevision ?? 7,
            currentPlanId: options.currentPlanId === undefined ? "plan-2" : options.currentPlanId
          };
        })
      },
      $queryRawUnsafe: vi.fn(async () => {
        order.push("operation.lock");
        return [row];
      }),
      bookEditOperation: { update: updateOperation }
    }
  };
}

describe("compensateStructuralPageChangeTx", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.revert.mockResolvedValue({ currentPlanId: "plan-1" });
  });

  it("locks Project first, reverts the exact stamp, and durably records completion", async () => {
    const state = transaction();

    const result = await compensateStructuralPageChangeTx(state.tx as never, {
      projectId: "project-1",
      operationId: "op-1",
      expectedAppliedAt: "2026-08-29T00:00:00.000Z",
      expectedLeaseToken: "worker-1"
    });

    expect(result).toEqual({ outcome: "compensated", currentPlanId: "plan-1" });
    expect(state.order).toEqual(["project.lock", "operation.lock", "operation.update"]);
    expect(mocks.revert).toHaveBeenCalledWith(
      state.tx,
      "project-1",
      expect.objectContaining({ insertedPageIds: ["placeholder-1"], baseContentRevision: 7 })
    );
    expect(state.updateOperation).toHaveBeenCalledWith({
      where: { id: "op-1" },
      data: {
        classifier: expect.objectContaining({
          keep: true,
          structuralRolledBackAt: expect.any(String),
          structuralCompensation: expect.objectContaining({
            status: "COMPLETED",
            applicationAppliedAt: "2026-08-29T00:00:00.000Z"
          })
        })
      }
    });
    const update = state.updateOperation.mock.calls[0]?.[0] as
      | { data: { classifier: Record<string, unknown> } }
      | undefined;
    expect(update?.data.classifier).not.toHaveProperty("structuralApplication");
  });

  it("stands down after an APPLIED publication wins", async () => {
    const state = transaction({ status: "APPLIED", publicationRevision: 8 });

    await expect(
      compensateStructuralPageChangeTx(state.tx as never, { projectId: "project-1", operationId: "op-1" })
    ).resolves.toEqual({ outcome: "published" });
    expect(mocks.revert).not.toHaveBeenCalled();
  });

  it("does not replay an old ordering over a newer manuscript revision", async () => {
    const state = transaction({ contentRevision: 8 });

    await expect(
      compensateStructuralPageChangeTx(state.tx as never, { projectId: "project-1", operationId: "op-1" })
    ).resolves.toEqual({ outcome: "superseded" });
    expect(mocks.revert).not.toHaveBeenCalled();
    expect(state.updateOperation).not.toHaveBeenCalled();
  });

  it("makes a stale worker lease loser stand down", async () => {
    const state = transaction({ leaseToken: "stop-owner" });

    await expect(
      compensateStructuralPageChangeTx(state.tx as never, {
        projectId: "project-1",
        operationId: "op-1",
        expectedLeaseToken: "worker-1"
      })
    ).resolves.toEqual({ outcome: "lost" });
    expect(mocks.revert).not.toHaveBeenCalled();
  });

  it("refuses a worker whose own token outlived its lease window", async () => {
    // The zombie: the heartbeat stalled past the lease, nobody has taken the row
    // over yet, so the expired token still matches. Reverting here would put a
    // shift back — and refund it — out from under the replacement that is free
    // to acquire the moment this transaction commits.
    const state = transaction({ leaseHeld: false });

    await expect(
      compensateStructuralPageChangeTx(state.tx as never, {
        projectId: "project-1",
        operationId: "op-1",
        expectedLeaseToken: "worker-1"
      })
    ).resolves.toEqual({ outcome: "lost" });
    expect(mocks.revert).not.toHaveBeenCalled();
    expect(state.updateOperation).not.toHaveBeenCalled();
  });

  it("still cancels through an expired lease when no token is named", async () => {
    // Stop owns the row by cancelling it rather than by leasing it, so the
    // liveness rule may not reach a caller that never claimed one.
    const state = transaction({ leaseHeld: false });

    await expect(
      compensateStructuralPageChangeTx(state.tx as never, { projectId: "project-1", operationId: "op-1" })
    ).resolves.toEqual({ outcome: "compensated", currentPlanId: "plan-1" });
    expect(mocks.revert).toHaveBeenCalledOnce();
  });

  it("refuses a worker carrying a different application stamp", async () => {
    const state = transaction();

    await expect(
      compensateStructuralPageChangeTx(state.tx as never, {
        projectId: "project-1",
        operationId: "op-1",
        expectedAppliedAt: "2026-08-29T00:00:01.000Z"
      })
    ).resolves.toEqual({ outcome: "lost" });
    expect(mocks.revert).not.toHaveBeenCalled();
  });

  it("is idempotent after the completion marker replaced the stamp", async () => {
    const state = transaction({
      classifier: {
        structuralRolledBackAt: "2026-08-29T00:00:01.000Z",
        structuralCompensation: { status: "COMPLETED" }
      }
    });

    await expect(
      compensateStructuralPageChangeTx(state.tx as never, { projectId: "project-1", operationId: "op-1" })
    ).resolves.toEqual({ outcome: "not-needed" });
    expect(mocks.revert).not.toHaveBeenCalled();
  });

  it("refuses to cancel through a malformed application stamp", async () => {
    const state = transaction({ classifier: { structuralApplication: { action: "insert" } } });

    await expect(
      compensateStructuralPageChangeTx(state.tx as never, { projectId: "project-1", operationId: "op-1" })
    ).resolves.toEqual({ outcome: "lost" });
    expect(mocks.revert).not.toHaveBeenCalled();
    expect(state.updateOperation).not.toHaveBeenCalled();
  });
});

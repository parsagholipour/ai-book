import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  prisma: {
    bookEditOperation: { update: vi.fn() },
    project: { update: vi.fn() },
    $transaction: vi.fn()
  },
  assertHeld: vi.fn(),
  stopHeartbeat: vi.fn(),
  startStructuralPageLeaseHeartbeat: vi.fn(),
  settleSkippedStructuralPageLeaseTx: vi.fn(),
  refundSkippedEditOperation: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("../generation/structuralPageLease.js", () => ({
  startStructuralPageLeaseHeartbeat: mocks.startStructuralPageLeaseHeartbeat,
  settleSkippedStructuralPageLeaseTx: mocks.settleSkippedStructuralPageLeaseTx,
  // The real predicate is an `instanceof`, and the real error is what
  // `assertHeld` throws; the name is the part the tests below need to forge.
  isStructuralPageLeaseLostError: (error: unknown) =>
    error instanceof Error && error.name === "StructuralPageLeaseLostError"
}));
vi.mock("../runtime/jobLifecycle.js", () => ({
  refundSkippedEditOperation: mocks.refundSkippedEditOperation
}));

import { settleSkippedRestructure } from "./restructurePagesSettlement.js";

/** What a renewal the database refused raises out of the heartbeat's barrier. */
const leaseLost = () => {
  const error = new Error("Structural page edit delivery lost its durable lease");
  error.name = "StructuralPageLeaseLostError";
  return error;
};

const job = { data: { projectId: "project-1", operationId: "op-1" }, id: "job-1" } as unknown as Job;

const settle = () =>
  settleSkippedRestructure({
    job,
    projectId: "project-1",
    operationId: "op-1",
    ownerToken: "owner-1",
    reason: "unknown_pages",
    fallbackStatus: "COMPLETE"
  });

describe("settleSkippedRestructure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startStructuralPageLeaseHeartbeat.mockReturnValue({
      assertHeld: mocks.assertHeld,
      stop: mocks.stopHeartbeat
    });
    mocks.assertHeld.mockResolvedValue(undefined);
    mocks.stopHeartbeat.mockResolvedValue(undefined);
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run(mocks.prisma)
    );
    mocks.settleSkippedStructuralPageLeaseTx.mockResolvedValue({ classifier: {} });
    mocks.refundSkippedEditOperation.mockResolvedValue(undefined);
  });

  it("refunds and settles while it still owns the delivery, merging onto the row the swap locked", async () => {
    mocks.settleSkippedStructuralPageLeaseTx.mockResolvedValue({
      classifier: { structuralRolledBackAt: "2026-08-19T00:00:00.000Z" }
    });

    await expect(settle()).resolves.toBe(true);

    expect(mocks.startStructuralPageLeaseHeartbeat).toHaveBeenCalledWith("op-1", "owner-1");
    expect(mocks.refundSkippedEditOperation).toHaveBeenCalledWith(job, expect.stringContaining("unknown_pages"));
    expect(mocks.settleSkippedStructuralPageLeaseTx).toHaveBeenCalledWith(mocks.prisma, "op-1", "owner-1");
    // Merged onto what the swap returned under its own lock, never onto a copy
    // read before the refund: a concurrent rollback's marker survives.
    expect(mocks.prisma.bookEditOperation.update).toHaveBeenCalledWith({
      where: { id: "op-1" },
      data: {
        classifier: { structuralRolledBackAt: "2026-08-19T00:00:00.000Z", structuralSkipped: "unknown_pages" }
      }
    });
    expect(mocks.prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "COMPLETE" }
    });
    expect(mocks.stopHeartbeat).toHaveBeenCalled();
  });

  it("holds the lease open across the refund, and proves it before spending anything", async () => {
    await settle();

    // The barrier is a renewal, so ownership is re-proved at the last moment the
    // refund can still be declined — and the heartbeat then carries it through a
    // ledger call the lease would otherwise expire under.
    expect(mocks.assertHeld.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.refundSkippedEditOperation.mock.invocationCallOrder[0]!
    );
    expect(mocks.startStructuralPageLeaseHeartbeat.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.assertHeld.mock.invocationCallOrder[0]!
    );
    expect(mocks.stopHeartbeat.mock.invocationCallOrder[0]!).toBeGreaterThan(
      mocks.prisma.project.update.mock.invocationCallOrder[0]!
    );
  });

  it("refunds nothing and writes nothing when a replacement already owns the edit", async () => {
    // The lease this delivery acquired for the refusal ran out before it got
    // here, and a replacement has taken the row and is shifting the book. The
    // charge belongs to that delivery now, so the money may not move either.
    mocks.assertHeld.mockRejectedValue(leaseLost());

    await expect(settle()).resolves.toBe(false);

    expect(mocks.refundSkippedEditOperation).not.toHaveBeenCalled();
    expect(mocks.settleSkippedStructuralPageLeaseTx).not.toHaveBeenCalled();
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    expect(mocks.stopHeartbeat).toHaveBeenCalled();
  });

  it("leaves the replacement's claim standing when the lease runs out during the refund", async () => {
    // The window the fence exists for: ownership was live when the refund
    // started and gone by the time it returned. The swap matches no row, so the
    // marker that would call the live edit a delivered no-op is never written,
    // the replacement's token is never cleared, and the book is not put back
    // down under a delivery that is still editing it.
    mocks.settleSkippedStructuralPageLeaseTx.mockResolvedValue(null);

    await expect(settle()).resolves.toBe(false);

    expect(mocks.refundSkippedEditOperation).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.bookEditOperation.update).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
  });

  it("hands a database failure on the barrier to the failure path instead of standing down", async () => {
    // Not takeover: nothing has been written, the row is still ACTIVE, and
    // `markFailed` settling it is exactly right. Only a refused renewal — real
    // takeover — is a silent stand-down.
    mocks.assertHeld.mockRejectedValue(new Error("database unavailable"));

    await expect(settle()).rejects.toThrow("database unavailable");
    expect(mocks.refundSkippedEditOperation).not.toHaveBeenCalled();
    expect(mocks.stopHeartbeat).toHaveBeenCalled();
  });
});

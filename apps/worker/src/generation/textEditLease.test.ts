import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  waitForStructuralPageLease: vi.fn(),
  tx: { $queryRawUnsafe: vi.fn() }
}));

vi.mock("./structuralPageLease.js", () => ({
  completeStructuralPageLease: vi.fn(),
  isStructuralPageLeaseLostError: vi.fn(),
  renewStructuralPageLeaseTx: vi.fn(),
  startStructuralPageLeaseHeartbeat: vi.fn(),
  waitForStructuralPageLease: mocks.waitForStructuralPageLease,
  waitForStructuralPageLeaseCompletion: vi.fn(),
  StructuralPageLeaseLostError: class StructuralPageLeaseLostError extends Error {}
}));

import {
  settleSkippedTextEditLeaseTx,
  waitForTextEditLease
} from "./textEditLease.js";

describe("text edit delivery lease", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the text wrapper's claim shape separate from structural application state", async () => {
    mocks.waitForStructuralPageLease.mockResolvedValue({
      outcome: "acquired",
      phase: "tail",
      application: { insertedPageIds: ["structural-only"] },
      expiresAt: new Date()
    });

    await expect(waitForTextEditLease("op-1", "owner-1")).resolves.toEqual({
      outcome: "acquired",
      phase: "tail"
    });
  });

  it("settles only a live ACTIVE text owner and returns its locked classifier", async () => {
    mocks.tx.$queryRawUnsafe.mockResolvedValue([
      { classifier: { preservedClassifierField: "keep" } }
    ]);

    await expect(
      settleSkippedTextEditLeaseTx(mocks.tx as never, "op-1", "owner-1")
    ).resolves.toEqual({ classifier: { preservedClassifierField: "keep" } });

    const [sql, operationId, ownerToken] = mocks.tx.$queryRawUnsafe.mock.calls[0]!;
    expect(sql).toContain('"status" = \'APPLIED\'');
    expect(sql).toContain('"affectedPageIndexes" = \'{}\'::integer[]');
    expect(sql).toContain('"structuralLeaseCompletedAt" = CURRENT_TIMESTAMP');
    expect(sql).toContain('"structuralLeaseToken" = $2');
    expect(sql).toContain('"structuralLeaseExpiresAt" > CURRENT_TIMESTAMP');
    expect(sql).toContain('"status" = \'ACTIVE\'');
    expect(operationId).toBe("op-1");
    expect(ownerToken).toBe("owner-1");
  });

  it("returns null without weakening the replacement's claim when the CAS loses", async () => {
    mocks.tx.$queryRawUnsafe.mockResolvedValue([]);

    await expect(
      settleSkippedTextEditLeaseTx(mocks.tx as never, "op-1", "stale-owner")
    ).resolves.toBeNull();
  });
});

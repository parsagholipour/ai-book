import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  bookEditOperationFindUnique: vi.fn(),
  refundCreditLedgerEntry: vi.fn(),
  refundLatestProjectOperationCredits: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  prisma: {
    generationJob: { findMany: mocks.findMany },
    bookEditOperation: { findUnique: mocks.bookEditOperationFindUnique }
  }
}));
vi.mock("@book-maker/db/billing", () => ({
  refundCreditLedgerEntry: mocks.refundCreditLedgerEntry,
  refundLatestProjectOperationCredits: mocks.refundLatestProjectOperationCredits
}));

import { settleLegacyStoppedJobs } from "./stopLegacySettlement.js";

/**
 * Which charge a stopped attempt-less book run refunds. These cases moved here
 * from `queue.test.ts` with the resolution itself; the stop-level cases there
 * still cover which rows reach this walk at all.
 */
describe("settling a stopped legacy book run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refundCreditLedgerEntry.mockResolvedValue({});
    mocks.refundLatestProjectOperationCredits.mockResolvedValue({});
  });

  it("refunds the charge stamped on the stopped run's own GENERATE_BOOK payload", async () => {
    await settleLegacyStoppedJobs("project-1", [
      { id: "job-book", type: "GENERATE_BOOK", payload: { planId: "plan-1", billingLedgerEntryId: "entry-own" } }
    ]);

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("entry-own", "Stopped by user");
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
  });

  it("resolves a fan-out job's charge through its plan's GENERATE_BOOK row, never a newer run's", async () => {
    mocks.findMany.mockResolvedValueOnce([
      { payload: { planId: "plan-2", billingLedgerEntryId: "entry-2" } },
      { payload: { planId: "plan-1", billingLedgerEntryId: "entry-1" } }
    ]);

    await settleLegacyStoppedJobs("project-1", [
      { id: "job-page", type: "GENERATE_PAGE", payload: { planId: "plan-1" } }
    ]);

    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("entry-1", "Stopped by user");
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
  });

  it("falls back to the latest FULL_BOOK_GENERATION charge when no payload is stamped", async () => {
    mocks.findMany.mockResolvedValueOnce([{ payload: { planId: "plan-1" } }]);

    await settleLegacyStoppedJobs("project-1", [
      { id: "job-page", type: "GENERATE_PAGE", payload: { planId: "plan-1" } }
    ]);

    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).toHaveBeenCalledWith({
      projectId: "project-1",
      operation: "FULL_BOOK_GENERATION",
      reason: "Stopped by user"
    });
  });
});

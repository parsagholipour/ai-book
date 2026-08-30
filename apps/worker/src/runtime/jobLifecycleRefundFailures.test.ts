import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookEditOperationFindUnique: vi.fn(),
  failGenerationAttempt: vi.fn(),
  refundCreditLedgerEntryPortion: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  Prisma: {},
  planRevisionRetryDelayMs: () => 1_000,
  prisma: {
    bookEditOperation: { findUnique: mocks.bookEditOperationFindUnique }
  }
}));

vi.mock("@book-maker/db/billing", () => ({
  failGenerationAttempt: mocks.failGenerationAttempt,
  markGenerationAttemptActive: vi.fn(),
  markGenerationAttemptSucceeded: vi.fn(),
  refundCreditLedgerEntry: vi.fn(),
  refundCreditLedgerEntryPortion: mocks.refundCreditLedgerEntryPortion,
  refundLatestProjectOperationCredits: vi.fn()
}));

import { refundSkippedEditOperation, refundUnwrittenEditPages } from "./jobLifecycle.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("job lifecycle refund failures", () => {
  it("lets a failed shortfall refund throw, for the reason a skipped edit's does", async () => {
    mocks.bookEditOperationFindUnique.mockResolvedValue({ ledgerEntryId: "ledger-op", creditsCharged: 200 });
    mocks.refundCreditLedgerEntryPortion.mockRejectedValue(new Error("ledger unavailable"));
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      refundUnwrittenEditPages(job({ operationId: "op-1" }), {
        billedPages: 5,
        writtenPages: 2,
        reason: "wrote 2 of 5"
      })
    ).rejects.toThrow("ledger unavailable");
    logged.mockRestore();
  });

  it("lets a failed settlement of a skipped edit throw, rather than keeping the charge quietly", async () => {
    // The caller has not settled its operation yet, so the throw reaches
    // markFailed, which asks for the same refund against a row still ACTIVE.
    mocks.failGenerationAttempt.mockRejectedValue(new Error("ledger unavailable"));

    await expect(
      refundSkippedEditOperation(job({ operationId: "op-1", attemptId: "attempt-1" }), "skipped")
    ).rejects.toThrow("ledger unavailable");
  });
});

function job(data: Record<string, unknown>) {
  return {
    name: "apply-book-edit",
    data: { projectId: "project-1", generationJobId: "job-apply-book-edit", ...data },
    attemptsMade: 0,
    opts: { attempts: 3 }
  } as never;
}

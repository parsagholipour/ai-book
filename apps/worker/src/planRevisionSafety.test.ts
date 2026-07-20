import { describe, expect, it } from "vitest";
import { planRevisionConsistencyWarning } from "./planRevisionSafety.js";

describe("plan revision worker consistency", () => {
  it("accepts matching operation, job, and billing linkage", () => {
    expect(
      planRevisionConsistencyWarning({
        durableGenerationJobId: "job-2",
        linkedGenerationJobId: "job-2",
        linkedLedgerEntryId: "ledger-1",
        payloadLedgerEntryId: "ledger-1"
      })
    ).toBeNull();
  });

  it("rejects a stale operation job and billing mismatch", () => {
    expect(
      planRevisionConsistencyWarning({
        durableGenerationJobId: "job-2",
        linkedGenerationJobId: "job-1",
        linkedLedgerEntryId: "ledger-1",
        payloadLedgerEntryId: "ledger-1"
      })
    ).toBe("operation_job_mismatch");
    expect(
      planRevisionConsistencyWarning({
        durableGenerationJobId: "job-2",
        linkedGenerationJobId: "job-2",
        linkedLedgerEntryId: "ledger-1",
        payloadLedgerEntryId: "ledger-2"
      })
    ).toBe("billing_link_mismatch");
  });

  it("allows unbilled web revisions when both billing links are absent", () => {
    expect(
      planRevisionConsistencyWarning({
        durableGenerationJobId: "job-1",
        linkedGenerationJobId: "job-1",
        linkedLedgerEntryId: null,
        payloadLedgerEntryId: null
      })
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { planRevisionConsistencyWarning } from "./planRevisionSafety.js";

describe("plan revision worker consistency", () => {
  it("accepts matching operation, job, and paid billing linkage", () => {
    expect(
      planRevisionConsistencyWarning({
        durableGenerationJobId: "job-2",
        linkedGenerationJobId: "job-2",
        linkedLedgerEntryId: "ledger-1",
        payloadLedgerEntryId: "ledger-1",
        billingRequired: true
      })
    ).toBeNull();
  });

  it("rejects stale job and paid billing linkage failures", () => {
    expect(
      planRevisionConsistencyWarning({
        durableGenerationJobId: "job-2",
        linkedGenerationJobId: "job-1",
        linkedLedgerEntryId: "ledger-1",
        payloadLedgerEntryId: "ledger-1",
        billingRequired: true
      })
    ).toBe("operation_job_mismatch");
    expect(
      planRevisionConsistencyWarning({
        durableGenerationJobId: "job-2",
        linkedGenerationJobId: "job-2",
        linkedLedgerEntryId: "ledger-1",
        payloadLedgerEntryId: "ledger-2",
        billingRequired: true
      })
    ).toBe("billing_link_mismatch");
    expect(
      planRevisionConsistencyWarning({
        durableGenerationJobId: "job-2",
        linkedGenerationJobId: "job-2",
        linkedLedgerEntryId: null,
        payloadLedgerEntryId: null,
        billingRequired: true
      })
    ).toBe("billing_link_missing");
  });

  it("allows unbilled web revisions when both billing links are absent", () => {
    expect(
      planRevisionConsistencyWarning({
        durableGenerationJobId: "job-1",
        linkedGenerationJobId: "job-1",
        linkedLedgerEntryId: null,
        payloadLedgerEntryId: null,
        billingRequired: false
      })
    ).toBeNull();
  });
});

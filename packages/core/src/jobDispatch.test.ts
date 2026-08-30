import { describe, expect, it } from "vitest";
import {
  bookGenerationChargeFromPayloads,
  dispatchBackoffMs,
  generationJobTypeForWorkerName,
  jobNames,
  jsonPayloadToRecord,
  retryJobOptions,
  shouldBypassConfiguredRetries,
  shouldRecoverJobAttempt,
  workerJobNameForType
} from "./jobDispatch.js";

describe("worker job names", () => {
  it("maps every dispatchable JobType and rejects unknown ones", () => {
    for (const [type, name] of Object.entries(jobNames)) {
      expect(workerJobNameForType(type)).toBe(name);
    }
    // RESEARCH exists in the Prisma enum but nothing handles it; naming it
    // would let the API dispatch a job that could only die.
    expect(() => workerJobNameForType("RESEARCH")).toThrow(/Unknown generation job type/);
  });

  it("round-trips every name back to its type and answers null for an unknown one", () => {
    for (const [type, name] of Object.entries(jobNames)) {
      expect(generationJobTypeForWorkerName(name)).toBe(type);
    }
    // Null rather than a throw: the callers are display paths, where an
    // unrecognised name is an empty step list and not a failed job.
    expect(generationJobTypeForWorkerName("research")).toBeNull();
    expect(generationJobTypeForWorkerName("GENERATE_PAGE")).toBeNull();
  });
});

describe("job retry policy", () => {
  it("gives generate-page and generate-book retry budgets and leaves other jobs one-shot", () => {
    expect(retryJobOptions("generate-page")).toMatchObject({ attempts: 4 });
    expect(retryJobOptions("generate-book")).toMatchObject({ attempts: 2 });
    expect(retryJobOptions("generate-audiobook")).toMatchObject({ attempts: 3 });
    expect(retryJobOptions("compile-export")).toBeUndefined();
    expect(retryJobOptions("plan-book")).toBeUndefined();
  });

  it("budgets the two delivered-tail jobs so processJob's replay rethrow is redelivered", () => {
    // Both publish and settle in one transaction and then run a checkpointed
    // tail outside the failure boundary; with no budget the rethrow that is
    // supposed to replay that tail only moved the job to failed.
    expect(retryJobOptions("apply-book-edit")).toMatchObject({ attempts: 2 });
    expect(retryJobOptions("continue-book")).toMatchObject({ attempts: 2 });
  });

  it("never lets a delivered-tail budget be spent by the handler's own failure", () => {
    // The settlement path has already failed and refunded the edit, so a
    // redelivery would re-run it against the row it just settled — transient
    // network faults included, which is what separates these two names from
    // the network-retryable ones.
    for (const jobName of ["apply-book-edit", "continue-book"]) {
      expect(
        shouldRecoverJobAttempt({ jobName, attemptsMade: 0, maxAttempts: 2, recoverableNetworkError: true })
      ).toBe(false);
      expect(
        shouldBypassConfiguredRetries({ jobName, attemptsMade: 0, maxAttempts: 2, recoverableNetworkError: true })
      ).toBe(true);
      expect(
        shouldBypassConfiguredRetries({ jobName, attemptsMade: 0, maxAttempts: 2, recoverableNetworkError: false })
      ).toBe(true);
    }
  });

  it("recovers network failures while attempts remain", () => {
    expect(
      shouldRecoverJobAttempt({ jobName: "generate-book", attemptsMade: 0, maxAttempts: 2, recoverableNetworkError: true })
    ).toBe(true);
    expect(
      shouldRecoverJobAttempt({ jobName: "generate-page", attemptsMade: 2, maxAttempts: 4, recoverableNetworkError: true })
    ).toBe(true);
  });

  it("does not recover once the attempt budget is exhausted", () => {
    expect(
      shouldRecoverJobAttempt({ jobName: "generate-book", attemptsMade: 1, maxAttempts: 2, recoverableNetworkError: true })
    ).toBe(false);
  });

  it("does not recover deterministic failures or unmanaged job types", () => {
    expect(
      shouldRecoverJobAttempt({ jobName: "generate-book", attemptsMade: 0, maxAttempts: 2, recoverableNetworkError: false })
    ).toBe(false);
    expect(
      shouldRecoverJobAttempt({ jobName: "compile-export", attemptsMade: 0, maxAttempts: 2, recoverableNetworkError: true })
    ).toBe(false);
  });

  it("bypasses configured retries for deterministic failures on retryable jobs only", () => {
    expect(
      shouldBypassConfiguredRetries({ jobName: "generate-book", attemptsMade: 0, maxAttempts: 2, recoverableNetworkError: false })
    ).toBe(true);
    expect(
      shouldBypassConfiguredRetries({ jobName: "generate-book", attemptsMade: 0, maxAttempts: 2, recoverableNetworkError: true })
    ).toBe(false);
    expect(
      shouldBypassConfiguredRetries({ jobName: "plan-book", attemptsMade: 0, maxAttempts: 1, recoverableNetworkError: false })
    ).toBe(false);
  });
});

describe("dispatch backoff", () => {
  it("doubles from 5s and caps at 5 minutes", () => {
    expect(dispatchBackoffMs(1)).toBe(5_000);
    expect(dispatchBackoffMs(2)).toBe(10_000);
    expect(dispatchBackoffMs(7)).toBe(300_000);
  });
});

describe("jsonPayloadToRecord", () => {
  it("keeps records and turns everything else into an empty one", () => {
    expect(jsonPayloadToRecord({ planId: "plan-1" })).toEqual({ planId: "plan-1" });
    expect(jsonPayloadToRecord(null)).toEqual({});
    expect(jsonPayloadToRecord([1, 2])).toEqual({});
    expect(jsonPayloadToRecord("nope")).toEqual({});
  });
});

describe("bookGenerationChargeFromPayloads", () => {
  it("returns the entry of its own run's GENERATE_BOOK payload, never a newer run's", () => {
    const rows = [
      { payload: { planId: "plan-2", billingLedgerEntryId: "entry-2" } },
      { payload: { planId: "plan-1", billingLedgerEntryId: "entry-1" } }
    ];
    expect(bookGenerationChargeFromPayloads(rows, "plan-1")).toBe("entry-1");
    expect(bookGenerationChargeFromPayloads(rows, "plan-2")).toBe("entry-2");
  });

  it("skips unstamped and malformed payloads and reports nothing rather than guessing", () => {
    const rows = [
      { payload: { planId: "plan-1" } },
      { payload: { planId: "plan-1", billingLedgerEntryId: "" } },
      { payload: null }
    ];
    expect(bookGenerationChargeFromPayloads(rows, "plan-1")).toBeNull();
    expect(bookGenerationChargeFromPayloads([], "plan-1")).toBeNull();
  });
});

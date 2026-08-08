import { describe, expect, it } from "vitest";
import {
  bookGenerationChargeFromPayloads,
  dispatchBackoffMs,
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
});

describe("job retry policy", () => {
  it("gives generate-page and generate-book retry budgets and leaves other jobs one-shot", () => {
    expect(retryJobOptions("generate-page")).toMatchObject({ attempts: 4 });
    expect(retryJobOptions("generate-book")).toMatchObject({ attempts: 2 });
    expect(retryJobOptions("generate-audiobook")).toMatchObject({ attempts: 3 });
    expect(retryJobOptions("compile-export")).toBeUndefined();
    expect(retryJobOptions("plan-book")).toBeUndefined();
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

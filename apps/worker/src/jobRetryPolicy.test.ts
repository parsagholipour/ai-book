import { describe, expect, it } from "vitest";
import {
  retryJobOptions,
  shouldBypassConfiguredRetries,
  shouldRecoverJobAttempt
} from "./jobRetryPolicy.js";

describe("job retry policy", () => {
  it("gives generate-page and generate-book retry budgets and leaves other jobs one-shot", () => {
    expect(retryJobOptions("generate-page")).toMatchObject({ attempts: 4 });
    expect(retryJobOptions("generate-book")).toMatchObject({ attempts: 2 });
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

import { describe, expect, it } from "vitest";
import { STOPPED_JOB_ERROR, STOPPED_JOB_MESSAGE, isStoppedGenerationJob } from "./jobTypes.js";

describe("isStoppedGenerationJob", () => {
  it("reads the stop markers a stop writes", () => {
    expect(isStoppedGenerationJob({ status: "FAILED", message: STOPPED_JOB_MESSAGE, error: null })).toBe(true);
    expect(isStoppedGenerationJob({ status: "FAILED", message: "Failed", error: STOPPED_JOB_ERROR })).toBe(true);
    expect(isStoppedGenerationJob({ status: "FAILED", message: "Failed", error: "Provider timed out" })).toBe(false);
    expect(isStoppedGenerationJob({ status: "ACTIVE", message: "Drafting page 4", error: null })).toBe(false);
  });

  it("treats a row deleted with its book as stopped, so the run stops paying providers", () => {
    // Both delete routes stop the jobs and delete the project in one request;
    // the cascade takes the row before most runs next look at it.
    expect(isStoppedGenerationJob(null)).toBe(true);
  });
});

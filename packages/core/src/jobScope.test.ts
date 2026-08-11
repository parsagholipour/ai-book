import { describe, expect, it } from "vitest";
import {
  DERIVATIVE_GENERATION_JOBS,
  DETACHED_FROM_PROJECT_LIFECYCLE,
  PRESENTATION_ONLY_RECOMPILE,
  generationJobControlsProjectStatus,
  isDerivativeGenerationJobType,
  isDerivativeWorkerJobName,
  jobOwnsQualityVerdict,
  workerJobControlsProjectStatus
} from "./jobScope.js";

describe("generation job scope", () => {
  it("keeps every declared derivative type and worker name outside the book lifecycle", () => {
    for (const [type, name] of Object.entries(DERIVATIVE_GENERATION_JOBS)) {
      expect(isDerivativeGenerationJobType(type)).toBe(true);
      expect(isDerivativeWorkerJobName(name)).toBe(true);
      expect(generationJobControlsProjectStatus(type)).toBe(false);
      expect(workerJobControlsProjectStatus(name)).toBe(false);
    }
  });

  it("keeps book-changing operations in the project lifecycle", () => {
    for (const [type, name] of [
      ["GENERATE_BOOK", "generate-book"],
      ["GENERATE_PAGE", "generate-page"],
      ["COMPILE_EXPORT", "compile-export"],
      ["APPLY_BOOK_EDIT", "apply-book-edit"],
      ["CONTINUE_BOOK", "continue-book"]
    ] as const) {
      expect(generationJobControlsProjectStatus(type)).toBe(true);
      expect(workerJobControlsProjectStatus(name)).toBe(true);
    }
  });

  it("defaults unknown future jobs to the book lifecycle", () => {
    expect(generationJobControlsProjectStatus("FUTURE_JOB")).toBe(true);
    expect(workerJobControlsProjectStatus("future-job")).toBe(true);
  });
});

describe("jobOwnsQualityVerdict", () => {
  it("gives the verdict to the compile that reviewed the manuscript", () => {
    expect(jobOwnsQualityVerdict("COMPILE_EXPORT", { planId: "plan-1" })).toBe(true);
  });

  it("keeps an edit's own recompile owning it, even though it skips final review", () => {
    // The prose moved, so its deterministic-only report has to replace findings
    // about text that no longer exists — otherwise the quality card names an
    // issue on a page the reader just fixed, forever.
    expect(jobOwnsQualityVerdict("COMPILE_EXPORT", { planId: "plan-1", skipFinalReview: true })).toBe(true);
  });

  it("refuses a detached export repair", () => {
    expect(
      jobOwnsQualityVerdict("COMPILE_EXPORT", {
        planId: "plan-1",
        skipFinalReview: true,
        [DETACHED_FROM_PROJECT_LIFECYCLE]: true
      })
    ).toBe(false);
  });

  it("refuses a presentation-only recompile", () => {
    expect(
      jobOwnsQualityVerdict("COMPILE_EXPORT", {
        planId: "plan-1",
        skipFinalReview: true,
        [PRESENTATION_ONLY_RECOMPILE]: true
      })
    ).toBe(false);
  });

  it("refuses every job that is not a compile", () => {
    for (const type of ["GENERATE_BOOK", "GENERATE_PAGE", "APPLY_BOOK_EDIT", "GENERATE_AUDIOBOOK"]) {
      expect(jobOwnsQualityVerdict(type, { planId: "plan-1" })).toBe(false);
    }
  });

  it("treats a missing or malformed payload as an owning compile", () => {
    // The flags are opt-out, and both are written by the one caller that means
    // them. A row whose payload never carried either is an ordinary compile.
    expect(jobOwnsQualityVerdict("COMPILE_EXPORT", null)).toBe(true);
    expect(jobOwnsQualityVerdict("COMPILE_EXPORT", [])).toBe(true);
    expect(jobOwnsQualityVerdict("COMPILE_EXPORT", "not-an-object")).toBe(true);
  });
});

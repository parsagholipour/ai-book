import { describe, expect, it } from "vitest";
import {
  DERIVATIVE_GENERATION_JOBS,
  generationJobControlsProjectStatus,
  isDerivativeGenerationJobType,
  isDerivativeWorkerJobName,
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

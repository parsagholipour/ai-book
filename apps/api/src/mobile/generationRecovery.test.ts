import { describe, expect, it } from "vitest";
import { DETACHED_FROM_PROJECT_LIFECYCLE, PRESENTATION_ONLY_RECOMPILE } from "@book-maker/core";
import { canRecoverGenerationJob } from "./generationRecovery.js";

describe("canRecoverGenerationJob", () => {
  const context = {
    currentPlanId: "plan-1",
    currentPlanCreatedAt: null,
    pageIds: new Set<string>()
  };
  const createdAt = new Date("2026-08-01T00:00:00Z");

  it("recovers an ordinary failed compile against the current plan", () => {
    expect(
      canRecoverGenerationJob("COMPILE_EXPORT", { planId: "plan-1", skipFinalReview: true }, context, createdAt)
    ).toBe(true);
  });

  it("refuses a detached export repair — it re-queues on demand instead", () => {
    expect(
      canRecoverGenerationJob(
        "COMPILE_EXPORT",
        { planId: "plan-1", skipFinalReview: true, [DETACHED_FROM_PROJECT_LIFECYCLE]: true },
        context,
        createdAt
      )
    ).toBe(false);
  });

  it("refuses a presentation-only reprint — resuming one strands the book GENERATING", () => {
    // /resume sets the project GENERATING for whatever it requeues, but a
    // requeued reprint's publication claim names the EDITING it was born
    // under, so it can never publish from there: it stands down, COMPLETEs,
    // and leaves a delivered book spinning until the stranded-generation sweep
    // re-runs full QA nobody is charged for. The reader re-toggles the
    // preference instead, which queues a fresh reprint.
    expect(
      canRecoverGenerationJob(
        "COMPILE_EXPORT",
        { planId: "plan-1", skipFinalReview: true, [PRESENTATION_ONLY_RECOMPILE]: true },
        context,
        createdAt
      )
    ).toBe(false);
  });
});

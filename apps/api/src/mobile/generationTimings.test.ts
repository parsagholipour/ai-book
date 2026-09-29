import { describe, expect, it } from "vitest";
import { generationTimingsForPlan } from "./generationTimings.js";

const at = (minute: number) => new Date(Date.UTC(2026, 5, 15, 12, minute));

describe("generationTimingsForPlan", () => {
  it("uses the current plan revision and its successful full-book attempt", () => {
    const timings = generationTimingsForPlan([
      { operation: "PLAN_GENERATION", startedAt: at(0), finishedAt: at(2), primaryJob: { type: "PLAN_BOOK", payload: {} } },
      { operation: "PLAN_REVISION", startedAt: at(5), finishedAt: at(8), primaryJob: { type: "REVISE_PLAN", payload: { planId: "old-plan" } } },
      { operation: "FULL_BOOK_GENERATION", startedAt: at(10), finishedAt: at(12), primaryJob: { type: "GENERATE_BOOK", payload: { planId: "old-plan" } } },
      // A paid recovery can start with a page rather than GENERATE_BOOK.
      { operation: "FULL_BOOK_GENERATION", startedAt: at(12), finishedAt: at(20), primaryJob: { type: "GENERATE_PAGE", payload: { planId: "new-plan" } } }
    ], { id: "new-plan", createdAt: at(7), approvedAt: at(9) });
    expect(timings).toEqual({ planningMs: 3 * 60_000, bookMs: 8 * 60_000 });
  });

  it("omits a stage without a completed measured attempt", () => {
    expect(generationTimingsForPlan([
      { operation: "PLAN_GENERATION", startedAt: at(0), finishedAt: null, primaryJob: { type: "PLAN_BOOK", payload: {} } },
      { operation: "FULL_BOOK_GENERATION", startedAt: at(10), finishedAt: at(20), primaryJob: { type: "GENERATE_BOOK", payload: { planId: "plan" } } }
    ], { id: "plan", createdAt: at(1), approvedAt: null })).toEqual({ planningMs: null, bookMs: null });
  });
});

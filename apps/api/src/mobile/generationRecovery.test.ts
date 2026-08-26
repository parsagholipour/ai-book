import { describe, expect, it } from "vitest";
import { DETACHED_FROM_PROJECT_LIFECYCLE, PRESENTATION_ONLY_RECOMPILE } from "@book-maker/core";
import { canRecoverGenerationJob, laterJobSupersedesOwningFailure } from "./generationRecovery.js";

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

describe("laterJobSupersedesOwningFailure", () => {
  const failedPlan = {
    type: "PLAN_BOOK",
    payload: {},
    status: "FAILED"
  };

  it("treats a later plan job as the same work, even while it is still queued", () => {
    expect(
      laterJobSupersedesOwningFailure(failedPlan, [{ type: "PLAN_BOOK", status: "QUEUED", payload: {} }])
    ).toBe(true);
    expect(
      laterJobSupersedesOwningFailure(failedPlan, [{ type: "PLAN_BOOK", status: "ACTIVE", payload: {} }])
    ).toBe(true);
    expect(
      laterJobSupersedesOwningFailure(failedPlan, [{ type: "PLAN_BOOK", status: "COMPLETED", payload: {} }])
    ).toBe(true);
    expect(
      laterJobSupersedesOwningFailure(failedPlan, [{ type: "REVISE_PLAN", status: "COMPLETED", payload: {} }])
    ).toBe(true);
  });

  it("does not treat a second failed plan, or a canceled retry, as a replacement", () => {
    expect(
      laterJobSupersedesOwningFailure(failedPlan, [{ type: "PLAN_BOOK", status: "FAILED", payload: {} }])
    ).toBe(false);
    expect(
      laterJobSupersedesOwningFailure(failedPlan, [{ type: "PLAN_BOOK", status: "CANCELED", payload: {} }])
    ).toBe(false);
  });

  it("does not hide a failed page behind a later page of a different target", () => {
    expect(
      laterJobSupersedesOwningFailure(
        { type: "GENERATE_PAGE", payload: { pageId: "page-1" } },
        [{ type: "GENERATE_PAGE", status: "ACTIVE", payload: { pageId: "page-2" } }]
      )
    ).toBe(false);
  });

  it("hides a failed page once the same page is retried", () => {
    expect(
      laterJobSupersedesOwningFailure(
        { type: "GENERATE_PAGE", payload: { pageId: "page-1" } },
        [{ type: "GENERATE_PAGE", status: "COMPLETED", payload: { pageId: "page-1" } }]
      )
    ).toBe(true);
  });

  it("does not match fan-out jobs that never named a target", () => {
    expect(
      laterJobSupersedesOwningFailure(
        { type: "GENERATE_PAGE", payload: {} },
        [{ type: "GENERATE_PAGE", status: "ACTIVE", payload: {} }]
      )
    ).toBe(false);
  });

  it("hides a failed cover once a later cover job is running", () => {
    expect(
      laterJobSupersedesOwningFailure(
        { type: "GENERATE_IMAGE", payload: { assetType: "COVER" } },
        [{ type: "GENERATE_IMAGE", status: "ACTIVE", payload: { assetType: "COVER" } }]
      )
    ).toBe(true);
  });

  it("does not hide a failed cover behind a later page illustration", () => {
    expect(
      laterJobSupersedesOwningFailure(
        { type: "GENERATE_IMAGE", payload: { assetType: "COVER" } },
        [{ type: "GENERATE_IMAGE", status: "COMPLETED", payload: { pageId: "page-1" } }]
      )
    ).toBe(false);
  });

  it("hides a failed book job once a later book job is queued", () => {
    expect(
      laterJobSupersedesOwningFailure(
        { type: "GENERATE_BOOK", payload: { planId: "plan-1" } },
        [{ type: "GENERATE_BOOK", status: "QUEUED", payload: { planId: "plan-1" } }]
      )
    ).toBe(true);
  });

  it("hides an owning compile once a later owning compile is queued", () => {
    expect(
      laterJobSupersedesOwningFailure(
        { type: "COMPILE_EXPORT", payload: { planId: "plan-1" } },
        [{ type: "COMPILE_EXPORT", status: "QUEUED", payload: { planId: "plan-1" } }]
      )
    ).toBe(true);
  });

  it("does not hide an owning compile behind a later detached repair", () => {
    expect(
      laterJobSupersedesOwningFailure(
        { type: "COMPILE_EXPORT", payload: { planId: "plan-1" } },
        [
          {
            type: "COMPILE_EXPORT",
            status: "COMPLETED",
            payload: { planId: "plan-1", [DETACHED_FROM_PROJECT_LIFECYCLE]: true }
          }
        ]
      )
    ).toBe(false);
  });

  it("does not hide an owning compile behind a later presentation reprint", () => {
    expect(
      laterJobSupersedesOwningFailure(
        { type: "COMPILE_EXPORT", payload: { planId: "plan-1" } },
        [
          {
            type: "COMPILE_EXPORT",
            status: "COMPLETED",
            payload: { planId: "plan-1", [PRESENTATION_ONLY_RECOMPILE]: true }
          }
        ]
      )
    ).toBe(false);
  });

  it("hides a failed edit once the same operation is retried", () => {
    expect(
      laterJobSupersedesOwningFailure(
        { type: "APPLY_BOOK_EDIT", payload: { operationId: "op-1" } },
        [{ type: "APPLY_BOOK_EDIT", status: "QUEUED", payload: { operationId: "op-1" } }]
      )
    ).toBe(true);
  });

  it("does not hide a failed edit behind a later edit of a different operation", () => {
    expect(
      laterJobSupersedesOwningFailure(
        { type: "APPLY_BOOK_EDIT", payload: { operationId: "op-1" } },
        [{ type: "APPLY_BOOK_EDIT", status: "COMPLETED", payload: { operationId: "op-2" } }]
      )
    ).toBe(false);
  });
});

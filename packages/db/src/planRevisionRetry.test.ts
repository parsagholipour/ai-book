import { describe, expect, it } from "vitest";
import {
  PLAN_REVISION_AUTOMATIC_RETRY_LIMIT,
  canClaimPlanRevisionRetry,
  planRevisionRetryDelayMs,
  retryRequestKey
} from "./planRevisionRetry.ts";

const now = new Date("2026-07-21T12:00:00.000Z");

function state(overrides: Record<string, unknown> = {}) {
  return {
    status: "FAILED",
    automaticRetryCount: 0,
    automaticRetryLimit: PLAN_REVISION_AUTOMATIC_RETRY_LIMIT,
    nextRetryAt: null,
    generationJob: {
      status: "FAILED",
      startedAt: new Date("2026-07-21T11:00:00.000Z"),
      updatedAt: new Date("2026-07-21T11:01:00.000Z")
    },
    ...overrides
  } as any;
}

describe("durable plan revision retry policy", () => {
  it("allows failed revisions but never takes over active work", () => {
    expect(canClaimPlanRevisionRetry(state(), now)).toMatchObject({ eligible: true, staleActive: false });
    expect(
      canClaimPlanRevisionRetry(
        state({ status: "ACTIVE", generationJob: { status: "ACTIVE", startedAt: new Date("2026-07-21T11:00:00Z"), updatedAt: new Date("2026-07-21T11:01:00Z") } }),
        now
      )
    ).toMatchObject({ eligible: false, staleActive: false, reason: "operation is not failed" });
    expect(canClaimPlanRevisionRetry(state({ status: "ACTIVE", generationJob: { status: "ACTIVE", startedAt: now, updatedAt: now } }), now).eligible).toBe(false);
  });

  it("enforces retry budget and persisted backoff", () => {
    expect(canClaimPlanRevisionRetry(state({ automaticRetryCount: 2 }), now).reason).toContain("budget");
    expect(canClaimPlanRevisionRetry(state({ nextRetryAt: new Date(now.getTime() + 1) }), now).reason).toContain("backoff");
    expect(planRevisionRetryDelayMs(1)).toBe(30_000);
    expect(planRevisionRetryDelayMs(2)).toBe(60_000);
  });

  it("builds deterministic retry keys", () => {
    expect(retryRequestKey("operation-1", 2)).toBe("plan-revision-retry:operation-1:2");
  });
});

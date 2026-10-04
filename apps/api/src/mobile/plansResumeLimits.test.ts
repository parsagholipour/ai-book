import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { enqueueGenerationJob } from "../queue.js";
import { generationRecoveryQuote } from "./generationRetryQuote.js";
import {
  bearer, buildMobileApp, jobRecord, mockAccessTokens, mockBilling, mockPrisma,
  projectRecord, resetMobileHarness, teardownMobileHarness
} from "./testing/mobileApiHarness.js";

describe("generation retry limit responses", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
  });
  afterEach(teardownMobileHarness);

  // Exercise Fastify's response serializer: both refusals use HTTP 403, but
  // only the page-limit response contains the previously required pageLimit.
  it.each([
    { operation: "FULL_BOOK_GENERATION", limit: "images" },
    { operation: "IMAGE_GENERATION", limit: "images" },
    { operation: "FULL_BOOK_GENERATION", limit: "pages" },
    { operation: "BOOK_REPLAN", limit: "pages" }
  ] as const)("preserves the $limit refusal for $operation without charging", async ({ operation, limit }) => {
    const attempt = {
      id: "attempt-failed", userId: "user-a", commandKey: "mobile:generation:failed",
      requestFingerprint: "failed-generation", status: "FAILED", operation,
      quotedCredits: 776, projectId: "project-1", refundPending: false
    };
    mockPrisma.project.findFirst.mockResolvedValue(projectRecord({
      status: "FAILED", currentPlanId: "plan-1", targetPages: 60,
      currentPlan: { id: "plan-1", createdAt: new Date("2026-06-15T12:00:00.000Z") }
    }));
    mockPrisma.generationJob.findMany.mockResolvedValueOnce([jobRecord({
      id: "job-failed", type: operation === "IMAGE_GENERATION" ? "APPLY_BOOK_EDIT" : "GENERATE_PAGE",
      status: "FAILED", attemptId: attempt.id,
      payload: {
        planId: "plan-1", pageId: "page-1",
        ...(operation === "IMAGE_GENERATION" ? {
          operationId: "operation-image", intentKind: "add_image",
          imageInsertion: { subject: "a dragon", placement: "end_of_book", targetPageIndex: 2 }
        } : {})
      }
    })]);
    mockPrisma.page.findMany.mockResolvedValueOnce([{ id: "page-1" }]);
    mockPrisma.generationAttempt.findMany.mockResolvedValueOnce([attempt]);
    if (limit === "images") {
      const quota = { used: 3, limit: 3, periodKey: "2026-06", resetsAt: new Date("2026-07-01T00:00:00.000Z") };
      mockBilling.getImageQuota.mockResolvedValue(quota);
      mockBilling.consumeIllustratedBookUse.mockResolvedValue({ ...quota, allowed: false });
    } else {
      mockBilling.getBookPageLimit.mockResolvedValue(30);
    }
    const app = await buildMobileApp();
    try {
      const response = await app.inject({
        method: "POST", url: "/api/mobile/projects/project-1/resume", headers: bearer("token-a"),
        payload: { requestId: "retry-limit-response", retryToken: generationRecoveryQuote(attempt).retryToken }
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: limit === "images" ? {
          code: "IMAGE_LIMIT_REACHED", message: expect.stringMatching(/upgrade/i),
          imageQuota: { used: 3, limit: 3, resetsAt: "2026-07-01T00:00:00.000Z" }
        } : {
          code: "PAGE_LIMIT_EXCEEDED", message: expect.stringContaining("60-page book"),
          pageLimit: { limit: 30, requestedPages: 60, maxPages: 600 }
        }
      });
      expect(mockBilling.reserveCredits).not.toHaveBeenCalled();
      expect(enqueueGenerationJob).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

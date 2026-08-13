import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { consumeIllustratedBookUse, getImageQuota, grantProjectEntitlement, reserveCredits } from "@book-maker/db/billing";
import { DETACHED_FROM_PROJECT_LIFECYCLE } from "@book-maker/core";

import { enqueueGenerationJob, requeueGenerationJob } from "../queue.js";
import { generationRecoveryQuote } from "./generationRetryQuote.js";
import {
  appliedEditOperationRecord,
  bearer,
  buildMobileApp,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

/**
 * POST /api/mobile/projects/:id/resume — the confirmed paid retry lane. Split
 * from plans.test.ts, which holds the plan lifecycle and approval suites.
 */

describe("mobile generation resume", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("rejects a legacy no-body generation retry without charging", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(
      projectRecord({
        id: "project-1",
        currentPlanId: "plan-1",
        currentPlan: { id: "plan-1", createdAt: new Date("2026-06-15T12:00:00.000Z") }
      })
    );
    mockPrisma.generationJob.findMany.mockResolvedValueOnce([
      jobRecord({
        id: "job-failed-page",
        projectId: "project-1",
        type: "GENERATE_PAGE",
        status: "FAILED",
        payload: { pageId: "page-1", planId: "plan-1" },
        createdAt: new Date("2026-06-15T12:10:00.000Z")
      })
    ]);
    mockPrisma.page.findMany.mockResolvedValueOnce([{ id: "page-1" }]);
    mockPrisma.project.update.mockResolvedValueOnce({});
    vi.mocked(requeueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-failed-page", status: "QUEUED" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/resume",
      headers: bearer("token-a")
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("RETRY_CONFIRMATION_REQUIRED");
    expect(vi.mocked(requeueGenerationJob)).not.toHaveBeenCalled();
    expect(reserveCredits).not.toHaveBeenCalled();
    await app.close();
  });

  it("never resumes a failed export repair on a finished book", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: { id: "plan-1", createdAt: new Date("2026-06-15T12:00:00.000Z") }
      })
    );
    mockPrisma.generationJob.findMany.mockResolvedValueOnce([
      jobRecord({
        id: "job-repair-failed",
        projectId: "project-1",
        type: "COMPILE_EXPORT",
        status: "FAILED",
        payload: { planId: "plan-1", skipFinalReview: true, [DETACHED_FROM_PROJECT_LIFECYCLE]: true },
        createdAt: new Date("2026-06-15T12:10:00.000Z")
      })
    ]);
    mockPrisma.page.findMany.mockResolvedValueOnce([{ id: "page-1" }]);
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/resume",
      headers: bearer("token-a"),
      payload: { requestId: "generation-retry-0001", retryToken: "a".repeat(32) }
    });

    // Nothing to resume, and above all nothing that would move a COMPLETE book
    // back into GENERATING: a repair rebuilds a file for a book that is already
    // delivered, and the next download or status poll queues another one.
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("RECOVERY_NOT_AVAILABLE");
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    expect(vi.mocked(requeueGenerationJob)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    expect(reserveCredits).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not requeue a refunded initial-plan ledger from a legacy request", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(
      projectRecord({
        id: "project-1",
        status: "FAILED",
        currentPlanId: null,
        currentPlan: null
      })
    );
    const failedPlanPayload = {
      inputSnapshot: { prompt: "Write a practical onboarding guide." },
      billingLedgerEntryId: "ledger-plan"
    };
    mockPrisma.generationJob.findMany.mockResolvedValueOnce([
      jobRecord({
        id: "job-failed-plan",
        projectId: "project-1",
        type: "PLAN_BOOK",
        status: "FAILED",
        bullJobId: "bull-failed-plan",
        payload: failedPlanPayload,
        createdAt: new Date("2026-06-15T12:10:00.000Z")
      })
    ]);
    mockPrisma.page.findMany.mockResolvedValueOnce([]);
    mockPrisma.project.update.mockResolvedValueOnce({});
    vi.mocked(requeueGenerationJob).mockResolvedValueOnce(
      jobRecord({ id: "job-failed-plan", type: "PLAN_BOOK", status: "QUEUED" })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/resume",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("RETRY_CONFIRMATION_REQUIRED");
    expect(vi.mocked(requeueGenerationJob)).not.toHaveBeenCalled();
    expect(reserveCredits).not.toHaveBeenCalled();
    await app.close();
  });

  it("uses a confirmed quote to create a fresh charged recovery attempt", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const sourceAttempt = {
      id: "attempt-source",
      userId: "user-a",
      commandKey: "mobile:plan-approval:plan-1",
      requestFingerprint: "source-fingerprint",
      status: "FAILED",
      operation: "FULL_BOOK_GENERATION",
      quotedCredits: 776,
      projectId: "project-1",
      refundPending: false
    };
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        currentPlanId: "plan-1",
        currentPlan: { id: "plan-1", createdAt: new Date("2026-06-15T12:00:00.000Z") }
      })
    );
    mockPrisma.generationJob.findMany
      .mockResolvedValueOnce([
        jobRecord({
          id: "job-failed-page",
          projectId: "project-1",
          type: "GENERATE_PAGE",
          status: "FAILED",
          attemptId: sourceAttempt.id,
          payload: {
            pageId: "page-1",
            planId: "plan-1",
            billingLedgerEntryId: "refunded-ledger"
          }
        })
      ])
      .mockResolvedValueOnce([{ id: "job-paid-retry", status: "QUEUED" }]);
    mockPrisma.page.findMany.mockResolvedValueOnce([{ id: "page-1" }]);
    mockPrisma.generationAttempt.findMany.mockResolvedValueOnce([sourceAttempt]);
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(
      jobRecord({ id: "job-paid-retry", type: "GENERATE_PAGE" })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/resume",
      headers: bearer("token-a"),
      payload: {
        requestId: "generation-retry-0001",
        retryToken: generationRecoveryQuote(sourceAttempt).retryToken
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ resumedActions: 1, currentAction: "Picking up your book generation." });
    expect(reserveCredits).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "FULL_BOOK_GENERATION", amountCredits: 776 })
    );
    expect(enqueueGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: expect.stringContaining("attempt-mobile-generation-retry-attempt-source"),
        payload: expect.objectContaining({
          pageId: "page-1",
          billingLedgerEntryId: "ledger-FULL_BOOK_GENERATION"
        })
      })
    );
    // The retry re-charges the full package, so it re-grants what the refund
    // revoked: exports stay unlocked on the delivered book.
    expect(vi.mocked(grantProjectEntitlement)).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-a", type: "EXPORT_UNLOCK" })
    );
    await app.close();
  });

  it("re-claims the illustrated-book slot on a confirmed full-book retry", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const sourceAttempt = {
      id: "attempt-source",
      userId: "user-a",
      commandKey: "mobile:plan-approval:plan-1",
      requestFingerprint: "source-fingerprint",
      status: "FAILED",
      operation: "FULL_BOOK_GENERATION",
      quotedCredits: 776,
      projectId: "project-1",
      refundPending: false
    };
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        currentPlanId: "plan-1",
        currentPlan: { id: "plan-1", createdAt: new Date("2026-06-15T12:00:00.000Z") }
      })
    );
    mockPrisma.generationJob.findMany
      .mockResolvedValueOnce([
        jobRecord({
          id: "job-failed-page",
          projectId: "project-1",
          type: "GENERATE_PAGE",
          status: "FAILED",
          attemptId: sourceAttempt.id,
          payload: { pageId: "page-1", planId: "plan-1" }
        })
      ])
      .mockResolvedValueOnce([{ id: "job-paid-retry", status: "QUEUED" }]);
    mockPrisma.page.findMany.mockResolvedValueOnce([{ id: "page-1" }]);
    mockPrisma.generationAttempt.findMany.mockResolvedValueOnce([sourceAttempt]);
    vi.mocked(getImageQuota).mockResolvedValueOnce({
      used: 1,
      limit: 3,
      periodKey: "2026-06",
      resetsAt: new Date("2026-07-01T00:00:00.000Z")
    });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/resume",
      headers: bearer("token-a"),
      payload: {
        requestId: "generation-retry-0002",
        retryToken: generationRecoveryQuote(sourceAttempt).retryToken
      }
    });

    // The refund of the failed attempt released the slot, so the paid retry of
    // an illustrated package claims it again rather than bypassing the budget.
    expect(response.statusCode).toBe(202);
    expect(vi.mocked(consumeIllustratedBookUse)).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-a", limit: 3 })
    );
    await app.close();
  });

  describe("add_image retry slot re-claim", () => {
    const imageAttempt = {
      id: "attempt-image",
      userId: "user-a",
      commandKey: "mobile:add-image:operation-image",
      requestFingerprint: "image-fingerprint",
      status: "FAILED",
      operation: "IMAGE_GENERATION",
      quotedCredits: 45,
      projectId: "project-1",
      refundPending: false
    };

    function failedAddImageResume() {
      mockPrisma.project.findFirst.mockResolvedValue(
        projectRecord({
          id: "project-1",
          status: "COMPLETE",
          currentPlanId: "plan-1",
          currentPlan: { id: "plan-1", createdAt: new Date("2026-06-15T12:00:00.000Z") }
        })
      );
      mockPrisma.generationJob.findMany
        .mockResolvedValueOnce([
          jobRecord({
            id: "job-failed-image-edit",
            projectId: "project-1",
            type: "APPLY_BOOK_EDIT",
            status: "FAILED",
            attemptId: imageAttempt.id,
            payload: {
              operationId: "operation-image",
              planId: "plan-1",
              intentKind: "add_image",
              imageInsertion: { subject: "a dragon", placement: "end_of_book", targetPageIndex: 2 }
            }
          })
        ])
        .mockResolvedValueOnce([{ id: "job-image-retry", status: "QUEUED" }]);
      mockPrisma.generationAttempt.findMany.mockResolvedValueOnce([imageAttempt]);
    }

    async function confirmRetry(app: Awaited<ReturnType<typeof buildMobileApp>>) {
      return app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/resume",
        headers: bearer("token-a"),
        payload: {
          requestId: "generation-retry-0003",
          retryToken: generationRecoveryQuote(imageAttempt).retryToken
        }
      });
    }

    it("re-claims the slot for a free-tier retry of the edit that illustrates a text-only book", async () => {
      mockAccessTokens({ "token-a": "user-a" });
      failedAddImageResume();
      vi.mocked(getImageQuota).mockResolvedValueOnce({
        used: 1,
        limit: 3,
        periodKey: "2026-06",
        resetsAt: new Date("2026-07-01T00:00:00.000Z")
      });
      const app = await buildMobileApp();

      const response = await confirmRetry(app);

      // The refund of the failed add_image released the slot its Apply
      // claimed (the failed render left the book text-only), so the paid
      // retry claims it again rather than bypassing the budget.
      expect(response.statusCode).toBe(202);
      expect(vi.mocked(consumeIllustratedBookUse)).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user-a", limit: 3 })
      );
      expect(reserveCredits).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "IMAGE_GENERATION", amountCredits: 45 })
      );
      await app.close();
    });

    it("claims nothing on a paid tier", async () => {
      mockAccessTokens({ "token-a": "user-a" });
      failedAddImageResume();
      // getImageQuota keeps its default null: no limit on this plan.
      const app = await buildMobileApp();

      const response = await confirmRetry(app);

      expect(response.statusCode).toBe(202);
      expect(vi.mocked(consumeIllustratedBookUse)).not.toHaveBeenCalled();
      await app.close();
    });

    it("claims nothing for a book a prior applied ADD_IMAGE already illustrated", async () => {
      mockAccessTokens({ "token-a": "user-a" });
      failedAddImageResume();
      vi.mocked(getImageQuota).mockResolvedValueOnce({
        used: 1,
        limit: 3,
        periodKey: "2026-06",
        resetsAt: new Date("2026-07-01T00:00:00.000Z")
      });
      state.bookEditOperations.push(
        appliedEditOperationRecord({ id: "operation-earlier-image", kind: "ADD_IMAGE", requestId: "earlier" })
      );
      const app = await buildMobileApp();

      const response = await confirmRetry(app);

      expect(response.statusCode).toBe(202);
      expect(vi.mocked(consumeIllustratedBookUse)).not.toHaveBeenCalled();
      await app.close();
    });
  });

  it("rejects a confirmed retry whose paid retry already ran instead of replaying it as a 202", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const sourceAttempt = {
      id: "attempt-source",
      userId: "user-a",
      commandKey: "mobile:plan-approval:plan-1",
      requestFingerprint: "source-fingerprint",
      status: "FAILED",
      operation: "FULL_BOOK_GENERATION",
      quotedCredits: 776,
      projectId: "project-1",
      refundPending: false
    };
    // The paid retry of that attempt exists and has itself already failed.
    state.generationAttempts.push({
      id: "attempt-paid-retry",
      userId: "user-a",
      commandKey: "mobile:generation-retry:attempt-source:generation-retry-0001",
      requestFingerprint: "retry-fingerprint",
      status: "FAILED",
      operation: "FULL_BOOK_GENERATION",
      quotedCredits: 776,
      projectId: "project-1",
      retryOfAttemptId: "attempt-source",
      refundPending: false,
      primaryJobId: "job-paid-retry",
      ledgerEntryId: null,
      editOperationId: null,
      error: null,
      createdAt: new Date("2026-06-15T13:00:00.000Z")
    });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        currentPlanId: "plan-1",
        currentPlan: { id: "plan-1", createdAt: new Date("2026-06-15T12:00:00.000Z") }
      })
    );
    mockPrisma.generationJob.findMany
      .mockResolvedValueOnce([
        jobRecord({
          id: "job-failed-page",
          projectId: "project-1",
          type: "GENERATE_PAGE",
          status: "FAILED",
          attemptId: sourceAttempt.id,
          payload: { pageId: "page-1", planId: "plan-1" }
        })
      ])
      .mockResolvedValueOnce([{ id: "job-paid-retry", status: "FAILED" }]);
    mockPrisma.page.findMany.mockResolvedValueOnce([{ id: "page-1" }]);
    mockPrisma.generationAttempt.findMany.mockResolvedValueOnce([sourceAttempt]);
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/resume",
      headers: bearer("token-a"),
      payload: {
        requestId: "generation-retry-0002",
        retryToken: generationRecoveryQuote(sourceAttempt).retryToken
      }
    });

    // Replaying the spent retry queues nothing; a 202 would strand the app on
    // a dead quote. The refreshed status now quotes the failed retry itself.
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("RETRY_NOT_AVAILABLE");
    expect(reserveCredits).not.toHaveBeenCalled();
    await app.close();
  });
});

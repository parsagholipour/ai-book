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
  mockBilling,
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
      operation: "FULL_BOOK_GENERATION" as const,
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
      operation: "FULL_BOOK_GENERATION" as const,
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
      operation: "IMAGE_GENERATION" as const,
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
      operation: "FULL_BOOK_GENERATION" as const,
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
      operation: "FULL_BOOK_GENERATION" as const,
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

  /**
   * The retry is the repo's one multi-job `create` callback, and every job past
   * the first used to be neither stamped nor verified.
   *
   * `assertPrimaryJobBelongsToAttempt` only ever sees `primaryJobId`, which this
   * loop takes from the first job (`primaryJobId ??= job.id`). So a second job
   * answered from a key some other path had spent passed every check: the charge
   * committed, that row never carried this attempt's id to a worker, and the
   * dispatch query `where: { attemptId }` found one job where the reader had paid
   * for two — with nothing to mark the attempt succeeded or failed if the
   * pre-existing row had already finished. `enqueueGenerationJob` refuses it at
   * the enqueue now, which is the only place that can see a job the callback does
   * not name. A spy has no dedupe-key table, so a spent key is expressed here the
   * way the fake models one: an earlier call under that key carrying somebody
   * else's `attemptId`.
   */
  it("refuses a multi-job retry whose second job's key another attempt already spent", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const sourceAttempt = {
      id: "attempt-source",
      userId: "user-a",
      commandKey: "mobile:plan-approval:plan-1",
      requestFingerprint: "source-fingerprint",
      status: "FAILED",
      operation: "FULL_BOOK_GENERATION" as const,
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
    const failedJobs = ["page-1", "page-2"].map((pageId, index) =>
      jobRecord({
        id: `job-failed-${pageId}`,
        projectId: "project-1",
        type: "GENERATE_PAGE",
        status: "FAILED",
        attemptId: sourceAttempt.id,
        payload: { pageId, planId: "plan-1" },
        createdAt: new Date(`2026-06-15T12:1${index}:00.000Z`)
      })
    );
    mockPrisma.generationJob.findMany.mockImplementation(async (args: { where?: { status?: string } }) =>
      args?.where?.status === "FAILED" ? failedJobs : []
    );
    mockPrisma.page.findMany.mockResolvedValue([{ id: "page-1" }, { id: "page-2" }]);
    mockPrisma.generationAttempt.findMany.mockResolvedValue([sourceAttempt]);
    const rowsByKey = new Map<string, ReturnType<typeof jobRecord>>();
    vi.mocked(enqueueGenerationJob).mockImplementation(async (options) => {
      const key = options.dedupeKey ?? `undeduped-${rowsByKey.size}`;
      const existing = rowsByKey.get(key);
      if (existing) {
        return existing;
      }
      const created = jobRecord({
        id: `job-${key}`,
        type: options.type,
        ...(options.attemptId ? { attemptId: options.attemptId } : {})
      });
      rowsByKey.set(key, created);
      return created;
    });
    const app = await buildMobileApp();
    // Somebody else's row already stands under the *second* job's key.
    await vi.mocked(enqueueGenerationJob)({
      projectId: "project-1",
      type: "GENERATE_PAGE",
      dedupeKey: "generation-retry:attempt-source:job-failed-page-2",
      payload: { pageId: "page-2" },
      attemptId: "attempt-somebody-else"
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/resume",
      headers: bearer("token-a"),
      payload: {
        requestId: "generation-retry-0009",
        retryToken: generationRecoveryQuote(sourceAttempt).retryToken
      }
    });

    // Loud rather than a 202 that queues one action for a two-action price. The
    // real refusal happens inside the attempt transaction, so the reader is
    // charged nothing — which is what the wire sentence promises.
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("GENERATION_JOB_NOT_CLAIMED");
    expect(state.generationAttempts).toHaveLength(0);
    await app.close();
  });

  /**
   * Two taps of Retry are one reader asking for one retry.
   *
   * The route's `commandKey` carries the request's own `requestId` while its
   * jobs are deduped on `generation-retry:<sourceAttemptId>:<sourceJobId>`,
   * which does not move — so a second tap looks, from the keys alone, like a
   * fresh attempt about to be handed a row the first one already wrote, which
   * is what `assertPrimaryJobBelongsToAttempt` refuses. It never gets there:
   * `retryOfAttemptId` is `@unique`, so `startGenerationAttempt` finds the one
   * retry that attempt already has and replays it before the callback runs.
   * That is the whole reason the mismatched keys are safe, and nothing else
   * pinned it — the suite above only covers a retry that has already *run*.
   */
  it("replays the one retry a second tap under a new requestId asks for, charging once", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const sourceAttempt = {
      id: "attempt-source",
      userId: "user-a",
      commandKey: "mobile:plan-approval:plan-1",
      requestFingerprint: "source-fingerprint",
      status: "FAILED",
      operation: "FULL_BOOK_GENERATION" as const,
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
    const failedJob = jobRecord({
      id: "job-failed-page",
      projectId: "project-1",
      type: "GENERATE_PAGE",
      status: "FAILED",
      attemptId: sourceAttempt.id,
      payload: { pageId: "page-1", planId: "plan-1" }
    });
    // The failed row is still failed after the first retry, so both taps read
    // the same source job and derive the same dedupe key from it.
    mockPrisma.generationJob.findMany.mockImplementation(async (args: { where?: { status?: string } }) =>
      args?.where?.status === "FAILED" ? [failedJob] : [{ id: "job-paid-retry", status: "QUEUED" }]
    );
    mockPrisma.page.findMany.mockResolvedValue([{ id: "page-1" }]);
    mockPrisma.generationAttempt.findMany.mockResolvedValue([sourceAttempt]);
    // One row per dedupe key, the way the database behaves.
    const rowsByKey = new Map<string, ReturnType<typeof jobRecord>>();
    vi.mocked(enqueueGenerationJob).mockImplementation(async (options) => {
      const key = options.dedupeKey ?? `undeduped-${rowsByKey.size}`;
      const existing = rowsByKey.get(key);
      if (existing) {
        return existing;
      }
      const created = jobRecord({ id: `job-${key}`, type: options.type, ...(options.attemptId ? { attemptId: options.attemptId } : {}) });
      rowsByKey.set(key, created);
      return created;
    });
    const app = await buildMobileApp();
    const retryToken = generationRecoveryQuote(sourceAttempt).retryToken;
    const tap = (requestId: string) =>
      app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/resume",
        headers: bearer("token-a"),
        payload: { requestId, retryToken }
      });

    const first = await tap("generation-retry-0001");
    const second = await tap("generation-retry-0002");

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({ status: "recovery_started", resumedActions: 1 });
    // One attempt, one charge, one job row — and no second enqueue under the
    // key the first tap spent.
    expect(state.generationAttempts).toHaveLength(1);
    expect(vi.mocked(reserveCredits)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledTimes(1);
    await app.close();
  });

  /**
   * The same two taps, overlapping rather than sequential.
   *
   * The test above lets the first tap finish, so the second one meets a
   * *committed* retry and replays it. A real double-tap does not wait: both
   * requests read the same still-FAILED source, both derive
   * `generation-retry:<sourceAttemptId>:<sourceJobId>`, and the loser would be
   * handed the winner's row under a key it never wrote — a 500
   * `GENERATION_JOB_NOT_CLAIMED` for a reader who asked for one retry, and the
   * `RECOVERY_NOT_AVAILABLE` 409 written for concurrency sits behind the
   * enqueue loop where it could never answer it.
   *
   * It never gets there either, and for the same reason one tap earlier: the
   * `@unique` on `retryOfAttemptId` is an index, so the loser's `INSERT` blocks
   * on it and raises 23505 at `tx.generationAttempt.create` — *before* the
   * `create` callback — which `startGenerationAttempt` answers with
   * `findWinningAttempt`. One attempt, one charge, one enqueue, two 202s.
   * `reserveCredits` is slowed here so the second request is genuinely inside
   * the window, which is the only thing separating this from the sequential
   * case; `packages/db/src/generationAttempts.test.ts` measures the same
   * convergence against the real function.
   */
  it("converges two overlapping confirmations of one retry on a single charge", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const sourceAttempt = {
      id: "attempt-source",
      userId: "user-a",
      commandKey: "mobile:plan-approval:plan-1",
      requestFingerprint: "source-fingerprint",
      status: "FAILED",
      operation: "FULL_BOOK_GENERATION" as const,
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
    const failedJob = jobRecord({
      id: "job-failed-page",
      projectId: "project-1",
      type: "GENERATE_PAGE",
      status: "FAILED",
      attemptId: sourceAttempt.id,
      payload: { pageId: "page-1", planId: "plan-1" }
    });
    mockPrisma.generationJob.findMany.mockImplementation(async (args: { where?: { status?: string } }) =>
      args?.where?.status === "FAILED" ? [failedJob] : [{ id: "job-paid-retry", status: "QUEUED" }]
    );
    mockPrisma.page.findMany.mockResolvedValue([{ id: "page-1" }]);
    mockPrisma.generationAttempt.findMany.mockResolvedValue([sourceAttempt]);
    const rowsByKey = new Map<string, ReturnType<typeof jobRecord>>();
    vi.mocked(enqueueGenerationJob).mockImplementation(async (options) => {
      const key = options.dedupeKey ?? `undeduped-${rowsByKey.size}`;
      const existing = rowsByKey.get(key);
      if (existing) {
        return existing;
      }
      const created = jobRecord({ id: `job-${key}`, type: options.type, ...(options.attemptId ? { attemptId: options.attemptId } : {}) });
      rowsByKey.set(key, created);
      return created;
    });
    // Holds the winner inside its paid start long enough for the second
    // confirmation to reach the same claim.
    const reserved = vi.mocked(reserveCredits).getMockImplementation();
    vi.mocked(reserveCredits).mockImplementationOnce(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return reserved?.(input) ?? null;
    });
    const app = await buildMobileApp();
    const retryToken = generationRecoveryQuote(sourceAttempt).retryToken;
    const tap = (requestId: string) =>
      app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/resume",
        headers: bearer("token-a"),
        payload: { requestId, retryToken }
      });

    const [first, second] = await Promise.all([tap("generation-retry-0001"), tap("generation-retry-0002")]);

    expect([first.statusCode, second.statusCode]).toEqual([202, 202]);
    expect(second.json()).toMatchObject({ status: "recovery_started", resumedActions: 1 });
    expect(state.generationAttempts).toHaveLength(1);
    expect(vi.mocked(reserveCredits)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledTimes(1);
    await app.close();
  });

  /**
   * `GenerationAttemptJobClaimError` is a wiring fault and stays a 500, but its
   * message is written for whoever reads the log — it names the attempt, the
   * job and the spent key. Rethrown, Fastify's default handler put exactly that
   * on the wire. `editFailure.ts` (core) already keeps it off the operation row
   * the app parses; this is the other way out.
   */
  it("never ships a job-claim fault's own words in the resume route's 500", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const sourceAttempt = {
      id: "attempt-source",
      userId: "user-a",
      commandKey: "mobile:plan-approval:plan-1",
      requestFingerprint: "source-fingerprint",
      status: "FAILED",
      operation: "FULL_BOOK_GENERATION" as const,
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
    mockPrisma.generationJob.findMany.mockResolvedValueOnce([
      jobRecord({
        id: "job-failed-page",
        projectId: "project-1",
        type: "GENERATE_PAGE",
        status: "FAILED",
        attemptId: sourceAttempt.id,
        payload: { pageId: "page-1", planId: "plan-1" }
      })
    ]);
    mockPrisma.page.findMany.mockResolvedValueOnce([{ id: "page-1" }]);
    mockPrisma.generationAttempt.findMany.mockResolvedValueOnce([sourceAttempt]);
    mockBilling.startGenerationAttempt.mockRejectedValueOnce(
      new mockBilling.GenerationAttemptJobClaimError(
        "Generation attempt attempt-2 may not claim generation job job-1: it is already attempt attempt-1's work. " +
          "A create() callback must enqueue its own job with this attemptId, never return one it found under a spent dedupeKey."
      )
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/resume",
      headers: bearer("token-a"),
      payload: { requestId: "generation-retry-0001", retryToken: generationRecoveryQuote(sourceAttempt).retryToken }
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "GENERATION_JOB_NOT_CLAIMED",
        message: "That couldn’t be started, so nothing was charged. Try again in a moment."
      }
    });
    expect(response.body).not.toMatch(/dedupeKey|create\(\)|attemptId|attempt-\d|job-\d/);
    await app.close();
  });
});

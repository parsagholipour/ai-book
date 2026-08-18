import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { reserveCredits } from "@book-maker/db/billing";

import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import { generationRecoveryQuote } from "./generationRetryQuote.js";
import {
  approvedPlanRecord,
  bearer,
  buildMobileApp,
  failedPlanRevisionOperationRecord,
  jobRecord,
  mockAccessTokens,
  mockBilling,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

describe("mobile plan revision retries and operations", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("revises an approved plan from project chat when no generation job is active", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "GENERATING",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: []
      })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-chat-revise", type: "REVISE_PLAN" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Change rabbit into a fly before writing starts." }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toMatchObject({ kind: "plan_revision" });
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        type: "REVISE_PLAN",
        payload: expect.objectContaining({
          planId: "plan-1",
          message: "Change rabbit into a fly before writing starts."
        })
      })
    );
    expect(mockPrisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "PLANNING" }
    });
    expect(body.reply.content).toContain("reopen it for review");
    await app.close();
  });

  it("requires a quote and creates a newly charged attempt for a failed revision", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const failed = failedPlanRevisionOperationRecord();
    state.bookEditOperations.push(failed);
    const sourceAttempt = failed.generationAttempts[0]!;
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(
      jobRecord({ id: "job-paid-retry", type: "REVISE_PLAN" })
    );
    const app = await buildMobileApp();

    const unconfirmed = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/operations/operation-failed-revision/retry",
      headers: bearer("token-a"),
      payload: {}
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error.code).toBe("RETRY_CONFIRMATION_REQUIRED");
    expect(reserveCredits).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/operations/operation-failed-revision/retry",
      headers: bearer("token-a"),
      payload: {
        requestId: "retry-paid-0001",
        retryToken: generationRecoveryQuote(sourceAttempt).retryToken
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().operation).toMatchObject({
      id: "operation-failed-revision",
      status: "queued"
    });
    expect(reserveCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "PLAN_REVISION",
        amountCredits: 40,
        idempotencyKey:
          "generation-attempt:attempt-mobile-plan-revision-retry-attempt-failed-revision-retry-paid-0001"
      })
    );
    expect(enqueueGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "REVISE_PLAN",
        attemptId:
          "attempt-mobile-plan-revision-retry-attempt-failed-revision-retry-paid-0001",
        payload: expect.objectContaining({
          retryOfGenerationJobId: "job-failed-revision",
          billingLedgerEntryId: "ledger-PLAN_REVISION"
        })
      })
    );
    expect(dispatchGenerationJob).toHaveBeenCalledWith("job-paid-retry");
    await app.close();
  });

  it("creates a fresh charged job for a confirmed failed revision", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const failed = failedPlanRevisionOperationRecord({
      automaticRetryCount: 0,
      automaticRetryLimit: 2,
      nextRetryAt: null,
      retryRequestId: null,
      ledgerEntry: { id: "ledger-PLAN_REVISION", status: "SETTLED", entryType: "SPEND" },
      generationJob: {
        id: "job-failed-revision",
        status: "FAILED",
        payload: {
          planId: "plan-1",
          message: "Make it brighter.",
          editOperationId: "operation-failed-revision",
          billingLedgerEntryId: "ledger-PLAN_REVISION"
        },
        startedAt: new Date("2026-06-15T13:00:00.000Z"),
        updatedAt: new Date("2026-06-15T13:01:00.000Z")
      }
    });
    state.bookEditOperations.push(failed);
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-retry-1", type: "REVISE_PLAN" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/operations/operation-failed-revision/retry",
      headers: bearer("token-a"),
      payload: {
        requestId: "retry-request-0001",
        retryToken: generationRecoveryQuote(failed.generationAttempts[0]!).retryToken
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().operation).toMatchObject({ id: "operation-failed-revision", status: "queued" });
    expect(enqueueGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "REVISE_PLAN",
        dedupeKey: expect.stringContaining("plan-revision-retry:attempt-mobile-plan-revision-retry"),
        dispatch: false,
        payload: expect.objectContaining({
          billingLedgerEntryId: "ledger-PLAN_REVISION",
          retryOfGenerationJobId: "job-failed-revision"
        })
      })
    );
    expect(dispatchGenerationJob).toHaveBeenCalledWith("job-retry-1");
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("allows another confirmed charge only after the first retry also fails", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const failed = failedPlanRevisionOperationRecord();
    state.bookEditOperations.push(failed);
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
    vi.mocked(enqueueGenerationJob)
      .mockResolvedValueOnce(jobRecord({ id: "job-retry-1", type: "REVISE_PLAN" }))
      .mockResolvedValueOnce(jobRecord({ id: "job-retry-2", type: "REVISE_PLAN" }));
    const app = await buildMobileApp();

    const first = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/operations/operation-failed-revision/retry",
      headers: bearer("token-a"),
      payload: {
        requestId: "retry-command-1",
        retryToken: generationRecoveryQuote(failed.generationAttempts[0]!).retryToken
      }
    });
    expect(first.statusCode).toBe(202);

    Object.assign(failed, {
      status: "FAILED",
      generationJobId: "job-retry-1",
      generationJob: {
        id: "job-retry-1",
        status: "FAILED",
        payload: {
          planId: "plan-1",
          message: "Make it brighter.",
          editOperationId: failed.id,
          billingLedgerEntryId: failed.ledgerEntryId
        },
        startedAt: new Date("2026-06-15T13:02:00.000Z"),
        updatedAt: new Date("2026-06-15T13:03:00.000Z")
      },
      error: "The first recovery also failed."
    });
    failed.generationAttempts[0]!.status = "FAILED";

    const second = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/operations/operation-failed-revision/retry",
      headers: bearer("token-a"),
      payload: {
        requestId: "retry-command-2",
        retryToken: generationRecoveryQuote(failed.generationAttempts[0]!).retryToken
      }
    });

    expect(second.statusCode).toBe(202);
    expect(second.json().operation).toMatchObject({ status: "queued" });
    expect(enqueueGenerationJob).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dedupeKey: expect.stringContaining("plan-revision-retry:attempt-mobile-plan-revision-retry"),
        payload: expect.objectContaining({ retryOfGenerationJobId: "job-retry-1" })
      })
    );
    expect(dispatchGenerationJob).toHaveBeenLastCalledWith("job-retry-2");
    await app.close();
  });

  it("returns a retry conflict while another edit operation is open", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const failed = failedPlanRevisionOperationRecord();
    const competing = failedPlanRevisionOperationRecord({
      id: "operation-active-edit",
      generationJobId: "job-active-edit",
      status: "QUEUED",
      kind: "LOCAL_PATCH",
      requestId: null
    });
    state.bookEditOperations.push(failed, competing);
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/operations/operation-failed-revision/retry",
      headers: bearer("token-a"),
      payload: {
        requestId: "retry-while-busy",
        retryToken: generationRecoveryQuote(failed.generationAttempts[0]!).retryToken
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "RETRY_NOT_AVAILABLE" });
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps a concurrent attempt-claim conflict to a retry conflict", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const failed = failedPlanRevisionOperationRecord();
    const competing = failedPlanRevisionOperationRecord({
      id: "operation-race-winner",
      generationJobId: "job-race-winner",
      status: "ACTIVE",
      kind: "LOCAL_PATCH",
      requestId: null
    });
    state.bookEditOperations.push(failed, competing);
    let openOperationChecks = 0;
    mockPrisma.bookEditOperation.findFirst.mockImplementation(async ({ where }: { where: Record<string, any> }) => {
      if (typeof where.id === "string") return where.id === failed.id ? failed : null;
      if (where.status?.in) {
        openOperationChecks += 1;
        return openOperationChecks === 1 ? null : competing;
      }
      return null;
    });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
    mockBilling.startGenerationAttempt.mockRejectedValueOnce(
      new mockBilling.GenerationAttemptConflictError("That retry was already claimed.")
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/operations/operation-failed-revision/retry",
      headers: bearer("token-a"),
      payload: {
        requestId: "retry-race",
        retryToken: generationRecoveryQuote(failed.generationAttempts[0]!).retryToken
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "RETRY_NOT_AVAILABLE" });
    expect(openOperationChecks).toBe(1);
    await app.close();
  });

  it("does not run the former automatic paid-retry sweep", async () => {
    const first = failedPlanRevisionOperationRecord({ id: "operation-retry-error", projectId: "project-error" });
    const second = failedPlanRevisionOperationRecord({ id: "operation-retry-ok", projectId: "project-ok" });
    state.bookEditOperations.push(first, second);
    mockPrisma.bookEditOperation.findMany.mockResolvedValueOnce([
      { id: first.id, automaticRetryCount: 0, project: { userId: "user-a" } },
      { id: second.id, automaticRetryCount: 0, project: { userId: "user-a" } }
    ]);
    mockPrisma.project.findFirst.mockResolvedValue({ currentPlanId: "plan-1" });
    mockPrisma.$transaction.mockRejectedValueOnce(new Error("temporary database failure"));
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(
      jobRecord({ id: "job-reconciled", projectId: "project-ok", type: "REVISE_PLAN" })
    );
    const log = { info: vi.fn(), warn: vi.fn() };
    const { reconcileRetryablePlanRevisionOperations } = await import("../mobileProjects.js");

    const queued = await reconcileRetryablePlanRevisionOperations({ log });

    expect(queued).toBe(0);
    expect(dispatchGenerationJob).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("leaves superseded failures untouched for explicit recovery decisions", async () => {
    const superseded = failedPlanRevisionOperationRecord();
    state.bookEditOperations.push(superseded);
    mockPrisma.bookEditOperation.findMany.mockImplementation(async () =>
      state.bookEditOperations
        .filter(
          (operation) =>
            operation.kind === "PLAN_REVISION" && operation.status === "FAILED" && operation.automaticRetryCount < 2
        )
        .map((operation) => ({
          id: operation.id,
          project: { userId: "user-a" },
          automaticRetryCount: operation.automaticRetryCount,
          automaticRetryLimit: operation.automaticRetryLimit
        }))
    );
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", currentPlanId: "plan-2" });
    const log = { info: vi.fn(), warn: vi.fn() };
    const { reconcileRetryablePlanRevisionOperations } = await import("../mobileProjects.js");

    expect(await reconcileRetryablePlanRevisionOperations({ log })).toBe(0);
    expect(await reconcileRetryablePlanRevisionOperations({ log })).toBe(0);

    expect(superseded).toMatchObject({ automaticRetryCount: 0, nextRetryAt: null });
    expect(log.warn).not.toHaveBeenCalled();
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
  });

  it("does not schedule a background retry for a blocked revision", async () => {
    const blocked = failedPlanRevisionOperationRecord();
    state.bookEditOperations.push(
      blocked,
      failedPlanRevisionOperationRecord({
        id: "operation-open-edit",
        generationJobId: "job-open-edit",
        status: "QUEUED",
        kind: "LOCAL_PATCH",
        requestId: null
      })
    );
    mockPrisma.bookEditOperation.findMany.mockResolvedValueOnce([
      { id: blocked.id, project: { userId: "user-a" }, automaticRetryCount: 0, automaticRetryLimit: 2 }
    ]);
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
    const now = new Date("2026-06-15T14:00:00.000Z");
    const log = { info: vi.fn(), warn: vi.fn() };
    const { reconcileRetryablePlanRevisionOperations } = await import("../mobileProjects.js");

    expect(await reconcileRetryablePlanRevisionOperations({ log, now })).toBe(0);

    expect(blocked).toMatchObject({
      automaticRetryCount: 0,
      nextRetryAt: null
    });
    expect(log.info).not.toHaveBeenCalled();
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
  });

  it("keeps the legacy operation retry alias behind the same paid confirmation", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.bookEditOperations.push(failedPlanRevisionOperationRecord());
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-retry-alias", type: "REVISE_PLAN" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/book-edit-operations/operation-failed-revision/retry",
      headers: bearer("token-a"),
      payload: {
        requestId: "retry-request-alias",
        retryToken: generationRecoveryQuote(state.bookEditOperations[0].generationAttempts[0]).retryToken
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().operation.id).toBe("operation-failed-revision");
    await app.close();
  });

  it("does not silently convert an unbilled historical web revision into a paid retry", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.bookEditOperations.push(
      failedPlanRevisionOperationRecord({
        ledgerEntryId: null,
        ledgerEntry: null,
        creditsCharged: 0,
        classifier: { kind: "plan_revision", source: "web" },
        generationAttempts: [],
        generationJob: {
          id: "job-web-revision",
          status: "FAILED",
          payload: { planId: "plan-1", message: "Clarify the ending.", editOperationId: "operation-failed-revision" },
          startedAt: new Date("2026-06-15T13:00:00.000Z"),
          updatedAt: new Date("2026-06-15T13:01:00.000Z")
        }
      })
    );
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-web-retry", type: "REVISE_PLAN" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/operations/operation-failed-revision/retry",
      headers: bearer("token-a"),
      payload: { requestId: "retry-web-request", retryToken: "historical-web-retry-token" }
    });

    expect(response.statusCode).toBe(409);
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    expect(reserveCredits).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps a failed operation unchanged when atomic retry job creation fails", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const failed = failedPlanRevisionOperationRecord({ retryRequestId: null, automaticRetryCount: 0 });
    state.bookEditOperations.push(failed);
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
    vi.mocked(enqueueGenerationJob).mockRejectedValueOnce(new Error("database unavailable"));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/operations/operation-failed-revision/retry",
      headers: bearer("token-a"),
      payload: {
        requestId: "retry-rollback-id",
        retryToken: generationRecoveryQuote(failed.generationAttempts[0]!).retryToken
      }
    });

    expect(response.statusCode).toBe(500);
    expect(failed).toMatchObject({ status: "FAILED", automaticRetryCount: 0, retryRequestId: null });
    await app.close();
  });

  it("serializes failed plan revision operations with error details", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(projectRecord({ id: "project-1" }));
    state.bookEditOperations.push(failedPlanRevisionOperationRecord());
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().operations).toEqual([
      expect.objectContaining({
        id: "operation-failed-revision",
        kind: "plan_revision",
        status: "failed",
        currentAction: "Plan revision failed.",
        error: "AI plan revision failed. No revised plan was created.",
        anchorMessageId: "chat-assistant-1",
        job: expect.objectContaining({
          id: "job-failed-revision",
          status: "failed"
        })
      })
    ]);
    await app.close();
  });

  it("anchors an operation to its user message when no reply was written", async () => {
    // The app renders an operation's outcome under its anchor. Without one it
    // falls back to the end of the transcript, where an applied edit reads as
    // the result of whatever the user asked most recently.
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(projectRecord({ id: "project-1" }));
    state.bookEditOperations.push(failedPlanRevisionOperationRecord({ assistantMessageId: null }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });

    expect(response.json().operations[0]).toMatchObject({ anchorMessageId: "chat-user-1" });
    await app.close();
  });

  it("reports a failed operation's credits as refunded, both refund shapes", async () => {
    // A failure is refunded. Showing its price with nothing to say otherwise
    // reads as a charge the user actually paid.
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(projectRecord({ id: "project-1" }));
    // Released in place: the spend never settled.
    state.bookEditOperations.push(
      failedPlanRevisionOperationRecord({ id: "operation-released", ledgerEntry: { id: "ledger-1", status: "REFUNDED" } })
    );
    // Settled, then reversed by a separate entry.
    state.bookEditOperations.push(
      failedPlanRevisionOperationRecord({
        id: "operation-reversed",
        ledgerEntry: {
          id: "ledger-2",
          status: "SETTLED",
          reversedByEntry: { id: "ledger-refund", amountCredits: 40 }
        }
      })
    );
    // Partly delivered: reports the exact return without claiming the whole
    // operation was refunded.
    state.bookEditOperations.push(
      failedPlanRevisionOperationRecord({
        id: "operation-partial",
        creditsCharged: 35,
        ledgerEntry: {
          id: "ledger-4",
          status: "SETTLED",
          reversedByEntry: { id: "ledger-refund-partial", amountCredits: 20 }
        }
      })
    );
    // Charged and kept.
    state.bookEditOperations.push(
      failedPlanRevisionOperationRecord({ id: "operation-charged", ledgerEntry: { id: "ledger-3", status: "SETTLED" } })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });
    const byId = new Map<string, any>(response.json().operations.map((operation: any) => [operation.id, operation]));

    expect(byId.get("operation-released")).toMatchObject({ creditsRefunded: true, creditsRefundedAmount: 40 });
    expect(byId.get("operation-reversed")).toMatchObject({ creditsRefunded: true, creditsRefundedAmount: 40 });
    expect(byId.get("operation-partial")).toMatchObject({ creditsRefunded: false, creditsRefundedAmount: 20 });
    expect(byId.get("operation-charged")).toMatchObject({ creditsRefunded: false, creditsRefundedAmount: 0 });
    await app.close();
  });

  it("serializes retry metadata needed by the mobile recovery UX", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(projectRecord({ id: "project-1" }));
    state.bookEditOperations.push(
      failedPlanRevisionOperationRecord({
        requestId: "revision-stable-1",
        automaticRetryCount: 0,
        automaticRetryLimit: 2,
        nextRetryAt: new Date("2026-06-15T13:05:00.000Z")
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().operations[0]).toMatchObject({
      retryAvailable: true,
      nextRetryAt: null,
      retryState: "available",
      retryMessage: "Retry costs 40 credits. The failed attempt was refunded.",
      recoveryQuote: { credits: 40, retryToken: expect.any(String) },
      submittedText: "Make it brighter.",
      requestId: "revision-stable-1"
    });
    await app.close();
  });

  it("hides recovered failed plan revisions from project chat history", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(projectRecord({ id: "project-1" }));
    state.bookEditOperations.push(failedPlanRevisionOperationRecord());
    const basePlan = approvedPlanRecord().planningPackage as Record<string, unknown>;
    state.planVersions.push(
      approvedPlanRecord({
        id: "plan-recovered",
        version: 2,
        status: "DRAFT",
        approvedAt: null,
        planningPackage: { ...basePlan, title: "Recovered revised plan" },
        createdAt: new Date("2026-06-15T13:05:00.000Z"),
        updatedAt: new Date("2026-06-15T13:05:00.000Z")
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().operations).toEqual([]);
    expect(response.json().plans).toEqual([
      expect.objectContaining({
        id: "plan-recovered",
        title: "Recovered revised plan"
      })
    ]);
    await app.close();
  });

  it("serializes plan snapshots in project chat history", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(projectRecord({ id: "project-1" }));
    const basePlan = approvedPlanRecord().planningPackage as Record<string, unknown>;
    state.planVersions.push(
      approvedPlanRecord({
        id: "plan-original",
        version: 1,
        status: "SUPERSEDED",
        approvedAt: null,
        planningPackage: { ...basePlan, title: "Original plan" },
        createdAt: new Date("2026-06-15T10:00:00.000Z"),
        updatedAt: new Date("2026-06-15T10:30:00.000Z")
      }),
      approvedPlanRecord({
        id: "plan-revised",
        version: 2,
        status: "DRAFT",
        approvedAt: null,
        planningPackage: { ...basePlan, title: "Revised plan" },
        createdAt: new Date("2026-06-15T11:00:00.000Z"),
        updatedAt: new Date("2026-06-15T11:00:00.000Z")
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.plans).toEqual([
      expect.objectContaining({
        id: "plan-original",
        version: 1,
        status: "superseded",
        title: "Original plan"
      }),
      expect.objectContaining({
        id: "plan-revised",
        version: 2,
        status: "draft",
        title: "Revised plan"
      })
    ]);
    await app.close();
  });

  // The app draws a one-of picker or a several-of picker from answerKind, so a
  // question the planner meant as several answers has to arrive saying so.
  it("tells the app how many answers a plan question takes", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(projectRecord({ id: "project-1" }));
    const basePlan = approvedPlanRecord().planningPackage as Record<string, unknown>;
    state.planVersions.push(
      approvedPlanRecord({
        id: "plan-questions",
        status: "DRAFT",
        approvedAt: null,
        planningPackage: {
          ...basePlan,
          questions: [
            {
              prompt: "Which themes should the tales carry?",
              options: ["Forgiveness", "Patience", "Justice"],
              answerKind: "multi",
              allowCustom: true
            }
          ]
        }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().plans[0].questions).toEqual([
      {
        prompt: "Which themes should the tales carry?",
        options: ["Forgiveness", "Patience", "Justice"],
        answerKind: "multi",
        allowCustom: true
      }
    ]);
    await app.close();
  });
});

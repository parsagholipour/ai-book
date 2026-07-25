import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { reserveCredits } from "@book-maker/db/billing";

import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import {
  MockPrismaKnownRequestError,
  approvedPlanRecord,
  bearer,
  buildMobileApp,
  failedPlanRevisionOperationRecord,
  jobRecord,
  mockAccessTokens,
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

  it("retries one failed plan revision idempotently without charging again", async () => {
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
      payload: { requestId: "retry-request-0001" }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().operation).toMatchObject({ id: "operation-failed-revision", status: "queued" });
    expect(enqueueGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "REVISE_PLAN",
        dedupeKey: "plan-revision-retry:operation-failed-revision:1",
        dispatch: false,
        payload: expect.objectContaining({
          billingLedgerEntryId: "ledger-PLAN_REVISION",
          retryOfGenerationJobId: "job-failed-revision",
          retryNumber: 1
        })
      })
    );
    expect(dispatchGenerationJob).toHaveBeenCalledWith("job-retry-1");
    expect(reserveCredits).not.toHaveBeenCalled();
    await app.close();
  });

  it("queues a second recovery when the first recovery fails and the command ID changes", async () => {
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
      payload: { requestId: "retry-command-1" }
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

    const second = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/operations/operation-failed-revision/retry",
      headers: bearer("token-a"),
      payload: { requestId: "retry-command-2" }
    });

    expect(second.statusCode).toBe(202);
    expect(second.json().operation).toMatchObject({ status: "queued" });
    expect(enqueueGenerationJob).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dedupeKey: "plan-revision-retry:operation-failed-revision:2",
        payload: expect.objectContaining({ retryNumber: 2, retryOfGenerationJobId: "job-retry-1" })
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
      payload: { requestId: "retry-while-busy" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "RETRY_NOT_AVAILABLE" });
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    await app.close();
  });

  it("converts a partial-unique retry race into a conflict instead of a server error", async () => {
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
    mockPrisma.$transaction.mockRejectedValueOnce(
      new MockPrismaKnownRequestError("open operation conflict", { code: "P2002" })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/operations/operation-failed-revision/retry",
      headers: bearer("token-a"),
      payload: { requestId: "retry-race" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "RETRY_NOT_AVAILABLE" });
    expect(openOperationChecks).toBe(2);
    await app.close();
  });

  it("continues automatic retry reconciliation after one operation throws", async () => {
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

    expect(queued).toBe(1);
    expect(dispatchGenerationJob).toHaveBeenCalledWith("job-reconciled");
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        warning: "retry_reconciliation_failed",
        operationId: "operation-retry-error"
      }),
      "Plan revision retry reconciliation skipped one operation"
    );
  });

  it("keeps the legacy operation retry alias available", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.bookEditOperations.push(failedPlanRevisionOperationRecord());
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", currentPlanId: "plan-1" });
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-retry-alias", type: "REVISE_PLAN" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/book-edit-operations/operation-failed-revision/retry",
      headers: bearer("token-a"),
      payload: { requestId: "retry-request-alias" }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().operation.id).toBe("operation-failed-revision");
    await app.close();
  });

  it("retries an unbilled web plan revision without requiring a ledger", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.bookEditOperations.push(
      failedPlanRevisionOperationRecord({
        ledgerEntryId: null,
        ledgerEntry: null,
        creditsCharged: 0,
        classifier: { kind: "plan_revision", source: "web" },
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
      payload: { requestId: "retry-web-request" }
    });

    expect(response.statusCode).toBe(202);
    expect(enqueueGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatch: false,
        payload: expect.not.objectContaining({ billingLedgerEntryId: expect.any(String) })
      })
    );
    expect(reserveCredits).not.toHaveBeenCalled();
    await app.close();
  });

  it("restores a failed operation when durable retry job creation fails", async () => {
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
      payload: { requestId: "retry-rollback-id" }
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
        job: expect.objectContaining({
          id: "job-failed-revision",
          status: "failed"
        })
      })
    ]);
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
      nextRetryAt: "2026-06-15T13:05:00.000Z",
      retryState: "scheduled",
      retryMessage: "Retrying this plan revision automatically.",
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

});

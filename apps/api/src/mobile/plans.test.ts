import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { InsufficientCreditsError, grantProjectEntitlement, reserveCredits } from "@book-maker/db/billing";

import { enqueueGenerationJob, requeueGenerationJob } from "../queue.js";
import {
  bearer,
  buildMobileApp,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

describe("mobile plan lifecycle", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("queues mobile-safe plan creation, revision, and approval responses", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(projectRecord({ id: "project-1" }));
    mockPrisma.project.update.mockResolvedValue({});
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan" }));
    mockPrisma.planVersion.findFirst
      .mockResolvedValueOnce({ id: "plan-1", projectId: "project-1", status: "DRAFT" })
      .mockResolvedValueOnce({ id: "plan-1", projectId: "project-1", status: "DRAFT", project: projectRecord({ id: "project-1" }) });
    mockPrisma.planVersion.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.planVersion.update.mockResolvedValue({});
    vi.mocked(enqueueGenerationJob)
      .mockResolvedValueOnce(jobRecord({ id: "job-revise" }))
      .mockResolvedValueOnce(jobRecord({ id: "job-generate" }));
    const app = await buildMobileApp();

    const plan = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/plan",
      headers: bearer("token-a"),
      payload: {}
    });
    const revise = await app.inject({
      method: "POST",
      url: "/api/mobile/plans/plan-1/revise",
      headers: bearer("token-a"),
      payload: { message: "Make the examples warmer and more practical." }
    });
    const approve = await app.inject({
      method: "POST",
      url: "/api/mobile/plans/plan-1/approve",
      headers: bearer("token-a")
    });

    expect(plan.statusCode).toBe(202);
    expect(plan.json()).toMatchObject({
      projectId: "project-1",
      planId: null,
      status: "planning_queued",
      job: { id: "job-plan", status: "queued" }
    });
    expect(revise.statusCode).toBe(202);
    expect(revise.json()).toMatchObject({
      projectId: "project-1",
      planId: "plan-1",
      status: "revision_queued",
      job: { id: "job-revise", status: "queued" }
    });
    expect(approve.statusCode).toBe(202);
    expect(approve.json()).toMatchObject({
      projectId: "project-1",
      planId: "plan-1",
      status: "generation_queued",
      job: { id: "job-generate", status: "queued" }
    });
    expect(vi.mocked(enqueueGenerationJob).mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ projectId: "project-1", type: "PLAN_BOOK" }),
      expect.objectContaining({
        projectId: "project-1",
        type: "REVISE_PLAN",
        payload: expect.objectContaining({
          planId: "plan-1",
          message: "Make the examples warmer and more practical.",
          billingLedgerEntryId: "ledger-PLAN_REVISION",
          editOperationId: "operation-1"
        })
      }),
      expect.objectContaining({
        projectId: "project-1",
        type: "GENERATE_BOOK",
        payload: expect.objectContaining({ planId: "plan-1", billingLedgerEntryId: "ledger-FULL_BOOK_GENERATION" })
      })
    ]);
    expect(vi.mocked(reserveCredits)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-a",
        projectId: "project-1",
        operation: "PLAN_REVISION",
        amountCredits: expect.any(Number)
      })
    );
    expect(vi.mocked(reserveCredits)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-a",
        projectId: "project-1",
        operation: "FULL_BOOK_GENERATION",
        amountCredits: expect.any(Number)
      })
    );
    expect(vi.mocked(grantProjectEntitlement)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-a",
        projectId: "project-1",
        type: "EXPORT_UNLOCK",
        relatedLedgerEntryId: "ledger-FULL_BOOK_GENERATION"
      })
    );
    expect(JSON.stringify({ plan: plan.json(), revise: revise.json(), approve: approve.json() })).not.toMatch(
      /strategy|provider|model|temperature/
    );
    await app.close();
  });

  it("retries recoverable mobile generation failures without returning queue internals", async () => {
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
    const body = response.json();

    expect(response.statusCode).toBe(202);
    expect(body).toEqual({
      projectId: "project-1",
      status: "recovery_started",
      currentAction: "Picking up your book generation.",
      resumedActions: 1,
      skippedActions: 0,
      stoppingActions: 0
    });
    expect(mockPrisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "GENERATING" }
    });
    expect(vi.mocked(requeueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "job-failed-page",
        projectId: "project-1",
        type: "GENERATE_PAGE",
        payload: { pageId: "page-1", planId: "plan-1" }
      })
    );
    expect(JSON.stringify(body)).not.toMatch(/jobs|queue|provider|model|temperature/);
    await app.close();
  });

  it("rejects mobile plan approval when credits are insufficient", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.planVersion.findFirst.mockResolvedValueOnce({
      id: "plan-1",
      projectId: "project-1",
      status: "DRAFT",
      project: projectRecord({ id: "project-1" })
    });
    vi.mocked(reserveCredits).mockRejectedValueOnce(
      new InsufficientCreditsError({ requiredCredits: 980, availableCredits: 100, reservedCredits: 0 })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/plans/plan-1/approve",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toEqual({
      error: {
        code: "INSUFFICIENT_CREDITS",
        message: "You need more credits for this action.",
        requiredCredits: 980,
        availableCredits: 100,
        reservedCredits: 0
      }
    });
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    await app.close();
  });

});

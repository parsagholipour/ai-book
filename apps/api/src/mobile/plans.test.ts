import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  InsufficientCreditsError,
  consumeIllustratedBookUse,
  getImageQuota,
  grantProjectEntitlement,
  releaseIllustratedBookUse,
  reserveCredits
} from "@book-maker/db/billing";
import { DEFAULT_CREDIT_COSTS } from "@book-maker/core";

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

  it("requeues a failed initial plan as a planning recovery", async () => {
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

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      projectId: "project-1",
      status: "recovery_started",
      currentAction: "Retrying your book plan.",
      resumedActions: 1,
      skippedActions: 0,
      stoppingActions: 0
    });
    expect(mockPrisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "PLANNING" }
    });
    expect(vi.mocked(requeueGenerationJob)).toHaveBeenCalledWith({
      id: "job-failed-plan",
      projectId: "project-1",
      type: "PLAN_BOOK",
      payload: failedPlanPayload
    });
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

describe("free tier illustrated book limit", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  const freeQuota = (used: number) => ({
    used,
    limit: 3,
    periodKey: "2026-06",
    resetsAt: new Date("2026-07-01T00:00:00.000Z")
  });

  function draftPlanForApproval(project = projectRecord({ id: "project-1" })) {
    mockPrisma.planVersion.findFirst.mockResolvedValueOnce({
      id: "plan-1",
      projectId: "project-1",
      status: "DRAFT",
      project
    });
  }

  it("refuses a fourth illustrated book and points at the upgrade", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    draftPlanForApproval();
    vi.mocked(getImageQuota).mockResolvedValueOnce(freeQuota(3));
    vi.mocked(consumeIllustratedBookUse).mockResolvedValueOnce({ allowed: false, ...freeQuota(3) });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/plans/plan-1/approve",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatchObject({
      code: "IMAGE_LIMIT_REACHED",
      imageQuota: { used: 3, limit: 3, resetsAt: "2026-07-01T00:00:00.000Z" }
    });
    // Nothing was charged and nothing was queued — the user still has the choice.
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    await app.close();
  });

  it("lets a text-only book through once the image budget is gone", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const textOnly = projectRecord({ id: "project-1" });
    textOnly.mediaSettings.fullIllustrations = false;
    textOnly.mediaSettings.includeCover = false;
    Object.assign(textOnly.mediaSettings.mobile, {
      imagesEnabled: false,
      coverEnabled: false,
      illustrationsEnabled: false
    });
    draftPlanForApproval(textOnly);
    vi.mocked(getImageQuota).mockResolvedValue(freeQuota(3));
    vi.mocked(reserveCredits).mockResolvedValueOnce({
      id: "ledger-1",
      userId: "user-a",
      projectId: "project-1",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: -500,
      planCreditsDelta: -500,
      entryType: "RESERVE",
      status: "RESERVED",
      idempotencyKey: "mobile:plan:plan-1:approve"
    });
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-book" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/plans/plan-1/approve",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(202);
    expect(consumeIllustratedBookUse).not.toHaveBeenCalled();
    await app.close();
  });

  it("charges one generated image for a cover-only book without consuming the illustrated-book quota", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const coverOnly = projectRecord({ id: "project-1" });
    coverOnly.mediaSettings.fullIllustrations = false;
    coverOnly.mediaSettings.includeCover = true;
    coverOnly.mediaSettings.illustrationCadence = "manual";
    Object.assign(coverOnly.mediaSettings.mobile, {
      imagesEnabled: true,
      coverEnabled: true,
      illustrationsEnabled: false
    });
    draftPlanForApproval(coverOnly);
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/plans/plan-1/approve",
      headers: bearer("token-a")
    });
    const expectedCredits =
      DEFAULT_CREDIT_COSTS.fullBookBase +
      coverOnly.targetPages * DEFAULT_CREDIT_COSTS.fullBookPerPage +
      DEFAULT_CREDIT_COSTS.imageGeneration +
      DEFAULT_CREDIT_COSTS.exportUnlock;

    expect(response.statusCode).toBe(202);
    expect(getImageQuota).not.toHaveBeenCalled();
    expect(consumeIllustratedBookUse).not.toHaveBeenCalled();
    expect(reserveCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCredits: expectedCredits,
        metadata: expect.objectContaining({
          creditEstimate: expect.objectContaining({
            totalCredits: expectedCredits,
            assumptions: expect.objectContaining({ includesCover: true, estimatedInteriorImages: 0 }),
            lineItems: expect.arrayContaining([
              expect.objectContaining({
                code: "IMAGE_GENERATION",
                label: "Cover image generation",
                quantity: 1,
                credits: DEFAULT_CREDIT_COSTS.imageGeneration
              }),
              expect.objectContaining({ label: "Interior image generation", quantity: 0, credits: 0 })
            ])
          })
        })
      })
    );
    await app.close();
  });

  it("does not count illustrated books against a paid plan", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    draftPlanForApproval();
    // No quota on this plan.
    vi.mocked(getImageQuota).mockResolvedValueOnce(null);
    vi.mocked(reserveCredits).mockResolvedValueOnce({
      id: "ledger-1",
      userId: "user-a",
      projectId: "project-1",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: -980,
      planCreditsDelta: -980,
      entryType: "RESERVE",
      status: "RESERVED",
      idempotencyKey: "mobile:plan:plan-1:approve"
    });
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-book" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/plans/plan-1/approve",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(202);
    expect(consumeIllustratedBookUse).not.toHaveBeenCalled();
    await app.close();
  });

  it("hands the slot back when the charge never lands", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    draftPlanForApproval();
    vi.mocked(getImageQuota).mockResolvedValueOnce(freeQuota(0));
    vi.mocked(consumeIllustratedBookUse).mockResolvedValueOnce({ allowed: true, ...freeQuota(1) });
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
    // Running out of credits must not also cost one of the three slots.
    expect(releaseIllustratedBookUse).toHaveBeenCalledWith("user-a", "2026-06");
    await app.close();
  });

  it("stamps the claimed period on the charge so a refund can release it", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    draftPlanForApproval();
    vi.mocked(getImageQuota).mockResolvedValueOnce(freeQuota(0));
    vi.mocked(consumeIllustratedBookUse).mockResolvedValueOnce({ allowed: true, ...freeQuota(1) });
    vi.mocked(reserveCredits).mockResolvedValueOnce({
      id: "ledger-1",
      userId: "user-a",
      projectId: "project-1",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: -980,
      planCreditsDelta: -980,
      entryType: "RESERVE",
      status: "RESERVED",
      idempotencyKey: "mobile:plan:plan-1:approve"
    });
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-book" }));
    const app = await buildMobileApp();

    await app.inject({ method: "POST", url: "/api/mobile/plans/plan-1/approve", headers: bearer("token-a") });

    expect(reserveCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ imageQuota: { periodKey: "2026-06" } })
      })
    );
    await app.close();
  });
});

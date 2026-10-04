import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { enqueueGenerationJob } from "../queue.js";
import { generationRecoveryQuote } from "./generationRetryQuote.js";
import {
  approvedPlanRecord, bearer, buildMobileApp, generatedPages, jobRecord,
  mockAccessTokens, mockBilling, mockPrisma, projectRecord,
  resetMobileHarness, teardownMobileHarness
} from "./testing/mobileApiHarness.js";

const quota = (used: number) => ({
  used, limit: 3, periodKey: "2026-10", resetsAt: new Date("2026-11-01T00:00:00.000Z")
});

function book(illustrated = true) {
  const project = projectRecord();
  return projectRecord({
    status: "COMPLETE", currentPlanId: "plan-1", currentPlan: approvedPlanRecord(), pages: generatedPages(),
    mediaSettings: {
      ...project.mediaSettings, fullIllustrations: illustrated,
      illustrationCadence: illustrated ? "template-driven" : "manual",
      mobile: { ...project.mediaSettings.mobile, illustrationsEnabled: illustrated, coverEnabled: true }
    }
  });
}

function apply(app: FastifyInstance, proposalId: string) {
  return app.inject({
    method: "POST", url: "/api/mobile/projects/project-1/chat/proposals/apply", headers: bearer("token-a"),
    payload: { proposalId }
  });
}

async function propose(app: FastifyInstance, message = "Generate again") {
  const response = await app.inject({
    method: "POST", url: "/api/mobile/projects/project-1/chat/messages", headers: bearer("token-a"), payload: { message }
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().reply.metadata.editProposal.kind).toBe("book_replan");
  return response.json().reply.metadata.editProposal.id as string;
}

describe("illustrated rebuild quota", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(book());
    mockBilling.getImageQuota.mockResolvedValue(quota(1));
    mockBilling.consumeIllustratedBookUse.mockResolvedValue({ ...quota(2), allowed: true });
    vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-replan", projectId: "project-copy", type: "REPLAN_BOOK" }));
  });
  afterEach(teardownMobileHarness);

  it("blocks an exhausted allowance before charging or creating a copy, and resumes after upgrading", async () => {
    mockBilling.getImageQuota.mockResolvedValueOnce(quota(3));
    mockBilling.consumeIllustratedBookUse.mockResolvedValueOnce({ ...quota(3), allowed: false });
    const app = await buildMobileApp();
    const proposalId = await propose(app);
    const response = await apply(app, proposalId);
    expect(response.statusCode).toBe(200);
    const blocked = response.json();
    expect(blocked.operation).toBeNull();
    expect(blocked.reply.metadata).toMatchObject({ charged: false, imageLimit: { used: 3, limit: 3 } });
    expect(blocked.reply.content).toMatch(/rebuild/i);
    expect(mockBilling.reserveCredits).not.toHaveBeenCalled();
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
    expect(enqueueGenerationJob).not.toHaveBeenCalled();

    const nextProposalId = blocked.reply.metadata.editProposal.id;
    expect(nextProposalId).not.toBe(proposalId);
    mockBilling.getImageQuota.mockResolvedValue(null);
    const resumed = await apply(app, nextProposalId);
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().operation.kind).toBe("book_replan");
    expect(mockBilling.consumeIllustratedBookUse).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("claims one new-book slot even when the source already has illustrations, with a refundable charge", async () => {
    const app = await buildMobileApp();
    const proposalId = await propose(app);
    expect(mockBilling.consumeIllustratedBookUse).not.toHaveBeenCalled();
    const response = await apply(app, proposalId);
    expect(response.statusCode).toBe(200);
    expect(response.json().operation.kind).toBe("book_replan");
    expect(mockBilling.consumeIllustratedBookUse).toHaveBeenCalledWith({ userId: "user-a", limit: 3 });
    expect(mockBilling.reserveCredits).toHaveBeenCalledWith(expect.objectContaining({
      operation: "BOOK_REPLAN", metadata: expect.objectContaining({ imageQuota: { periodKey: "2026-10" } })
    }));
    await apply(app, proposalId);
    expect(mockBilling.consumeIllustratedBookUse).toHaveBeenCalledTimes(1);
    expect(mockPrisma.project.create).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it.each([
    { illustrated: true, message: "It's too much talking. I think we should make it 3 pages without illustrations", claims: 0 },
    { illustrated: false, message: "Generate again", claims: 0 }
  ])("uses the rebuilt book's illustration settings: $message (source=$illustrated)", async ({ illustrated, message, claims }) => {
    mockPrisma.project.findFirst.mockResolvedValue(book(illustrated));
    const app = await buildMobileApp();
    const response = await apply(app, await propose(app, message));
    expect(response.statusCode).toBe(200);
    expect(response.json().operation.kind).toBe("book_replan");
    expect(mockBilling.consumeIllustratedBookUse).toHaveBeenCalledTimes(claims);
    await app.close();
  });

  it("allows paid plans without claiming a free-tier slot", async () => {
    mockBilling.getImageQuota.mockResolvedValue(null);
    const app = await buildMobileApp();
    const response = await apply(app, await propose(app));
    expect(response.statusCode).toBe(200);
    expect(response.json().operation.kind).toBe("book_replan");
    expect(mockBilling.consumeIllustratedBookUse).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    { type: "REPLAN_BOOK", illustrated: true, used: 1, subscribed: false, status: 202, claims: 1 },
    { type: "GENERATE_PAGE", illustrated: true, used: 1, subscribed: false, status: 202, claims: 1 },
    { type: "REPLAN_BOOK", illustrated: true, used: 3, subscribed: false, status: 403, claims: 1 },
    { type: "GENERATE_PAGE", illustrated: true, used: 3, subscribed: false, status: 403, claims: 1 },
    { type: "REPLAN_BOOK", illustrated: false, used: 3, subscribed: false, status: 202, claims: 0 },
    { type: "REPLAN_BOOK", illustrated: true, used: 3, subscribed: true, status: 202, claims: 0 }
  ] as const)("enforces the quota on retry: $type illustrated=$illustrated used=$used subscribed=$subscribed", async ({ type, illustrated, used, subscribed, status, claims }) => {
    const sourceAttempt = {
      id: "attempt-source", userId: "user-a", commandKey: "mobile:edit-command:source:rebuild",
      requestFingerprint: "rebuild", status: "FAILED", operation: "BOOK_REPLAN" as const,
      quotedCredits: 776, projectId: "project-1", refundPending: false
    };
    mockPrisma.project.findFirst.mockResolvedValue({ ...book(illustrated), status: "FAILED" });
    mockBilling.getImageQuota.mockResolvedValue(subscribed ? null : quota(used));
    mockBilling.consumeIllustratedBookUse.mockResolvedValue({ ...quota(Math.min(used + 1, 3)), allowed: used < 3 });
    mockPrisma.generationJob.findMany
      .mockResolvedValueOnce([jobRecord({
        id: "job-failed", type, status: "FAILED", attemptId: sourceAttempt.id,
        payload: { pageId: "page-1", planId: "plan-1", operationId: "operation-rebuild" }
      })])
      .mockResolvedValueOnce([{ id: "job-paid-retry", status: "QUEUED" }]);
    mockPrisma.page.findMany.mockResolvedValueOnce([{ id: "page-1" }]);
    mockPrisma.generationAttempt.findMany.mockResolvedValueOnce([sourceAttempt]);
    mockPrisma.bookEditOperation.updateMany.mockResolvedValueOnce({ count: 1 });
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-paid-retry", type }));
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "POST", url: "/api/mobile/projects/project-1/resume", headers: bearer("token-a"),
      payload: { requestId: "rebuild-retry-0001", retryToken: generationRecoveryQuote(sourceAttempt).retryToken }
    });
    expect(response.statusCode).toBe(status);
    expect(mockBilling.consumeIllustratedBookUse).toHaveBeenCalledTimes(claims);
    if (status === 403) {
      expect(response.json().error).toMatchObject({
        code: "IMAGE_LIMIT_REACHED",
        imageQuota: { used: 3, limit: 3, resetsAt: "2026-11-01T00:00:00.000Z" }
      });
      expect(mockBilling.reserveCredits).not.toHaveBeenCalled();
      expect(enqueueGenerationJob).not.toHaveBeenCalled();
    } else if (claims) {
      expect(mockBilling.reserveCredits).toHaveBeenCalledWith(expect.objectContaining({
        operation: "BOOK_REPLAN", metadata: expect.objectContaining({ imageQuota: { periodKey: "2026-10" } })
      }));
    }
    await app.close();
  });
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { MessageAllowanceError, reserveMessageUsage, settleMessageUsage } from "@book-maker/db/billing";
import { approvedPlanRecord, bearer, buildMobileApp, creationDraftRecord, mockAccessTokens, mockPrisma, projectRecord, resetMobileHarness, teardownMobileHarness } from "./testing/mobileApiHarness.js";

beforeEach(() => {
  resetMobileHarness();
  mockAccessTokens({ "token-a": "user-a" });
  mockPrisma.project.findFirst.mockResolvedValue(projectRecord({
    id: "project-1", status: "PLAN_READY",
    currentPlan: approvedPlanRecord({ status: "DRAFT", approvedAt: null }), pages: []
  }));
  let draft = creationDraftRecord({ revision: 1 });
  let startRequestId: string | undefined;
  mockPrisma.mobileCreationDraft.findFirst.mockImplementation(async ({ where }) =>
    where.requestId ? (where.requestId === startRequestId ? draft : null) : draft);
  mockPrisma.mobileCreationDraft.create.mockImplementation(async ({ data }) => {
    startRequestId = data.requestId;
    draft = creationDraftRecord({ ...data, revision: 1 });
    return draft;
  });
  mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }) => {
    draft = { ...draft, ...data, revision: 2 };
    return draft;
  });
});
afterEach(teardownMobileHarness);

it.each([
  ["/api/mobile/creation-sessions", 201],
  ["/api/mobile/creation-sessions/draft-1/messages", 200],
  ["/api/mobile/projects/project-1/chat/messages", 200]
] as const)("recovery at %s does not consume turn rate limits", async (url, status) => {
  const app = await buildMobileApp({
    creationEnrichment: false,
    advisorRateLimit: { maxAttempts: 1 }, draftRateLimit: { maxAttempts: 1 }
  });
  const request = {
    method: "POST" as const, url, headers: bearer("token-a"),
    payload: { message: "What is this book about?", requestId: "original-request" }
  };
  // The original turn owns the durable lease. Reconnecting must wait for it,
  // without using the quota for starting another turn or settling its charge.
  for (let i = 0; i < 3; i++) {
    vi.mocked(reserveMessageUsage).mockRejectedValueOnce(new MessageAllowanceError("REQUEST_IN_PROGRESS"));
    const pending = await app.inject(request);
    expect(pending.statusCode).toBe(409);
    expect(pending.json().error.code).toBe("REQUEST_IN_PROGRESS");
  }
  expect(settleMessageUsage).not.toHaveBeenCalled();

  const delivered = await app.inject(request);
  expect(delivered.statusCode).toBe(status);
  const reservations = vi.mocked(reserveMessageUsage).mock.calls.length;
  for (let i = 0; i < 3; i++) {
    const replay = await app.inject(request);
    expect(replay.statusCode).toBe(status);
    expect(replay.json()).toEqual(delivered.json());
  }
  expect(reserveMessageUsage).toHaveBeenCalledTimes(reservations);
  expect(mockPrisma.projectChatMessage.create.mock.calls.length).toBe(url.includes("/projects/") ? 2 : 0);
  expect(mockPrisma.mobileCreationDraft.create.mock.calls.length).toBe(status === 201 ? 1 : 0);
  expect(mockPrisma.mobileCreationDraft.update.mock.calls.length).toBe(url.includes("draft-1/messages") ? 1 : 0);

  // New turns still consume the rate quota, and the denied reservation is refunded.
  const denied = await app.inject({ ...request, payload: { ...request.payload, requestId: "new-request" } });
  expect(denied.statusCode).toBe(429);
  expect(denied.json().error.code).toBe("RATE_LIMITED");
  expect(settleMessageUsage).toHaveBeenLastCalledWith("user-a", expect.stringContaining("new-request"), false, "message-reservation-1");
  await app.close();
});

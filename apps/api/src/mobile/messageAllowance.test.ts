import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { InsufficientCreditsError, MessageAllowanceError, reserveMessageUsage, resetMessageAllowance, settleMessageUsage } from "@book-maker/db/billing";
import { approvedPlanRecord, bearer, buildMobileApp, creationDraftRecord, mockAccessTokens, mockPrisma, projectRecord, resetMobileHarness, teardownMobileHarness } from "./testing/mobileApiHarness.js";

beforeEach(() => {
  resetMobileHarness();
  mockAccessTokens({ "token-a": "user-a" });
  mockPrisma.project.findFirst.mockResolvedValue(projectRecord({ id: "project-1", status: "PLAN_READY", currentPlan: approvedPlanRecord({ status: "DRAFT", approvedAt: null }), pages: [] }));
  mockPrisma.mobileCreationDraft.create.mockImplementation(async ({ data }) => creationDraftRecord({ id: "draft-1", payload: data.payload }));
});
afterEach(teardownMobileHarness);

describe("message allowance routes", () => {
  it.each([
    ["/api/mobile/creation-sessions", { message: "A bedtime story", requestId: "request-1" }],
    ["/api/mobile/projects/project-1/chat/messages", { message: "What is this plan about?", requestId: "request-1" }]
  ])("blocks %s before saving a message", async (url, payload) => {
    vi.mocked(reserveMessageUsage).mockRejectedValueOnce(new MessageAllowanceError("MESSAGE_LIMIT_REACHED"));
    const app = await buildMobileApp({ creationEnrichment: false });
    const response = await app.inject({ method: "POST", url, headers: bearer("token-a"), payload });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe("MESSAGE_LIMIT_REACHED");
    expect(mockPrisma.projectChatMessage.create).not.toHaveBeenCalled();
    expect(mockPrisma.mobileCreationDraft.create).not.toHaveBeenCalled();
    expect(settleMessageUsage).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not count an empty creation-session greeting", async () => {
    const app = await buildMobileApp({ creationEnrichment: false });
    const response = await app.inject({ method: "POST", url: "/api/mobile/creation-sessions", headers: bearer("token-a"), payload: {} });
    expect(response.statusCode).toBe(201);
    expect(reserveMessageUsage).not.toHaveBeenCalled();
    await app.close();
  });

  it("settles a delivered message and replays it without another reservation", async () => {
    const app = await buildMobileApp();
    const request = { method: "POST" as const, url: "/api/mobile/projects/project-1/chat/messages", headers: bearer("token-a"), payload: { message: "What is this plan about?", requestId: "request-1" } };
    expect((await app.inject(request)).statusCode).toBe(200);
    expect((await app.inject(request)).statusCode).toBe(200);
    expect(reserveMessageUsage).toHaveBeenCalledTimes(1);
    expect(settleMessageUsage).toHaveBeenCalledWith("user-a", "project:project-1:request-1", true);
    await app.close();
  });

  it("refunds a slot and its charge when a creation message cannot be persisted", async () => {
    mockPrisma.mobileCreationDraft.create.mockRejectedValueOnce(new Error("database unavailable"));
    const app = await buildMobileApp({ creationEnrichment: false });
    const response = await app.inject({ method: "POST", url: "/api/mobile/creation-sessions", headers: bearer("token-a"), payload: { message: "A bedtime story", requestId: "request-1" } });
    expect(response.statusCode).toBe(500);
    expect(settleMessageUsage).toHaveBeenCalledWith("user-a", "creation-start:request-1", false, "message-reservation-1");
    await app.close();
  });

  it("returns actionable insufficient-credit errors before chat processing", async () => {
    vi.mocked(reserveMessageUsage).mockRejectedValueOnce(new InsufficientCreditsError({ requiredCredits: 7, availableCredits: 3, reservedCredits: 0 }));
    const app = await buildMobileApp();
    const response = await app.inject({ method: "POST", url: "/api/mobile/projects/project-1/chat/messages", headers: bearer("token-a"), payload: { message: "What is this plan about?" } });
    expect(response.statusCode).toBe(402);
    expect(response.json().error).toMatchObject({ code: "INSUFFICIENT_CREDITS", requiredCredits: 7, availableCredits: 3 });
    await app.close();
  });

  it("retries a turn whose user message survived but whose reply failed", async () => {
    const save = mockPrisma.projectChatMessage.create.getMockImplementation()!;
    mockPrisma.projectChatMessage.create
      .mockImplementationOnce(save)
      .mockRejectedValueOnce(new Error("reply storage unavailable"));
    const app = await buildMobileApp();
    const request = { method: "POST" as const, url: "/api/mobile/projects/project-1/chat/messages", headers: bearer("token-a"), payload: { message: "What is this plan about?", requestId: "retry-turn" } };
    expect((await app.inject(request)).statusCode).toBe(500);
    expect((await app.inject(request)).statusCode).toBe(200);
    const userWrites = mockPrisma.projectChatMessage.create.mock.calls.filter(([args]) => args.data.role === "USER");
    expect(userWrites).toHaveLength(1);
    expect(reserveMessageUsage).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("requires auth and a valid reset quote, using only the authenticated account", async () => {
    const app = await buildMobileApp();
    const url = "/api/mobile/billing/messages/reset";
    const payload = { resetToken: "2026-09-10:0:50", expectedCredits: 50 };
    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url, headers: bearer("token-a"), payload: { ...payload, expectedCredits: -1 } })).statusCode).toBe(400);
    const response = await app.inject({ method: "POST", url, headers: bearer("token-a"), payload: { ...payload, userId: "user-b" } });
    expect(response.statusCode).toBe(200);
    expect(resetMessageAllowance).toHaveBeenCalledExactlyOnceWith({ userId: "user-a", ...payload });
    expect(response.json().billing.messageAllowance).toMatchObject({ limit: 50, remaining: 50, creditsPerMessage: 0 });
    await app.close();
  });

  it("surfaces changed reset quotes so the app can request a new confirmation", async () => {
    vi.mocked(resetMessageAllowance).mockRejectedValueOnce(new MessageAllowanceError("MESSAGE_QUOTE_CHANGED"));
    const app = await buildMobileApp();
    const response = await app.inject({ method: "POST", url: "/api/mobile/billing/messages/reset", headers: bearer("token-a"), payload: { resetToken: "2026-09-10:0:50", expectedCredits: 50 } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("MESSAGE_QUOTE_CHANGED");
    await app.close();
  });
});

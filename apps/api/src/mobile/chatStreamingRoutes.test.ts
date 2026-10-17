import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());
import { bearer, buildMobileApp, creationDraftRecord, approvedPlanRecord, projectRecord, mockAccessTokens, mockPrisma, resetMobileHarness, teardownMobileHarness } from "./testing/mobileApiHarness.js";
import { decideDecision, routerAdapter } from "../testing/bookEditIntentFixtures.js";
import type { MobileCreationTurnRequest } from "../mobileCreation.js";

beforeEach(resetMobileHarness);
afterEach(teardownMobileHarness);

function events(body: string) {
  return body.split("\n\n").filter((line) => line.startsWith("event:")).map((line) => ({
    event: line.split("\n")[0]!.slice(7), data: JSON.parse(line.split("\ndata: ")[1]!)
  }));
}

it("creation routes carry a preview separately from the persisted final turn", async () => {
  mockAccessTokens({ "token-a": "user-a" });
  mockPrisma.mobileCreationDraft.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    creationDraftRecord({ id: "session-draft", payload: data.payload }));
  const app = await buildMobileApp({ creationEnrichment: async (request: MobileCreationTurnRequest) => {
    request.onAssistantText?.("A partial reply");
    return { assistantMessage: "The saved reply", question: null };
  } });
  const response = await app.inject({ method: "POST", url: "/api/mobile/creation-sessions", headers: { ...bearer("token-a"), accept: "text/event-stream" }, payload: { message: "A fox story", requestId: "stream-start" } });
  const frames = events(response.body);
  expect(frames[0]).toEqual({ event: "text", data: { text: "A partial reply" } });
  expect(frames.at(-1)).toMatchObject({ event: "done", data: { turn: { assistantMessage: "The saved reply" } } });
  const create = mockPrisma.mobileCreationDraft.create.mock.calls.at(-1)![0];
  expect(JSON.stringify(create)).toContain("The saved reply");
  expect(JSON.stringify(create)).not.toContain("A partial reply");
  await app.close();
});

it("book chat streams its grounded answer and completes with the saved transcript", async () => {
  mockAccessTokens({ "token-a": "user-a" });
  mockPrisma.project.findFirst.mockResolvedValue(projectRecord({ id: "project-1", status: "PLAN_READY", currentPlanId: "plan-1", currentPlan: approvedPlanRecord({ status: "DRAFT", approvedAt: null }), pages: [] }));
  const model = routerAdapter(async (options) => {
    await options.onToolCallProgress?.({ type: "start" });
    await options.onToolCallProgress?.({ type: "arguments", index: 0, name: "decide", argumentsText: '{"assistantMessage":"Draft' });
    return decideDecision({ action: "answer", confidence: 1, reasoning: "private routing", assistantMessage: "Draft answer", clarification: "none", pageIndexes: [], chapterIndex: null, targetLanguage: null });
  });
  model.generateText = async (options) => {
    await options.onOutputTextChunk?.("The grounded ");
    await options.onOutputTextChunk?.("answer");
    return { text: "The grounded answer", provider: "test", model: "test" };
  };
  const app = await buildMobileApp({ routingTextModel: model });
  const response = await app.inject({ method: "POST", url: "/api/mobile/projects/project-1/chat/messages", headers: { ...bearer("token-a"), accept: "text/event-stream" }, payload: { message: "What is this story about?", requestId: "stream-book" } });
  const frames = events(response.body);
  expect(frames).toContainEqual({ event: "text", data: { text: "The grounded" } });
  expect(frames.at(-1)).toMatchObject({ event: "done", data: { reply: { content: "The grounded answer" } } });
  expect(response.body).not.toContain("private routing");
  // The router's draft reply is replaced by the grounded one, so it is never
  // shown, and nothing blanks the answer once it has started.
  expect(response.body).not.toContain("Draft");
  const texts = frames.filter((frame) => frame.event === "text").map((frame) => frame.data.text as string);
  expect(texts.slice(texts.findIndex((text) => text !== ""))).not.toContain("");
  const replay = await app.inject({ method: "POST", url: "/api/mobile/projects/project-1/chat/messages", headers: { ...bearer("token-a"), accept: "text/event-stream" }, payload: { message: "What is this story about?", requestId: "stream-book" } });
  expect(replay.json().reply.content).toBe("The grounded answer");
  expect(replay.json().messages).toHaveLength(2);
  await app.close();
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  bearer,
  buildMobileApp,
  creationDraftRecord,
  mockAccessTokens,
  mockPrisma,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

/**
 * Branch navigation for the creation chat: editing a user message forks a
 * sibling, and switching between siblings restores that branch's own turn.
 * Split from creationSessions.test.ts, which covers session lifecycle.
 */
describe("mobile creation chat branches", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("branches the creation chat when editing a previous user message", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    // Legacy flat transcript without ids: the server must mint stable ids
    // ("legacy-<index>") that the client can reference in editMessageId.
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          messages: [
            { role: "assistant", content: "Hi! Tell me about your book." },
            { role: "user", content: "Bedtime story for 5 year olds" },
            { role: "assistant", content: "Lovely! Any favourite animals?" }
          ]
        }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload: data.payload })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/messages",
      headers: bearer("token-a"),
      payload: { message: "Space adventure for teens", editMessageId: "legacy-1" }
    });
    const body = response.json();
    const updateCall = mockPrisma.mobileCreationDraft.update.mock.calls.at(0)?.[0] as {
      data: { payload: { messages: Array<Record<string, unknown>> } };
    };

    expect(response.statusCode).toBe(200);
    // The visible thread follows the new branch: greeting, edited message, fresh reply.
    expect(body.session.messages.map((message: { role: string }) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant"
    ]);
    const editedSlot = body.session.messages[1];
    expect(editedSlot.content).toBe("Space adventure for teens");
    expect(editedSlot.branch).toMatchObject({ index: 2, total: 2, canGoPrevious: true, canGoNext: false });
    // The abandoned branch stays stored: original user turn is deactivated, not deleted.
    const stored = updateCall.data.payload.messages;
    const original = stored.find((message) => message.id === "legacy-1");
    expect(original).toMatchObject({ content: "Bedtime story for 5 year olds", isActiveChild: false });
    expect(stored.filter((message) => message.role === "user")).toHaveLength(2);
    expect(JSON.stringify(body.session)).not.toContain("isActiveChild");
    await app.close();
  });

  it("rejects edits that target an unknown or non-user message", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const draft = creationDraftRecord({
      id: "session-draft",
      payload: {
        payloadVersion: 3,
        messages: [
          { role: "assistant", content: "Hi!" },
          { role: "user", content: "Bedtime story" }
        ]
      }
    });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(draft);
    const app = await buildMobileApp({ creationEnrichment: false });

    const unknown = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/messages",
      headers: bearer("token-a"),
      payload: { message: "Edited", editMessageId: "missing" }
    });
    const assistant = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/messages",
      headers: bearer("token-a"),
      payload: { message: "Edited", editMessageId: "legacy-0" }
    });

    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("MESSAGE_NOT_FOUND");
    expect(assistant.statusCode).toBe(404);
    expect(assistant.json().error.code).toBe("MESSAGE_NOT_FOUND");
    await app.close();
  });

  it("switches between creation chat sibling branches", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    // A stored tree with a fork under the greeting: the edited branch is active.
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          messages: [
            { id: "m0", parentId: null, isActiveChild: true, role: "assistant", content: "Hi!" },
            { id: "m1", parentId: "m0", isActiveChild: false, role: "user", content: "Bedtime story" },
            { id: "m2", parentId: "m1", isActiveChild: true, role: "assistant", content: "Reply about bedtime" },
            { id: "m3", parentId: "m0", isActiveChild: true, role: "user", content: "Space adventure" },
            { id: "m4", parentId: "m3", isActiveChild: true, role: "assistant", content: "Reply about space" }
          ]
        }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload: data.payload })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/branches",
      headers: bearer("token-a"),
      payload: { messageId: "m3", direction: "previous" }
    });
    const body = response.json();
    const updateCall = mockPrisma.mobileCreationDraft.update.mock.calls.at(0)?.[0] as {
      data: { payload: { messages: Array<Record<string, unknown>>; rawIdea: string } };
    };

    expect(response.statusCode).toBe(200);
    expect(body.session.messages.map((message: { id: string }) => message.id)).toEqual(["m0", "m1", "m2"]);
    expect(body.session.messages[1].branch).toMatchObject({
      index: 1,
      total: 2,
      canGoPrevious: false,
      canGoNext: true
    });
    // No fresh assistant text is generated for a switch.
    expect(body.turn.assistantMessage).toBe("");
    // The draft state now reflects the re-activated branch.
    expect(updateCall.data.payload.rawIdea).toContain("Bedtime story");
    const storedById = new Map(updateCall.data.payload.messages.map((message) => [message.id, message]));
    expect(storedById.get("m1")).toMatchObject({ isActiveChild: true });
    expect(storedById.get("m3")).toMatchObject({ isActiveChild: false });
    await app.close();
  });

  it("restores branch-specific grounded research when switching creation chat branches", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const bedtimeResearch = {
      query: "bedtime science",
      summary: "Grounded bedtime evidence.",
      sources: [{ title: "Sleep Foundation", summary: "A bedtime source." }]
    };
    const spaceResearch = {
      query: "space science",
      summary: "Grounded space evidence.",
      sources: [{ title: "NASA", summary: "A space source." }]
    };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          messages: [
            { id: "m0", parentId: null, isActiveChild: true, role: "assistant", content: "Hi!" },
            { id: "m1", parentId: "m0", isActiveChild: false, role: "user", content: "Bedtime science" },
            {
              id: "m2",
              parentId: "m1",
              isActiveChild: true,
              role: "assistant",
              content: "Bedtime answer",
              research: bedtimeResearch
            },
            { id: "m3", parentId: "m0", isActiveChild: true, role: "user", content: "Space science" },
            {
              id: "m4",
              parentId: "m3",
              isActiveChild: true,
              role: "assistant",
              content: "Space answer",
              research: spaceResearch
            }
          ]
        }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload: data.payload, lastTurn: data.lastTurn })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/branches",
      headers: bearer("token-a"),
      payload: { messageId: "m3", direction: "previous" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().session.messages.at(-1).research).toEqual(bedtimeResearch);
    expect(JSON.stringify(response.json().session)).not.toContain("space science");
    await app.close();
  });

  it("restores the localized question when switching creation chat branches", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          language: "pt",
          messages: [
            { id: "m0", parentId: null, isActiveChild: true, role: "assistant", content: "Olá!" },
            { id: "m1", parentId: "m0", isActiveChild: false, role: "user", content: "Uma história de romance" },
            {
              id: "m2",
              parentId: "m1",
              isActiveChild: true,
              role: "assistant",
              content: "Para quem você imagina essa história?",
              turnUi: {
                question: {
                  prompt: "Para quem é este livro?",
                  options: ["Jovens adultos", "Leitores de romance", "Público geral"],
                  allowCustom: true
                },
                quickReplies: []
              }
            },
            { id: "m3", parentId: "m0", isActiveChild: true, role: "user", content: "Uma história de suspense" },
            { id: "m4", parentId: "m3", isActiveChild: true, role: "assistant", content: "Que tipo de suspense?" }
          ]
        }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload: data.payload, lastTurn: data.lastTurn })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/branches",
      headers: bearer("token-a"),
      payload: { messageId: "m3", direction: "previous" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.turn.assistantMessage).toBe("");
    expect(body.turn.language).toBe("pt");
    // The stored snapshot predates answerKind; restoring it defaults to the
    // tappable shape it was written with.
    expect(body.turn.question).toEqual({
      prompt: "Para quem é este livro?",
      answerKind: "choice",
      options: ["Jovens adultos", "Leitores de romance", "Público geral"],
      allowCustom: true
    });
    expect(body.turn.quickReplies).toEqual([]);
    await app.close();
  });

  it("returns 404 when switching to an unknown creation chat branch", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          messages: [{ role: "assistant", content: "Hi!" }]
        }
      })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/branches",
      headers: bearer("token-a"),
      payload: { messageId: "missing", direction: "previous" }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("MESSAGE_NOT_FOUND");
    await app.close();
  });

  it("exposes stable ids and parent links for legacy transcripts", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          messages: [
            { role: "assistant", content: "Hi!" },
            { role: "user", content: "Bedtime story" }
          ]
        }
      })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/creation-sessions/session-draft",
      headers: bearer("token-a")
    });
    const messages = response.json().session.messages;

    expect(response.statusCode).toBe(200);
    expect(messages).toEqual([
      expect.objectContaining({ id: "legacy-0", parentId: null, branch: null }),
      expect.objectContaining({ id: "legacy-1", parentId: "legacy-0", branch: null })
    ]);
    await app.close();
  });

});

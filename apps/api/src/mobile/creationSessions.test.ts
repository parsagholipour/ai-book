import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { reserveCredits } from "@book-maker/db/billing";

import {
  bearer,
  buildMobileApp,
  creationDraftRecord,
  mockAccessTokens,
  mockPrisma,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

describe("mobile creation sessions", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("starts a creation session with a deterministic greeting turn", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", status: "ACTIVE", payload: data.payload })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions",
      headers: bearer("token-a"),
      payload: {}
    });
    const body = response.json();

    expect(response.statusCode).toBe(201);
    expect(body.session).toMatchObject({ draftId: "session-draft", status: "ACTIVE" });
    expect(body.session.messages).toHaveLength(1);
    expect(body.session.messages[0].role).toBe("assistant");
    expect(body.turn.assistantMessage).toContain("Tell me about the book");
    expect(body.turn.readiness.canBuild).toBe(false);
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toMatch(/provider|model|temperature|credits|billing/);
    await app.close();
  });

  it("starts a creation session with the first user message already persisted", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", status: "ACTIVE", payload: data.payload })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions",
      headers: bearer("token-a"),
      payload: { message: "Bedtime story for 5 year olds" }
    });
    const body = response.json();
    const createCall = mockPrisma.mobileCreationDraft.create.mock.calls.at(0)?.[0] as {
      data: { payload: Record<string, any> };
    };

    expect(response.statusCode).toBe(201);
    expect(body.session.draftId).toBe("session-draft");
    expect(body.turn.detectedLane).toBe("auto");
    expect(body.turn.readiness.canBuild).toBe(true);
    expect(body.session.messages.map((message: { role: string }) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant"
    ]);
    expect(createCall.data.payload.rawIdea).toBe("Bedtime story for 5 year olds");
    expect(createCall.data.payload.messages.map((message: { role: string }) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant"
    ]);
    expect(typeof createCall.data.payload.lastMessageAt).toBe("string");
    await app.close();
  });

  it("resumes an active session and runs a turn once the user has replied", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          rawIdea: "Bedtime story for 5 year olds",
          messages: [
            { role: "assistant", content: "Hi! Tell me about your book." },
            { role: "user", content: "Bedtime story for 5 year olds" }
          ]
        }
      })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/creation-sessions/active",
      headers: bearer("token-a")
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.session.draftId).toBe("session-draft");
    expect(body.turn.detectedLane).toBe("auto");
    expect(body.turn.readiness.canBuild).toBe(true);
    await app.close();
  });

  it("returns a greeting when no active creation session exists", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(null);
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/creation-sessions/active",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().session).toBeNull();
    expect(response.json().turn.assistantMessage).toContain("Tell me about the book");
    await app.close();
  });

  it("lists creation sessions with output summaries and legacy output fallback", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findMany.mockResolvedValueOnce([
      creationDraftRecord({
        id: "draft-with-output",
        createdProjectId: "project-new",
        payload: {
          payloadVersion: 3,
          rawIdea: "Workbook for new coaches",
          messages: [{ role: "user", content: "Workbook for new coaches" }]
        },
        outputs: [
          {
            id: "output-new",
            draftId: "draft-with-output",
            projectId: "project-new",
            title: "Coach Workbook",
            sequence: 1,
            createdAt: new Date("2026-06-15T12:00:00.000Z"),
            updatedAt: new Date("2026-06-15T12:00:00.000Z"),
            project: { title: "Coach Workbook", updatedAt: new Date("2026-06-15T12:30:00.000Z") }
          }
        ]
      }),
      creationDraftRecord({
        id: "draft-legacy",
        status: "COMPLETED",
        createdProjectId: "project-legacy",
        payload: {
          payloadVersion: 3,
          rawIdea: "Legacy story",
          messages: [{ role: "user", content: "Legacy story" }]
        }
      })
    ]);
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/creation-sessions",
      headers: bearer("token-a")
    });
    const sessions = response.json().sessions;

    expect(response.statusCode).toBe(200);
    expect(sessions[0]).toMatchObject({
      draftId: "draft-with-output",
      activeProjectId: "project-new",
      outputs: [{ id: "output-new", projectId: "project-new", title: "Coach Workbook", sequence: 1 }]
    });
    expect(sessions[1]).toMatchObject({
      draftId: "draft-legacy",
      activeProjectId: "project-legacy",
      outputs: [{ projectId: "project-legacy", title: "Legacy story", sequence: 1 }]
    });
    expect(sessions[1].outputs[0].id).toContain("legacy:");
    await app.close();
  });

  it("orders creation sessions by last conversation activity, not row updatedAt", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findMany.mockResolvedValueOnce([
      // Built/exported chat: the row was touched after the newer chat was
      // created, but its last message is older.
      creationDraftRecord({
        id: "draft-built",
        updatedAt: new Date("2026-06-15T14:00:00.000Z"),
        payload: {
          payloadVersion: 3,
          lastMessageAt: "2026-06-15T10:00:00.000Z",
          messages: [{ role: "user", content: "Livro em portugues" }]
        }
      }),
      creationDraftRecord({
        id: "draft-new",
        updatedAt: new Date("2026-06-15T12:00:00.000Z"),
        payload: {
          payloadVersion: 3,
          lastMessageAt: "2026-06-15T12:00:00.000Z",
          messages: [{ role: "user", content: "Outro livro" }]
        }
      }),
      // Drafts from before lastMessageAt existed fall back to updatedAt.
      creationDraftRecord({
        id: "draft-legacy",
        updatedAt: new Date("2026-06-15T11:00:00.000Z"),
        payload: {
          payloadVersion: 3,
          messages: [{ role: "user", content: "Old idea" }]
        }
      })
    ]);
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/creation-sessions",
      headers: bearer("token-a")
    });
    const sessions = response.json().sessions;

    expect(response.statusCode).toBe(200);
    expect(sessions.map((session: { draftId: string }) => session.draftId)).toEqual([
      "draft-new",
      "draft-legacy",
      "draft-built"
    ]);
    expect(sessions[0].lastMessageAt).toBe("2026-06-15T12:00:00.000Z");
    expect(sessions[1].lastMessageAt).toBe("2026-06-15T11:00:00.000Z");
    await app.close();
  });

  it("uses the search-capable timeout budget for continuation messages", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          rawIdea: "A scientific book about a recent discovery",
          messages: [
            { role: "assistant", content: "Hi!" },
            { role: "user", content: "A scientific book about a recent discovery" }
          ]
        }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload: data.payload, lastTurn: data.lastTurn })
    );
    const app = await buildMobileApp({
      creationEnrichment: async () => ({
        assistantMessage: "I found a current, grounded topic.",
        question: null
      })
    });
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/creation-sessions/session-draft/messages",
        headers: bearer("token-a"),
        payload: { message: "Find the latest on the internet" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().turn.assistantMessage).toContain("grounded topic");
      expect(timeoutSpy.mock.calls.some((call) => call[1] === 85_000)).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
      await app.close();
    }
  });

  it("persists and serializes grounded research on a creation answer", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          rawIdea: "A scientific book about a recent discovery",
          messages: [
            { role: "assistant", content: "Hi!" },
            { role: "user", content: "A scientific book about a recent discovery" },
            { role: "assistant", content: "Which discovery?" }
          ]
        }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload: data.payload, lastTurn: data.lastTurn })
    );
    const research = {
      query: "recent scientific discovery",
      summary: "A grounded discovery summary.",
      sources: [
        {
          title: "NASA Science",
          url: "https://science.nasa.gov/example",
          summary: "NASA's source-backed explanation."
        }
      ]
    };
    let enrichCalls = 0;
    const app = await buildMobileApp({
      creationEnrichment: async () => {
        enrichCalls += 1;
        return {
          assistantMessage: "A recent NASA-reported discovery is a strong topic.",
          question: null,
          research
        };
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/messages",
      headers: bearer("token-a"),
      payload: { message: "Find it on the internet and tell me", requestId: "search-request-0001" }
    });
    const body = response.json();
    const updateCall = mockPrisma.mobileCreationDraft.update.mock.calls.at(0)?.[0] as {
      data: { payload: { messages: Array<Record<string, any>> } };
    };

    expect(response.statusCode).toBe(200);
    expect(enrichCalls).toBe(1);
    expect(body.turn.research).toEqual(research);
    expect(body.session.messages.at(-1).research).toEqual(research);
    expect(updateCall!.data.payload.messages.at(-1)!.research).toEqual(research);
    expect(JSON.stringify(body.session)).not.toContain("turnUi");
    await app.close();
  });

  it("replays a searched request id without running enrichment again", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const research = {
      query: "recent scientific discovery",
      summary: "A grounded discovery summary.",
      sources: [{ title: "NASA", summary: "Grounded evidence." }]
    };
    const payload = {
      payloadVersion: 3,
      rawIdea: "A recent discovery",
      messages: [
        { id: "m0", parentId: null, isActiveChild: true, role: "assistant", content: "Hi!" },
        {
          id: "m1",
          parentId: "m0",
          isActiveChild: true,
          role: "user",
          content: "Find it online",
          requestId: "search-request-0002"
        },
        {
          id: "m2",
          parentId: "m1",
          isActiveChild: true,
          role: "assistant",
          content: "I found a grounded topic.",
          research
        }
      ]
    };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({ id: "session-draft", payload })
    );
    let enrichCalls = 0;
    const app = await buildMobileApp({
      creationEnrichment: async () => {
        enrichCalls += 1;
        return {};
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/messages",
      headers: bearer("token-a"),
      payload: { message: "Find it online", requestId: "search-request-0002" }
    });

    expect(response.statusCode).toBe(200);
    expect(enrichCalls).toBe(0);
    expect(response.json().session.messages.at(-1).research).toEqual(research);
    expect(mockPrisma.mobileCreationDraft.update).not.toHaveBeenCalled();
    await app.close();
  });

  it("appends a conversation message and persists the updated transcript", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: { payloadVersion: 3, messages: [{ role: "assistant", content: "Hi! Tell me about your book." }] }
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
      payload: { message: "Bedtime story for 5 year olds" }
    });
    const body = response.json();
    const updateCall = mockPrisma.mobileCreationDraft.update.mock.calls.at(0)?.[0] as {
      data: { payload: Record<string, any> };
    };

    expect(response.statusCode).toBe(200);
    expect(body.turn.detectedLane).toBe("auto");
    expect(body.turn.readiness.canBuild).toBe(true);
    expect(body.session.messages.map((message: { role: string }) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant"
    ]);
    expect(updateCall.data.payload.payloadVersion).toBe(3);
    expect(updateCall.data.payload.messages.at(-1).role).toBe("assistant");
    expect(updateCall.data.payload.messages.at(-1).turnUi).toEqual({
      question: body.turn.question,
      quickReplies: body.turn.quickReplies
    });
    expect(JSON.stringify(body.session)).not.toContain("turnUi");
    expect(typeof updateCall.data.payload.lastMessageAt).toBe("string");
    expect(JSON.stringify(body)).not.toMatch(/provider|model|temperature|credits|billing/);
    await app.close();
  });

  it("appends messages to a completed creation session so another output can be shaped", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        status: "COMPLETED",
        payload: {
          payloadVersion: 3,
          messages: [
            { role: "assistant", content: "Hi! Tell me about your book." },
            { role: "user", content: "Bedtime story" }
          ]
        }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload: data.payload, status: data.status })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/messages",
      headers: bearer("token-a"),
      payload: { message: "Add a dragon" }
    });
    const updateCall = mockPrisma.mobileCreationDraft.update.mock.calls.at(0)?.[0] as {
      data: { payload: Record<string, any>; status: string };
    };

    expect(response.statusCode).toBe(200);
    expect(response.json().session.status).toBe("ACTIVE");
    expect(updateCall.data.status).toBe("ACTIVE");
    expect(updateCall.data.payload.messages.map((message: { role: string }) => message.role)).toEqual([
      "assistant",
      "user",
      "user",
      "assistant"
    ]);
    await app.close();
  });

  it("returns 404 for messages to an unknown creation session", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(null);
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/missing/messages",
      headers: bearer("token-a"),
      payload: { message: "Hello" }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("SESSION_NOT_FOUND");
    await app.close();
  });

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
    expect(body.turn.question).toEqual({
      prompt: "Para quem é este livro?",
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { reserveCredits } from "@book-maker/db/billing";
import { deterministicCreationTurn } from "../mobileCreation.js";

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
    expect(body.turn.coverPreview.designId.length).toBeGreaterThan(0);
    expect(body.turn.coverPreview.palette).toHaveLength(3);
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
    expect(body.turn.coverPreview.designId.length).toBeGreaterThan(0);
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

  it("fills the advanced-settings byline from a name stated in chat", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          rawIdea: "A fable about generosity",
          messages: [
            { role: "assistant", content: "Hi!" },
            { role: "user", content: "A fable about generosity" }
          ]
        }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload: data.payload, lastTurn: data.lastTurn })
    );
    const app = await buildMobileApp({
      creationEnrichment: async () => ({
        assistantMessage: "Got it — The Lantern, by Parsa Gh.",
        question: null,
        authorName: "Parsa Gh.",
        title: "The Lantern"
      })
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/messages",
      headers: bearer("token-a"),
      payload: { message: "Put my name Parsa Gh. on it and call it The Lantern" }
    });
    const body = response.json();
    const updateCall = mockPrisma.mobileCreationDraft.update.mock.calls.at(0)?.[0] as {
      data: { payload: { optionalDetails: Record<string, string> } };
    };

    expect(response.statusCode).toBe(200);
    // The app reads these back into the Advanced settings sheet, and the build
    // path takes Project.authorName straight off optionalDetails.
    expect(updateCall!.data.payload.optionalDetails).toMatchObject({
      authorName: "Parsa Gh.",
      title: "The Lantern"
    });
    expect(body.turn.authorName).toBe("Parsa Gh.");
    expect(body.turn.title).toBe("The Lantern");
    await app.close();
  });

  it("restores a stored byline onto the turn so a cold start refills the sheet", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          rawIdea: "A fable about generosity",
          optionalDetails: { authorName: "Parsa Gh.", title: "The Lantern", mustInclude: "", tone: "" },
          messages: [
            { role: "assistant", content: "Hi!" },
            { role: "user", content: "A fable about generosity" },
            { role: "assistant", content: "Sounds lovely." }
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
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.turn.authorName).toBe("Parsa Gh.");
    expect(body.turn.title).toBe("The Lantern");
    await app.close();
  });

  it("does not restore a stored turn's derived brief title or its echo suggestions", async () => {
    // Regression: drafts saved before recipe titles became explicit-only carry
    // a title mangled from the first message ("Make A About Flies And Their")
    // in payload.recipe and lastTurn; replaying them verbatim put that text
    // back in the app as the book's working title and as suggestion chips.
    mockAccessTokens({ "token-a": "user-a" });
    const rawIdea = "Make a book about flies and their use in medicine";
    const echo = "Make A About Flies And Their";
    const storedTurn = deterministicCreationTurn({ messages: [{ role: "user", content: rawIdea }] });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          rawIdea,
          optionalDetails: { mustInclude: "", tone: "" },
          recipe: { ...storedTurn.brief, title: echo },
          messages: [
            { role: "assistant", content: "Hi!" },
            { role: "user", content: rawIdea },
            { role: "assistant", content: "Great idea." }
          ]
        },
        lastTurn: {
          ...storedTurn,
          assistantMessage: "Great idea.",
          brief: { ...storedTurn.brief, title: echo },
          titleSuggestions: [echo, `${echo} Book`, `${echo} Story`]
        }
      })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/creation-sessions/session-draft",
      headers: bearer("token-a")
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.turn.brief.title).toBe("");
    expect(body.turn.titleSuggestions).toEqual([]);
    // The chat keeps a label, but it is the user's own words, not the mangle.
    expect(body.session.title).toBe(rawIdea);
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

  it("preserves a stored cover-only choice when an old client echoes the unchanged image aggregate", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const payload = {
      payloadVersion: 3,
      rawIdea: "A short bread guide",
      messages: [
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "A short bread guide" }
      ],
      selectedPresets: {
        bookType: "lead_magnet",
        bookTypeChoice: "auto",
        lengthPreset: "short",
        qualityPreset: "balanced",
        imagesEnabled: true,
        coverEnabled: true,
        illustrationsEnabled: false
      }
    };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({ id: "session-draft", payload })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload: data.payload, lastTurn: data.lastTurn })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/messages",
      headers: bearer("token-a"),
      payload: {
        message: "Add a chapter about shaping the loaf",
        presets: {
          bookType: "lead_magnet",
          bookTypeChoice: "auto",
          lengthPreset: "short",
          qualityPreset: "balanced",
          imagesEnabled: true
        }
      }
    });
    const updateCall = mockPrisma.mobileCreationDraft.update.mock.calls.at(0)?.[0] as {
      data: { payload: Record<string, any> };
    };

    expect(response.statusCode).toBe(200);
    expect(response.json().turn.presets).toMatchObject({
      imagesEnabled: true,
      coverEnabled: true,
      illustrationsEnabled: false
    });
    expect(updateCall.data.payload.selectedPresets).toMatchObject({
      imagesEnabled: true,
      coverEnabled: true,
      illustrationsEnabled: false
    });
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

});

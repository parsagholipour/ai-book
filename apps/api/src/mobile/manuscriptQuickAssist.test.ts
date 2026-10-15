import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import type { FastifyInstance } from "fastify";
import { runStudioQuickAssist } from "./manuscript/manuscriptQuickAssist.js";
import { installManuscriptFakeDb, type ManuscriptFakeDb } from "./testing/manuscriptFakeDb.js";
import {
  buildMobileApp,
  mockAccessTokens,
  mockBilling,
  mockPrisma,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";
import {
  createStudioBook,
  getManuscript,
  patchSettings,
  quickAssist,
  saveChapter,
  scriptedAssistModel,
  seedLibraryCharacter
} from "./testing/manuscriptTestSupport.js";

let db: ManuscriptFakeDb;

beforeEach(() => {
  resetMobileHarness();
  db = installManuscriptFakeDb();
  mockAccessTokens({ "token-a": "user-a" });
});
afterEach(teardownMobileHarness);

const REPLIES = {
  "author-assist-rewrite": { text: "The keeper climbed the stairs, counting each one aloud." },
  "author-assist-proofread": { corrections: [{ find: "teh", replace: "the", reason: "Spelling" }] },
  "author-assist-continue": { text: "Above her, the lamp turned slowly in the dark." },
  "author-assist-describe": { text: "The iron stairs rang under her boots, cold and wet with sea air." },
  "author-assist-brainstorm": {
    ideas: [
      { title: "A ship in trouble", text: "A distress flare lights the fog." },
      { title: "A visitor", text: "Someone knocks at the lighthouse door at midnight." },
      { title: "The lamp fails", text: "The great lamp flickers out during the storm." }
    ]
  },
  "author-assist-ask": { answer: "Keep her fear quiet and physical: short sentences, the cold, the sound of the stairs." }
};

async function studioChapter(app: FastifyInstance) {
  const { body } = await createStudioBook(app);
  const projectId = body.project.id as string;
  const chapterId = body.chapter.id as string;
  await saveChapter(app, projectId, { id: chapterId, revision: 1 }, "The keeper climbed. I saw teh boat.");
  return { projectId, chapterId };
}

function settledAs(): boolean | undefined {
  return (mockBilling.settleMessageUsage.mock.calls.at(-1) as unknown[] | undefined)?.[2] as boolean | undefined;
}

describe("quick assists", () => {
  it("rewrites a selection on the book's tier, metered as one studio message, and costs the call", async () => {
    const model = scriptedAssistModel(REPLIES);
    const app = await buildMobileApp({ studioAssistTextModel: model });
    const { projectId, chapterId } = await studioChapter(app);

    const response = await quickAssist(app, projectId, {
      kind: "rewrite",
      chapterId,
      selection: " The keeper climbed. ",
      preset: "vivid",
      requestId: "request-assist-0001"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      assist: {
        kind: "rewrite",
        // The selection's own surrounding whitespace is kept, so the app replaces the range verbatim.
        suggestions: [{ text: " The keeper climbed the stairs, counting each one aloud. " }],
        corrections: [],
        ideas: [],
        answer: null
      }
    });
    expect(mockBilling.reserveMessageUsage).toHaveBeenCalledWith({
      userId: "user-a",
      projectId,
      requestKey: `studio:${projectId}:request-assist-0001`
    });
    expect(settledAs()).toBe(true);
    expect(model.calls.map((call) => call.purpose)).toEqual(["author-assist-rewrite"]);
    expect(mockPrisma.providerCallLog.create).toHaveBeenCalledTimes(1);
    const row = mockPrisma.providerCallLog.create.mock.calls[0]![0].data;
    expect(row).toMatchObject({
      projectId,
      generationJobId: null,
      userId: "user-a",
      provider: "deepseek",
      model: "deepseek-chat",
      purpose: "author-assist-rewrite",
      promptTokens: 1200,
      outputTokens: 300,
      metadata: { operation: "inline", liveStatus: "settled", provisional: false, callId: expect.any(String) }
    });
    expect(row.costHint).toBeGreaterThan(0);
  });

  it("answers every kind in the one shape, every key present", async () => {
    const app = await buildMobileApp({ studioAssistTextModel: scriptedAssistModel(REPLIES) });
    const { projectId, chapterId } = await studioChapter(app);
    const ask = (payload: Record<string, unknown>, requestId: string) =>
      quickAssist(app, projectId, { chapterId, requestId, ...payload }).then((response) => response.json().assist);

    expect(await ask({ kind: "proofread", selection: "I saw teh boat." }, "request-proof-0001")).toEqual({
      kind: "proofread",
      suggestions: [],
      corrections: [{ find: "teh", replace: "the", reason: "Spelling" }],
      ideas: [],
      answer: null
    });
    const continued = await ask({ kind: "continue", before: "The keeper climbed." }, "request-cont-0001");
    expect(continued.suggestions).toHaveLength(1);
    expect(continued.suggestions[0].text.trim()).toBe("Above her, the lamp turned slowly in the dark.");
    expect((await ask({ kind: "describe", selection: "the stairs" }, "request-desc-0001")).suggestions).toHaveLength(1);
    expect((await ask({ kind: "brainstorm" }, "request-idea-0001")).ideas.map((idea: { title: string }) => idea.title)).toEqual([
      "A ship in trouble",
      "A visitor",
      "The lamp fails"
    ]);
    expect((await ask({ kind: "ask", instruction: "How do I make her scared?" }, "request-ask-0001")).answer).toMatch(/short sentences/);
  });

  it("tells the model about the book's cast", async () => {
    const model = scriptedAssistModel(REPLIES);
    const app = await buildMobileApp({ studioAssistTextModel: model });
    const { projectId, chapterId } = await studioChapter(app);
    seedLibraryCharacter(db, { id: "char-mira", name: "Mira", appearance: "red coat, grey braid" });
    expect((await patchSettings(app, projectId, { castCharacterIds: ["char-mira"] })).statusCode).toBe(200);

    await quickAssist(app, projectId, { kind: "brainstorm", chapterId, requestId: "request-cast-0001" });

    const sent = JSON.stringify(model.calls[0]!.messages);
    expect(sent).toContain("Mira");
    expect(sent).toContain("red coat, grey braid");
  });

  it("refuses a request the runner cannot serve before a message slot is taken", async () => {
    const app = await buildMobileApp({ studioAssistTextModel: scriptedAssistModel(REPLIES) });
    const { projectId, chapterId } = await studioChapter(app);

    const noSelection = await quickAssist(app, projectId, { kind: "rewrite", chapterId, requestId: "request-bad-0001" });
    expect(noSelection.statusCode).toBe(400);
    expect(noSelection.json().error.code).toBe("SELECTION_REQUIRED");
    const noQuestion = await quickAssist(app, projectId, { kind: "ask", chapterId, requestId: "request-bad-0002" });
    expect(noQuestion.json().error.code).toBe("INSTRUCTION_REQUIRED");
    const tooLong = await quickAssist(app, projectId, {
      kind: "proofread",
      chapterId,
      selection: "x".repeat(6001),
      requestId: "request-bad-0003"
    });
    expect(tooLong.json().error.code).toBe("INPUT_TOO_LONG");
    const unknown = await quickAssist(app, projectId, { kind: "summarize", chapterId, requestId: "request-bad-0004" });
    expect(unknown.json().error.code).toBe("INVALID_ASSIST");
    const missing = await quickAssist(app, projectId, { kind: "brainstorm", chapterId: "gone", requestId: "request-bad-0005" });
    expect(missing.statusCode).toBe(404);

    expect(mockBilling.reserveMessageUsage).not.toHaveBeenCalled();
  });

  it("answers 503 and returns the message when the model fails", async () => {
    const app = await buildMobileApp({
      studioAssistTextModel: scriptedAssistModel({ ...REPLIES, "author-assist-rewrite": new Error("provider exploded") })
    });
    const { projectId, chapterId } = await studioChapter(app);

    const response = await quickAssist(app, projectId, {
      kind: "rewrite",
      chapterId,
      selection: "The keeper climbed.",
      requestId: "request-fail-0001"
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("ASSIST_UNAVAILABLE");
    expect(settledAs()).toBe(false);
  });

  it("passes the message allowance's own refusals through untouched", async () => {
    const model = scriptedAssistModel(REPLIES);
    const app = await buildMobileApp({ studioAssistTextModel: model });
    const { projectId, chapterId } = await studioChapter(app);
    mockBilling.reserveMessageUsage.mockRejectedValueOnce(new mockBilling.MessageAllowanceError("MESSAGE_LIMIT_REACHED"));

    const response = await quickAssist(app, projectId, { kind: "brainstorm", chapterId, requestId: "request-limit-0001" });

    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe("MESSAGE_LIMIT_REACHED");
    expect(model.calls).toEqual([]);
  });

  it("never lets a cost row that cannot be written fail the assist", async () => {
    const app = await buildMobileApp({ studioAssistTextModel: scriptedAssistModel(REPLIES) });
    const { projectId, chapterId } = await studioChapter(app);
    mockPrisma.providerCallLog.create.mockRejectedValueOnce(new Error("database away"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await quickAssist(app, projectId, { kind: "brainstorm", chapterId, requestId: "request-log-0001" });

    expect(response.statusCode).toBe(200);
    expect(settledAs()).toBe(true);
    quiet.mockRestore();
  });

  it("keeps a generated book out", async () => {
    const app = await buildMobileApp({ studioAssistTextModel: scriptedAssistModel(REPLIES) });
    const { projectId, chapterId } = await studioChapter(app);
    db.projects.push({ ...db.projects[0]!, id: "project-generated", mediaSettings: { mobile: { bookType: "custom" } } });
    expect((await getManuscript(app, projectId)).statusCode).toBe(200);

    const response = await quickAssist(app, "project-generated", { kind: "brainstorm", chapterId, requestId: "request-gen-0001" });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("NOT_AUTHOR_MANUSCRIPT");
  });
});

describe("runStudioQuickAssist", () => {
  it("gives up at its time box and cancels the call it abandoned", async () => {
    let signal: AbortSignal | undefined;
    const hanging = {
      ...scriptedAssistModel({}),
      generateJson: (options: { signal?: AbortSignal }) => {
        signal = options.signal;
        return new Promise<never>(() => undefined);
      }
    };

    await expect(
      runStudioQuickAssist({
        textModel: hanging as never,
        budgetMs: 20,
        request: { kind: "brainstorm", book: { title: "T", kind: "story", language: "en" }, chapter: { title: "C", notes: "" } }
      })
    ).rejects.toThrow(/budget/);
    expect(signal?.aborted).toBe(true);
  });
});

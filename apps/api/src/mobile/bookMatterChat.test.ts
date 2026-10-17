import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import type { GenerateJsonOptions, GenerateWithToolsOptions, TextModelAdapter } from "@book-maker/core";
import { reserveCredits, startGenerationAttempt } from "@book-maker/db/billing";
import { enqueueGenerationJob } from "../queue.js";
import { decideDecision, type DecideArgs } from "../testing/bookEditIntentFixtures.js";
import { SEPARATE_REQUEST_NOTE } from "./bookMatterChatEdits.js";
import { createAssistantChatMessage, createUserProjectChatMessage } from "./projectChat.js";
import {
  approvedPlanRecord,
  bearer,
  buildMobileApp,
  generatedPages,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  openJobRow,
  projectRecord,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

/**
 * A matter change sent to the finished-book chat, end to end: routed to
 * `book_matter`, composed by the model from the book's matter as it stands,
 * written through the book's matter patch — no card, no charge, no edit
 * operation — and the book reprinted.
 */
const MATTER_DECISION: DecideArgs = {
  action: "propose_edit",
  confidence: 0.92,
  reasoning: "The reader wants the book's matter changed.",
  assistantMessage: "I’ll change that on the title and credits pages.",
  clarification: "none",
  pageIndexes: [],
  chapterIndex: null,
  targetLanguage: null,
  editTarget: "book_matter"
};

/** The chat's one routing model: the router's `decide` call and the composer's JSON, in turn. */
function chatModel(composerAnswers: Array<Record<string, unknown> | Error>, options: { routerDown?: boolean } = {}) {
  const generateWithTools = vi.fn(async (_call: GenerateWithToolsOptions) => {
    if (options.routerDown) throw new Error("router unavailable");
    return decideDecision(MATTER_DECISION);
  });
  let turn = 0;
  const generateJson = vi.fn(async (call: GenerateJsonOptions<unknown>) => {
    const answer = composerAnswers[Math.min(turn, composerAnswers.length - 1)]!;
    turn += 1;
    if (answer instanceof Error) throw answer;
    return { data: call.schema.parse(answer), text: JSON.stringify(answer), model: "test", provider: "test" };
  });
  const model = {
    generateText: async () => ({ text: "", model: "test", provider: "test" }),
    generateWithTools,
    generateJson,
    async *streamText() {
      yield "";
    }
  } as unknown as TextModelAdapter;
  const shown = (call: number) => JSON.parse(generateJson.mock.calls[call]![0].messages.at(-1)!.content);
  return { model, generateWithTools, generateJson, shown };
}

const set = (field: string, text: string | null, requestedBy: string, action: "set" | "remove" = "set") => ({
  outcome: "change",
  changes: [{ field, action, text, requestedBy }]
});

describe("a matter change sent to the book chat", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
    // One row for every read: the route's, the matter patch's own and the one
    // it takes again under the project lock.
    mockPrisma.project.findUnique.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages(),
        authorName: "Ana Ruiz",
        bookMatter: { dedication: "For Dad", allRightsReserved: true }
      })
    );
    mockPrisma.project.update.mockResolvedValue({ contentRevision: 1 });
    vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-compile", type: "COMPILE_EXPORT" }));
  });
  afterEach(teardownMobileHarness);

  const send = async (app: Awaited<ReturnType<typeof buildMobileApp>>, message: string) =>
    app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message }
    });

  const expectNothingBought = () => {
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    expect(vi.mocked(startGenerationAttempt)).not.toHaveBeenCalled();
    expect(mockPrisma.bookEditOperation.create).not.toHaveBeenCalled();
  };

  it("is composed from the book's matter and applied free, never priced as a page rewrite", async () => {
    const message = "change the dedication to mention my mom too";
    const { model, shown, generateWithTools } = chatModel([
      set("dedication", "For Dad and my mom", message), { verdicts: [{ id: 0, supported: true }] }
    ]);
    const app = await buildMobileApp({ routingTextModel: model });
    const response = await send(app, message);
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.reply.content).toBe(
      "Done — the dedication now reads “For Dad and my mom”. I’m refreshing the exports. This one’s free."
    );
    expect(body.reply.metadata).toMatchObject({
      charged: false,
      intent: { kind: "book_matter" },
      bookMatterEdit: { before: { dedication: "For Dad" }, after: { dedication: "For Dad and my mom" } }
    });
    expect(body.reply.metadata.editProposal).toBeUndefined();
    // The router saw the matter; the composer saw all of it.
    expect(JSON.parse(vi.mocked(generateWithTools).mock.calls[0]![0].messages.at(-1)!.content).bookMatter).toMatchObject({
      dedication: "For Dad",
      authorName: "Ana Ruiz"
    });
    expect(shown(0).currentMatter).toMatchObject({ dedication: "For Dad", authorName: "Ana Ruiz", allRightsReserved: true });
    expect(mockPrisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "project-1" },
        data: expect.objectContaining({ bookMatter: { dedication: "For Dad and my mom", allRightsReserved: true } })
      })
    );
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(expect.objectContaining({ type: "COMPILE_EXPORT" }));
    expectNothingBought();
    await app.close();
  });

  it("writes a cost row for each model call it makes, under the book", async () => {
    const message = "change the dedication to mention my mom too";
    const { model } = chatModel([
      set("dedication", "For Dad and my mom", message), { verdicts: [{ id: 0, supported: true }] }
    ]);
    const app = await buildMobileApp({ routingTextModel: model });
    expect((await send(app, message)).statusCode).toBe(200);

    const rows = mockPrisma.providerCallLog.create.mock.calls.map((call) => (call[0] as { data: Record<string, unknown> }).data);
    expect(rows.map((row) => row.purpose)).toEqual(expect.arrayContaining([
      "project_chat.edit_router", "project_chat.book_matter", "project_chat.book_matter_grounding"
    ]));
    for (const row of rows) {
      // Inline spend: no job, the book's id, the reader who asked, and no
      // settled price for tokens the provider never reported.
      expect(row).toMatchObject({ projectId: "project-1", generationJobId: null, userId: "user-a", costHint: null });
    }
    await app.close();
  });

  it("still reaches the matter edit when the router is down", async () => {
    const { model, generateWithTools } = chatModel([set("allRightsReserved", null, "remove all rights reserved", "remove")], {
      routerDown: true
    });
    const app = await buildMobileApp({ routingTextModel: model });
    const response = await send(app, "remove all rights reserved");

    expect(generateWithTools).toHaveBeenCalled();
    expect(response.json().reply.content).toBe(
      "Done — “All rights reserved.” no longer prints. I’m refreshing the exports. This one’s free."
    );
    expect(mockPrisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bookMatter: { dedication: "For Dad" } }) })
    );
    expectNothingBought();
    await app.close();
  });

  it("writes nothing and says so when the composer fails", async () => {
    const { model } = chatModel([new Error("provider down")]);
    const app = await buildMobileApp({ routingTextModel: model });
    const response = await send(app, "dedicate it to my mom");

    expect(response.json().reply.content).toMatch(/^Sorry, I couldn’t make that change right now\./);
    expect(response.json().operation).toBeNull();
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    expectNothingBought();
    await app.close();
  });

  it("asks once for what it needs, then applies the answer merged with the request", async () => {
    const { model, shown } = chatModel([
      { outcome: "question", question: "What’s the ISBN?" },
      set("isbn", "978-0-306-40615-7", "978-0-306-40615-7")
    ]);
    const app = await buildMobileApp({ routingTextModel: model });

    const asked = await send(app, "add an ISBN");
    expect(asked.json().reply.content).toBe("What’s the ISBN?");
    expect(asked.json().reply.metadata.pendingEdit).toMatchObject({ request: "add an ISBN", clarification: "matter" });
    expect(mockPrisma.project.update).not.toHaveBeenCalled();

    const answered = await send(app, "978-0-306-40615-7");
    expect(shown(1)).toMatchObject({ alreadyAskedOnce: true });
    expect(shown(1).readerMessage).toMatch(/^add an ISBN[\s\S]*978-0-306-40615-7$/);
    expect(answered.json().reply.content).toBe(
      "Done — the ISBN line now reads “ISBN 978-0-306-40615-7”. I’m refreshing the exports. This one’s free."
    );
    expect(mockPrisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bookMatter: expect.objectContaining({ isbn: "978-0-306-40615-7" }) }) })
    );
    expectNothingBought();
    await app.close();
  });

  it("never asks a second question: an answer that still fails is told where to send it instead", async () => {
    const { model, shown } = chatModel([
      // An ISBN the reader never typed, then one whose check digit is wrong.
      set("isbn", "978-0-306-40615-7", "add an ISBN"),
      set("isbn", "978-0-306-40615-8", "978-0-306-40615-8")
    ]);
    const app = await buildMobileApp({ routingTextModel: model });

    const asked = await send(app, "add an ISBN");
    expect(asked.json().reply.content).toMatch(/\?$/);
    expect(asked.json().reply.metadata.pendingEdit).toMatchObject({ request: "add an ISBN", clarification: "matter" });

    const answered = await send(app, "978-0-306-40615-8");
    expect(shown(1)).toMatchObject({ alreadyAskedOnce: true });
    const content: string = answered.json().reply.content;
    expect(content).toMatch(/^That doesn’t look like a valid ISBN/);
    expect(content).not.toContain("?");
    expect(content).toMatch(/Title & credits to type it in yourself\.$/);
    expect(answered.json().reply.metadata.pendingEdit).toBeUndefined();
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    expectNothingBought();
    await app.close();
  });

  it("applies an answer that names no field, because the request it answers did", async () => {
    const { model } = chatModel([
      { outcome: "question", question: "What’s the publisher called?" },
      set("imprint", "Lantern", "Lantern")
    ]);
    const app = await buildMobileApp({ routingTextModel: model });

    expect((await send(app, "change the publisher")).json().reply.content).toBe("What’s the publisher called?");
    const answered = await send(app, "Lantern");
    expect(answered.json().reply.content).toBe(
      "Done — the publisher line now reads “Lantern”. I’m refreshing the exports. This one’s free."
    );
    expect(mockPrisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bookMatter: expect.objectContaining({ imprint: "Lantern" }) }) })
    );
    expectNothingBought();
    await app.close();
  });

  it("takes the answer to its question as words to print, even when they read like a scope", async () => {
    // Review finding 4: stored as a scope question, "throughout" resolved as a
    // scope — the composer got "Add a dedication throughout the whole book",
    // without the reader's words, and asked again.
    for (const answer of [
      "For my mom, who stood by me throughout",
      "For everyone who believed in me, everywhere",
      "To the whole book club",
      "For Dad, on every page"
    ]) {
      resetMobileHarness();
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findUnique.mockResolvedValue(
        projectRecord({ id: "project-1", status: "COMPLETE", currentPlanId: "plan-1", currentPlan: approvedPlanRecord(), pages: generatedPages() })
      );
      mockPrisma.project.update.mockResolvedValue({ contentRevision: 1 });
      vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-compile", type: "COMPILE_EXPORT" }));
      const { model, shown, generateWithTools } = chatModel([
        { outcome: "question", question: "What should the dedication say?" },
        set("dedication", answer, answer)
      ]);
      const app = await buildMobileApp({ routingTextModel: model });

      const asked = await send(app, "Add a dedication");
      expect(asked.json().reply.content, answer).toBe("What should the dedication say?");
      expect(asked.json().reply.metadata.pendingEdit).toEqual({ request: "Add a dedication", clarification: "matter" });

      const answered = await send(app, answer);
      // Merged as the follow-up that spends the one question — for the router and the composer alike.
      const routed = JSON.parse(vi.mocked(generateWithTools).mock.calls[1]![0].messages.at(-1)!.content);
      expect(routed.userMessage, answer).toBe(`Add a dedication\n\nFollow-up from the user: ${answer}`);
      expect(shown(1), answer).toMatchObject({ alreadyAskedOnce: true, readerMessage: `Add a dedication\n\nFollow-up from the user: ${answer}` });
      expect(answered.json().reply.content, answer).toBe(
        `Done — the dedication now reads “${answer}”. I’m refreshing the exports. This one’s free.`
      );
      expect(answered.json().reply.metadata.pendingEdit).toBeUndefined();
      expect(mockPrisma.project.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ bookMatter: expect.objectContaining({ dedication: answer }) }) })
      );
      expectNothingBought();
      await app.close();
    }
  });

  it("drops its question on a cancel word, and merges anything else as the follow-up for the router to read", async () => {
    const { model, generateJson, generateWithTools } = chatModel([
      { outcome: "question", question: "What should the dedication say?" },
      { outcome: "question", question: "What should the dedication say?" },
      { outcome: "none", noneReason: "not_matter" }
    ]);
    const app = await buildMobileApp({ routingTextModel: model });

    await send(app, "Add a dedication");
    const cancelled = await send(app, "never mind");
    expect(cancelled.json().reply.content).toBe("Okay, I dropped that request. No edit was applied.");
    expect(cancelled.json().reply.metadata).toMatchObject({ pendingEditCancelled: true });
    expect(generateJson).toHaveBeenCalledTimes(1);

    // A new request while the question is open is the follow-up the router
    // reads with its question spent — a scope word in it resolves nothing.
    await send(app, "Add a dedication");
    await send(app, "make every page funnier");
    const routed = JSON.parse(vi.mocked(generateWithTools).mock.calls.at(-1)![0].messages.at(-1)!.content);
    expect(routed.userMessage).toBe("Add a dedication\n\nFollow-up from the user: make every page funnier");
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    expectNothingBought();
    await app.close();
  });

  it("still resumes a question an older build stored as a scope question", async () => {
    // Written before the matter question had its own kind.
    const request = await mockPrisma.projectChatMessage.create({
      data: { projectId: "project-1", role: "USER", content: "add an ISBN", metadata: {} }
    });
    await mockPrisma.projectChatMessage.create({
      data: {
        projectId: "project-1",
        parentId: request.id,
        role: "ASSISTANT",
        content: "What’s the ISBN?",
        metadata: { intent: { kind: "book_matter" }, charged: false, pendingEdit: { request: "add an ISBN", clarification: "scope" } }
      }
    });
    const { model, shown } = chatModel([set("isbn", "978-0-306-40615-7", "978-0-306-40615-7")]);
    const app = await buildMobileApp({ routingTextModel: model });

    const answered = await send(app, "978-0-306-40615-7");
    expect(shown(0)).toMatchObject({ alreadyAskedOnce: true });
    expect(shown(0).readerMessage).toMatch(/^add an ISBN[\s\S]*978-0-306-40615-7$/);
    expect(answered.json().reply.content).toBe(
      "Done — the ISBN line now reads “ISBN 978-0-306-40615-7”. I’m refreshing the exports. This one’s free."
    );
    expectNothingBought();
    await app.close();
  });

  it("changes the matter of a compound sentence with the router down, and names the page edit as a separate change", async () => {
    // Review finding 7: the page number in the same sentence made the whole
    // message a priced page edit, and the publisher change was dropped.
    const message = "Change the publisher to Lantern and make page 2 shorter";
    const { model } = chatModel([set("imprint", "Lantern", "Change the publisher to Lantern")], { routerDown: true });
    const app = await buildMobileApp({ routingTextModel: model });
    const response = await send(app, message);

    expect(response.json().operation).toBeNull();
    expect(response.json().reply.metadata.intent).toMatchObject({ kind: "book_matter" });
    expect(response.json().reply.content).toBe(
      `Done — the publisher line now reads “Lantern”. I’m refreshing the exports. This one’s free. ${SEPARATE_REQUEST_NOTE}`
    );
    expect(mockPrisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bookMatter: expect.objectContaining({ imprint: "Lantern" }) }) })
    );
    expectNothingBought();
    await app.close();
  });

  it.each([
    { saved: {}, expected: undefined },
    { saved: { replyLanguage: "fa" }, expected: "fa" }
  ])("tells the router and the composer a conversation language only when a turn saved one ($expected)", async ({ saved, expected }) => {
    // A Persian chat from before reply languages were saved records none. Told
    // the English default as established, both prompts answered a bare ISBN in
    // English; with nothing told, they read the language off the transcript.
    const asked = await createUserProjectChatMessage({
      projectId: "project-1", parentId: null, content: "یک شابک به کتاب اضافه کن", metadata: {}
    });
    await createAssistantChatMessage({
      projectId: "project-1", parentId: asked.id, content: "شابک کتاب چیست؟", metadata: { charged: false, ...saved }
    });
    const message = "۹۷۸۰۳۰۶۴۰۶۱۵۷";
    const { model, generateWithTools, shown } = chatModel([set("isbn", message, message)]);
    const app = await buildMobileApp({ routingTextModel: model });
    const response = await send(app, message);

    expect(response.statusCode).toBe(200);
    const routed = JSON.parse(vi.mocked(generateWithTools).mock.calls[0]![0].messages.at(-1)!.content);
    expect(routed.userMessage).toBe(message);
    expect(routed.conversationLanguage).toBe(expected);
    expect(shown(0).readerMessage).toBe(message);
    expect(shown(0).conversationLanguage).toBe(expected);
    await app.close();
  });

  it("forgets its question once the answer has been replied to", async () => {
    // Nothing marked the answering turn, so the next message — and every one
    // after it — was merged with "add an ISBN" as the question's follow-up.
    const { model, generateWithTools, shown } = chatModel([
      { outcome: "question", question: "What’s the ISBN?" },
      set("isbn", "978-0-306-40615-7", "978-0-306-40615-7"),
      { outcome: "question", question: "Who should the dedication be for?" }
    ]);
    const app = await buildMobileApp({ routingTextModel: model });
    await send(app, "add an ISBN");
    await send(app, "978-0-306-40615-7");
    const next = await send(app, "add a dedication");

    const routed = JSON.parse(vi.mocked(generateWithTools).mock.calls.at(-1)![0].messages.at(-1)!.content);
    expect(routed.userMessage).toBe("add a dedication");
    expect(shown(2)).toMatchObject({ readerMessage: "add a dedication", alreadyAskedOnce: false });
    // A fresh request may ask its own one question.
    expect(next.json().reply.metadata.pendingEdit).toEqual({ request: "add a dedication", clarification: "matter" });
    await app.close();
  });

  it("applies a follow-up that points back with “it”", async () => {
    // Review round 7: the gate kept a change only when its quoted words named its
    // field, so every follow-up was dropped — 0 of 12.
    const { model, shown } = chatModel([
      set("dedication", "For my mom", "Dedicate it to my mom"),
      set("dedication", "For my mom and my sister", "Mention my sister in it too"),
      { verdicts: [{ id: 0, supported: true }] },
      {
        outcome: "change",
        changes: [
          { field: "dedication", action: "set", text: "For my sister", requestedBy: "Make it just my sister" },
          { field: "imprint", action: "set", text: "Lantern", requestedBy: "the publisher is Lantern" }
        ]
      }
    ]);
    const app = await buildMobileApp({ routingTextModel: model });
    const first = await send(app, "Dedicate it to my mom");
    expect(first.json().reply.content).toBe("Done — the dedication now reads “For my mom”. I’m refreshing the exports. This one’s free.");

    mockPrisma.project.findUnique.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages(),
        authorName: "Ana Ruiz",
        bookMatter: { dedication: "For my mom", allRightsReserved: true }
      })
    );
    const followUp = await send(app, "Mention my sister in it too");
    // The composer is shown the reply it points back at.
    expect(shown(1).recentConversation).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "assistant", content: expect.stringContaining("For my mom") })])
    );
    expect(followUp.json().reply.content).toBe(
      "Done — the dedication now reads “For my mom and my sister”. I’m refreshing the exports. This one’s free."
    );
    expect(followUp.json().reply.metadata).toMatchObject({
      bookMatterEdit: { before: { dedication: "For my mom" }, after: { dedication: "For my mom and my sister" } }
    });
    expect(mockPrisma.project.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bookMatter: { dedication: "For my mom and my sister", allRightsReserved: true } }) })
    );

    // Beside a change that names its field, "it" is read off the stored reply before it.
    const both = await send(app, "Make it just my sister, and the publisher is Lantern");
    expect(both.json().reply.metadata.bookMatterEdit.after).toEqual({ dedication: "For my sister", imprint: "Lantern" });
    expectNothingBought();
    await app.close();
  });

  it("is saved behind a running job and run on “apply it”", async () => {
    mockPrisma.generationJob.findMany.mockResolvedValueOnce([
      openJobRow({ operationId: "ordinary-edit", intentKind: "page_rewrite" })
    ]);
    const { model } = chatModel([set("dedication", null, "remove the dedication", "remove")]);
    const app = await buildMobileApp({ routingTextModel: model });
    const busy = await send(app, "remove the dedication");

    expect(busy.statusCode).toBe(200);
    // A free edit has no card to confirm, so the saved request runs as it is.
    expect(busy.json().reply.content).toContain("I’ll run it");
    expect(busy.json().reply.metadata).toMatchObject({
      blockedByActiveJob: true,
      pendingEdit: { request: "remove the dedication", clarification: "busy" }
    });
    expect(mockPrisma.project.update).not.toHaveBeenCalled();

    const resumed = await send(app, "apply it");
    expect(resumed.json().reply.content).toBe("Done — the dedication is gone. I’m refreshing the exports. This one’s free.");
    expect(mockPrisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bookMatter: { allRightsReserved: true } }) })
    );
    expectNothingBought();
    await app.close();
  });
});

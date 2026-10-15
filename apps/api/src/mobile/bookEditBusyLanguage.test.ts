import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { reserveCredits, startGenerationAttempt } from "@book-maker/db/billing";
import { decideDecision, fakeDecideModel, type DecideArgs } from "../testing/bookEditIntentFixtures.js";
import { createAssistantChatMessage, createUserProjectChatMessage } from "./projectChat.js";
import {
  approvedPlanRecord, bearer, buildMobileApp, generatedPages, mockAccessTokens,
  mockPrisma, openJobRow, projectRecord, resetMobileHarness, teardownMobileHarness
} from "./testing/mobileApiHarness.js";

const decision = (kind: "book_matter" | "tomeza_credit", responseLanguage?: string): DecideArgs => ({
  action: "propose_edit", confidence: 0.95, reasoning: "A free matter change.",
  assistantMessage: "I’ll change that.", clarification: "none", pageIndexes: [],
  chapterIndex: null, targetLanguage: null, editTarget: kind,
  ...(responseLanguage ? { responseLanguage } : {})
});
// A Tomeza request the English-only precise recogniser does not read, so the router picks its language.
const request = { book_matter: "remove the dedication", tomeza_credit: "Can the Made with Tomeza line go?" };
const send = (app: Awaited<ReturnType<typeof buildMobileApp>>, message: string) => app.inject({
  method: "POST", url: "/api/mobile/projects/project-1/chat/messages",
  headers: bearer("token-a"), payload: { message }
});

describe("saved matter requests while a book is busy", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findUnique.mockResolvedValue(projectRecord({
      id: "project-1", status: "COMPLETE", language: "english", currentPlanId: "plan-1",
      currentPlan: approvedPlanRecord(), pages: generatedPages(), bookMatter: { dedication: "For Dad" }
    }));
    mockPrisma.generationJob.findMany.mockResolvedValue([
      openJobRow({ operationId: "ordinary-edit", intentKind: "page_rewrite" })
    ]);
  });
  afterEach(teardownMobileHarness);

  it.each([
    { kind: "book_matter", language: "fa", expected: "درخواست" },
    { kind: "book_matter", language: "ar", expected: "طلبك" },
    { kind: "book_matter", language: "fr", expected: "demande" },
    { kind: "tomeza_credit", language: "fa", expected: "درخواست" },
    { kind: "tomeza_credit", language: "ar", expected: "طلبك" },
    { kind: "tomeza_credit", language: "fr", expected: "demande" }
  ] as const)("saves $kind in the router's $language conversation language", async ({ kind, language, expected }) => {
    const model = fakeDecideModel(decision(kind, language));
    const app = await buildMobileApp({ routingTextModel: model });
    const response = await send(app, request[kind]);
    expect(response.statusCode).toBe(200);
    const { reply, operation } = response.json();
    expect(reply.content).toContain(expected);
    // The quoted command remains executable by the pending-edit confirmation parser.
    expect(reply.content).toContain("apply it");
    expect(reply.metadata).toMatchObject({
      replyLanguage: language, blockedByActiveJob: true, charged: false,
      intent: { kind, responseLanguage: language },
      pendingEdit: { request: request[kind], clarification: "busy" }
    });
    expect(reply.metadata.editProposal).toBeUndefined();
    expect(operation).toBeNull();
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    expect(mockPrisma.bookEditOperation.create).not.toHaveBeenCalled();
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(startGenerationAttempt).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([undefined, "Persian"])("keeps history when the busy router's language is %j", async (hint) => {
    const previousUser = await createUserProjectChatMessage({
      projectId: "project-1", parentId: null, content: "نام نویسنده را تغییر بده", metadata: {}
    });
    await createAssistantChatMessage({
      projectId: "project-1", parentId: previousUser.id, content: "انجام شد",
      metadata: { replyLanguage: "fa", charged: false }
    });
    const model = fakeDecideModel(decision("book_matter", hint));
    const app = await buildMobileApp({ routingTextModel: model });
    const response = await send(app, request.book_matter);
    expect(response.statusCode).toBe(200);
    expect(response.json().reply.content).toContain("درخواست");
    expect(response.json().reply.metadata.replyLanguage).toBe("fa");
    await app.close();
  });

  it("preserves the saved language when the free request resumes after the job finishes", async () => {
    const model = fakeDecideModel(decision("tomeza_credit", "fa"));
    const app = await buildMobileApp({ routingTextModel: model });
    const busy = await send(app, request.tomeza_credit);
    expect(busy.json().reply.metadata.replyLanguage).toBe("fa");

    mockPrisma.generationJob.findMany.mockResolvedValue([]);
    model.generateWithTools.mockResolvedValue(decideDecision(decision("tomeza_credit")));
    const resumed = await send(app, "apply it");
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().reply.metadata).toMatchObject({
      replyLanguage: "fa", charged: false, insufficientCredits: {}, intent: { kind: "tomeza_credit" }
    });
    expect(resumed.json().reply.metadata.pendingEdit).toBeUndefined();
    expect(JSON.parse(model.generateWithTools.mock.calls[1]![0].messages.at(-1)!.content)).toMatchObject({
      conversationLanguage: "fa", userMessage: request.tomeza_credit
    });
    await app.close();
  });
});

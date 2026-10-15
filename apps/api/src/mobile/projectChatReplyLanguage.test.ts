import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { startGenerationAttempt } from "@book-maker/db/billing";
import { fakeDecideModel, type DecideArgs } from "../testing/bookEditIntentFixtures.js";
import { BOOK_TITLE_CHAT_COPY } from "./bookTitleChatCopy.js";
import { createAssistantChatMessage, createUserProjectChatMessage } from "./projectChat.js";
import { PROJECT_CHAT_REPLY_COPY } from "./projectChatReplyCopy.js";
import {
  approvedPlanRecord, bearer, buildMobileApp, generatedPages, mockAccessTokens,
  mockPrisma, openJobRow, projectRecord, resetMobileHarness, teardownMobileHarness
} from "./testing/mobileApiHarness.js";

/**
 * The chat's deterministic replies — a dropped request, an undo or redo held
 * back by a running job, a title change — answer in the conversation's
 * language and record it, like the localized matter and busy replies beside
 * them. A Persian reader asked a Persian matter question who answered "cancel"
 * used to get the conversation's one English reply.
 */
type App = Awaited<ReturnType<typeof buildMobileApp>>;
const send = (app: App, message: string) => app.inject({
  method: "POST", url: "/api/mobile/projects/project-1/chat/messages", headers: bearer("token-a"), payload: { message }
});
const decision = (overrides: Partial<DecideArgs> & Record<string, unknown>): DecideArgs => ({
  action: "propose_edit", confidence: 0.95, reasoning: "Routed.", assistantMessage: "Okay.",
  clarification: "none", pageIndexes: [], chapterIndex: null, targetLanguage: null, ...overrides
});

/** An open matter question, saved the way the matter composer saves one. */
async function matterQuestion(replyLanguage?: string) {
  const asked = await createUserProjectChatMessage({
    projectId: "project-1", parentId: null, content: replyLanguage ? "شابک کتاب را اضافه کن" : "Add an ISBN", metadata: {}
  });
  await createAssistantChatMessage({
    projectId: "project-1", parentId: asked.id,
    content: replyLanguage ? "شابک چه باشد؟" : "What should the ISBN be?",
    metadata: {
      charged: false,
      pendingEdit: { request: asked.content, clarification: "matter" },
      ...(replyLanguage ? { replyLanguage } : {})
    }
  });
}

/** An earlier Persian turn, so a language-less decision has history to keep. */
async function persianHistory() {
  const asked = await createUserProjectChatMessage({ projectId: "project-1", parentId: null, content: "سلام", metadata: {} });
  await createAssistantChatMessage({
    projectId: "project-1", parentId: asked.id, content: "سلام! چه کمکی از دستم برمی‌آید؟",
    metadata: { charged: false, replyLanguage: "fa" }
  });
}

describe("deterministic chat replies follow the conversation language", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findUnique.mockResolvedValue(projectRecord({
      id: "project-1", status: "COMPLETE", title: "The Quiet Sea", currentPlanId: "plan-1",
      currentPlan: approvedPlanRecord(), pages: generatedPages()
    }));
  });
  afterEach(teardownMobileHarness);

  it("drops a Persian matter question in Persian when the reader answers cancel", async () => {
    await matterQuestion("fa");
    const app = await buildMobileApp();
    const response = await send(app, "cancel");
    expect(response.statusCode).toBe(200);
    const { reply } = response.json();
    expect(reply.content).toBe(PROJECT_CHAT_REPLY_COPY.fa.cancelled);
    expect(reply.metadata).toMatchObject({ pendingEditCancelled: true, charged: false, replyLanguage: "fa" });
    await app.close();
  });

  it("keeps the English cancel reply for an English conversation", async () => {
    await matterQuestion();
    const app = await buildMobileApp();
    const response = await send(app, "never mind");
    expect(response.json().reply.content).toBe("Okay, I dropped that request. No edit was applied.");
    expect(response.json().reply.metadata).toMatchObject({ pendingEditCancelled: true, replyLanguage: "en" });
    await app.close();
  });

  it.each([
    { kind: "undo_last_edit", copy: "undoBusy" },
    { kind: "redo_last_edit", copy: "redoBusy" }
  ] as const)("holds back a Persian $kind in Persian while a job runs", async ({ kind, copy }) => {
    mockPrisma.generationJob.findMany.mockResolvedValue([openJobRow({ operationId: "edit-1", intentKind: "page_rewrite" })]);
    const model = fakeDecideModel(decision({ action: kind, responseLanguage: "fa" }));
    const app = await buildMobileApp({ routingTextModel: model });
    const response = await send(app, kind === "undo_last_edit" ? "آخرین ویرایش را برگردان" : "ویرایشی را که برگرداندی دوباره اعمال کن");
    expect(response.statusCode).toBe(200);
    const { reply, operation } = response.json();
    expect(reply.content).toBe(PROJECT_CHAT_REPLY_COPY.fa[copy]);
    expect(reply.metadata).toMatchObject({ replyLanguage: "fa", blockedByActiveJob: true, charged: false, intent: { kind } });
    expect(reply.metadata.pendingEdit).toBeUndefined();
    expect(operation).toBeNull();
    await app.close();
  });

  it("answers a model-free busy undo from the conversation's saved language, and English stays English", async () => {
    mockPrisma.generationJob.findMany.mockResolvedValue([openJobRow({ operationId: "edit-1", intentKind: "page_rewrite" })]);
    const app = await buildMobileApp();
    const english = await send(app, "undo");
    expect(english.json().reply.content).toBe(
      "This book is still being worked on. Ask me to undo again once the current job finishes."
    );
    expect(english.json().reply.metadata.replyLanguage).toBe("en");

    await persianHistory();
    const persian = await send(app, "undo");
    expect(persian.json().reply.content).toBe(PROJECT_CHAT_REPLY_COPY.fa.undoBusy);
    expect(persian.json().reply.metadata.replyLanguage).toBe("fa");
    await app.close();
  });

  it("proposes an AI-cover retitle in Persian, then drops it in Persian from either cancel", async () => {
    mockPrisma.imageAsset.findFirst.mockResolvedValue({ metadata: { coverArtSource: "ai" } });
    // The router named the title but no language: the saved Persian turn decides.
    await persianHistory();
    const model = fakeDecideModel(decision({ editTarget: "book_title", bookTitle: "دریای نقره‌ای" }));
    const app = await buildMobileApp({ routingTextModel: model });

    const proposed = await send(app, "عنوان کتاب را به «دریای نقره‌ای» تغییر بده");
    expect(proposed.statusCode).toBe(200);
    const card = proposed.json().reply;
    expect(card.content).toBe(BOOK_TITLE_CHAT_COPY.fa.proposal.replace("{title}", "دریای نقره‌ای"));
    expect(card.metadata).toMatchObject({ replyLanguage: "fa", editProposal: { kind: "book_title" } });
    expect(card.content).not.toMatch(/\d/);

    const typed = await send(app, "cancel");
    expect(typed.json().reply.content).toBe(PROJECT_CHAT_REPLY_COPY.fa.cancelled);
    expect(typed.json().reply.metadata.replyLanguage).toBe("fa");

    const again = await send(app, "عنوان کتاب را به «دریای نقره‌ای» تغییر بده");
    const button = await app.inject({
      method: "POST", url: "/api/mobile/projects/project-1/chat/proposals/cancel", headers: bearer("token-a"),
      payload: { proposalId: again.json().reply.metadata.editProposal.id, requestId: "cancel-1" }
    });
    expect(button.statusCode).toBe(200);
    expect(button.json().reply.content).toBe(PROJECT_CHAT_REPLY_COPY.fa.cancelled);
    expect(button.json().reply.metadata).toMatchObject({ pendingEditCancelled: true, replyLanguage: "fa" });
    expect(startGenerationAttempt).not.toHaveBeenCalled();
    await app.close();
  });
});

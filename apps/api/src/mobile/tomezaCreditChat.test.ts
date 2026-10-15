import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { reserveCredits, resolvePlanTier, startGenerationAttempt } from "@book-maker/db/billing";
import { objectKey } from "@book-maker/storage";
import { enqueueGenerationJob } from "../queue.js";
import { seedObject } from "../testing/objectStorage.js";
import { decideDecision, fakeDecideModel, type DecideArgs } from "../testing/bookEditIntentFixtures.js";
import { TOMEZA_CREDIT_NOT_FINISHED_MESSAGE } from "./tomezaCredit.js";
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
 * "Remove the Made with Tomeza line" in the finished-book chat, end to end
 * through the shared `removeTomezaCredit`: a subscriber's book is reprinted
 * free with no card, charge or edit operation; a free account is offered the
 * plans; and nothing is ever priced as a page rewrite.
 */
const PUBLISHED_WITH_CREDIT = [
  '<section class="book-title-page">',
  '  <h1 class="book-title-page__title">Owned Book</h1>',
  '  <p class="book-title-page__imprint">Made with Tomeza</p>',
  "</section>",
  "",
  "The first page."
].join("\n");

const creditDecision = (responseLanguage?: string): DecideArgs => ({
  action: "propose_edit", confidence: 0.92, reasoning: "Remove the free-tier credit.",
  assistantMessage: "I’ll take the Made with Tomeza line off.", clarification: "none",
  pageIndexes: [], chapterIndex: null, targetLanguage: null, editTarget: "tomeza_credit",
  ...(responseLanguage ? { responseLanguage } : {})
});

describe("the Tomeza line sent to the book chat", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findUnique.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    mockPrisma.project.update.mockResolvedValue({ contentRevision: 1 });
    vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-compile", type: "COMPILE_EXPORT" }));
    seedObject(objectKey("books", "project-1", "book.md"), PUBLISHED_WITH_CREDIT);
  });
  afterEach(teardownMobileHarness);

  const send = async (app: Awaited<ReturnType<typeof buildMobileApp>>, message: string) =>
    app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message }
    });

  const nothingBought = () => {
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    expect(vi.mocked(startGenerationAttempt)).not.toHaveBeenCalled();
    expect(mockPrisma.bookEditOperation.create).not.toHaveBeenCalled();
  };

  it("uses the router's Arabic language for a polite removal request sharing Persian vocabulary", async () => {
    const model = fakeDecideModel({
      action: "propose_edit", confidence: 0.92, reasoning: "Remove the free-tier credit.",
      assistantMessage: "سأحذف هذه العبارة من الكتاب.", responseLanguage: "ar", clarification: "none",
      pageIndexes: [], chapterIndex: null, targetLanguage: null, editTarget: "tomeza_credit"
    });
    const app = await buildMobileApp({ routingTextModel: model });
    const response = await send(app, "هل يمكنك حذف عبارة Tomeza؟");

    expect(response.statusCode).toBe(200);
    expect(response.json().reply.metadata).toMatchObject({ charged: false, replyLanguage: "ar" });
    expect(response.json().reply.content).toMatch(/^تتيح أي خطة اشتراك/);
    expect(model.generateWithTools).toHaveBeenCalledOnce();
    nothingBought();
    await app.close();
  });

  it.each([
    { language: "fa", message: "Tomeza را از کتاب بردار", plan: "creator", expected: "انجام شد" },
    { language: "ar", message: "احذف عبارة Tomeza من الكتاب", plan: "free", expected: "اشتراك" },
    { language: "fr", message: "Supprime la mention Tomeza de mon livre", plan: "creator", expected: "Terminé" }
  ] as const)("answers the $language request in its conversation language", async ({ language, message, plan, expected }) => {
    vi.mocked(resolvePlanTier).mockResolvedValue(plan);
    const model = fakeDecideModel({
      action: "propose_edit",
      confidence: 0.92,
      reasoning: "The reader wants the free-tier credit gone.",
      assistantMessage: "I’ll take the Made with Tomeza line off.",
      responseLanguage: language,
      clarification: "none",
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null,
      editTarget: "tomeza_credit"
    });
    const app = await buildMobileApp({ routingTextModel: model });
    const response = await send(app, message);
    const { reply, operation } = response.json();

    expect(response.statusCode).toBe(200);
    expect(reply.content).toContain(expected);
    expect(reply.metadata).toMatchObject({ charged: false, replyLanguage: language, intent: { kind: "tomeza_credit" } });
    // The precise recogniser reads English alone, so with no history the router picks the language.
    expect(model.generateWithTools).toHaveBeenCalledOnce();
    expect(operation).toBeNull();
    expect(reply.metadata.editProposal).toBeUndefined();
    if (plan === "free") {
      expect(reply.metadata.insufficientCredits).toEqual({});
      expect(reply.content).not.toMatch(/\p{N}/u);
      expect(mockPrisma.project.update).not.toHaveBeenCalled();
    } else {
      expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(expect.objectContaining({ type: "COMPILE_EXPORT" }));
    }
    nothingBought();
    await app.close();
  });

  it("keeps an English request in English for a Persian book", async () => {
    mockPrisma.project.findUnique.mockResolvedValue(projectRecord({
      id: "project-1", status: "COMPLETE", language: "persian", currentPlanId: "plan-1",
      currentPlan: approvedPlanRecord(), pages: generatedPages()
    }));
    const app = await buildMobileApp();
    const response = await send(app, "Remove the Made with Tomeza line");

    expect(response.statusCode).toBe(200);
    expect(response.json().reply.content).toMatch(/^Removing the/);
    expect(response.json().reply.metadata).toMatchObject({ charged: false, replyLanguage: "en" });
    nothingBought();
    await app.close();
  });

  it.each([
    { language: "fr", message: "Supprime Tomeza", plan: "creator", expected: "Terminé" },
    { language: "fr", message: "Supprime Tomeza", plan: "free", expected: "Tout abonnement" },
    { language: "es", message: "Quita Tomeza", plan: "creator", expected: "Hecho" },
    { language: "es", message: "Quita Tomeza", plan: "free", expected: "Cualquier suscripción" },
    { language: "zh", message: "请删除 Tomeza", plan: "creator", expected: "已完成" },
    { language: "zh", message: "请删除 Tomeza", plan: "free", expected: "订阅任意套餐" },
    { language: "ar", message: "أزل علامة Tomeza", plan: "creator", expected: "تم" },
    { language: "ar", message: "أزل علامة Tomeza", plan: "free", expected: "تتيح" },
    { language: "ja", message: "Tomeza の表示を消して", plan: "creator", expected: "完了" },
    { language: "ja", message: "Tomeza の表示を消して", plan: "free", expected: "どの定期購入" },
    { language: "ko", message: "Tomeza 지워 줘", plan: "creator", expected: "완료" },
    { language: "ru", message: "Убери Tomeza", plan: "free", expected: "Убрать" },
    { language: "pt", message: "Retire a marca Tomeza", plan: "creator", expected: "Concluído" }
  ] as const)("switches an English conversation to $language for a short removal request on $plan", async ({ language, message, plan, expected }) => {
    const model = fakeDecideModel(creditDecision(language));
    const app = await buildMobileApp({ routingTextModel: model });
    const first = await send(app, "Remove the Made with Tomeza line");
    expect(first.statusCode).toBe(200);
    expect(first.json().reply.metadata.replyLanguage).toBe("en");
    expect(model.generateWithTools).not.toHaveBeenCalled();

    vi.mocked(resolvePlanTier).mockResolvedValue(plan);
    const response = await send(app, message);
    const { reply, operation } = response.json();
    expect(response.statusCode).toBe(200);
    expect(reply.content).toMatch(new RegExp(`^${expected}`));
    expect(reply.metadata).toMatchObject({ charged: false, replyLanguage: language, intent: { kind: "tomeza_credit" } });
    expect(operation).toBeNull();
    expect(reply.metadata.editProposal).toBeUndefined();
    if (plan === "free") {
      expect(reply.metadata.insufficientCredits).toEqual({});
      expect(mockPrisma.project.update).not.toHaveBeenCalled();
      expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    } else {
      expect(reply.metadata.insufficientCredits).toBeUndefined();
      expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(expect.objectContaining({ type: "COMPILE_EXPORT" }));
    }
    nothingBought();
    await app.close();
  });

  it.each([undefined, "Persian"])("retains saved language on a terse follow-up when the router returns %j", async (hint) => {
    const model = fakeDecideModel(creditDecision(hint));
    model.generateWithTools.mockResolvedValueOnce(decideDecision(creditDecision("fa")));
    const app = await buildMobileApp({ routingTextModel: model });
    const first = await send(app, "Tomeza را از کتاب بردار");
    const followUp = await send(app, "بله");

    expect(first.statusCode).toBe(200);
    expect(followUp.statusCode).toBe(200);
    expect(first.json().reply.metadata.replyLanguage).toBe("fa");
    expect(followUp.json().reply.metadata).toMatchObject({ replyLanguage: "fa", insufficientCredits: {}, charged: false });
    expect(followUp.json().reply.content).toBe(first.json().reply.content);
    expect(JSON.parse(model.generateWithTools.mock.calls[1]![0].messages.at(-1).content)).toMatchObject({
      conversationLanguage: "fa",
      userMessage: "بله"
    });
    nothingBought();
    await app.close();
  });

  it("retains saved conversation language when the router becomes unavailable", async () => {
    const model = fakeDecideModel(creditDecision("fa"));
    const app = await buildMobileApp({ routingTextModel: model });
    await send(app, "Tomeza را از کتاب بردار");
    model.generateWithTools.mockRejectedValue(new Error("router unavailable"));
    const response = await send(app, "Remove the Made with Tomeza line");

    expect(response.statusCode).toBe(200);
    expect(response.json().reply.metadata).toMatchObject({ replyLanguage: "fa", charged: false });
    expect(model.generateWithTools).toHaveBeenCalledOnce();
    nothingBought();
    await app.close();
  });

  // A precise removal is answered without a paid router call. Its words are
  // English, but the language a conversation has established wins: a precise
  // removal no longer switches a Persian chat back to English, while the next
  // message the router reads still can.
  it("answers a precise English removal with no router call, in English with no history", async () => {
    const model = fakeDecideModel(creditDecision("fa"));
    const app = await buildMobileApp({ routingTextModel: model });
    const response = await send(app, "Remove the Made with Tomeza line");

    expect(response.statusCode).toBe(200);
    expect(response.json().reply.metadata).toMatchObject({
      replyLanguage: "en", charged: false, intent: { kind: "tomeza_credit", responseLanguage: "en" }
    });
    expect(response.json().reply.content).toMatch(/^Removing the/);
    expect(model.generateWithTools).not.toHaveBeenCalled();
    nothingBought();
    await app.close();
  });

  it("keeps a saved Persian conversation on a precise English removal, with no router call", async () => {
    const model = fakeDecideModel(creditDecision("en"));
    model.generateWithTools.mockResolvedValueOnce(decideDecision(creditDecision("fa")));
    const app = await buildMobileApp({ routingTextModel: model });
    const first = await send(app, "Tomeza را از کتاب بردار");
    const response = await send(app, "Remove the Made with Tomeza line");

    expect(response.statusCode).toBe(200);
    expect(response.json().reply.metadata).toMatchObject({
      replyLanguage: "fa", charged: false, intent: { kind: "tomeza_credit", responseLanguage: "fa" }
    });
    expect(response.json().reply.content).toBe(first.json().reply.content);
    // Only the Persian opener reached the router.
    expect(model.generateWithTools).toHaveBeenCalledOnce();
    nothingBought();
    await app.close();
  });

  it("reprints a subscriber's book free, never priced as a page rewrite", async () => {
    vi.mocked(resolvePlanTier).mockResolvedValue("creator");
    const app = await buildMobileApp();
    const response = await send(app, "Remove the Made with Tomeza line");
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.reply.content).toBe(
      "Done — I’m taking the “Made with Tomeza” line off this book and refreshing the exports. This one’s free."
    );
    expect(body.reply.metadata).toMatchObject({ charged: false, intent: { kind: "tomeza_credit" } });
    expect(body.reply.metadata.editProposal).toBeUndefined();
    expect(body.reply.metadata.insufficientCredits).toBeUndefined();
    // A presentation reprint: the revision bump and a compile, nothing else.
    expect(mockPrisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "project-1" }, data: expect.objectContaining({ status: "EDITING" }) })
    );
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(expect.objectContaining({ type: "COMPILE_EXPORT" }));
    nothingBought();
    await app.close();
  });

  it("offers a free account the plans, in a reply that never dead-ends and never names a price", async () => {
    const app = await buildMobileApp();
    const response = await send(app, "please remove the Tomeza watermark");
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.reply.content).toBe(
      "Removing the “Made with Tomeza” line comes with any plan — credits alone don’t unlock it. Tap below and pick a monthly plan, then ask me again and I’ll take it off this book for free."
    );
    // The one chat key every shipped app draws a paywall button from; no
    // numbers, so no price badge.
    expect(body.reply.metadata.insufficientCredits).toEqual({});
    expect(body.reply.content).not.toMatch(/\d/);
    expect(vi.mocked(resolvePlanTier)).toHaveBeenCalledWith("user-a");
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    nothingBought();
    await app.close();
  });

  it("says when the published book does not carry it", async () => {
    vi.mocked(resolvePlanTier).mockResolvedValue("creator");
    seedObject(objectKey("books", "project-1", "book.md"), "The first page.");
    const app = await buildMobileApp();
    const response = await send(app, "remove the Tomeza credit");

    expect(response.json().reply.content).toBe(
      "This book doesn’t carry the “Made with Tomeza” line, so there’s nothing to take off."
    );
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    nothingBought();
    await app.close();
  });

  it("is saved behind a running job and run on “apply it”", async () => {
    vi.mocked(resolvePlanTier).mockResolvedValue("creator");
    mockPrisma.generationJob.findMany.mockResolvedValueOnce([openJobRow({ operationId: "ordinary-edit", intentKind: "page_rewrite" })]);
    const app = await buildMobileApp();
    const busy = await send(app, "remove the Tomeza credit");

    expect(busy.statusCode).toBe(200);
    // A free edit has no card to confirm, so the saved request runs as it is.
    expect(busy.json().reply.content).toContain("I’ll run it");
    expect(busy.json().reply.metadata).toMatchObject({
      blockedByActiveJob: true,
      pendingEdit: { request: "remove the Tomeza credit", clarification: "busy" }
    });
    expect(mockPrisma.project.update).not.toHaveBeenCalled();

    const resumed = await send(app, "apply it");
    expect(resumed.json().reply.content).toBe(
      "Done — I’m taking the “Made with Tomeza” line off this book and refreshing the exports. This one’s free."
    );
    nothingBought();
    await app.close();
  });

  it("tells a subscriber whose book started updating under it to ask again if the line is still there, promising no rebuild", async () => {
    vi.mocked(resolvePlanTier).mockResolvedValue("creator");
    // The chat read a finished book; by the time the reprint holds the row lock
    // something else has put it to EDITING, and not every such window ends in a
    // recompile.
    const project = projectRecord({
      id: "project-1",
      status: "COMPLETE",
      currentPlanId: "plan-1",
      currentPlan: approvedPlanRecord(),
      pages: generatedPages()
    });
    mockPrisma.project.findUnique.mockResolvedValue(project);
    mockPrisma.$queryRaw.mockImplementation(async (strings: readonly string[]) => {
      if (strings.join("?").includes("FOR UPDATE")) project.status = "EDITING";
      return [];
    });
    const app = await buildMobileApp();
    const response = await send(app, "remove the Tomeza credit");
    expect(response.statusCode).toBe(200);
    expect(response.json().reply.content).toBe(
      "This book is being updated right now. Once it’s ready, if the “Made with Tomeza” line is still there, ask me again."
    );
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    nothingBought();
    await app.close();
  });

  it("tells a subscriber whose book is not finished that it will be put together without the line, with nothing to ask again", async () => {
    vi.mocked(resolvePlanTier).mockResolvedValue("creator");
    mockPrisma.project.findUnique.mockResolvedValue(
      projectRecord({ id: "project-1", status: "REVIEW_REQUIRED", currentPlanId: null, pages: generatedPages() })
    );
    const app = await buildMobileApp();
    const response = await send(app, "remove the Tomeza credit");
    // The credit is decided per compile from the owner's plan, so the first
    // compile already leaves it out — the route's own sentence, not "ask me again".
    expect(response.json().reply.content).toBe(TOMEZA_CREDIT_NOT_FINISHED_MESSAGE);
    expect(response.json().reply.content).toBe(
      "This book isn’t finished yet. On your plan it will be put together without the “Made with Tomeza” line."
    );
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    nothingBought();
    await app.close();
  });
});

describe("what the chat says for each outcome of the shared decision", () => {
  it("says a busy book is busy, an unfinished one will print without the line, and promises no rebuild while the book is being updated", async () => {
    const { tomezaCreditReply } = await import("./tomezaCreditEdits.js");
    expect(tomezaCreditReply({ kind: "busy" })).toBe(
      "This book is still being worked on. Ask me again once the current job finishes."
    );
    // The route answers the same case with the same sentence.
    expect(tomezaCreditReply({ kind: "not_finished" })).toBe(TOMEZA_CREDIT_NOT_FINISHED_MESSAGE);
    expect(tomezaCreditReply({ kind: "not_finished" })).not.toMatch(/ask me again|once this book has finished/i);
    expect(tomezaCreditReply({ kind: "refreshing" })).toBe(
      "This book is being updated right now. Once it’s ready, if the “Made with Tomeza” line is still there, ask me again."
    );
    // Some EDITING windows settle without a recompile, so it says to ask again, never that the line goes.
    expect(tomezaCreditReply({ kind: "refreshing" })).not.toMatch(/prints without|new version/);
    for (const kind of ["reprinted", "not_printed", "subscription_required", "busy", "not_finished", "refreshing"] as const) {
      expect(tomezaCreditReply({ kind })).not.toMatch(/\d/);
    }
  });
});

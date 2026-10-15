import { describe, expect, it, vi } from "vitest";
import { intentFromDecideAction } from "./bookEditDecision.js";
import { classifyWithDegradedHeuristics } from "./bookEditHeuristics.js";
import { classifyProjectChatMessage } from "./bookEditIntent.js";
import type { DecideActionPayload } from "./bookEditRouterPrompt.js";
import { isTomezaCreditRemoval, mentionsTomezaCreditRemoval } from "./bookEditTomezaCredit.js";
import { chapters, fakeDecideModel, fakeFailingTextModel, pages } from "./testing/bookEditIntentFixtures.js";

/**
 * "Remove the Made with Tomeza line" had no home in the chat: no page holds the
 * line — the compile prints it from the owner's plan — so a page rewrite is the
 * one thing that cannot take it off. It is a free `tomeza_credit` intent now.
 */
describe("reading a request to take the Tomeza line off", () => {
  it.each([
    "Remove the Made with Tomeza line",
    "remove the made with tomeza line from my book",
    "Remove “Made with Tomeza”",
    "remove 'made with tomeza' please",
    "remove the Tomeza credit",
    "Remove the Tomeza branding.",
    "hide the Tomeza watermark",
    "delete the tomeza logo from the title page",
    "get rid of the Made with Tomeza text at the bottom of the title page, thanks",
    "take the Tomeza credit off",
    "please take the made with tomeza line out of the book",
    "take off the Tomeza branding",
    "Can you remove the Tomeza watermark?",
    "could you please remove the made with tomeza credit line",
    "I don't want the Tomeza branding",
    "no Made with Tomeza line please",
    "print it without the Made with Tomeza line",
    "I want the Tomeza watermark removed",
    "I'd like the made with tomeza line gone",
    "remove the line that says Made with Tomeza"
  ])("reads %j", (message) => {
    expect(isTomezaCreditRemoval(message)).toBe(true);
  });

  it.each([
    // Questions about it change nothing.
    "what is the Made with Tomeza line?",
    "why does my book say Made with Tomeza?",
    "can I remove the made with tomeza line?",
    "how do I remove the Tomeza credit?",
    "does a plan remove the Tomeza watermark?",
    // Tomeza without a word for the line, or the line without Tomeza.
    "remove Tomeza",
    "remove the last line on page 3",
    "remove the credit card scene",
    // Another book, or every book, is not this book's request.
    "remove the Tomeza credit from all my books",
    // A second request rides along.
    "remove the Tomeza credit and make page 3 funnier",
    // A page about it is page text.
    "write a page about how this book was made with Tomeza",
    // A clarification's merged follow-up is the router's.
    "remove the tomeza line\n\nFollow-up from the user: yes"
  ])("leaves %j to the router", (message) => {
    expect(isTomezaCreditRemoval(message)).toBe(false);
  });
});

describe("the Tomeza line in the finished-book chat", () => {
  /** A router that would misprice the line as page content, were it ever asked. */
  const rewriteRouter = () =>
    fakeDecideModel({
      action: "propose_edit",
      confidence: 0.95,
      reasoning: "The credit is mistaken for page content.",
      assistantMessage: "I’ll rewrite the book without the credit.",
      responseLanguage: "en",
      clarification: "none",
      pageIndexes: [1, 2],
      chapterIndex: null,
      targetLanguage: null,
      editTarget: "whole_book",
      editStyle: "rewrite"
    });

  // The router's only say over a precise removal was its reply language, and
  // the recogniser's shapes are English: no router call, and no rewrite.
  it.each([
    { conversationLanguage: undefined, expected: "en" },
    { conversationLanguage: "fa", expected: "fa" }
  ] as const)("answers a precise removal with no model call, in $expected", async ({ conversationLanguage, expected }) => {
    const model = rewriteRouter();
    const generateText = vi.spyOn(model, "generateText");
    for (const message of ["Remove the Made with Tomeza line", "hide the Tomeza watermark", "remove the Tomeza credit"]) {
      const intent = await classifyProjectChatMessage({
        message, stage: "complete", pages, chapters, textModel: model,
        ...(conversationLanguage ? { conversationLanguage } : {})
      });
      expect(intent, message).toMatchObject({
        kind: "tomeza_credit",
        responseLanguage: expected,
        scope: "none",
        affectedPageIndexes: [],
        clarification: "none"
      });
    }
    expect(model.generateWithTools).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  it("leaves a removal in another language to the router, which picks its language", async () => {
    const model = fakeDecideModel({
      action: "propose_edit", confidence: 0.92, reasoning: "The credit line.", assistantMessage: "حذفش می‌کنم.",
      responseLanguage: "fa", clarification: "none", pageIndexes: [], chapterIndex: null, targetLanguage: null,
      editTarget: "tomeza_credit"
    });
    const intent = await classifyProjectChatMessage({ message: "Tomeza را از کتاب بردار", stage: "complete", pages, textModel: model });
    expect(intent).toMatchObject({ kind: "tomeza_credit", responseLanguage: "fa" });
    expect(model.generateWithTools).toHaveBeenCalledOnce();
  });

  it("still recognises a precise removal when no model is available", async () => {
    const intent = await classifyProjectChatMessage({ message: "Remove the Made with Tomeza line", stage: "complete", pages });
    expect(intent).toMatchObject({ kind: "tomeza_credit", scope: "none", affectedPageIndexes: [] });
  });

  it("is not recognised before the book exists", async () => {
    const intent = await classifyProjectChatMessage({ message: "remove the Tomeza credit", stage: "plan_ready", pages: [] });
    expect(intent.kind).not.toBe("tomeza_credit");
  });

  it("survives a router outage paraphrased, and is never widened into a rewrite once the question is spent", async () => {
    const message = "honestly I'd rather the Tomeza watermark wasn't on my book, can it go?";
    expect(isTomezaCreditRemoval(message)).toBe(false);
    // A question mark after a plain wish: the loose reading still asks it as a question…
    expect(mentionsTomezaCreditRemoval(message)).toBe(false);
    // …but a wish stated is a request.
    const wish = "honestly I'd rather the Made with Tomeza line was gone from this book";
    expect(mentionsTomezaCreditRemoval(wish)).toBe(true);
    for (const clarifyExhausted of [false, true]) {
      const intent = await classifyProjectChatMessage({
        message: wish,
        stage: "complete",
        pages,
        textModel: fakeFailingTextModel(),
        clarifyExhausted
      });
      expect(intent).toMatchObject({ kind: "tomeza_credit", scope: "none", affectedPageIndexes: [] });
    }
  });

  it("leaves a question about the line to be answered on the model-free path too", () => {
    expect(classifyWithDegradedHeuristics("what is the made with tomeza line?", "complete", pages).kind).toBe("answer");
    expect(classifyWithDegradedHeuristics("remove the Tomeza credit and rewrite page 2", "complete", pages).kind).not.toBe(
      "tomeza_credit"
    );
  });
});

describe("the Tomeza line the router routed", () => {
  it("maps the target to the free intent", () => {
    const intent = intentFromDecideAction(
      {
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "The credit line.",
        assistantMessage: "I’ll take that line off.",
        editInstruction: "",
        editTarget: "tomeza_credit"
      } as unknown as DecideActionPayload,
      "lose the little Tomeza thing on the first page"
    );
    expect(intent).toMatchObject({ kind: "tomeza_credit", scope: "none", affectedPageIndexes: [], clarification: "none" });
  });

  it("reaches the free intent through the live router for a paraphrase", async () => {
    const model = fakeDecideModel({
      action: "propose_edit",
      confidence: 0.92,
      reasoning: "The reader wants the free-tier credit gone.",
      assistantMessage: "I’ll take the Made with Tomeza line off.",
      clarification: "none",
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null,
      editTarget: "tomeza_credit"
    });
    const intent = await classifyProjectChatMessage({
      message: "Tomeza را از کتاب بردار",
      stage: "complete",
      pages,
      textModel: model
    });
    expect(model.generateWithTools).toHaveBeenCalledTimes(1);
    expect(intent).toMatchObject({ kind: "tomeza_credit", affectedPageIndexes: [] });
  });
});

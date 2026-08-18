import { describe, expect, it } from "vitest";
import type { GenerateWithToolsOptions, TextModelAdapter, ToolCallsResult } from "@book-maker/core";
import { classifyProjectChatMessage, intentFromProposeEdit, messageWithFollowUp } from "./bookEditIntent.js";
import {
  chapters,
  decideDecision,
  fakeDecideModel,
  pages,
  routerAdapter,
  type DecideArgs
} from "./testing/bookEditIntentFixtures.js";

describe("clarification budget", () => {
  const clarifyPayload: DecideArgs = {
    action: "clarify",
    confidence: 0.5,
    reasoning: "Who is Kaka and where should they appear?",
    assistantMessage: "Could you tell me a bit more about who Kaka is?",
    clarification: "scope",
    pageIndexes: [],
    chapterIndex: null,
    targetLanguage: null
  };

  function capturingModel(result: ToolCallsResult): {
    model: TextModelAdapter;
    calls: GenerateWithToolsOptions[];
  } {
    const calls: GenerateWithToolsOptions[] = [];
    const model = routerAdapter(async (options) => {
      calls.push(options);
      return result;
    });
    return { model, calls };
  }

  it("offers clarify to the router until the budget is spent", async () => {
    const { model, calls } = capturingModel(decideDecision(clarifyPayload));

    await classifyProjectChatMessage({ message: "Add Kaka in the match", stage: "complete", pages, textModel: model });
    const openBudget = calls[0]!.tools.find((tool) => tool.name === "decide")!;
    expect(openBudget.parameters.safeParse(clarifyPayload).success).toBe(true);

    await classifyProjectChatMessage({
      message: "Add Kaka in the match\n\nFollow-up from the user: Just add",
      stage: "complete",
      pages,
      textModel: model,
      clarifyExhausted: true
    });
    const spentBudget = calls[1]!.tools.find((tool) => tool.name === "decide")!;
    // The model cannot return an action the schema does not contain.
    expect(spentBudget.parameters.safeParse(clarifyPayload).success).toBe(false);
    expect(
      spentBudget.parameters.safeParse({ ...clarifyPayload, action: "propose_edit", editTarget: "whole_book" }).success
    ).toBe(true);
  });

  it("tells the router it may not ask again once the budget is spent", async () => {
    const { model, calls } = capturingModel(decideDecision(clarifyPayload));

    await classifyProjectChatMessage({ message: "Add Kaka in the match", stage: "complete", pages, textModel: model });
    await classifyProjectChatMessage({
      message: "Add Kaka in the match\n\nFollow-up from the user: Just add",
      stage: "complete",
      pages,
      textModel: model,
      clarifyExhausted: true
    });

    const [firstPrompt, secondPrompt] = calls.map((call) => String(call.messages[0]!.content));
    // The policy itself is always on: no questions about creative preferences,
    // and any question has to carry the default it will fall back to.
    for (const prompt of [firstPrompt!, secondPrompt!]) {
      expect(prompt).toMatch(/at most once per request/i);
      expect(prompt).toMatch(/never send a bare question/i);
      expect(prompt).toMatch(/adding something new to the finished book/i);
    }
    expect(firstPrompt).not.toMatch(/already asked a clarifying question/i);
    expect(secondPrompt).toMatch(/already asked a clarifying question/i);
  });

  it("keeps a hesitant decision actionable instead of demoting it back to a question", async () => {
    const model = fakeDecideModel({
      ...clarifyPayload,
      action: "propose_edit",
      // Below BOOK_EDIT_CONFIDENCE_THRESHOLD: the normal gate would turn this
      // straight back into the clarification the user just refused to answer.
      confidence: 0.5,
      editTarget: "whole_book",
      editStyle: "rewrite"
    });

    const intent = await classifyProjectChatMessage({
      message: "Add Kaka in the match\n\nFollow-up from the user: Just add",
      stage: "complete",
      pages,
      textModel: model,
      clarifyExhausted: true
    });

    expect(intent.kind).toBe("page_rewrite");
    expect(intent.scope).toBe("all_pages");
    expect(intent.confidence).toBeGreaterThanOrEqual(0.72);
  });

  it("forces a decision when the router asks a second question anyway", async () => {
    const intent = await classifyProjectChatMessage({
      message: "Add Kaka in the match\n\nFollow-up from the user: Just add",
      stage: "complete",
      pages,
      textModel: fakeDecideModel(clarifyPayload),
      clarifyExhausted: true
    });

    expect(intent.kind).toBe("page_rewrite");
    expect(intent.scope).toBe("all_pages");
    expect(intent.clarification).toBe("none");
  });

  it("forces a decision when there is no router model at all", async () => {
    const intent = await classifyProjectChatMessage({
      message: "Add Kaka in the match\n\nFollow-up from the user: Just add",
      stage: "complete",
      pages,
      clarifyExhausted: true
    });

    expect(intent.kind).toBe("page_rewrite");
    expect(intent.scope).toBe("all_pages");
  });

  it("keeps a chapter-heading request free even when the clarification budget is spent", async () => {
    // forcedDecision turns any unresolved request into a whole-book page_rewrite,
    // which for this one would charge for every page and then recompile the same
    // heading straight back. The recogniser runs before normalizeIntentForStage
    // precisely so this cannot happen.
    const intent = await classifyProjectChatMessage({
      message:
        'I don\'t like that we have "Chapter x" We should simply mention the Title\n\nFollow-up from the user: just do it',
      stage: "complete",
      pages,
      textModel: fakeDecideModel(clarifyPayload),
      clarifyExhausted: true
    });

    expect(intent.kind).toBe("chapter_heading");
    expect(intent.chapterHeading).toEqual({ style: "title_only" });
    expect(intent.scope).toBe("none");
    expect(intent.affectedPageIndexes).toEqual([]);
  });

  it("forces a spent plan-stage clarification into a plan revision", async () => {
    const intent = await classifyProjectChatMessage({
      message: "Add a dragon\n\nFollow-up from the user: Just add",
      stage: "plan_ready",
      pages,
      textModel: fakeDecideModel(clarifyPayload),
      clarifyExhausted: true
    });

    expect(intent.kind).toBe("plan_revision");
    expect(intent.clarification).toBe("none");
  });

  it("still asks the first question when the budget is open", async () => {
    const intent = await classifyProjectChatMessage({
      message: "Add Kaka in the match",
      stage: "complete",
      pages,
      textModel: fakeDecideModel(clarifyPayload)
    });

    expect(intent.kind).toBe("clarify");
    // Recorded as a scope clarification whatever the model reports, so the next
    // turn has resumable state to recover the original request from.
    expect(intent.clarification).toBe("scope");
  });

  it("carries the original request into the follow-up turn", () => {
    expect(messageWithFollowUp("Add Kaka in the match", "Just add")).toBe(
      "Add Kaka in the match\n\nFollow-up from the user: Just add"
    );
    expect(messageWithFollowUp("", "Just add")).toBe("Just add");
    expect(messageWithFollowUp("Just add", "just add")).toBe("just add");
  });
});

describe("hesitant edit decisions on a finished book", () => {
  it("keeps a below-threshold propose_edit as the edit instead of a promise with nothing to apply", async () => {
    // Regression: the router targeted the final page at confidence 0.7 — just
    // under the threshold — and the demotion re-labelled it clarify while
    // keeping the confirmation-style assistantMessage. The reply read "I'll
    // rewrite the final page…" with no proposal card, and only a second "Do
    // it" (spending the clarification budget) surfaced Apply.
    const model = fakeDecideModel({
      action: "propose_edit",
      confidence: 0.7,
      reasoning: "The ending is page 2; rewrite it as asked.",
      assistantMessage: "I'll rewrite the final page so the ending changes as you asked.",
      clarification: "none",
      editTarget: "pages",
      editStyle: "rewrite",
      pageIndexes: [2],
      chapterIndex: null,
      targetLanguage: null
    });

    const intent = await classifyProjectChatMessage({
      message: "Change the ending",
      stage: "complete",
      pages,
      textModel: model
    });

    expect(intent.kind).toBe("page_rewrite");
    expect(intent.affectedPageIndexes).toEqual([2]);
    expect(intent.clarification).toBe("none");
  });

  it("keeps a pageless propose_edit as an edit for the proposal flow to target", () => {
    const intent = intentFromProposeEdit(
      {
        action: "propose_edit",
        confidence: 0.85,
        reasoning: "Rewrite where the phrase appears.",
        assistantMessage: "I'll rewrite the part with the old phrase.",
        clarification: "none",
        editTarget: "pages",
        editStyle: "rewrite",
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: null
      },
      'Get rid of "the old phrase"',
      chapters
    );

    // proposeBookEdit resolves the target from the quoted text, or asks its
    // own real "which page?" question — a clarify here would surface the
    // confirmation message above as a reply that promises an edit and
    // proposes nothing.
    expect(intent.kind).toBe("page_rewrite");
    expect(intent.scope).toBe("none");
    expect(intent.clarification).toBe("none");
  });

  it("widens a pageless edit to the whole book once the clarification budget is spent", async () => {
    const model = fakeDecideModel({
      action: "propose_edit",
      confidence: 0.6,
      reasoning: "Add Kaka wherever it fits.",
      assistantMessage: "I'll add Kaka to the story.",
      clarification: "none",
      editTarget: "pages",
      editStyle: "rewrite",
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null
    });

    const intent = await classifyProjectChatMessage({
      message: "Add Kaka in the match\n\nFollow-up from the user: Just add",
      stage: "complete",
      pages,
      textModel: model,
      clarifyExhausted: true
    });

    // Without the widening, proposeBookEdit would resolve zero pages and ask
    // "which page?" — a second question after the budget was already spent.
    expect(intent.kind).toBe("page_rewrite");
    expect(intent.scope).toBe("all_pages");
    expect(intent.clarification).toBe("none");
  });
});

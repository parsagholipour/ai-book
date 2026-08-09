import { describe, expect, it, vi } from "vitest";
import type { GenerateWithToolsOptions, TextModelAdapter, ToolCallsResult } from "@book-maker/core";
import {
  CLASSIFIER_PAGE_SAMPLE_CAP,
  classifierPageSample,
  classifyProjectChatMessage,
  classifyWithHeuristics,
  intentFromProposeEdit,
  continuationRequestFromMessage,
  isBookEditScopeOnlyMessage,
  messageWithFollowUp,
  messageWithScope,
  type BookEditIntent,
  type BookEditPageContext
} from "./bookEditIntent.js";

const pages = [
  {
    id: "page-1",
    index: 1,
    title: "Opening",
    summary: "Rabbit brags before the race.",
    previewText: "Rabbit hops to the starting line while Turtle smiles."
  },
  {
    id: "page-2",
    index: 2,
    title: "Practice",
    summary: "Turtle keeps moving.",
    previewText: "The old phrase appears in the practice scene."
  }
];

const chapters = [
  { index: 1, title: "The Race Begins", pageIndexes: [1] },
  { index: 2, title: "Steady Wins", pageIndexes: [2] }
];

describe("book edit intent heuristics", () => {
  it("treats generated-book questions as answers", () => {
    const intent = classifyWithHeuristics("How many pages are in the book?", "complete", pages);

    expect(intent.kind).toBe("answer");
    expect(intent.confidence).toBeGreaterThanOrEqual(0.72);
  });

  it("answers plan-stage questions without generated-book edit fallback copy", () => {
    const intent = classifyWithHeuristics("What is this plan about?", "plan_ready", pages);

    expect(intent.kind).toBe("answer");
    expect(intent.assistantMessage).not.toMatch(/book text edits are available after/i);
    expect(intent.assistantMessage).toMatch(/plan/i);
  });

  it("keeps dislike-flavored questions as answers", () => {
    const intent = classifyWithHeuristics("Why is there a public display in chapter 2?", "complete", pages);

    expect(intent.kind).toBe("answer");
  });

  it("does not invent charged edit kinds from English regex trees", () => {
    for (const message of [
      "Make the examples warmer and more practical.",
      "I don't like the dragon battles.",
      "I don't like the main character.",
      "On page 1, replace \"old phrase\" with \"new phrase\".",
      "Add a new chapter about launch strategy.",
      "Now generate the English version",
      "Replace rabbit with fly throughout the whole book.",
      "Make the whole book warmer and simpler.",
      "Rewrite chapter 2 and make it funnier.",
      "I don't want images or covers",
      "Move the ending earlier in the outline."
    ]) {
      const intent = classifyWithHeuristics(message, "complete", pages, undefined, chapters);
      expect(["clarify", "answer", "show_content", "undo_last_edit"]).toContain(intent.kind);
      expect(intent.kind).not.toBe("local_patch");
      expect(intent.kind).not.toBe("page_rewrite");
      expect(intent.kind).not.toBe("book_replan");
      expect(intent.kind).not.toBe("chapter_regenerate");
      expect(intent.kind).not.toBe("plan_revision");
    }
  });

  it("routes read requests to show_content with the right target", () => {
    const outline = classifyWithHeuristics("Show me the outline", "complete", pages, undefined, chapters);
    expect(outline.kind).toBe("show_content");
    expect(outline.contentTarget).toEqual({ type: "outline" });

    const chapter = classifyWithHeuristics("Read chapter 2", "complete", pages, undefined, chapters);
    expect(chapter.kind).toBe("show_content");
    expect(chapter.contentTarget).toEqual({ type: "chapter", index: 2 });

    const page = classifyWithHeuristics("Show me page 1", "complete", pages, undefined, chapters);
    expect(page.kind).toBe("show_content");
    expect(page.contentTarget).toEqual({ type: "page", index: 1 });
    expect(page.affectedPageIndexes).toEqual([1]);
  });

  it("does not treat edit requests that mention chapters as read requests", () => {
    const intent = classifyWithHeuristics("Rewrite chapter 2 and make it funnier.", "complete", pages, undefined, chapters);

    expect(intent.kind).toBe("clarify");
    expect(intent.kind).not.toBe("show_content");
  });

  it("routes undo requests to undo_last_edit", () => {
    for (const message of ["Undo that last change", "Please revert the last edit", "Roll back that edit"]) {
      const intent = classifyWithHeuristics(message, "complete", pages, undefined, chapters);

      expect(intent.kind).toBe("undo_last_edit");
      expect(intent.confidence).toBeGreaterThanOrEqual(0.72);
    }
  });

  it("short-circuits read/undo intents without calling the AI router", async () => {
    const model = fakeDecideModel({
      action: "answer",
      confidence: 0.9,
      reasoning: "Should never be used.",
      assistantMessage: "Model reply",
      clarification: "none",
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null
    });

    const intent = await classifyProjectChatMessage({
      message: "Show me the outline",
      stage: "complete",
      pages,
      chapters,
      textModel: model
    });

    expect(model.generateWithTools).not.toHaveBeenCalled();
    expect(intent.kind).toBe("show_content");
  });

  it("keeps a sources-removal request off the priced page-edit path", async () => {
    const model = fakeDecideModel({
      action: "propose_edit",
      confidence: 0.95,
      reasoning: "Should never be used.",
      assistantMessage: "Model reply",
      clarification: "none",
      pageIndexes: [1, 2],
      chapterIndex: null,
      targetLanguage: null,
      editTarget: "whole_book"
    });

    const intent = await classifyProjectChatMessage({
      message: "Remove the sources at the end of the book",
      stage: "complete",
      pages,
      chapters,
      textModel: model
    });

    // The sources list is compiled back matter: rewriting pages would charge
    // for work that cannot remove it.
    expect(model.generateWithTools).not.toHaveBeenCalled();
    expect(intent.kind).toBe("back_matter");
    expect(intent.backMatter).toEqual({ includeSources: false });
    expect(intent.affectedPageIndexes).toEqual([]);
  });

  it("routes the router's back_matter edit target to a free back-matter intent", async () => {
    const model = fakeDecideModel({
      action: "propose_edit",
      confidence: 0.93,
      reasoning: "The reader wants the citation list gone.",
      assistantMessage: "Ich entferne die Quellenliste.",
      clarification: "none",
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null,
      editTarget: "back_matter",
      backMatterSources: false
    });

    const intent = await classifyProjectChatMessage({
      message: "Entferne die Quellenliste am Ende des Buches",
      stage: "complete",
      pages,
      chapters,
      textModel: model
    });

    expect(model.generateWithTools).toHaveBeenCalledOnce();
    expect(intent).toMatchObject({
      kind: "back_matter",
      backMatter: { includeSources: false },
      assistantMessage: "Ich entferne die Quellenliste."
    });
  });

  it("uses the AI router for plan revisions via decide", async () => {
    const model = fakeDecideModel({
      action: "plan_revision",
      confidence: 0.97,
      reasoning: "The model handled the routing.",
      assistantMessage: "I’ll revise the plan with that media preference.",
      clarification: "none",
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null
    });

    const intent = await classifyProjectChatMessage({
      message: "Make the examples warmer and more practical.",
      stage: "plan_ready",
      pages,
      textModel: model
    });

    expect(model.generateWithTools).toHaveBeenCalledOnce();
    expect(intent).toMatchObject({
      kind: "plan_revision",
      reasoning: "The model handled the routing."
    });
    const call = vi.mocked(model.generateWithTools).mock.calls[0]![0];
    expect(call.tools.map((tool: { name: string }) => tool.name)).toEqual(["read_page", "decide"]);
  });

  it("falls back to degraded heuristics when the AI router fails", async () => {
    const model = fakeFailingTextModel();

    const intent = await classifyProjectChatMessage({
      message: "I don't want images or covers",
      stage: "plan_ready",
      pages,
      textModel: model
    });

    expect(model.generateWithTools).toHaveBeenCalled();
    expect(intent.kind).toBe("plan_revision");
  });

  it("retries the AI router once on a transient network failure", async () => {
    const model = fakeFlakyDecideModel({
      action: "plan_revision",
      confidence: 0.95,
      reasoning: "Recovered after the connection reset.",
      assistantMessage: "I’ll revise the plan.",
      clarification: "none",
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null
    });

    const intent = await classifyProjectChatMessage({
      message: "Make the examples warmer and more practical.",
      stage: "plan_ready",
      pages,
      textModel: model
    });

    expect(model.generateWithTools).toHaveBeenCalledTimes(2);
    expect(intent.reasoning).toBe("Recovered after the connection reset.");
  });

  it("falls back to degraded heuristics without retrying when the AI router exceeds its time budget", async () => {
    vi.useFakeTimers();
    try {
      const model = fakeHangingTextModel();

      const pending = classifyProjectChatMessage({
        message: "I don't want images or covers",
        stage: "plan_ready",
        pages,
        textModel: model
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const intent = await pending;

      expect(model.generateWithTools).toHaveBeenCalledTimes(1);
      expect(intent.kind).toBe("plan_revision");
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes small books to the classifier prompt without sampling", () => {
    const sample = classifierPageSample(pages, "Fix the typo on page 2.");

    expect(sample.truncated).toBe(false);
    expect(sample.pages).toEqual(pages);
  });

  it("samples large books under the cap while keeping explicitly mentioned pages", () => {
    const bigBook = manyPages(600);

    const sample = classifierPageSample(bigBook, "Fix a typo on page 412.");

    expect(sample.truncated).toBe(true);
    expect(sample.pages.length).toBeLessThanOrEqual(CLASSIFIER_PAGE_SAMPLE_CAP);
    const indexes = sample.pages.map((page) => page.index);
    expect(indexes).toContain(412);
    expect(indexes).toContain(411);
    expect(indexes).toContain(413);
    expect(indexes).toContain(1);
    expect(indexes).toContain(600);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it("tells the AI router when the page list was sampled", async () => {
    const model = fakeDecideModel({
      action: "propose_edit",
      confidence: 0.9,
      reasoning: "Targeted page edit.",
      assistantMessage: "I’ll rewrite page 412.",
      clarification: "none",
      editTarget: "pages",
      editStyle: "rewrite",
      pageIndexes: [412],
      chapterIndex: null,
      targetLanguage: null
    });

    await classifyProjectChatMessage({
      message: "Rewrite page 412 in a warmer tone.",
      stage: "complete",
      pages: manyPages(600),
      textModel: model
    });

    const call = vi.mocked(model.generateWithTools).mock.calls[0]![0];
    const prompt = JSON.parse(call.messages.at(-1)!.content);
    expect(prompt.pageContext).toMatchObject({ totalPages: 600, truncated: true });
    expect(prompt.pages.length).toBeLessThanOrEqual(CLASSIFIER_PAGE_SAMPLE_CAP);
    expect(prompt.pages.map((page: { index: number }) => page.index)).toContain(412);
  });

  it("lets the router read page prose before deciding", async () => {
    const loadPageBody = vi.fn(async () => "Full prose of the practice scene where the old phrase appears.");
    const model = scriptedTextModel([
      {
        text: "",
        model: "test-router",
        provider: "test",
        toolCalls: [{ id: "call-read", name: "read_page", arguments: { index: 2 } }]
      },
      decideDecision({
        action: "propose_edit",
        confidence: 0.93,
        reasoning: "The phrase only appears on page 2.",
        assistantMessage: "I’ll rewrite page 2 without that phrase.",
        clarification: "none",
        editTarget: "pages",
        editStyle: "rewrite",
        pageIndexes: [2],
        chapterIndex: null,
        targetLanguage: null
      })
    ]);

    const intent = await classifyProjectChatMessage({
      message: "Get rid of the part with the old phrase.",
      stage: "complete",
      pages,
      textModel: model,
      loadPageBody
    });

    expect(loadPageBody).toHaveBeenCalledWith(2);
    expect(model.generateWithTools).toHaveBeenCalledTimes(2);
    const secondCall = vi.mocked(model.generateWithTools).mock.calls[1]![0];
    const toolResult = secondCall.messages.find(
      (message: { role: string }) => message.role === "tool"
    );
    expect(toolResult?.content).toContain("Full prose of the practice scene");
    expect(intent.kind).toBe("page_rewrite");
    expect(intent.affectedPageIndexes).toEqual([2]);
  });

  it("only offers stage-appropriate decide actions to the model", async () => {
    const model = fakeDecideModel({
      action: "plan_revision",
      confidence: 0.9,
      reasoning: "Plan-stage routing.",
      assistantMessage: "I’ll revise the plan.",
      clarification: "none",
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null
    });

    await classifyProjectChatMessage({
      message: "Make the examples warmer.",
      stage: "plan_ready",
      pages,
      textModel: model
    });

    const call = vi.mocked(model.generateWithTools).mock.calls[0]![0];
    const decideTool = call.tools.find((tool: { name: string }) => tool.name === "decide")!;
    const editActionAtPlanStage = decideTool.parameters.safeParse({
      action: "propose_edit",
      confidence: 0.9,
      reasoning: "Not allowed at plan stage.",
      assistantMessage: "x",
      clarification: "none",
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null
    });
    expect(editActionAtPlanStage.success).toBe(false);
  });

  it("falls back to degraded heuristics when the router never commits a decision", async () => {
    const textOnly: ToolCallsResult = {
      text: "I think this is a plan change.",
      model: "test-router",
      provider: "test",
      toolCalls: []
    };
    const model = scriptedTextModel([textOnly, textOnly, textOnly, textOnly]);

    const intent = await classifyProjectChatMessage({
      message: "I don't want images or covers",
      stage: "plan_ready",
      pages,
      textModel: model
    });

    expect(intent.kind).toBe("plan_revision");
  });

  it("recognizes a scope-only follow-up that can resolve a pending edit", () => {
    expect(isBookEditScopeOnlyMessage("whole book")).toBe(true);
    expect(isBookEditScopeOnlyMessage("I said whole book")).toBe(true);
    expect(messageWithScope("Replace rabbit with fly", "all_pages")).toMatch(/whole book/i);
  });
});

function manyPages(count: number): BookEditPageContext[] {
  return Array.from({ length: count }, (_, offset) => ({
    id: `page-${offset + 1}`,
    index: offset + 1,
    title: `Section ${offset + 1}`,
    summary: `Summary of section ${offset + 1}.`,
    previewText: `Preview of section ${offset + 1}.`
  }));
}

function routerAdapter(
  generateWithTools: (options: GenerateWithToolsOptions) => Promise<ToolCallsResult>
): TextModelAdapter {
  return {
    generateText: async () => ({ text: "", model: "test-router", provider: "test" }),
    generateJson: async () => {
      throw new Error("generateJson is not used by the tool-calling router");
    },
    generateWithTools: generateWithTools as TextModelAdapter["generateWithTools"],
    async *streamText() {
      yield "";
    }
  };
}

type DecideArgs = {
  action: string;
  confidence: number;
  reasoning: string;
  assistantMessage: string;
  clarification: "none" | "scope";
  pageIndexes: number[];
  chapterIndex: number | null;
  targetLanguage: string | null;
  editTarget?: string;
  editStyle?: string;
  backMatterSources?: boolean;
};

function decideDecision(args: DecideArgs): ToolCallsResult {
  return {
    text: "",
    model: "test-router",
    provider: "test",
    toolCalls: [{ id: "call-decide", name: "decide", arguments: args }]
  };
}

function fakeDecideModel(args: DecideArgs): TextModelAdapter & { generateWithTools: ReturnType<typeof vi.fn> } {
  const generateWithTools = vi.fn(async () => decideDecision(args));
  return Object.assign(routerAdapter(generateWithTools), { generateWithTools });
}

function fakeFlakyDecideModel(args: DecideArgs): TextModelAdapter & { generateWithTools: ReturnType<typeof vi.fn> } {
  let attempts = 0;
  const generateWithTools = vi.fn(async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("socket hang up");
      (error as Error & { code?: string }).code = "ECONNRESET";
      throw error;
    }
    return decideDecision(args);
  });
  return Object.assign(routerAdapter(generateWithTools), { generateWithTools });
}

function fakeFailingTextModel(): TextModelAdapter & { generateWithTools: ReturnType<typeof vi.fn> } {
  const generateWithTools = vi.fn(async () => {
    throw new Error("router unavailable");
  });
  return Object.assign(routerAdapter(generateWithTools), { generateWithTools });
}

function fakeHangingTextModel(): TextModelAdapter & { generateWithTools: ReturnType<typeof vi.fn> } {
  const generateWithTools = vi.fn(async () => new Promise<ToolCallsResult>(() => undefined));
  return Object.assign(routerAdapter(generateWithTools), { generateWithTools });
}

function scriptedTextModel(results: ToolCallsResult[]): TextModelAdapter & { generateWithTools: ReturnType<typeof vi.fn> } {
  let index = 0;
  const generateWithTools = vi.fn(async () => {
    const next = results[Math.min(index, results.length - 1)]!;
    index += 1;
    return next;
  });
  return Object.assign(routerAdapter(generateWithTools), { generateWithTools });
}

// Silence unused BookEditIntent import warnings in helpers if needed.
void (null as unknown as BookEditIntent);

describe("continuation intent", () => {
  it("detects continuation requests and chapter counts from messages", () => {
    expect(continuationRequestFromMessage("Continue the story")).toEqual({ chapterCount: 1 });
    expect(continuationRequestFromMessage("keep writing my book")).toEqual({ chapterCount: 1 });
    expect(continuationRequestFromMessage("Write the next chapter")).toEqual({ chapterCount: 1 });
    expect(continuationRequestFromMessage("add 3 more chapters")).toEqual({ chapterCount: 3 });
    expect(continuationRequestFromMessage("please write two new chapters")).toEqual({ chapterCount: 2 });
    expect(continuationRequestFromMessage("finish the book")).toEqual({ chapterCount: 1 });
  });

  it("ignores questions and unrelated messages", () => {
    expect(continuationRequestFromMessage("Should I continue the story?")).toBeNull();
    expect(continuationRequestFromMessage("Fix the typo on page 2")).toBeNull();
    expect(continuationRequestFromMessage("What happens in chapter 3?")).toBeNull();
  });

  it("routes continuation to continue_book without a model on completed books", async () => {
    const intent = await classifyProjectChatMessage({
      message: "Continue the story and add 2 more chapters",
      stage: "complete",
      pages
    });
    expect(intent.kind).toBe("continue_book");
    expect(intent.continuation).toEqual({ chapterCount: 2 });
    expect(intent.affectedPageIndexes).toEqual([]);
  });

  it("never proposes continuation while the plan is still under review", async () => {
    const intent = await classifyProjectChatMessage({
      message: "Continue the story",
      stage: "plan_ready",
      pages
    });
    expect(intent.kind).not.toBe("continue_book");
  });

  it("maps the continuation propose_edit target to continue_book", () => {
    const intent = intentFromProposeEdit(
      {
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Continuation.",
        assistantMessage: "I’ll write the next chapters.",
        clarification: "none",
        editTarget: "continuation",
        editStyle: "rewrite",
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: null,
        newChapterCount: 4
      },
      "Keep writing the book",
      chapters
    );
    expect(intent.kind).toBe("continue_book");
    expect(intent.continuation).toEqual({ chapterCount: 4 });
    expect(intent.affectedPageIndexes).toEqual([]);
    expect(intent.clarification).toBe("none");
  });

  it("recovers the chapter count from the message when the router omits it", () => {
    const intent = intentFromProposeEdit(
      {
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Continuation.",
        assistantMessage: "I’ll write the next chapters.",
        clarification: "none",
        editTarget: "continuation",
        editStyle: "rewrite",
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: null
      },
      "add 3 more chapters",
      chapters
    );
    expect(intent.continuation).toEqual({ chapterCount: 3 });
  });
});

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

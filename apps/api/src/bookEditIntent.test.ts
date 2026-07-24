import { describe, expect, it, vi } from "vitest";
import type { GenerateWithToolsOptions, TextModelAdapter, ToolCallsResult } from "@book-maker/core";
import {
  CLASSIFIER_PAGE_SAMPLE_CAP,
  classifierPageSample,
  classifyProjectChatMessage,
  classifyWithHeuristics,
  intentFromDecideAction,
  intentFromProposeEdit,
  isBookEditScopeOnlyMessage,
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

describe("propose_edit pricing mapping", () => {
  it("maps exact page replacements to local_patch", () => {
    const intent = intentFromProposeEdit(
      {
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Exact replacement.",
        assistantMessage: "I’ll replace that phrase on page 1.",
        clarification: "none",
        editTarget: "pages",
        editStyle: "exact_replace",
        pageIndexes: [1],
        chapterIndex: null,
        targetLanguage: null
      },
      'On page 1, replace "old" with "new".',
      chapters
    );

    expect(intent.kind).toBe("local_patch");
    expect(intent.scope).toBe("explicit_pages");
    expect(intent.impact).toBe("small_text");
  });

  it("maps whole-book rewrites to page_rewrite", () => {
    const intent = intentFromProposeEdit(
      {
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Whole-book style.",
        assistantMessage: "I’ll rewrite the whole book warmer.",
        clarification: "none",
        editTarget: "whole_book",
        editStyle: "rewrite",
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: null
      },
      "Make the whole book warmer.",
      chapters
    );

    expect(intent.kind).toBe("page_rewrite");
    expect(intent.scope).toBe("all_pages");
  });

  it("maps chapter targets to chapter_regenerate", () => {
    const intent = intentFromProposeEdit(
      {
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Chapter rewrite.",
        assistantMessage: "I’ll rewrite chapter 2.",
        clarification: "none",
        editTarget: "chapter",
        editStyle: "rewrite",
        pageIndexes: [],
        chapterIndex: 2,
        targetLanguage: null
      },
      "Rewrite chapter 2.",
      chapters
    );

    expect(intent.kind).toBe("chapter_regenerate");
    expect(intent.affectedChapterIndex).toBe(2);
    expect(intent.affectedPageIndexes).toEqual([2]);
  });

  it("maps structural and language_copy targets to book_replan", () => {
    const structural = intentFromDecideAction(
      {
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Identity change.",
        assistantMessage: "I’ll rebuild around a new protagonist.",
        clarification: "none",
        editTarget: "structural",
        editStyle: "rewrite",
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: null
      },
      "Change the main character.",
      chapters
    );
    expect(structural.kind).toBe("book_replan");

    const language = intentFromDecideAction(
      {
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Language copy.",
        assistantMessage: "I’ll create an English copy.",
        clarification: "none",
        editTarget: "language_copy",
        editStyle: "rewrite",
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: "en"
      },
      "Generate the English version",
      chapters
    );
    expect(language.kind).toBe("book_replan");
    expect(language.targetLanguage).toBe("en");
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

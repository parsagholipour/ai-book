import { describe, expect, it, vi } from "vitest";
import type { GenerateWithToolsOptions, TextModelAdapter, ToolCallsResult } from "@book-maker/core";
import {
  CLASSIFIER_PAGE_SAMPLE_CAP,
  classifierPageSample,
  classifyProjectChatMessage,
  classifyWithHeuristics,
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

  it("routes plan-stage edit requests to plan revision", () => {
    const intent = classifyWithHeuristics("Make the examples warmer and more practical.", "plan_ready", pages);

    expect(intent.kind).toBe("plan_revision");
    expect(intent.confidence).toBeGreaterThanOrEqual(0.72);
  });

  it("answers plan-stage questions without generated-book edit fallback copy", () => {
    const intent = classifyWithHeuristics("What is this plan about?", "plan_ready", pages);

    expect(intent.kind).toBe("answer");
    expect(intent.assistantMessage).not.toMatch(/book text edits are available after/i);
    expect(intent.assistantMessage).toMatch(/plan/i);
  });

  it("routes soft plan-stage change requests to plan revision", () => {
    const intent = classifyWithHeuristics("I want the audience to be parents.", "plan_ready", pages);

    expect(intent.kind).toBe("plan_revision");
    expect(intent.confidence).toBeGreaterThanOrEqual(0.72);
  });

  it("routes negative media plan preferences to plan revision without a model", () => {
    for (const message of ["I don't want images or covers", "No images please", "without covers"]) {
      const intent = classifyWithHeuristics(message, "plan_ready", pages);

      expect(intent.kind).toBe("plan_revision");
      expect(intent.confidence).toBeGreaterThanOrEqual(0.72);
    }
  });

  it("routes completed-book dislike preferences to a rewrite of thematically matching pages", () => {
    const scenePages: BookEditPageContext[] = [
      {
        id: "page-1",
        index: 1,
        title: "Morning",
        summary: "A quiet private morning at home.",
        previewText: "The day begins slowly."
      },
      {
        id: "page-2",
        index: 2,
        title: "The Gathering",
        summary: "A public gathering where the pair is on display.",
        previewText: "Guests watch from the hall."
      },
      {
        id: "page-3",
        index: 3,
        title: "The Feast",
        summary: "A feast with a public display at the table.",
        previewText: "The hall is crowded."
      }
    ];

    const intent = classifyWithHeuristics(
      "I don't like the public display. This should be private between them.",
      "complete",
      scenePages
    );

    expect(intent.kind).toBe("page_rewrite");
    expect(intent.affectedPageIndexes).toEqual([2, 3]);
    expect(intent.impact).toBe("style_rewrite");
    expect(intent.confidence).toBeGreaterThanOrEqual(0.72);
  });

  it("offers concrete options when a dislike preference matches no pages", () => {
    const intent = classifyWithHeuristics("I don't like the dragon battles.", "complete", pages);

    expect(intent.kind).toBe("clarify");
    expect(intent.clarification).toBe("scope");
    expect(intent.assistantMessage).toMatch(/whole book/i);
  });

  it("routes plan-stage dislike preferences to plan revision", () => {
    const intent = classifyWithHeuristics("I don't like the villain being so scary.", "plan_ready", pages);

    expect(intent.kind).toBe("plan_revision");
    expect(intent.confidence).toBeGreaterThanOrEqual(0.72);
  });

  it("routes identity-level dislike preferences on a finished book to replan", () => {
    const intent = classifyWithHeuristics("I don't like the main character.", "complete", pages);

    expect(intent.kind).toBe("book_replan");
    expect(intent.impact).toBe("structural_replan");
  });

  it("treats bare should-be directives as edit requests, not answers", () => {
    const intent = classifyWithHeuristics("This should be private between them.", "complete", pages);

    expect(intent.kind).not.toBe("answer");
  });

  it("keeps dislike-flavored questions as answers", () => {
    const intent = classifyWithHeuristics("Why is there a public display in chapter 2?", "complete", pages);

    expect(intent.kind).toBe("answer");
  });

  it("uses the AI router even when heuristics are high-confidence", async () => {
    const modelIntent: BookEditIntent = {
      kind: "plan_revision",
      confidence: 0.97,
      reasoning: "The model handled the routing.",
      affectedPageIndexes: [],
      assistantMessage: "I’ll revise the plan with that media preference.",
      scope: "none",
      impact: "structural_replan",
      clarification: "none"
    };
    const model = fakeTextModel(modelIntent);

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
    const prompt = JSON.parse(call.messages.at(-1)!.content);
    expect(prompt.heuristicIntent).toMatchObject({ kind: "plan_revision" });
    expect(call.tools.map((tool) => tool.name)).toEqual(["read_page", "route_message"]);
  });

  it("falls back to heuristics when the AI router fails", async () => {
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
    const modelIntent: BookEditIntent = {
      kind: "plan_revision",
      confidence: 0.95,
      reasoning: "Recovered after the connection reset.",
      affectedPageIndexes: [],
      assistantMessage: "I’ll revise the plan.",
      scope: "none",
      impact: "structural_replan",
      clarification: "none"
    };
    const model = fakeFlakyTextModel(modelIntent);

    const intent = await classifyProjectChatMessage({
      message: "Make the examples warmer and more practical.",
      stage: "plan_ready",
      pages,
      textModel: model
    });

    expect(model.generateWithTools).toHaveBeenCalledTimes(2);
    expect(intent.reasoning).toBe("Recovered after the connection reset.");
  });

  it("falls back to heuristics without retrying when the AI router exceeds its time budget", async () => {
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

  it("routes exact generated text replacements to local patch", () => {
    const intent = classifyWithHeuristics('On page 1, replace "old phrase" with "new phrase".', "complete", pages);

    expect(intent.kind).toBe("local_patch");
    expect(intent.scope).toBe("explicit_pages");
    expect(intent.affectedPageIndexes).toEqual([1]);
  });

  it("routes structural generated-book changes to replan", () => {
    const intent = classifyWithHeuristics("Add a new chapter about launch strategy.", "complete", pages);

    expect(intent.kind).toBe("book_replan");
    expect(intent.impact).toBe("structural_replan");
  });

  it("routes completed-book language version requests to replan with a target language", () => {
    const intent = classifyWithHeuristics("Now generate the English version", "complete", pages);

    expect(intent.kind).toBe("book_replan");
    expect(intent.kind).not.toBe("answer");
    expect(intent.targetLanguage).toBe("en");
    expect(intent.scope).toBe("all_pages");
    expect(intent.impact).toBe("structural_replan");
  });

  it("routes main character changes to replan", () => {
    const intent = classifyWithHeuristics("Change the character of rabbit with a fly.", "complete", pages);

    expect(intent.kind).toBe("book_replan");
    expect(intent.impact).toBe("structural_replan");
  });

  it("routes whole-book replacements to matching local patches", () => {
    const intent = classifyWithHeuristics("Replace rabbit with fly throughout the whole book.", "complete", pages);

    expect(intent.kind).toBe("local_patch");
    expect(intent.scope).toBe("matching_pages");
    expect(intent.affectedPageIndexes).toEqual([1]);
  });

  it("routes whole-book style edits to all-page rewrites", () => {
    const intent = classifyWithHeuristics("Make the whole book warmer and simpler.", "complete", pages);

    expect(intent.kind).toBe("page_rewrite");
    expect(intent.scope).toBe("all_pages");
    expect(intent.impact).toBe("style_rewrite");
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

    expect(intent.kind).toBe("chapter_regenerate");
    expect(intent.affectedChapterIndex).toBe(2);
    expect(intent.affectedPageIndexes).toEqual([2]);
    expect(intent.impact).toBe("style_rewrite");
  });

  it("routes chapter regeneration requests in plan stage to plan revision", () => {
    const intent = classifyWithHeuristics("Rewrite chapter 2 and make it funnier.", "plan_ready", pages, undefined, chapters);

    expect(intent.kind).toBe("plan_revision");
  });

  it("routes undo requests to undo_last_edit", () => {
    for (const message of ["Undo that last change", "Please revert the last edit", "Roll back that edit"]) {
      const intent = classifyWithHeuristics(message, "complete", pages, undefined, chapters);

      expect(intent.kind).toBe("undo_last_edit");
      expect(intent.confidence).toBeGreaterThanOrEqual(0.72);
    }
  });

  it("short-circuits read/undo/chapter intents without calling the AI router", async () => {
    const model = fakeTextModel({
      kind: "answer",
      confidence: 0.9,
      reasoning: "Should never be used.",
      affectedPageIndexes: [],
      assistantMessage: "Model reply",
      scope: "none",
      impact: "small_text",
      clarification: "none"
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

  it("routes plan-stage structure requests to plan revision with structural impact", () => {
    const intent = classifyWithHeuristics("Move the ending earlier in the outline.", "plan_ready", pages, undefined, chapters);

    expect(intent.kind).toBe("plan_revision");
    expect(intent.impact).toBe("structural_replan");
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
    const modelIntent: BookEditIntent = {
      kind: "page_rewrite",
      confidence: 0.9,
      reasoning: "Targeted page edit.",
      affectedPageIndexes: [412],
      assistantMessage: "I’ll rewrite page 412.",
      scope: "explicit_pages",
      impact: "style_rewrite",
      clarification: "none"
    };
    const model = fakeTextModel(modelIntent);

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

  it("lets the router read page prose before routing", async () => {
    const loadPageBody = vi.fn(async () => "Full prose of the practice scene where the old phrase appears.");
    const model = scriptedTextModel([
      {
        text: "",
        model: "test-router",
        provider: "test",
        toolCalls: [{ id: "call-read", name: "read_page", arguments: { index: 2 } }]
      },
      routeDecision({
        kind: "page_rewrite",
        confidence: 0.93,
        reasoning: "The phrase only appears on page 2.",
        affectedPageIndexes: [2],
        assistantMessage: "I’ll rewrite page 2 without that phrase.",
        scope: "explicit_pages",
        impact: "style_rewrite",
        clarification: "none"
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
    const toolResult = secondCall.messages.find((message) => message.role === "tool");
    expect(toolResult?.content).toContain("Full prose of the practice scene");
    expect(intent.kind).toBe("page_rewrite");
    expect(intent.affectedPageIndexes).toEqual([2]);
  });

  it("only offers stage-appropriate route kinds to the model", async () => {
    const model = fakeTextModel({
      kind: "plan_revision",
      confidence: 0.9,
      reasoning: "Plan-stage routing.",
      affectedPageIndexes: [],
      assistantMessage: "I’ll revise the plan.",
      scope: "none",
      impact: "small_text",
      clarification: "none"
    });

    await classifyProjectChatMessage({
      message: "Make the examples warmer.",
      stage: "plan_ready",
      pages,
      textModel: model
    });

    const call = vi.mocked(model.generateWithTools).mock.calls[0]![0];
    const routeTool = call.tools.find((tool) => tool.name === "route_message")!;
    const editKindAtPlanStage = routeTool.parameters.safeParse({
      kind: "page_rewrite",
      confidence: 0.9,
      reasoning: "Not allowed at plan stage.",
      affectedPageIndexes: [],
      assistantMessage: "x",
      scope: "none",
      impact: "small_text",
      clarification: "none",
      affectedChapterIndex: null,
      targetLanguage: null
    });
    expect(editKindAtPlanStage.success).toBe(false);
  });

  it("falls back to heuristics when the router never commits a decision", async () => {
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

    const resolved = classifyWithHeuristics(
      messageWithScope("Replace rabbit with fly", "all_pages"),
      "complete",
      pages
    );

    expect(resolved.kind).toBe("local_patch");
    expect(resolved.scope).toBe("matching_pages");
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

function routeDecision(intent: BookEditIntent): ToolCallsResult {
  return {
    text: "",
    model: "test-router",
    provider: "test",
    toolCalls: [{ id: "call-route", name: "route_message", arguments: intent }]
  };
}

function fakeTextModel(intent: BookEditIntent): TextModelAdapter {
  return routerAdapter(vi.fn(async () => routeDecision(intent)));
}

function fakeFailingTextModel(): TextModelAdapter {
  return routerAdapter(
    vi.fn(async () => {
      throw new Error("router failed");
    })
  );
}

function fakeFlakyTextModel(intent: BookEditIntent): TextModelAdapter {
  const generateWithTools = vi.fn(async () => {
    if (generateWithTools.mock.calls.length === 1) {
      const error = new Error("socket hang up") as Error & { code: string };
      error.code = "ECONNRESET";
      throw error;
    }
    return routeDecision(intent);
  });
  return routerAdapter(generateWithTools);
}

function fakeHangingTextModel(): TextModelAdapter {
  return routerAdapter(vi.fn(() => new Promise<never>(() => undefined)));
}

/** Scripts one generateWithTools result per model call, erroring past the script. */
function scriptedTextModel(turns: ToolCallsResult[]): TextModelAdapter {
  const generateWithTools = vi.fn(async () => {
    const turn = turns[generateWithTools.mock.calls.length - 1];
    if (!turn) {
      throw new Error("scripted model ran out of turns");
    }
    return turn;
  });
  return routerAdapter(generateWithTools);
}

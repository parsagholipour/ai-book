import { describe, expect, it, vi } from "vitest";
import type { GenerateJsonOptions, JsonResult, TextModelAdapter } from "@book-maker/core";
import {
  classifyProjectChatMessage,
  classifyWithHeuristics,
  isBookEditScopeOnlyMessage,
  messageWithScope,
  type BookEditIntent
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

    expect(model.generateJson).toHaveBeenCalledOnce();
    expect(intent).toMatchObject({
      kind: "plan_revision",
      reasoning: "The model handled the routing."
    });
    const call = vi.mocked(model.generateJson).mock.calls[0]![0];
    const prompt = JSON.parse(call.messages.at(-1)!.content);
    expect(prompt.heuristicIntent).toMatchObject({ kind: "plan_revision" });
  });

  it("falls back to heuristics when the AI router fails", async () => {
    const model = fakeFailingTextModel();

    const intent = await classifyProjectChatMessage({
      message: "I don't want images or covers",
      stage: "plan_ready",
      pages,
      textModel: model
    });

    expect(model.generateJson).toHaveBeenCalled();
    expect(intent.kind).toBe("plan_revision");
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

    expect(model.generateJson).not.toHaveBeenCalled();
    expect(intent.kind).toBe("show_content");
  });

  it("routes plan-stage structure requests to plan revision with structural impact", () => {
    const intent = classifyWithHeuristics("Move the ending earlier in the outline.", "plan_ready", pages, undefined, chapters);

    expect(intent.kind).toBe("plan_revision");
    expect(intent.impact).toBe("structural_replan");
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

function fakeTextModel(intent: BookEditIntent): TextModelAdapter {
  const generateJson = vi.fn(async (options: GenerateJsonOptions<unknown>): Promise<JsonResult<unknown>> => {
    const data = options.schema.parse(intent);
    return {
      data,
      text: JSON.stringify(data),
      model: "test-router",
      provider: "test"
    };
  });
  return {
    generateText: async () => ({ text: "", model: "test-router", provider: "test" }),
    generateJson: generateJson as TextModelAdapter["generateJson"],
    async *streamText() {
      yield "";
    }
  };
}

function fakeFailingTextModel(): TextModelAdapter {
  const generateJson = vi.fn(async () => {
    throw new Error("router failed");
  });
  return {
    generateText: async () => ({ text: "", model: "test-router", provider: "test" }),
    generateJson: generateJson as TextModelAdapter["generateJson"],
    async *streamText() {
      yield "";
    }
  };
}

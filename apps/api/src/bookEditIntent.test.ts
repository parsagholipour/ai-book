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

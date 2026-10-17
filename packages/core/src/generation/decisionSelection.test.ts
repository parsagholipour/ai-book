import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { DecisionModelAdapter, DecisionRequest } from "../adapters/decisions.js";
import { createProjectSchema, type BookPlan, type ChapterPlan } from "../schemas/book.js";
import { judgeChapterDrafts } from "./chapterJudge.js";
import { selectCoverDesign } from "./coverDesignSelection.js";
import { COVER_DESIGNS } from "./coverDesigns.js";
import { decideFromCandidates } from "./decisionSelection.js";

const input = createProjectSchema.parse({ prompt: "A detective follows a trail through Tehran", category: "STORY", temperature: 0.8 });
const plan = { title: "The Ledger", audience: "Adults", premise: "A detective follows a trail" } as BookPlan;
const chapter = { index: 1, title: "The first clue" } as ChapterPlan;
const text = new FakeTextModelAdapter();
function route(choose: DecisionModelAdapter["choose"]) {
  return { resolve: vi.fn(async () => ({ choose })) };
}
const result = (selectedOption: string) => ({ provider: "vercel-ai-gateway", model: "typesafe-ai/jev", selectedOption });
const request: DecisionRequest = {
  purpose: "test-choice",
  instructions: "Pick one.",
  context: "context",
  options: [{ id: "picked", description: "Picked" }, { id: "other", description: "Other" }]
};

describe("decideFromCandidates", () => {
  it("uses the decision path when a model is present", async () => {
    const choose = vi.fn<DecisionModelAdapter["choose"]>(async () => result("picked"));
    await expect(
      decideFromCandidates({
        decisionModel: { choose },
        request,
        fromDecision: (decision) => decision.selectedOption,
        fallback: async () => "fallback"
      })
    ).resolves.toBe("picked");
    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose.mock.calls[0]![0]).toBe(request);
  });

  it("uses the fallback path when no model is present", async () => {
    const fallback = vi.fn(async () => "fallback");
    await expect(
      decideFromCandidates({
        request,
        fromDecision: () => "decision",
        fallback
      })
    ).resolves.toBe("fallback");
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});

describe("finite selection integration", () => {
  it("pins one chapter route, sends full drafts in both orders and leaves Jev reasons empty", async () => {
    const first = Array.from({ length: 3000 }, (_, i) => `a${i}`).join(" ");
    const second = Array.from({ length: 4000 }, (_, i) => `b${i}`).join(" ");
    const choose = vi.fn(async (request: DecisionRequest) => result(request.options.find((option) => option.description.startsWith("b0"))!.id));
    const decisions = route(choose);
    await expect(judgeChapterDrafts({ input, plan, chapter, drafts: [first, second], judge: text, decisions })).resolves.toEqual({ pick: 1, agreed: true, reasons: [] });
    expect(decisions.resolve).toHaveBeenCalledTimes(1);
    expect(choose.mock.calls.map(([request]) => request.options.map((option) => option.description))).toEqual([[first, second], [second, first]]);
  });
  it("keeps the first chapter on order disagreement and does not activate a second candidate", async () => {
    const choose = vi.fn(async () => result("A"));
    const decisions = route(choose);
    await expect(judgeChapterDrafts({ input, plan, chapter, drafts: ["one", "two"], judge: text, decisions })).resolves.toEqual({ pick: 0, agreed: false, reasons: [] });
    choose.mockClear();
    decisions.resolve.mockClear();
    await judgeChapterDrafts({ input, plan, chapter, drafts: ["one"], judge: text, decisions });
    expect(decisions.resolve).not.toHaveBeenCalled();
    expect(choose).not.toHaveBeenCalled();
  });
  it("retains chapter failure handling", async () => {
    await expect(judgeChapterDrafts({ input, plan, chapter, drafts: ["one", "two"], judge: text, decisions: route(async () => { throw new Error("failed chapter judgment"); }) })).rejects.toThrow("failed chapter judgment");
  });
  it("picks the cover with the text model alone and never consults a decision route", async () => {
    // A decision model was asked first for four Balanced books (2026-09-19) and cleared its 0.70
    // gate once across fifty options; three covers paid for the call and then the pick anyway.
    const generateJson = vi.spyOn(text, "generateJson").mockImplementation(async (options) => ({ data: options.schema.parse({ designId: "fog-street" }), text: "", provider: "test", model: "test" }));
    try {
      const chosen = await selectCoverDesign({ input, plan, textModel: text, seed: "book" });
      expect(chosen).toMatchObject({ design: { id: "fog-street" }, selectedBy: "model" });
      expect(generateJson).toHaveBeenCalledOnce();
      expect(generateJson.mock.calls[0]![0].messages[0]!.content).toContain(COVER_DESIGNS[0]!.id);
    } finally {
      generateJson.mockRestore();
    }
  });
});

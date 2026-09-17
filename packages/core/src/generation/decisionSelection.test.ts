import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { DecisionModelAdapter, DecisionRequest } from "../adapters/decisions.js";
import { createProjectSchema, pageDraftSchema, type BookPlan, type ChapterPlan } from "../schemas/book.js";
import { generateBestOfPageDrafts } from "./bestOf.js";
import { judgeChapterDrafts } from "./chapterJudge.js";
import { selectCoverDesign } from "./coverDesignSelection.js";
import { COVER_DESIGNS } from "./coverDesigns.js";
import { decideFromCandidates } from "./decisionSelection.js";

const input = createProjectSchema.parse({ prompt: "A detective follows a trail through Tehran", category: "STORY", temperature: 0.8 });
const plan = { title: "The Ledger", audience: "Adults", premise: "A detective follows a trail" } as BookPlan;
const chapter = { index: 1, title: "The first clue" } as ChapterPlan;
const text = new FakeTextModelAdapter();
const draft = (title: string) => pageDraftSchema.parse({ title, markdown: title + " content", summary: title });
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
  const pages = (decisions: ReturnType<typeof route>) => {
    let count = 0;
    return generateBestOfPageDrafts({ draftPage: async () => draft(String(count++)), baseOptions: { input, pageIndex: 1, pageBrief: { purpose: "Find clue", beat: "Read the ledger" } }, candidateCount: 2, judgeModel: text, decisions });
  };
  it("chooses the page by ID and retains its rubric and full candidate content", async () => {
    const choose = vi.fn(async () => result("1"));
    expect((await pages(route(choose))).title).toBe("1");
    const request = (choose.mock.calls as unknown as [DecisionRequest][])[0]![0];
    expect(request.instructions).toContain("Faithfulness to the page brief");
    expect(request.instructions).toContain("opening page");
    expect(request.context).toContain("Read the ledger");
    expect(request.options[1]?.description).toContain("1 content");
  });
  it("keeps the first surviving page when the decision providers fail", async () => {
    expect((await pages(route(async () => { throw new Error("both providers failed"); }))).title).toBe("0");
  });
  it("does not swallow a decision settings failure or cancellation", async () => {
    const failed = route(async () => result("1"));
    failed.resolve.mockRejectedValue(new Error("settings read failed"));
    await expect(pages(failed)).rejects.toThrow("settings read failed");
    await expect(pages(route(async () => { throw new DOMException("Stop", "AbortError"); }))).rejects.toMatchObject({ name: "AbortError" });
  });
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
  it("uses real cover IDs and descriptions and never invents Jev rationale", async () => {
    const choose = vi.fn(async (_request: DecisionRequest) => result("fog-street"));
    const chosen = await selectCoverDesign({ input, plan, textModel: text, seed: "book", decisions: route(choose) });
    expect(chosen).toMatchObject({ design: { id: "fog-street" }, selectedBy: "model" });
    expect(chosen).not.toHaveProperty("reason");
    expect(choose.mock.calls[0]![0].options.map((option) => option.id)).toEqual(COVER_DESIGNS.map((design) => design.id));
    expect(choose.mock.calls[0]![0].options[0]?.description).toContain(COVER_DESIGNS[0]!.description);
  });
  it("uses a deterministic cover on provider failure or unknown ID, but propagates cancellation and settings failure", async () => {
    const fallback = await selectCoverDesign({ input, plan, textModel: text, seed: "book", decisions: route(async () => { throw new Error("provider failed"); }) });
    expect(await selectCoverDesign({ input, plan, textModel: text, seed: "book", decisions: route(async () => result("invented")) })).toEqual(fallback);
    expect(fallback.selectedBy).toBe("fallback");
    const failed = route(async () => result("fog-street"));
    failed.resolve.mockRejectedValue(new Error("settings failed"));
    await expect(selectCoverDesign({ input, plan, textModel: text, seed: "book", decisions: failed })).rejects.toThrow("settings failed");
    await expect(selectCoverDesign({ input, plan, textModel: text, seed: "book", decisions: route(async () => { throw new DOMException("Stop", "AbortError"); }) })).rejects.toMatchObject({ name: "AbortError" });
  });
});

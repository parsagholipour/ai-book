import { afterEach, expect, it, vi } from "vitest";
import {
  createProjectSchema, makeFallbackPlan, FakeTextModelAdapter,
  PageMapIntegrityUnresolvedError,
  type ChapterBrief, type BookGenerationStrategy
} from "@book-maker/core";
import capturedMap from "../../../../packages/core/src/generation/testing/premiumBridgeMap2124.json" with { type: "json" };
import { enforceProductionMapIntegrity } from "./productionMapIntegrity.js";

vi.mock("../runtime/jobLifecycle.js", () => ({ updateJobProgress: vi.fn() }));
vi.mock("./qualitySettings.js", () => ({ applyPlanThinkingBoost: vi.fn() }));

afterEach(() => vi.unstubAllEnvs());

function fixture(modelTier: "fast" | "balanced" | "premium" = "premium") {
  vi.stubEnv("BOOK_MAKER_PRODUCTION_MAP_INTEGRITY", "enforce");
  const input = createProjectSchema.parse({
    prompt: "Rabbit and Wise Turtle restore four lanterns and escort the neighbors before moonrise.",
    category: "KIDS", targetPages: 30,
    mediaSettings: { modelTier, finalReview: true, generationStrategy: "auto" }
  });
  const briefs: ChapterBrief[] = capturedMap.chapters.map((chapter, i) => ({
    chapterIndex: i + 1, title: chapter.title, summary: chapter.summary, continuityFocus: [],
    pages: capturedMap.pages.filter(page => page.pageIndex > (capturedMap.chapters[i - 1]?.endPage ?? 0)
      && page.pageIndex <= chapter.endPage).map(page => ({ ...page, chapterIndex: i + 1 }))
  }));
  const plan = { ...makeFallbackPlan(input), chapters: briefs.map(brief => ({
    index: brief.chapterIndex, title: brief.title, summary: brief.summary,
    targetPages: brief.pages.length, keyBeats: []
  })) };
  const model = new FakeTextModelAdapter();
  const calls = vi.spyOn(model, "generateJson").mockImplementation(async options => {
    expect(options.purpose).toBe("dedupe-page-beats");
    return { data: options.schema.parse({
      beatPatches: [],
      distinctPairs: [{
        pageIndex: 23, duplicateOfPageIndex: 2,
        reason: "Page 2 establishes the lantern before the storm displaces it; page 23 restores the recovered lantern.",
        evidence: [2, 5, 22, 23].map(pageIndex => ({
          pageIndex, quote: capturedMap.pages.find(page => page.pageIndex === pageIndex)!.beat
        }))
      }]
    }), text: "", provider: "test", model: "test" };
  });
  const regenerate = vi.fn().mockRejectedValue(new Error("A valid story must not need chapter regeneration"));
  const options = {
    input, plan, briefs, textModel: model,
    strategy: { generateChapterBrief: regenerate } as unknown as BookGenerationStrategy,
    chapterRanges: plan.chapters.map((chapter, i) => ({
      chapter, startPage: briefs[i]!.pages[0]!.pageIndex, endPage: briefs[i]!.pages.at(-1)!.pageIndex
    })), quality: async () => true
  };
  return { options, briefs, calls, regenerate };
}

it.each(["balanced", "premium"] as const)(
  "lets the captured setup/restoration through unchanged in one bounded review on %s", async modelTier => {
  const { options, briefs, calls, regenerate } = fixture(modelTier);
  const result = await enforceProductionMapIntegrity(options);
  expect(result).toEqual(briefs);
  expect(calls).toHaveBeenCalledTimes(1);
  expect(regenerate).not.toHaveBeenCalled();
});

it("stops after two unanswered reviews without treating lexical overlap as grounds to rebuild a chapter", async () => {
  const { options, calls, regenerate } = fixture();
  calls.mockImplementation(async request => ({ data: request.schema.parse({ beatPatches: [] }),
    text: "", provider: "test", model: "test" }));
  await expect(enforceProductionMapIntegrity(options)).rejects.toBeInstanceOf(PageMapIntegrityUnresolvedError);
  expect(calls).toHaveBeenCalledTimes(2);
  expect(regenerate).not.toHaveBeenCalled();
});

it("does not regenerate a valid chapter when semantic review is unavailable", async () => {
  const { options, calls, regenerate } = fixture();
  calls.mockRejectedValue(new Error("semantic review unavailable"));
  await expect(enforceProductionMapIntegrity(options)).rejects.toBeInstanceOf(PageMapIntegrityUnresolvedError);
  expect(regenerate).not.toHaveBeenCalled();
  // Ordinary provider retry behavior is unchanged; no new chapter-generation call is added.
  expect(calls).toHaveBeenCalled();
});

import { expect, it } from "vitest";
import { OpenAITextAdapter } from "../adapters/openai.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { createProjectSchema } from "../schemas/book.js";
import { generateWholeBookPageMap } from "./pagesPageMap.js";

// Sparse Premium trace, 2026-09-23: the global map spent 159,342 ms and its
// entire 16,000-token effective cap on reasoning, with no visible output.
// A 24,000-token retry succeeded (13,096 reasoning + 2,375 visible tokens).
// Replay that exhausted-cap boundary through the real map -> retry -> adapter
// path. This pins avoidance of the known cap, not a provider latency promise.
it("gives the complete thirty-page map headroom before paying for a truncated retry", async () => {
  const input = createProjectSchema.parse({
    prompt: "Rabbit and Wise Turtle recover six lanterns before moonrise; both must grow.",
    category: "KIDS", targetPages: 30,
    mediaSettings: { fullIllustrations: true, finalReview: true, generationStrategy: "auto", illustrationCadence: "every-third-page" }
  });
  const plan = { ...makeFallbackPlan(input), chapters: Array.from({ length: 15 }, (_, i) => ({
    index: i + 1, title: `Chapter ${i + 1}`, summary: `The friends find clue ${i + 1}.`,
    targetPages: 2, keyBeats: [`Follow clue ${i + 1}.`]
  })) };
  const data = { pages: Array.from({ length: 30 }, (_, i) => ({
    pageIndex: i + 1, chapterIndex: Math.floor(i / 2) + 1,
    purpose: `Find the next clue ${i + 1}.`, beat: `The friends follow clue ${i + 1} together.`,
    requiredContinuity: [], endingPressure: `Follow the next clue ${i + 2}.`
  })) };
  const requests: Array<{ max_output_tokens: number; model: string; reasoning: { effort: string } }> = [];
  const adapter = new OpenAITextAdapter({ apiKey: "fixture", model: "gpt-6-luna", thinkingEffort: "high" });
  Object.assign(adapter, { client: { responses: { create: async (request: typeof requests[number]) => {
    requests.push(request);
    const exhausted = request.max_output_tokens <= 16_000;
    return { model: request.model, status: exhausted ? "incomplete" : "completed",
      incomplete_details: exhausted ? { reason: "max_output_tokens" } : undefined,
      output_text: exhausted ? "" : JSON.stringify(data),
      usage: { input_tokens: 2_353, output_tokens: exhausted ? 16_000 : 15_471,
        output_tokens_details: { reasoning_tokens: exhausted ? 16_000 : 13_096 } }
    };
  } } } });
  const result = await generateWholeBookPageMap({ input, plan, textModel: adapter });
  expect(result.flatMap((chapter) => chapter.pages.map((page) => page.pageIndex))).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  expect(requests).toHaveLength(1);
  expect(requests[0]?.max_output_tokens).toBe(24_000);
  expect(requests[0]?.model).toBe("gpt-6-luna");
  expect(requests[0]?.reasoning.effort).toBe("high");
});

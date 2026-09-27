import { describe, expect, it, vi } from "vitest";
import { OpenAITextAdapter } from "../adapters/openai.js";
import { parseSchemaWithContext } from "../adapters/json.js";
import type { GenerateJsonOptions, TextModelAdapter } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { createProjectSchema } from "../schemas/book.js";
import { generateCompactPictureBookMap } from "./compactPictureBookPlanning.js";
import { generateWholeBookPageMap } from "./pagesPageMap.js";
import captured from "./testing/premiumMapChapterIndex0338.json" with { type: "json" };

const input = createProjectSchema.parse({ prompt: "Rabbit and Wise Turtle restore the lantern path before moonrise.",
  category: "KIDS", targetPages: 30, mediaSettings: { finalReview: true, fullIllustrations: false, modelTier: "premium" } });
const plan = { ...makeFallbackPlan(input), chapters: Array.from({ length: 10 }, (_, i) => ({
  index: i + 1, title: `Lantern search ${i + 1}`, summary: `The friends follow the next lantern clue ${i + 1}.`,
  targetPages: 3, keyBeats: [`Find and follow clue ${i + 1}.`]
})) };
const chapterRanges = () => plan.chapters.map((chapter, i) => ({ chapter, startPage: i * 3 + 1, endPage: i * 3 + 3 }));
function model(answer: unknown) {
  const calls = vi.fn(async <T>(request: GenerateJsonOptions<T>) => ({
    data: parseSchemaWithContext("Fixture", request.schema, answer, request.purpose, JSON.stringify(answer))
  }));
  return { calls, textModel: { generateJson: calls } as unknown as TextModelAdapter };
}

describe("compact map chapter ownership", () => {
  it("retains the complete captured Premium map in one provider attempt despite page 9's wrong chapter label", async () => {
    expect(captured.pages[8]).toMatchObject({ pageIndex: 9, chapterIndex: 4 });
    const create = vi.fn(async () => ({ status: "completed", model: "gpt-6-luna", output_text: JSON.stringify(captured),
      usage: { input_tokens: 2687, output_tokens: 12513, output_tokens_details: { reasoning_tokens: 10299 } } }));
    const adapter = new OpenAITextAdapter({ apiKey: "fixture", model: "gpt-6-luna", thinkingEffort: "high" });
    Object.assign(adapter, { client: { responses: { create } } });
    const result = await generateWholeBookPageMap({ input, plan, textModel: adapter });
    expect(create).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(10);
    expect(result.flatMap(brief => brief.pages)).toMatchObject(captured.pages.map((page, i) => ({
      ...page, chapterIndex: Math.floor(i / 3) + 1
    })));
  });

  it.each([undefined, null, "wrong chapter", 99])("derives chapters even when the ignored model label is %s", async chapterIndex => {
    const pages = captured.pages.map(({ chapterIndex: _ignored, ...page }) => ({ ...page,
      ...(chapterIndex === undefined ? {} : { chapterIndex }) }));
    const { textModel, calls } = model({ pages });
    const result = await generateWholeBookPageMap({ input, plan, textModel });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(result.flatMap(brief => brief.pages)).toMatchObject(captured.pages.map((page, i) => ({
      ...page, chapterIndex: Math.floor(i / 3) + 1
    })));
  });

  it("uses unequal chapter ranges rather than assuming the captured three-page allocation", async () => {
    const planned = { ...plan, chapters: [4, 8, 18].map((targetPages, i) => ({ ...plan.chapters[i]!, targetPages })) };
    const { textModel, calls } = model(captured);
    const result = await generateWholeBookPageMap({ input, plan: planned, textModel });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(result.map(brief => brief.pages.map(page => [page.pageIndex, page.chapterIndex]))).toEqual([
      Array.from({ length: 4 }, (_, i) => [i + 1, 1]),
      Array.from({ length: 8 }, (_, i) => [i + 5, 2]),
      Array.from({ length: 18 }, (_, i) => [i + 13, 3])
    ]);
  });

  it.each(["missing", "duplicate", "reordered", "extra", "fractional", "missing beat"])("still rejects %s page data", async kind => {
    const pages = structuredClone(captured.pages);
    if (kind === "missing") pages.pop();
    if (kind === "duplicate") pages[29]!.pageIndex = 1;
    if (kind === "reordered") [pages[7], pages[8]] = [pages[8]!, pages[7]!];
    if (kind === "extra") pages[29]!.pageIndex = 31;
    if (kind === "fractional") pages[8]!.pageIndex = 9.5;
    if (kind === "missing beat") pages[8]!.beat = "";
    const { textModel, calls } = model({ pages });
    await expect(generateWholeBookPageMap({ input, plan, textModel })).rejects.toThrow();
    expect(calls).toHaveBeenCalledTimes(3);
  });

  it.each(["gap", "overlap", "duplicate chapter", "fractional boundary", "out of bounds", "incomplete"])(
    "rejects a %s in the authoritative ranges before buying a map", async kind => {
      const ranges = chapterRanges();
      if (kind === "gap") ranges[1]!.startPage = 5;
      if (kind === "overlap") ranges[1]!.startPage = 3;
      if (kind === "duplicate chapter") ranges[1]!.chapter = ranges[0]!.chapter;
      if (kind === "fractional boundary") ranges[0]!.endPage = 3.5;
      if (kind === "out of bounds") ranges[9]!.endPage = 31;
      if (kind === "incomplete") ranges.pop();
      const { textModel, calls } = model(captured);
      await expect(generateCompactPictureBookMap({ input, plan, chapterRanges: ranges, textModel })).rejects.toThrow(/chapter ranges/i);
      expect(calls).not.toHaveBeenCalled();
    });
});

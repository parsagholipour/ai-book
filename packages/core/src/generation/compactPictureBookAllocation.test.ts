import { expect, it, vi } from "vitest";
import type { GenerateJsonOptions, TextModelAdapter } from "../adapters/types.js";
import { parseSchemaWithContext } from "../adapters/json.js";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { bookPlanSchema, createProjectSchema } from "../schemas/book.js";
import { generateWholeBookPageMap } from "./pagesPageMap.js";
import { compactPictureBookPlanForBriefs } from "./compactPictureBookPlanning.js";
import captured from "./testing/premiumMapChapterIndex0338.json" with { type: "json" };

const input = createProjectSchema.parse({ prompt: "Rabbit and Wise Turtle restore the lantern path before moonrise.",
  category: "KIDS", targetPages: 30, mediaSettings: { finalReview: true, fullIllustrations: false } });
const plan = { ...makeFallbackPlan(input), chapters: Array.from({ length: 10 }, (_, i) => ({
  index: i + 1, title: `Lantern search ${i + 1}`, summary: `Search stage ${i + 1}.`,
  targetPages: 3, keyBeats: ["Prepare to help.", "Ask permission.", "Begin to help."]
})) };
const ends = [2, 6, 10, 14, 18, 21, 24, 27, 29, 30];
function model(answer: unknown) {
  const calls = vi.fn(async <T>(request: GenerateJsonOptions<T>) => ({
    data: parseSchemaWithContext("Fixture", request.schema, answer, request.purpose, JSON.stringify(answer))
  }));
  return { calls, textModel: { generateJson: calls } as unknown as TextModelAdapter };
}

it("allocates scenes before chapter breaks without briefing the model to fill the old three-page grid", async () => {
  const chapterEnds = [5, 12, 20, 27, 30];
  const { textModel, calls } = model({ pages: captured.pages, chapters: chapterEnds.map((endPage, i) => ({ endPage, title: `Story phase ${i + 1}`, summary: `A meaningful change ${i + 1}.` })) });
  const result = await generateWholeBookPageMap({ input, plan, textModel });
  expect(calls).toHaveBeenCalledTimes(1);
  expect(result.map(brief => brief.pages.at(-1)!.pageIndex)).toEqual(chapterEnds);
  const allocated = compactPictureBookPlanForBriefs(input, plan, result);
  expect(allocated.chapters.map(chapter => chapter.targetPages)).toEqual([5, 7, 8, 7, 3]);
  expect(allocated.chapters.map(chapter => chapter.title)).toEqual(result.map(brief => brief.title));
  expect(allocated.chapters[0]!.keyBeats).toEqual(result[0]!.pages.map(page => page.beat));
  expect(allocated.promises).toEqual(plan.promises);
  expect(allocated.continuityRules).toEqual(plan.continuityRules);
  expect(result.flatMap(brief => brief.pages.map(page => page.pageIndex))).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  // Legacy per-page chapter labels still cannot override the validated allocation.
  expect(result[1]!.pages.find(page => page.pageIndex === 9)?.chapterIndex).toBe(2);
  const payload = JSON.parse(calls.mock.calls[0]![0].messages[1]!.content);
  expect(payload).not.toHaveProperty("chapterRanges");
  expect(payload).not.toHaveProperty("chapters");
  expect(payload.storyOutline).toEqual(plan.chapters.map(chapter => chapter.summary));
  expect(JSON.stringify(payload)).not.toContain("Prepare to help.");
  expect(payload.userPrompt).toBe(input.prompt);
});

it("only adopts complete, ordered chapter partitions in the compact lane", async () => {
  const { textModel } = model({ pages: captured.pages, chapters: ends.map((endPage, i) => ({ endPage, title: plan.chapters[i]!.title, summary: plan.chapters[i]!.summary })) });
  const briefs = await generateWholeBookPageMap({ input, plan, textModel });
  const allocated = compactPictureBookPlanForBriefs(input, plan, briefs);
  expect(allocated.chapters.map(chapter => chapter.targetPages)).toEqual([2, 4, 4, 4, 4, 3, 3, 3, 2, 1]);
  expect(allocated.chapters.map(chapter => chapter.title)).toEqual(plan.chapters.map(chapter => chapter.title));
  expect(compactPictureBookPlanForBriefs({ ...input, mediaSettings: { ...input.mediaSettings, generationStrategy: "draft-then-polish" } }, plan, briefs)).toBe(plan);
  expect(compactPictureBookPlanForBriefs({ ...input, targetPages: 20 }, plan, briefs)).toBe(plan);
  for (const corrupt of [briefs.slice(1), [...briefs].reverse(), briefs.map((brief, i) => i === 0 ? { ...brief, pages: [] } : brief),
    briefs.map((brief, i) => i === 1 ? { ...brief, pages: brief.pages.map(page => ({ ...page, chapterIndex: 1 })) } : brief),
    briefs.map((brief, i) => i === 1 ? { ...brief, pages: brief.pages.map(page => ({ ...page, pageIndex: 1 })) } : brief)
  ]) expect(compactPictureBookPlanForBriefs(input, plan, corrupt)).toBe(plan);
});

it("keeps global story contracts but removes obsolete chapter-indexed arc jobs after regrouping", async () => {
  const source = bookPlanSchema.parse({ ...plan, bookArc: { question: "Will they cooperate?", answer: "They work together.",
    chapters: plan.chapters.map(chapter => ({ index: chapter.index, pages: 3, kind: "case", job: { does: "Search for a lantern." } })) } });
  const { textModel } = model({ pages: captured.pages, chapters: [10, 22, 30].map((endPage, i) => ({
    endPage, title: `A new phase ${i + 1}`, summary: "The friends make a consequential choice." })) });
  const briefs = await generateWholeBookPageMap({ input, plan: source, textModel });
  const allocated = compactPictureBookPlanForBriefs(input, source, briefs);
  expect(allocated.bookArc).toBeUndefined();
  expect(allocated.chapters.map(chapter => chapter.targetPages)).toEqual([10, 12, 8]);
  expect(allocated.characters).toEqual(source.characters);
  expect(allocated.promises).toEqual(source.promises);
  expect(allocated.continuityRules).toEqual(source.continuityRules);
  expect(source.bookArc?.chapters).toHaveLength(10);
});

it("accepts a concise final chapter summary without another paid attempt", async () => {
  const { textModel, calls } = model({ pages: captured.pages,
    chapters: [{ endPage: 27, title: "The search", summary: "Find the lights." }, { endPage: 30, title: "Picnic", summary: "They rest." }] });
  const briefs = await generateWholeBookPageMap({ input, plan, textModel });
  expect(calls).toHaveBeenCalledTimes(1);
  expect(briefs[1]!.summary).toBe("They rest.");
});

it("supports the complete scene map in the local MOCK_AI workflow", async () => {
  const textModel = new FakeTextModelAdapter(input);
  const call = vi.spyOn(textModel, "generateJson");
  const briefs = await generateWholeBookPageMap({ input, plan, textModel });
  expect(call).toHaveBeenCalledTimes(1);
  expect(briefs.flatMap(brief => brief.pages.map(page => page.pageIndex))).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  expect(compactPictureBookPlanForBriefs(input, plan, briefs).chapters.map(chapter => chapter.targetPages)).toEqual([30]);
});

it.each([
  [2, 6, 10], [2, 6, 10, 14, 18, 21, 24, 27, 30, 30],
  [2, 6, 10, 14, 18, 21, 24, 27, 29, 31], [2, 6, 10, 14, 18, 21, 24, 27, 28, 29],
  [2, 6, 10, 14, 18, 21, 24, 27, 29.5, 30]
])("rejects an incomplete, empty, or invalid allocation %j", async (...chapterEndPages) => {
  const { textModel, calls } = model({ pages: captured.pages, chapters: chapterEndPages.map((endPage, i) => ({ endPage, title: `Part ${i + 1}`, summary: "The friends continue the search." })) });
  await expect(generateWholeBookPageMap({ input, plan, textModel })).rejects.toThrow();
  expect(calls).toHaveBeenCalledTimes(3);
});

import { expect, it, vi } from "vitest";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { GenerateJsonOptions, TextModelAdapter } from "../adapters/types.js";
import { generationPageCountBounds, inputWithSelectedPageCount, pageCountAllowance } from "./pageCountAllowance.js";
import { compactPictureBookPlanForBriefs, usesCompactPictureBookPlanning } from "./compactPictureBookPlanning.js";
import { generateWholeBookPageMap } from "./pagesPageMap.js";
import { generateWholeBookDraft } from "./pages.js";
import { resolveBookGenerationStrategy } from "./strategies/router.js";
import { FakeTextModelAdapter } from "../adapters/fake.js";

const input = createProjectSchema.parse({ prompt: "Rabbit and Turtle restore the lantern path together.", category: "KIDS", targetPages: 30 });
function model(answer: unknown) {
  const calls = vi.fn(async <T>(request: GenerateJsonOptions<T>) => ({ data: request.schema.parse(answer) }));
  return { calls, textModel: { generateJson: calls } as unknown as TextModelAdapter };
}
const pages = (count: number) => Array.from({ length: count }, (_, i) => ({ index: i + 1, title: `Turn ${i + 1}`,
  markdown: `Rabbit follows a new clue ${i + 1}.`, summary: `Discovery ${i + 1}.`, continuityNotes: [] }));
const map = (count: number) => ({ pages: pages(count).map(page => ({ pageIndex: page.index,
  purpose: page.markdown, beat: page.markdown, endingPressure: "Continue toward the lights.", requiredContinuity: [] })),
  chapters: [{ endPage: count, title: "The lantern path", summary: "The friends bring the lights home." }] });

it.each([[1, 2], [5, 6], [15, 16], [30, 33], [40, 44]])("keeps %i as the minimum and allows up to %i", (minimumPages, maximumPages) => {
  expect(pageCountAllowance(minimumPages)).toEqual({ minimumPages, maximumPages });
});

it("freezes a selected count even when it equals the original minimum", () => {
  const selected = createProjectSchema.parse(inputWithSelectedPageCount(input, 30));
  expect(selected.mediaSettings.generationPageCount).toEqual({ requestedPages: 30, selectedPages: 30 });
  expect(generationPageCountBounds(selected)).toEqual({ minimumPages: 30, maximumPages: 30 });
  expect(() => inputWithSelectedPageCount(selected, 31)).toThrow();
});

it.each([5, 30])("retains the existing provider route and one-call dry run for %i pages", async count => {
  const source = { ...input, targetPages: count }, textModel = new FakeTextModelAdapter(source);
  const calls = vi.spyOn(textModel, "generateJson");
  const briefs = await generateWholeBookPageMap({ input: source, plan: makeFallbackPlan(source), textModel });
  expect(briefs.flatMap(brief => brief.pages)).toHaveLength(count);
  expect(calls).toHaveBeenCalledTimes(1);
  expect(calls.mock.calls[0]![0]).toMatchObject({ purpose: count > 24 ? "generate-chapter-brief" : "generate-page-map",
    maxTokens: count > 24 ? 24_000 : 1800 });
});

it.each([30, 31, 33])("accepts a %i-page draft for a thirty-page request", async count => {
  const { textModel } = model({ pages: pages(count) });
  expect((await generateWholeBookDraft({ input, plan: makeFallbackPlan(input), researchNotes: [], textModel })).pages).toHaveLength(count);
});

it.each([0, 29, 34, 45])("rejects %i pages outside the customer's one-sided allowance", async count => {
  const { textModel } = model({ pages: pages(count) });
  await expect(generateWholeBookDraft({ input, plan: makeFallbackPlan(input), researchNotes: [], textModel })).rejects.toThrow(/expected 30-33/);
});

it.each([[5, 6], [30, 33], [40, 44]])("carries a %i-page request through the extended map and a fixed %i-page draft", async (requested, chosen) => {
  const source = { ...input, targetPages: requested }, plan = makeFallbackPlan(source);
  const mapped = model(map(chosen));
  const briefs = await generateWholeBookPageMap({ input: source, plan, textModel: mapped.textModel });
  expect(mapped.calls).toHaveBeenCalledTimes(1);
  const allocated = compactPictureBookPlanForBriefs(source, plan, briefs);
  expect(allocated.chapters.reduce((sum, chapter) => sum + chapter.targetPages, 0)).toBe(chosen);
  const selected = createProjectSchema.parse(inputWithSelectedPageCount(source, chosen));
  expect(generationPageCountBounds(selected)).toEqual({ minimumPages: chosen, maximumPages: chosen });
  expect(usesCompactPictureBookPlanning(selected)).toBe(true);
  expect(resolveBookGenerationStrategy(selected).strategy.id).toBe("draft-then-polish");
  const draft = model({ pages: pages(chosen) });
  expect((await generateWholeBookDraft({ input: selected, plan: allocated, chapterBriefs: briefs, researchNotes: [], textModel: draft.textModel })).pages).toHaveLength(chosen);
  expect(() => inputWithSelectedPageCount(selected, chosen + 1)).toThrow();
  for (const invalid of [requested - 1, chosen + 1]) {
    await expect(generateWholeBookPageMap({ input: source, plan, textModel: model(map(invalid)).textModel })).rejects.toThrow();
    await expect(generateWholeBookDraft({ input: selected, plan: allocated, chapterBriefs: briefs, researchNotes: [], textModel: model({ pages: pages(invalid) }).textModel })).rejects.toThrow();
  }
});

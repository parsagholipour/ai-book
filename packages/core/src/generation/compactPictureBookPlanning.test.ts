import { describe, expect, it, vi } from "vitest";
import type { GenerateJsonOptions, TextModelAdapter } from "../adapters/types.js";
import { parseSchemaWithContext } from "../adapters/json.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { createProjectSchema } from "../schemas/book.js";
import { createPlanningPackage } from "./planner.js";
import { generateWholeBookDraft } from "./pages.js";
import { generateWholeBookPageMap } from "./pagesPageMap.js";
import { usesCompactPictureBookPlanning } from "./compactPictureBookPlanning.js";
import { resolveBookGenerationStrategy } from "./strategies/router.js";

const input = createProjectSchema.parse({ prompt: "Rabbit and Wise Turtle recover six lanterns before moonrise; both must grow.", category: "KIDS", targetPages: 30,
  mediaSettings: { fullIllustrations: true, finalReview: true, generationStrategy: "auto" } });
const plan = () => ({ ...makeFallbackPlan(input), storyTreatment: "Rabbit races ahead and mistakes a fallen lantern for a route marker. Turtle checks every possibility until waiting makes matters worse. Together they compare two landing places, predict where the remaining lanterns fell, and recover them. Rabbit pauses to listen while Turtle trusts a useful clue. They guide their neighbors to the picnic before moonrise.", chapters: Array.from({ length: 6 }, (_, i) => ({ index: i + 1, title: `Chapter ${i + 1}`, summary: `Chapter ${i + 1} moves the search onward.`, targetPages: 5, keyBeats: [`Discover the next clue ${i + 1}.`] })) });
const beats = () => Array.from({ length: 30 }, (_, i) => ({ pageIndex: i + 1, chapterIndex: Math.floor(i / 5) + 1,
  purpose: `Rabbit checks clue ${i + 1}.`, beat: `Rabbit follows clue ${i + 1} toward the next bend.`, requiredContinuity: [], endingPressure: `Follow clue ${i + 2}.` }));
function model(answer: unknown) {
  const calls = vi.fn(async <T>(options: GenerateJsonOptions<T>) => ({ data: parseSchemaWithContext("Fixture", options.schema, answer, options.purpose, JSON.stringify(answer)) }));
  return { calls, textModel: { generateJson: calls } as unknown as TextModelAdapter };
}
const research = { search: vi.fn() };

describe("compact picture-book planning", () => {
  it.each(["fast", "balanced", "premium"] as const)("keeps compact planning and the complete map for %s text-only stories with saved characters", async (modelTier) => {
    const textInput = createProjectSchema.parse({ ...input, mediaSettings: { ...input.mediaSettings,
      modelTier, fullIllustrations: false, illustrationCadence: "manual", includeCover: false, coverArtSource: "none",
      mobile: { characters: [{ id: "rabbit", name: "Rabbit", description: "An impatient explorer who learns to listen.", fields: [] }] }
    } });
    expect(resolveBookGenerationStrategy(textInput).strategy.id).toBe("draft-then-polish");
    const planning = model(plan());
    const result = await createPlanningPackage({ input: textInput, textModel: planning.textModel, research });
    expect(planning.calls).toHaveBeenCalledTimes(1);
    const prompt = planning.calls.mock.calls[0]![0].messages[0]!.content;
    expect(prompt).toContain("Keep total plan prose about 700–1000 words");
    expect(prompt).toContain("An impatient explorer who learns to listen.");
    expect(prompt).toContain("Leave chapter illustrationPrompts empty");
    expect(prompt).not.toContain("Give each chapter only 1–2 short illustration moments");
    expect(result.characters).toContainEqual(expect.objectContaining({ name: "Rabbit", description: "An impatient explorer who learns to listen." }));
    const map = model({ pages: beats() });
    const briefs = await generateWholeBookPageMap({ input: textInput, plan: plan(), textModel: map.textModel });
    expect(map.calls).toHaveBeenCalledTimes(1);
    expect(map.calls.mock.calls[0]![0]).toMatchObject({ purpose: "generate-chapter-brief", maxTokens: 24_000 });
    expect(map.calls.mock.calls[0]![0].messages[0]!.content).toContain("omit imageMoment");
    expect(briefs.flatMap((brief) => brief.pages.map((page) => page.pageIndex))).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it("keeps the compact eligibility bounds with illustrations disabled", () => {
    const textInput = { ...input, mediaSettings: { ...input.mediaSettings, fullIllustrations: false } };
    expect(usesCompactPictureBookPlanning(textInput)).toBe(true);
    for (const changed of [
      { ...textInput, category: "STORY" as const }, { ...textInput, targetPages: 4 }, { ...textInput, targetPages: 41 },
      { ...textInput, prompt: "Teach scientific facts about real turtles." },
      { ...textInput, mediaSettings: { ...textInput.mediaSettings, finalReview: false } },
      { ...textInput, mediaSettings: { ...textInput.mediaSettings, generationStrategy: "draft-then-polish" as const } },
      { ...textInput, mediaSettings: { ...textInput.mediaSettings, mobile: { import: { source: "manuscript" } } } }
    ]) expect(usesCompactPictureBookPlanning(changed)).toBe(false);
  });

  it("keeps the saved plan purpose and obligations while omitting unused author essays and duplicated fallback prose", async () => {
    const { textModel, calls } = model(plan());
    await createPlanningPackage({ input, textModel, research });
    expect(calls).toHaveBeenCalledTimes(1);
    const request = calls.mock.calls[0]![0];
    expect(request.purpose).toBe("plan-book");
    const prompt = request.messages.map((m) => m.content).join("\n");
    expect(prompt).toContain(input.prompt);
    expect(prompt).toContain("initial limitation");
    expect(prompt).toContain("In continuityRules, record one compact arc contract");
    expect(prompt).toContain("before moonrise");
    expect(prompt).not.toContain("180 to 260 words");
    expect(prompt).not.toContain('"fallbackOutline"');
    expect(prompt).not.toContain('"authorStance"');
  });

  it("generates thirty ordered assignments in one call using the existing chapter-brief route", async () => {
    const { textModel, calls } = model({ pages: beats() });
    const planned = plan();
    planned.continuityRules = ["Turtle initially refuses the short route; tests Rabbit's idea at the fork; later trusts Rabbit to lead."];
    const result = await generateWholeBookPageMap({ input, plan: planned, textModel });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(calls.mock.calls[0]![0].purpose).toBe("generate-chapter-brief");
    expect(result).toHaveLength(6);
    expect(result.flatMap((b) => b.pages.map((p) => p.pageIndex))).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    const prompt = calls.mock.calls[0]![0].messages.map((m) => m.content).join("\n");
    expect(prompt).toContain(input.prompt);
    expect(prompt).toContain("chapter boundaries");
    expect(prompt).toContain("endingPressure describes the unresolved change");
    expect(prompt).toContain("initial limitation");
    expect(prompt).toContain("moonrise");
    expect(JSON.parse(calls.mock.calls[0]![0].messages[1]!.content).book.continuityRules).toEqual(planned.continuityRules);
  });

  it.each(["missing", "duplicate"])("rejects %s page assignments without invented fallback beats", async (kind) => {
    const pages = beats();
    if (kind === "missing") pages.pop();
    if (kind === "duplicate") pages[29]!.pageIndex = 1;
    const { textModel, calls } = model({ pages });
    await expect(generateWholeBookPageMap({ input, plan: plan(), textModel })).rejects.toThrow();
    expect(calls.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("propagates cancellation without a fallback map", async () => {
    const { textModel, calls } = model({ pages: beats() });
    calls.mockRejectedValue(Object.assign(new Error("stopped"), { name: "AbortError" }));
    await expect(generateWholeBookPageMap({ input, plan: plan(), textModel })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("carries the inventory, locations, deadline and each character arc into the complete draft", async () => {
    const planned = plan();
    planned.continuityRules = ["Turtle initially refuses the short route; tests Rabbit's idea at the fork; later trusts Rabbit to lead."];
    const { textModel, calls } = model({ pages: Array.from({ length: 30 }, (_, i) => ({ index: i + 1, title: `Scene ${i + 1}`, markdown: `Rabbit follows clue ${i + 1}.`, summary: `Clue ${i + 1}`, continuityNotes: [] })) });
    await generateWholeBookDraft({ input, plan: planned, textModel, chapterBriefs: [], researchNotes: [] });
    const system = calls.mock.calls[0]![0].messages[0]!.content;
    expect(system).toContain("endingPressure is an author note");
    expect(JSON.parse(calls.mock.calls[0]![0].messages[1]!.content).book.continuityRules).toEqual(planned.continuityRules);
    for (const phrase of ["stable prop inventory", "entrance and exit locations", "before its deadline", "initial limitation",
      "exact visible characters and their positions", "current visible prop count and ownership", "time of day", "Exclude items recovered only on later pages"]) expect(system).toContain(phrase);
  });

  it("does not compact explicit workflows or research requests", async () => {
    for (const change of [{ mediaSettings: { ...input.mediaSettings, generationStrategy: "draft-then-polish" as const } }, { prompt: "A scientific book about real turtles." }, { targetPages: 80 }]) {
      const { textModel, calls } = model(plan());
      await createPlanningPackage({ input: { ...input, ...change }, textModel, research: { search: async () => ({ query: "", summary: "", sources: [] }) } });
      expect(calls.mock.calls[0]![0].messages[0]!.content).toContain("180 to 260 words");
    }
  });

  it("keeps the compact thirty-page plan and map while drafting image prompts only for ten selected pages", async () => {
    const sparseInput = createProjectSchema.parse({ ...input, mediaSettings: { ...input.mediaSettings, illustrationCadence: "every-third-page" } });
    const planning = model(plan());
    await createPlanningPackage({ input: sparseInput, textModel: planning.textModel, research });
    const map = model({ pages: beats() });
    await generateWholeBookPageMap({ input: sparseInput, plan: plan(), textModel: map.textModel });
    for (const capture of [planning, map]) {
      expect(capture.calls).toHaveBeenCalledTimes(1);
      const prompt = capture.calls.mock.calls[0]![0].messages.map((message) => message.content).join("\n");
      expect(prompt).toContain("Illustrate story pages 3, 6, 9, 12, 15, 18, 21, 24, 27, 30.");
      expect(prompt).toContain("Preserve the complete narrative progression");
    }
    const draft = model({ pages: Array.from({ length: 30 }, (_, i) => ({ index: i + 1, title: `Scene ${i + 1}`, markdown: `Rabbit follows clue ${i + 1}.`, summary: `Clue ${i + 1}`, continuityNotes: [] })) });
    const result = await generateWholeBookDraft({ input: sparseInput, plan: plan(), textModel: draft.textModel, chapterBriefs: [], researchNotes: [] });
    expect(result.pages).toHaveLength(30);
    const prompt = draft.calls.mock.calls[0]![0].messages[0]!.content;
    expect(prompt).toContain("Only include imagePrompt on pages 3, 6, 9, 12, 15, 18, 21, 24, 27, 30; omit it on every other page.");
    expect(prompt).toContain("stable prop inventory");
  });
});

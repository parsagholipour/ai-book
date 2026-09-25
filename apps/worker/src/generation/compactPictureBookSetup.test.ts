import { expect, it, vi } from "vitest";
import { createProjectSchema, generateWholeBookPageMap, makeFallbackPlan, type GenerateJsonOptions, type ProviderSet, type BookGenerationStrategy } from "@book-maker/core";
const mocks = vi.hoisted(() => ({ integrity: vi.fn(), critic: vi.fn() }));
vi.mock("@book-maker/db", () => ({ prisma: {}, Prisma: {} }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn(), updateJobProgress: vi.fn() }));
vi.mock("./qualitySettings.js", () => ({ applyPlanThinkingBoost: vi.fn(), loadQualityContext: async () => ({ enabled: () => true }) }));
vi.mock("./productionMapIntegrity.js", () => ({ enforceProductionMapIntegrity: mocks.integrity }));
vi.mock("@book-maker/core", async (original) => ({ ...await original<object>(), critiquePageMap: mocks.critic }));
import { prepareChapterSetups } from "./bookState.js";

it.each([true, false])("retains both mandatory integrity passes and the configured critic with fullIllustrations=%s", async (fullIllustrations) => {
  const input = createProjectSchema.parse({ prompt: "Rabbit and Wise Turtle recover six lanterns before moonrise; both grow.", category: "KIDS", targetPages: 30,
    mediaSettings: { fullIllustrations, finalReview: true, generationStrategy: "auto" } });
  const plan = { ...makeFallbackPlan(input), chapters: Array.from({ length: 6 }, (_, i) => ({ index: i + 1, title: `Chapter ${i + 1}`, summary: `Search stage ${i + 1}.`, targetPages: 5, keyBeats: [] })) };
  const pages = Array.from({ length: 30 }, (_, i) => ({ pageIndex: i + 1, chapterIndex: Math.floor(i / 5) + 1,
    purpose: `Rabbit checks clue ${i + 1}.`, beat: `Rabbit follows clue ${i + 1} toward the next bend.`, requiredContinuity: [], endingPressure: `Follow clue ${i + 2}.` }));
  const events: string[] = [];
  const generateJson = vi.fn(async <T>(options: GenerateJsonOptions<T>) => { events.push(options.purpose ?? ""); return { data: options.schema.parse({ pages }) }; });
  mocks.integrity.mockImplementation(async ({ briefs }) => { events.push("integrity"); return briefs; });
  mocks.critic.mockImplementation(async () => { events.push("critic"); return { beatPatches: [], duplicatePurposeWarnings: [], missingEndingPressure: [], unscheduledPromises: [] }; });
  const result = await prepareChapterSetups({ input, plan, providers: { text: { generateJson } } as unknown as ProviderSet,
    strategy: { createChapterBriefs: generateWholeBookPageMap } as unknown as BookGenerationStrategy });
  expect(events).toEqual(["generate-chapter-brief", "integrity", "critic", "integrity"]);
  expect(result.flatMap((setup) => setup.brief!.pages)).toHaveLength(30);
  expect(mocks.critic).toHaveBeenCalledWith(expect.objectContaining({ input, plan, promises: plan.promises }));
});

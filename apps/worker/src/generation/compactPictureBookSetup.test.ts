import { beforeEach, expect, it, vi } from "vitest";
import { createProjectSchema, generateWholeBookPageMap, makeFallbackPlan, type GenerateJsonOptions, type ProviderSet, type BookGenerationStrategy } from "@book-maker/core";
const mocks = vi.hoisted(() => ({ integrity: vi.fn(), critic: vi.fn(), enabled: vi.fn() }));
vi.mock("@book-maker/db", () => ({ prisma: {}, Prisma: {} }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn(), updateJobProgress: vi.fn() }));
vi.mock("./qualitySettings.js", () => ({ applyPlanThinkingBoost: vi.fn(), loadQualityContext: async () => ({ enabled: mocks.enabled }) }));
vi.mock("./productionMapIntegrity.js", () => ({ enforceProductionMapIntegrity: mocks.integrity }));
vi.mock("@book-maker/core", async (original) => ({ ...await original<object>(), critiquePageMap: mocks.critic }));
import { prepareChapterSetups } from "./bookState.js";

beforeEach(() => { vi.clearAllMocks(); mocks.enabled.mockReturnValue(true); });

it.each((["fast", "balanced", "premium", "ultra"] as const).flatMap(modelTier =>
  [true, false].map(fullIllustrations => ({ modelTier, fullIllustrations }))
))("keeps integrity and skips the extra critic for $modelTier auto stories, illustrations=$fullIllustrations", async ({ modelTier, fullIllustrations }) => {
  const input = createProjectSchema.parse({ prompt: "Rabbit and Wise Turtle recover six lanterns before moonrise; both grow.", category: "KIDS", targetPages: 30,
    mediaSettings: { modelTier, fullIllustrations, finalReview: true, generationStrategy: "auto" } });
  const plan = { ...makeFallbackPlan(input), chapters: Array.from({ length: 6 }, (_, i) => ({ index: i + 1, title: `Chapter ${i + 1}`, summary: `Search stage ${i + 1}.`, targetPages: 5, keyBeats: [] })) };
  const pages = Array.from({ length: 30 }, (_, i) => ({ pageIndex: i + 1, chapterIndex: Math.floor(i / 5) + 1,
    purpose: `Rabbit checks clue ${i + 1}.`, beat: `Rabbit follows clue ${i + 1} toward the next bend.`, requiredContinuity: [], endingPressure: `Follow clue ${i + 2}.` }));
  const events: string[] = [];
  const generateJson = vi.fn(async <T>(options: GenerateJsonOptions<T>) => { events.push(options.purpose ?? ""); return { data: options.schema.parse({ pages }) }; });
  mocks.integrity.mockImplementation(async ({ briefs }) => { events.push("integrity"); return briefs; });
  mocks.critic.mockImplementation(async () => { events.push("critic"); return { beatPatches: [], duplicatePurposeWarnings: [], missingEndingPressure: [], unscheduledPromises: [] }; });
  const result = await prepareChapterSetups({ input, plan, providers: { text: { generateJson } } as unknown as ProviderSet,
    strategy: { createChapterBriefs: generateWholeBookPageMap } as unknown as BookGenerationStrategy });
  expect(events).toEqual(["generate-chapter-brief", "integrity"]);
  expect(result.flatMap((setup) => setup.brief!.pages)).toHaveLength(30);
  expect(mocks.critic).not.toHaveBeenCalled();
});

it.each([
  { name: "five-page auto story", targetPages: 5, critic: false },
  { name: "twenty-page auto story", targetPages: 20, critic: false },
  { name: "forty-page auto story", targetPages: 40, critic: false },
  { name: "four-page story", targetPages: 4, critic: true },
  { name: "longer story", targetPages: 41, critic: true },
  { name: "other category", category: "STORY", critic: true },
  { name: "research request", prompt: "Teach scientific facts about real turtles.", critic: true },
  { name: "explicit strategy", mediaSettings: { generationStrategy: "draft-then-polish" }, critic: true },
  { name: "import", mediaSettings: { mobile: { import: { source: "manuscript" } } }, critic: true },
  { name: "final review disabled", mediaSettings: { finalReview: false }, critic: true },
  { name: "model prose review disabled", proseReview: false, critic: true },
  { name: "critic disabled", criticEnabled: false, proseReview: false, critic: false }
])("respects critic applicability for $name", async (scenario) => {
  const input = createProjectSchema.parse({ prompt: scenario.prompt ?? "Rabbit and Wise Turtle recover lanterns before moonrise.",
    category: scenario.category ?? "KIDS", targetPages: scenario.targetPages ?? 30,
    mediaSettings: { finalReview: true, ...scenario.mediaSettings } });
  const plan = { ...makeFallbackPlan(input), chapters: [{ index: 1, title: "The search", summary: "Rabbit and Turtle search together.", targetPages: input.targetPages, keyBeats: [] }] };
  const briefs = [{ chapterIndex: 1, title: "The search", summary: "Rabbit and Turtle search together.", continuityFocus: [],
    pages: Array.from({ length: input.targetPages }, (_, i) => ({ pageIndex: i + 1, chapterIndex: 1,
      purpose: `Search place ${i + 1}`, beat: `Rabbit checks the next clue ${i + 1}.`, requiredContinuity: [], endingPressure: "Continue to the next discovery." })) }];
  mocks.enabled.mockImplementation(feature => feature === "pageModelReview" ? scenario.proseReview !== false
    : feature === "pageMapCritic" ? scenario.criticEnabled !== false : true);
  mocks.integrity.mockImplementation(async ({ briefs }) => briefs);
  mocks.critic.mockResolvedValue({ beatPatches: [], duplicatePurposeWarnings: [], missingEndingPressure: [], unscheduledPromises: [] });
  const result = await prepareChapterSetups({ input, plan, providers: {} as ProviderSet,
    strategy: { createChapterBriefs: async () => briefs } as unknown as BookGenerationStrategy });
  expect(result.map(setup => setup.brief)).toEqual(briefs);
  expect(mocks.integrity).toHaveBeenCalledTimes(scenario.critic ? 2 : 1);
  expect(mocks.critic).toHaveBeenCalledTimes(scenario.critic ? 1 : 0);
});

it("still stops a compact story when mandatory map integrity fails", async () => {
  const input = createProjectSchema.parse({ prompt: "Rabbit and Wise Turtle recover lanterns before moonrise.", category: "KIDS", targetPages: 30,
    mediaSettings: { finalReview: true } });
  const failure = new Error("Unresolved production map integrity");
  mocks.integrity.mockRejectedValueOnce(failure);
  await expect(prepareChapterSetups({ input, plan: makeFallbackPlan(input), providers: {} as ProviderSet,
    strategy: { createChapterBriefs: async () => [] } as unknown as BookGenerationStrategy })).rejects.toBe(failure);
  expect(mocks.critic).not.toHaveBeenCalled();
});

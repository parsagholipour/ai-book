import { createProjectSchema, inputWithSelectedPageCount, resolveBookGenerationStrategy, shortKidsStoryPageLayout } from "@book-maker/core";
import type { BookPlan } from "@book-maker/core";
import { expect, it } from "vitest";
import { usesShortBookPath } from "./shortPictureBook.js";
const pages = Array.from({ length: 30 }, (_, i) => ({ index: i + 1, title: `Page ${i + 1}`, markdown: `Rabbit carries lantern ${i + 1} into the village.`, summary: "A lantern." }));
const input = { category: "KIDS", prompt: "Rabbit and Wise Turtle find lanterns.", targetPages: 30,
  mediaSettings: { finalReview: true, fullIllustrations: true, generationStrategy: "auto" } };
const plan = { title: "Lanterns", chapters: [] };
const eligible = () => ({ input, plan, pages, strategy: { shouldIllustratePage: () => true } }) as unknown as Parameters<typeof usesShortBookPath>[0];

it("bounds the new workflow to complete auto-selected short children's manuscripts", () => {
  expect(usesShortBookPath(eligible())).toBe(true);
  for (const mutation of [
    { input: { ...input, category: "FICTION" } }, { input: { ...input, targetPages: 80 } },
    { input: { ...input, mediaSettings: { ...input.mediaSettings, generationStrategy: "draft-then-polish" } } },
    { pages: pages.slice(1) },
    { strategy: { researchDepth: 12, shouldIllustratePage: () => true } },
    { input: { ...input, mediaSettings: { ...input.mediaSettings, mobile: { import: { source: "manuscript" } } } } }
  ]) expect(usesShortBookPath({ ...eligible(), ...mutation } as never)).toBe(false);
});

it("takes no research cue in a children's brief as evidence, and leaves a research strategy off the path", () => {
  // cmvc7ofzj002cpep62ug9u1zw (2026-10-17): the creation chat's "the real treasure" tripped `hasResearchIntent`,
  // and a 10-page otter story lost its early pictures and its draft-decided sheets.
  const treasure = { ...input, targetPages: 10, prompt: "Moss the otter learns the warmth of friendship is the real treasure." };
  expect(usesShortBookPath({ ...eligible(), input: treasure, pages: pages.slice(0, 10) } as never)).toBe(true);
  expect(usesShortBookPath({ ...eligible(), input: { ...input, prompt: "Teach scientific facts." } } as never)).toBe(true);
  // The router sends a factual picture book of 12+ pages to a research strategy, and that keeps its own workflow.
  const factual = createProjectSchema.parse({ ...input, title: "Volcanoes", prompt: "A picture book of scientific facts about volcanoes.",
    targetPages: 20, complexity: 3, temperature: 0.7, language: "en" });
  const routed = resolveBookGenerationStrategy(factual).strategy;
  expect(routed.researchDepth).toBeGreaterThan(0);
  expect(usesShortBookPath({ input: factual, plan: plan as unknown as BookPlan, strategy: routed, pages: pages.slice(0, 20) })).toBe(false);
});

it("is decided by the book's shape alone, on every tier and whatever the retired final-review flag says", () => {
  // 2026-10-16: no review hangs off this path any more (E4, H7b), so neither a tier nor `finalReview` moves a book off it.
  for (const modelTier of ["fast", "balanced", "premium", "ultra"] as const) for (const finalReview of [true, false, undefined]) {
    const shaped = { ...input, mediaSettings: { ...input.mediaSettings, modelTier, ...(finalReview === undefined ? {} : { finalReview }) } };
    expect(usesShortBookPath({ ...eligible(), input: shaped } as never)).toBe(true);
  }
});

const storyInput = { category: "STORY", prompt: "A waitress and a famous footballer, enemies to lovers. Theme: Real connection.", targetPages: 10,
  mediaSettings: { finalReview: true, fullIllustrations: true, generationStrategy: "auto" } };
const story = () => ({ input: storyInput, plan, pages: pages.slice(0, 10),
  strategy: { executionMode: "draft-then-polish", shouldIllustratePage: (_input: unknown, _plan: unknown, index: number) => index % 3 === 1 } }) as unknown as Parameters<typeof usesShortBookPath>[0];
it("puts a short illustrated story on the path, and keeps text-only, long, composed and nonfiction books off it", () => {
  // "Real" is a romance's theme, and the app's Auto brief says "Decide the real book shape": no research cue counts for a story.
  expect(usesShortBookPath(story())).toBe(true);
  expect(usesShortBookPath({ ...story(), input: { ...storyInput, category: "CUSTOM" } } as never)).toBe(true);
  expect(usesShortBookPath({ ...story(), input: { ...storyInput, mediaSettings: { ...storyInput.mediaSettings, finalReview: false, modelTier: "fast" } } } as never)).toBe(true);
  const seventeen = { input: { ...storyInput, targetPages: 17 }, pages: pages.slice(0, 17) };
  for (const mutation of [
    { strategy: { executionMode: "draft-then-polish", shouldIllustratePage: () => false } },
    { strategy: { executionMode: "composed-chapters", shouldIllustratePage: () => true } },
    { strategy: { executionMode: "draft-then-polish", researchDepth: 12, shouldIllustratePage: () => true } },
    seventeen,
    { input: { ...storyInput, category: "CUSTOM", prompt: "A step-by-step guide to opening a café." } },
    { plan: { ...plan, writingMode: "analytical-history" } },
    { input: { ...storyInput, mediaSettings: { ...storyInput.mediaSettings, generationStrategy: "draft-then-polish" } } },
    { input: { ...storyInput, mediaSettings: { ...storyInput.mediaSettings, mobile: { import: { source: "manuscript" } } } } }
  ]) expect(usesShortBookPath({ ...story(), ...mutation } as never)).toBe(false);
  expect(usesShortBookPath({ ...story(), ...seventeen, input: { ...seventeen.input, targetPages: 16 }, pages: pages.slice(0, 16) } as never)).toBe(true);
});

it("puts a children's story filed under STORY on the path, because a children-narrative plan is a narrative", () => {
  // cmv9ob8mz001r4vqgquuafbc1 (2026-10-15): a read-aloud book for ages 4–6 sent with the legacy
  // `bookTypeChoice: "short_story"` is filed STORY, and its planner wrote `writingMode:
  // "children-narrative"`, which the story branch's `=== "narrative"` refused — so Quick Draft
  // paid ten serial polish calls.
  const otter = createProjectSchema.parse({ title: "Moss and the River's Best Treasure", category: "STORY", subcategory: "Short Story",
    prompt: "Create a children's story.\nBook type choice: Children's story\nArtifact: Children's picture book\nAudience or reader: children ages 4-6, read aloud by a parent or carer",
    targetPages: 10, complexity: 4, temperature: 0.65, language: "en",
    mediaSettings: { modelTier: "fast", finalReview: false, toneProfile: "narrative", includeCover: true, coverTemplate: "fiction", coverArtSource: "ai",
      draftCandidates: 1, fullIllustrations: true, generationStrategy: "auto", illustrationCadence: "template-driven", parallelPageGeneration: true,
      generationPageCount: { selectedPages: 10, requestedPages: 10 },
      mobile: { bookType: "short_story", bookTypeChoice: "short_story", detectedLane: "children_story", qualityPreset: "fast", imagesEnabled: true } } });
  const otterPlan = { ...plan, title: "Moss and the River's Best Treasure", audience: "Children ages 4–6, for reading aloud with a parent or carer.",
    writingMode: "children-narrative", chapters: [1, 2, 3, 4, 5].map((index) => ({ index, title: `Part ${index}`, targetPages: 2 })) } as unknown as BookPlan;
  const strategy = resolveBookGenerationStrategy(otter).strategy;
  const manuscript = pages.slice(0, 10).map((page) => ({ ...page, markdown: `Moss the otter looks for her smooth stone by the river, page ${page.index}.` }));
  expect(strategy.executionMode).toBe("draft-then-polish");
  expect(manuscript.filter((page) => strategy.shouldIllustratePage(otter, otterPlan, page.index)).map((page) => page.index)).toEqual([1, 8]);
  expect(usesShortBookPath({ input: otter, plan: otterPlan, strategy, pages: manuscript })).toBe(true);
  // A story without pictures is not on it.
  expect(usesShortBookPath({ input: { ...otter, mediaSettings: { ...otter.mediaSettings, fullIllustrations: false } },
    plan: otterPlan, strategy, pages: manuscript })).toBe(false);
});

it("keeps all 44 pages of a forty-page request on the path and in separate story-page export", () => {
  const extended = inputWithSelectedPageCount({ ...eligible().input, targetPages: 40 }, 44);
  const manuscript = Array.from({ length: 44 }, (_, i) => ({ ...pages[i % pages.length]!, index: i + 1 }));
  expect(usesShortBookPath({ ...eligible(), input: extended, pages: manuscript })).toBe(true);
  expect(shortKidsStoryPageLayout(extended, manuscript)).toBe("separate");
});

it("bases the short-book path on the complete manuscript independently of illustration slots", () => {
  const options = eligible();
  options.input = { ...options.input, mediaSettings: { ...options.input.mediaSettings, fullIllustrations: false, coverArtSource: "none" } };
  options.strategy = { ...options.strategy, shouldIllustratePage: () => false };
  expect(usesShortBookPath(options)).toBe(true);
  for (const changed of [pages.slice(1), [...pages].reverse(), pages.map((page) => ({ ...page, markdown: " " })),
    pages.map((page) => ({ ...page, markdown: "x".repeat(1601) })),
    pages.map((page) => ({ ...page, markdown: "word ".repeat(201) }))]) {
    expect(usesShortBookPath({ ...options, pages: changed })).toBe(false);
  }
});

it("keeps all thirty text pages eligible when only ten pages have illustrations", () => {
  const baseline = eligible();
  const options: typeof baseline = { ...baseline, strategy: { ...baseline.strategy, shouldIllustratePage: (_input, _plan, index) => index % 3 === 0 } };
  expect(usesShortBookPath(options)).toBe(true);
  expect(usesShortBookPath({ ...options, pages: pages.filter((page) => page.index % 3 === 0) })).toBe(false);
  expect(usesShortBookPath({ ...options, pages: pages.map((page) => page.index === 2 ? { ...page, markdown: "" } : page) })).toBe(false);
});

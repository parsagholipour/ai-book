import { beforeEach, expect, it, vi } from "vitest";
import { bookPlanSchema, createProjectSchema, generateWholeBookPageMap, makeFallbackPlan, compactPictureBookPlanForBriefs,
  type BookGenerationStrategy, type GenerateJsonOptions, type ProviderSet } from "@book-maker/core";
const mocks = vi.hoisted(() => ({
  integrity: vi.fn(), planUpdate: vi.fn(), projectUpdate: vi.fn(), createPages: vi.fn(), transaction: vi.fn()
}));
vi.mock("@book-maker/db", () => ({ prisma: {
  planVersion: { update: mocks.planUpdate }, project: { update: mocks.projectUpdate },
  page: { createMany: mocks.createPages }, $transaction: mocks.transaction
}, Prisma: {} }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn(), updateJobProgress: vi.fn() }));
vi.mock("./qualitySettings.js", () => ({ applyPlanThinkingBoost: vi.fn(), loadQualityContext: async () => ({ enabled: () => false }) }));
vi.mock("./productionMapIntegrity.js", () => ({ enforceProductionMapIntegrity: mocks.integrity }));
import { prepareChapterSetups, effectiveWholeBookDraftContext, persistAcceptedWholeBookTarget,
  checkpointWholeBookDraftPages, directResumeStateForContext, rebuildChapterSetupsFromStored } from "./bookState.js";

const input = createProjectSchema.parse({ prompt: "Rabbit and Turtle find lanterns before moonrise.", category: "KIDS", targetPages: 30,
  mediaSettings: { finalReview: true } });
const plan = { ...makeFallbackPlan(input), chapters: Array.from({ length: 10 }, (_, i) => ({ index: i + 1,
  title: `Search ${i + 1}`, summary: `A search scene ${i + 1}.`, targetPages: 3, keyBeats: [] })) };
const ends = [2, 8, 19, 27, 30];
const pages = Array.from({ length: 30 }, (_, i) => ({ pageIndex: i + 1, purpose: `Discover a new clue ${i + 1}.`,
  beat: `Rabbit follows the next clue ${i + 1}.`, requiredContinuity: [], endingPressure: "They follow the discovery onward." }));
const draft = { pages: pages.map(page => ({ index: page.pageIndex, title: `Scene ${page.pageIndex}`,
  markdown: page.beat, summary: page.purpose, continuityNotes: [] })) };

beforeEach(() => { vi.clearAllMocks(); mocks.integrity.mockImplementation(async ({ briefs }) => briefs); });

it("uses the scene allocation for integrity, chapter rows, saved plan, page ownership and resume at the same 30-page target", async () => {
  const generateJson = vi.fn(async <T>(request: GenerateJsonOptions<T>) => ({ data: request.schema.parse({ pages,
    chapters: ends.map((endPage, i) => ({ endPage, title: `Scene phase ${i + 1}`, summary: `The next meaningful change ${i + 1}.` })) }) }));
  const setups = await prepareChapterSetups({ input, plan, providers: { text: { generateJson } } as unknown as ProviderSet,
    strategy: { createChapterBriefs: generateWholeBookPageMap } as unknown as BookGenerationStrategy });
  const briefs = setups.map(setup => setup.brief!);
  const mappedPlan = compactPictureBookPlanForBriefs(input, plan, briefs);
  const effective = effectiveWholeBookDraftContext(input, mappedPlan, draft, setups);
  expect(effective.chapterSetups.map(setup => setup.endPage)).toEqual(ends);
  expect(mocks.integrity.mock.calls[0]![0].chapterRanges.map((setup: { endPage: number }) => setup.endPage)).toEqual(ends);
  expect(mocks.integrity.mock.calls[0]![0].plan.chapters).toEqual(mappedPlan.chapters);
  expect(plan.chapters.map(chapter => chapter.targetPages)).toEqual(Array(10).fill(3));

  await persistAcceptedWholeBookTarget({ projectId: "book", planId: "plan", input, plan: effective.plan, draft, chapterAllocationChanged: true });
  const saved = bookPlanSchema.parse(mocks.planUpdate.mock.calls[0]![0].data.planningPackage);
  expect(saved.chapters.map(chapter => chapter.targetPages)).toEqual([2, 6, 11, 8, 3]);
  expect(mocks.projectUpdate).not.toHaveBeenCalled(); // total page count did not change
  const chapterIds = new Map(saved.chapters.map(chapter => [chapter.index, `chapter-${chapter.index}`]));
  await checkpointWholeBookDraftPages({ projectId: "book", chapterSetups: effective.chapterSetups, chapterIds, pages: draft.pages });
  expect(mocks.createPages.mock.calls[0]![0].data[2]).toMatchObject({ index: 3, chapterId: "chapter-2" });

  const chapters = saved.chapters.map((chapter, i) => ({ ...chapter, id: chapterIds.get(chapter.index)!, brief: briefs[i] }));
  const context = { chapters, pages: draft.pages.map(page => ({ ...page, status: page.index < 3 ? "COMPLETED" : "PENDING", imagePrompt: null })) };
  expect(directResumeStateForContext({ targetPages: 30, plan: saved, context, requiresBriefs: true, requireAllPagesPresent: true }))
    .toEqual({ kind: "resume", firstMissingPageIndex: 3 });
  expect(rebuildChapterSetupsFromStored(saved, 30, chapters).chapterSetups.map(setup => setup.endPage)).toEqual(ends);
  expect(generateJson).toHaveBeenCalledTimes(1);
});

it("does not write a saved plan for unchanged allocation and unchanged page count", async () => {
  await persistAcceptedWholeBookTarget({ projectId: "book", planId: "plan", input, plan, draft });
  expect(mocks.transaction).not.toHaveBeenCalled();
});

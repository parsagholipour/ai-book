import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedStoryStateFromPromises, createProjectSchema, makeFallbackPlan } from "@book-maker/core";
import type { ChapterSetup } from "../runtime/jobTypes.js";

const mocks = vi.hoisted(() => ({
  prisma: {
    project: { update: vi.fn() },
    planVersion: { update: vi.fn() },
    $transaction: vi.fn()
  },
  loadQualityContext: vi.fn(),
  dedupePageBeats: vi.fn(),
  updateJobProgress: vi.fn()
}));

vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  Prisma: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../runtime/jobLifecycle.js", () => ({
  advanceJobStep: vi.fn(),
  updateJobProgress: mocks.updateJobProgress
}));
vi.mock("./qualitySettings.js", () => ({
  loadQualityContext: mocks.loadQualityContext,
  applyPlanThinkingBoost: vi.fn()
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    // Detection (`findDuplicatePageBeats`) and the deterministic fallback
    // (`beatDedupPatch`) stay real; only the model rewrite call is mocked.
    dedupePageBeats: mocks.dedupePageBeats
  };
});

import { prepareChapterSetups, resetBookForDirectGeneration, effectiveWholeBookDraftContext, persistAcceptedWholeBookTarget } from "./bookState.js";

it("persists the chosen page count and original minimum while preserving the complete map", async () => {
  const input = createProjectSchema.parse({ prompt: "Rabbit follows the lantern path home.", category: "KIDS", targetPages: 30 });
  const base = makeFallbackPlan(input);
  const plan = { ...base, chapters: [{ ...base.chapters[0]!, index: 1, targetPages: 33 }] };
  const draft = { pages: Array.from({ length: 33 }, (_, i) => ({ index: i + 1, title: `Turn ${i + 1}`,
    markdown: `A new discovery ${i + 1}.`, summary: "A discovery.", continuityNotes: [] })) };
  const setups = [{ chapter: plan.chapters[0]!, startPage: 1, endPage: 33 }];
  const effective = effectiveWholeBookDraftContext(input, plan, draft, setups);
  expect(effective.plan).toBe(plan);
  expect(effective.chapterSetups).toBe(setups);
  expect(effective.input).toMatchObject({ targetPages: 33, mediaSettings: { generationPageCount: { requestedPages: 30, selectedPages: 33 } } });
  mocks.prisma.$transaction.mockResolvedValue([]);
  await persistAcceptedWholeBookTarget({ projectId: "p", planId: "plan", ...effective, draft, originalTargetPages: 30 });
  expect(mocks.prisma.project.update).toHaveBeenCalledWith({ where: { id: "p" }, data: { targetPages: 33 } });
  expect(mocks.prisma.planVersion.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
    inputSnapshot: expect.objectContaining({ targetPages: 33, mediaSettings: expect.objectContaining({ generationPageCount: { requestedPages: 30, selectedPages: 33 } }) })
  }) }));
  for (const count of [0, 29, 34]) expect(() => effectiveWholeBookDraftContext(input, plan,
    { pages: Array.from({ length: count }, () => draft.pages[0]!) })).toThrow();
});

it("persists the fixed selection when the draft uses exactly the original minimum", async () => {
  const input = createProjectSchema.parse({ prompt: "Rabbit follows the lantern path home.", category: "KIDS", targetPages: 30 });
  const draft = { pages: Array.from({ length: 30 }, (_, i) => ({ index: i + 1, title: `Turn ${i + 1}`,
    markdown: `A new discovery ${i + 1}.`, summary: "A discovery.", continuityNotes: [] })) };
  const effective = effectiveWholeBookDraftContext(input, makeFallbackPlan(input), draft);
  mocks.prisma.planVersion.update.mockClear();
  mocks.prisma.$transaction.mockResolvedValue([]);
  await persistAcceptedWholeBookTarget({ projectId: "p", planId: "plan", ...effective, draft });
  expect(mocks.prisma.planVersion.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
    inputSnapshot: expect.objectContaining({ mediaSettings: expect.objectContaining({ generationPageCount: { requestedPages: 30, selectedPages: 30 } }) })
  }) }));
});

const chapterSetups: ChapterSetup[] = [
  {
    chapter: { index: 1, title: "One", summary: "Opening.", targetPages: 2, keyBeats: [] },
    startPage: 1,
    endPage: 2
  }
];

describe("resetBookForDirectGeneration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("seeds storyState from the plan promises in the same wipe transaction", async () => {
    const tx = {
      imageAsset: { deleteMany: vi.fn() },
      page: { deleteMany: vi.fn() },
      chapter: { deleteMany: vi.fn(), create: vi.fn(async () => ({ id: "ch-1" })) },
      continuityNote: { deleteMany: vi.fn() },
      embedding: { deleteMany: vi.fn() },
      project: { update: vi.fn() }
    };
    mocks.prisma.$transaction.mockImplementation(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));

    await resetBookForDirectGeneration("project-1", chapterSetups, ["The lantern will be lit."]);

    expect(tx.page.deleteMany).toHaveBeenCalledWith({ where: { projectId: "project-1" } });
    expect(tx.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: {
        status: "GENERATING",
        storyState: seedStoryStateFromPromises(["The lantern will be lit."])
      }
    });
  });
});

/** A two-page map of a two-page book; integrity validates pages 1..2 in order. */
function twoPageBriefs() {
  return [
    {
      chapterIndex: 1,
      title: "One",
      summary: "Opening.",
      continuityFocus: [],
      pages: [
        { pageIndex: 1, chapterIndex: 1, purpose: "Open inside the July crisis",
          beat: "A telegram reaches Berlin while the fleet is already coaling.", requiredContinuity: [],
          endingPressure: "Carry a concrete consequence into the next page." },
        { pageIndex: 2, chapterIndex: 1, purpose: "Explain how the naval blockade strangled the German war economy",
          beat: "Show the distant patrols of the North Sea blockade cutting Germany's supply lines and starving its industry of imports.",
          requiredContinuity: [], endingPressure: "Carry a concrete consequence into the next page." }
      ]
    }
  ];
}

const mapPath = (briefs: unknown[]) => prepareChapterSetups({
  input: { targetPages: 2 } as never,
  plan: { chapters: [{ index: 1, title: "One", summary: "Opening.", targetPages: 2 }], promises: [] } as never,
  providers: { text: {} } as never,
  strategy: { createChapterBriefs: async () => briefs } as never
});

describe("prepareChapterSetups page map", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A stored revision may still list the removed critic; nothing reads it.
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "premium", enabled: () => true });
  });

  it("drafts from the map integrity hands back, with no critic call after it", async () => {
    const briefs = twoPageBriefs();
    const setups = await mapPath(briefs);
    expect(setups.map((setup) => setup.brief)).toEqual(briefs);
    expect(mocks.dedupePageBeats).not.toHaveBeenCalled();
  });
});

/**
 * When `prepareChapterSetups` reads the quality settings, which is when a gate
 * asks and not before.
 *
 * The read is one indexed `generationQualityRevision` row, so what these pin is
 * not a cost — it is where the cost sits. Taken at the top of the function it
 * belonged to the function; taken behind the gates it belongs to the gates, and
 * a shape that consults none of them (or dies before it does) pays nothing. The
 * other half is that the gates on one path share a snapshot: two reads could
 * straddle an operator saving the Quality tab, and one book's page map would
 * then be built to two different settings revisions.
 */
describe("prepareChapterSetups quality settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "premium",
      enabled: (feature: string) => feature === "planThinkingBoost"
    });
  });

  it("reads the settings once on the map path", async () => {
    await mapPath(twoPageBriefs());

    expect(mocks.loadQualityContext).toHaveBeenCalledTimes(1);
  });

  // The fan-out path's own gate is the last thing it does, and its chapter
  // briefs are a model call each. Hoisted, the read was made before all of
  // them — on a job that may never reach a gate at all.
  it("reads nothing for a fan-out that fails before any gate asks", async () => {
    const failed = new Error("chapter brief call failed");

    await expect(
      prepareChapterSetups({
        input: { targetPages: 2 } as never,
        plan: {
          chapters: [{ index: 1, title: "One", summary: "Opening.", targetPages: 2 }],
          promises: []
        } as never,
        providers: { text: { model: "test" } } as never,
        strategy: {
          generateChapterBrief: async () => {
            throw failed;
          }
        } as never
      })
    ).rejects.toBe(failed);

    expect(mocks.loadQualityContext).not.toHaveBeenCalled();
  });
});

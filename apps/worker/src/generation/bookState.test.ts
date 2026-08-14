import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedStoryStateFromPromises } from "@book-maker/core";
import { StopRequestedError } from "../runtime/jobTypes.js";
import type { ChapterSetup } from "../runtime/jobTypes.js";

const mocks = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn()
  },
  loadQualityContext: vi.fn(),
  critiquePageMap: vi.fn(),
  mergePageMapCriticPatch: vi.fn(),
  updateJobProgress: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: {}
}));
vi.mock("../runtime/jobLifecycle.js", () => ({
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
    critiquePageMap: mocks.critiquePageMap,
    mergePageMapCriticPatch: mocks.mergePageMapCriticPatch
  };
});

import { prepareChapterSetups, resetBookForDirectGeneration } from "./bookState.js";

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

describe("prepareChapterSetups page-map critic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "premium",
      enabled: (feature: string) => feature === "pageMapCritic"
    });
  });

  it("rethrows StopRequestedError from the page-map critic", async () => {
    const stop = new StopRequestedError();
    mocks.critiquePageMap.mockRejectedValue(stop);

    await expect(
      prepareChapterSetups({
        input: { targetPages: 2 } as never,
        plan: { chapters: [{ index: 1, title: "One", summary: "Opening.", targetPages: 2 }], promises: [] } as never,
        providers: { text: {} } as never,
        strategy: {
          createChapterBriefs: async () => [{ chapterIndex: 1, pages: [] }]
        } as never
      })
    ).rejects.toBe(stop);
  });
});

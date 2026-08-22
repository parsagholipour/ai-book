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

vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  Prisma: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
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

const openingHook = "Jack is already halfway over the chapel wall when the bell starts ringing for him.";

function emptyPatch() {
  return { beatPatches: [], duplicatePurposeWarnings: [], missingEndingPressure: [], unscheduledPromises: [] };
}

/**
 * A two-page map of the two-page book below. requireBriefForChapter validates
 * pages 1..2 in order *after* the merge, so whatever the merge mock returns has
 * to carry those indexes too.
 */
function criticBriefs() {
  return [
    {
      chapterIndex: 1,
      title: "One",
      summary: "Opening.",
      continuityFocus: [],
      pages: [
        { pageIndex: 1, chapterIndex: 1, purpose: "Open", beat: "Beat", requiredContinuity: [], endingPressure: "" },
        { pageIndex: 2, chapterIndex: 1, purpose: "Turn", beat: "Beat", requiredContinuity: [], endingPressure: "x" }
      ]
    }
  ];
}

/** Runs the critic path over that two-page book, answering with an empty patch. */
async function runCritic(options: {
  briefs: unknown[];
  plan: { openingHook?: string };
  input?: Record<string, unknown>;
}): Promise<ReturnType<typeof emptyPatch>> {
  const patch = emptyPatch();
  mocks.critiquePageMap.mockResolvedValue(patch);
  mocks.mergePageMapCriticPatch.mockReturnValue(options.briefs);
  await prepareChapterSetups({
    input: { targetPages: 2, ...options.input } as never,
    plan: {
      chapters: [{ index: 1, title: "One", summary: "Opening.", targetPages: 2 }],
      promises: [],
      ...options.plan
    } as never,
    providers: { text: {} } as never,
    strategy: { createChapterBriefs: async () => options.briefs } as never
  });
  return patch;
}

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

  // The critic gets the last word on every brief, page 1's included, so a patch
  // it writes without the hook silently drops the book's opening commitment.
  // The rule and the payload key are pinned in core's pageMapCritic.test.ts;
  // what only this seam can assert is that the plan reaches the critic at all.
  it("hands the page-map critic the plan the hook lives on", async () => {
    await runCritic({ briefs: criticBriefs(), plan: { openingHook } });

    expect(mocks.critiquePageMap).toHaveBeenCalledWith(
      expect.objectContaining({ plan: expect.objectContaining({ openingHook }) })
    );
  });

  // Page 1's contract is not this handler's to decide. It used to pass
  // `plan.openingHook` over as a bare string, which made this the one place the
  // imported-manuscript exemption had to be spelled a second time — and it was
  // not, so a replanned import briefed its page 1 to deliver a hook invented for
  // it by a revision that never read the page. The gate is in core beside the
  // rule it gates, and what this seam owes it is the book: the plan the hook is
  // on and the input the provenance is on, neither pre-decided here.
  it("hands over the book rather than deciding the hook here", async () => {
    const imported = {
      mediaSettings: { mobile: { import: { importId: "imp_1", fileName: "chapel.docx", format: "docx" } } }
    };

    await runCritic({ briefs: criticBriefs(), plan: { openingHook }, input: imported });

    const call = (mocks.critiquePageMap.mock.calls[0]?.[0] ?? {}) as Record<string, any>;
    expect(Object.keys(call)).not.toContain("openingHook");
    expect(call.input?.mediaSettings).toEqual(imported.mediaSettings);
    expect(call.plan?.openingHook).toBe(openingHook);
  });

  // The critic ranks page 1 against the book's last page and its substitution
  // writes the last page's ending pressure, so both halves need the book's own
  // length. A map that came back short is what requireBriefForChapter and the
  // brief repair loop exist for, which is exactly when the highest index in the
  // briefs is a middle page.
  it("takes the last page from the book's targetPages, not from the map it received", async () => {
    const briefs = criticBriefs();

    const patch = await runCritic({ briefs, plan: {} });

    // The critic reads it off the `input` it is handed; the merge takes the
    // number, because it states no rule and has no book.
    expect(mocks.critiquePageMap).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ targetPages: 2 }) })
    );
    expect(mocks.mergePageMapCriticPatch).toHaveBeenCalledWith(briefs, patch, 2);
  });
});

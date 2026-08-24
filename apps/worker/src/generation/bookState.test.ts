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
  dedupePageBeats: vi.fn(),
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
    mergePageMapCriticPatch: mocks.mergePageMapCriticPatch,
    // Detection (`findDuplicatePageBeats`) and the deterministic fallback
    // (`beatDedupPatch`) stay real; only the model rewrite call is mocked.
    dedupePageBeats: mocks.dedupePageBeats
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

const blockadeBeat = {
  purpose: "Explain how the naval blockade strangled the German war economy",
  beat: "Show the distant patrols of the North Sea blockade cutting Germany's supply lines and starving its industry of imports."
};

/** A two-page map whose pages collide — the real detector flags page 2. */
function collidingBriefs() {
  return [
    {
      chapterIndex: 1,
      title: "One",
      summary: "Opening.",
      continuityFocus: [],
      pages: [
        { pageIndex: 1, chapterIndex: 1, ...blockadeBeat, requiredContinuity: [], endingPressure: "x" },
        { pageIndex: 2, chapterIndex: 1, ...blockadeBeat, requiredContinuity: [], endingPressure: "y" }
      ]
    }
  ];
}

/**
 * A map the detector cannot fingerprint: `beatText` interpolates `purpose` into
 * a template string, so a page that reached this pass from a producer which
 * never went through `chapterBriefSchema` throws there — the same door the
 * merge's own guard exists for, one pass earlier. The page indexes stay valid,
 * because what is under test is this pass and not requireBriefForChapter.
 */
function unfingerprintableBriefs() {
  const briefs = collidingBriefs();
  Object.defineProperty(briefs[0]!.pages[0]!, "purpose", {
    get() {
      throw new TypeError("a brief page the detector cannot fingerprint");
    }
  });
  return briefs;
}

describe("prepareChapterSetups beat dedup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` clears calls and not implementations, and one case below
    // makes this write throw; without the reset that failure would outlive its
    // own test and reach the unguarded progress call every run of this pass
    // opens with.
    mocks.updateJobProgress.mockReset();
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "balanced",
      enabled: (feature: string) => feature === "beatDedup"
    });
    mocks.mergePageMapCriticPatch.mockImplementation((briefs: unknown[]) => briefs);
  });

  /**
   * A progress write that fails only on the line this pass announces its
   * rewrite with. `prepareChapterSetups` opens with a progress write of its
   * own ("Creating global page map"), which is not what these are about.
   */
  const rewriteProgressLineFails = (error: Error) => {
    mocks.updateJobProgress.mockImplementation(async (_generationJobId: unknown, update: { message?: string }) => {
      if (update.message?.startsWith("Rewriting")) {
        throw error;
      }
    });
  };

  const run = (briefs: unknown[]) =>
    prepareChapterSetups({
      input: { targetPages: 2 } as never,
      plan: { chapters: [{ index: 1, title: "One", summary: "Opening.", targetPages: 2 }], promises: ["A promise."] } as never,
      providers: { text: { model: "test" } } as never,
      strategy: { createChapterBriefs: async () => briefs } as never
    });

  /**
   * `console.warn` is the run log an operator reads a degraded pass out of, so
   * for the cases below the line itself is the assertion — which pass degraded
   * is the whole question when three of them run in a row.
   */
  const runWithWarnings = async (briefs: unknown[]) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const setups = await run(briefs);
      return { setups, warnings: warn.mock.calls.map((call) => String(call[0])) };
    } finally {
      warn.mockRestore();
    }
  };

  it("hands the detector's findings to the rewrite call and merges its patch", async () => {
    const briefs = collidingBriefs();
    const patch = { beatPatches: [], duplicatePurposeWarnings: [], missingEndingPressure: [], unscheduledPromises: [] };
    mocks.dedupePageBeats.mockResolvedValue(patch);

    await run(briefs);

    expect(mocks.dedupePageBeats).toHaveBeenCalledWith(
      expect.objectContaining({
        briefs,
        promises: ["A promise."],
        findings: [expect.objectContaining({ pageIndex: 2, duplicateOfPageIndex: 1 })]
      })
    );
    expect(mocks.mergePageMapCriticPatch).toHaveBeenCalledWith(briefs, patch, 2);
  });

  it("makes no rewrite call for a map with nothing to dedupe", async () => {
    await run(criticBriefs());

    expect(mocks.dedupePageBeats).not.toHaveBeenCalled();
    expect(mocks.mergePageMapCriticPatch).not.toHaveBeenCalled();
  });

  it("degrades a failed rewrite to the deterministic distinctness notes", async () => {
    const briefs = collidingBriefs();
    mocks.dedupePageBeats.mockRejectedValue(new Error("provider down"));

    await run(briefs);

    expect(mocks.mergePageMapCriticPatch).toHaveBeenCalledWith(
      briefs,
      expect.objectContaining({
        beatPatches: [
          expect.objectContaining({
            pageIndex: 2,
            requiredContinuity: [expect.stringMatching(/Stay distinct from page 1/)]
          })
        ]
      }),
      2
    );
  });

  // Both failures used to print that one line, because detection lived inside
  // the rewrite's guard: a detector that threw found nothing, so there were no
  // deterministic notes to keep, and the operator was told the fallback held
  // while the whole pass had produced nothing at all.
  it("names the detector, not the rewrite, when detection is what threw", async () => {
    const briefs = unfingerprintableBriefs();

    const { setups, warnings } = await runWithWarnings(briefs);

    expect(warnings).toEqual([expect.stringContaining("Page-beat dedup detection failed")]);
    expect(setups[0]?.brief).toBe(briefs[0]);
    expect(mocks.dedupePageBeats).not.toHaveBeenCalled();
    expect(mocks.mergePageMapCriticPatch).not.toHaveBeenCalled();
  });

  // And the other way round: a rewrite that threw still has the detector's
  // findings behind it, so it keeps the line that promises the notes and still
  // writes them — the wording of which "degrades a failed rewrite" pins.
  it("names the rewrite, and still writes the notes, when the rewrite is what threw", async () => {
    const briefs = collidingBriefs();
    mocks.dedupePageBeats.mockRejectedValue(new Error("provider down"));

    const { warnings } = await runWithWarnings(briefs);

    expect(warnings).toEqual([expect.stringContaining("Page-beat dedup rewrite skipped")]);
    expect(mocks.mergePageMapCriticPatch).toHaveBeenCalledWith(
      briefs,
      expect.objectContaining({ beatPatches: [expect.objectContaining({ pageIndex: 2 })] }),
      2
    );
  });

  it("rethrows a user stop instead of degrading", async () => {
    const stop = new StopRequestedError();
    mocks.dedupePageBeats.mockRejectedValue(stop);

    await expect(run(collidingBriefs())).rejects.toBe(stop);
  });

  // The progress line is the cheapest write in this pass and the rewrite is the
  // most expensive thing in it — and the first used to be the gate on the
  // second, because `updateJobProgress` opened the rewrite's `attempt`. A
  // `GenerationJob` row a retention sweep had retired (P2025), or any pool blip,
  // was caught by the rewrite's own guard, logged as "rewrite skipped" and
  // answered `undefined`, so the model call this pass had already decided to buy
  // was never made: the collisions shipped with the deterministic notes alone
  // and the drafter spent its whole per-page rewrite budget re-executing each
  // one, because a message could not be written.
  it("still buys the rewrite when the line announcing it cannot be written", async () => {
    const briefs = collidingBriefs();
    const patch = emptyPatch();
    rewriteProgressLineFails(new Error("no GenerationJob row left to write to"));
    mocks.dedupePageBeats.mockResolvedValue(patch);

    const { warnings } = await runWithWarnings(briefs);

    // The failure is reported as what it was — a message — and not as the
    // rewrite, which ran.
    expect(warnings).toEqual([expect.stringContaining("Page-beat dedup progress message skipped")]);
    expect(mocks.updateJobProgress).toHaveBeenCalledWith(undefined, {
      message: "Rewriting 1 near-duplicate page beat in the page map"
    });
    expect(mocks.dedupePageBeats).toHaveBeenCalledTimes(1);
    // The model's patch, not the deterministic stand-in the rewrite falls back
    // to when it is the rewrite that failed.
    expect(mocks.mergePageMapCriticPatch).toHaveBeenCalledWith(briefs, patch, 2);
  });

  // And the write it was moved out of is also this pass's stop check
  // (`assertJobNotStopped`), so guarding it separately may not swallow one: a
  // reader who ended the run must not be answered with a rewrite call.
  it("rethrows a user stop raised by that progress write", async () => {
    const stop = new StopRequestedError();
    rewriteProgressLineFails(stop);
    mocks.dedupePageBeats.mockResolvedValue(emptyPatch());

    await expect(run(collidingBriefs())).rejects.toBe(stop);
    expect(mocks.dedupePageBeats).not.toHaveBeenCalled();
  });

  const throwingMerge = () => {
    mocks.mergePageMapCriticPatch.mockImplementation(() => {
      throw new Error("a brief shape the merge cannot take");
    });
  };

  // The merge used to be the last statement of the try that guards this pass,
  // so a patch it could not take landed in the catch — whose answer was to
  // merge again with the deterministic patch. That threw the same way with
  // nothing behind it, and an advisory note failed the whole book.
  it("keeps the briefed page map when the merge of a successful rewrite throws", async () => {
    const briefs = collidingBriefs();
    mocks.dedupePageBeats.mockResolvedValue(emptyPatch());
    throwingMerge();

    const setups = await run(briefs);

    expect(setups.map((setup) => setup.brief)).toEqual(briefs);
    // Once: the failure of a merge must not be answered by another merge.
    expect(mocks.mergePageMapCriticPatch).toHaveBeenCalledTimes(1);
  });

  // The fallback merge has nothing behind it either, and this is the shape the
  // old code died on: the rewrite fails, and the merge of the deterministic
  // patch that stands in for it fails too.
  it("keeps the briefed page map when the rewrite fails and the fallback merge throws", async () => {
    const briefs = collidingBriefs();
    mocks.dedupePageBeats.mockRejectedValue(new Error("provider down"));
    throwingMerge();

    const setups = await run(briefs);

    expect(setups.map((setup) => setup.brief)).toEqual(briefs);
  });

  it("rethrows a user stop raised by the merge", async () => {
    const stop = new StopRequestedError();
    mocks.dedupePageBeats.mockResolvedValue(emptyPatch());
    mocks.mergePageMapCriticPatch.mockImplementation(() => {
      throw stop;
    });

    await expect(run(collidingBriefs())).rejects.toBe(stop);
  });

  it("dedupes the per-chapter fan-out path, where chapters are briefed blind to each other", async () => {
    const colliding = collidingBriefs()[0]!;
    const chapterOne = { ...colliding, pages: [colliding.pages[0]!] };
    const chapterTwo = {
      ...colliding,
      chapterIndex: 2,
      pages: [{ ...colliding.pages[1]!, chapterIndex: 2 }]
    };
    const patch = { beatPatches: [], duplicatePurposeWarnings: [], missingEndingPressure: [], unscheduledPromises: [] };
    mocks.dedupePageBeats.mockResolvedValue(patch);
    const deduped = [chapterOne, chapterTwo];
    mocks.mergePageMapCriticPatch.mockReturnValue(deduped);

    const setups = await prepareChapterSetups({
      input: { targetPages: 2 } as never,
      plan: {
        chapters: [
          { index: 1, title: "One", summary: "Opening.", targetPages: 1 },
          { index: 2, title: "Two", summary: "Middle.", targetPages: 1 }
        ],
        promises: []
      } as never,
      providers: { text: { model: "test" } } as never,
      strategy: {
        generateChapterBrief: async (options: { chapter: { index: number } }) =>
          options.chapter.index === 1 ? chapterOne : chapterTwo
      } as never
    });

    expect(mocks.dedupePageBeats).toHaveBeenCalledWith(
      expect.objectContaining({
        findings: [expect.objectContaining({ pageIndex: 2, duplicateOfPageIndex: 1 })]
      })
    );
    expect(setups.map((setup) => setup.brief)).toEqual(deduped);
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
      enabled: (feature: string) => feature === "pageMapCritic" || feature === "beatDedup"
    });
  });

  it("reads the settings once for the two gates that ask on one path", async () => {
    await runCritic({ briefs: criticBriefs(), plan: { openingHook } });

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

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FinalBookQa, PageQualityReport } from "@book-maker/core";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";

/**
 * How a brief repair travels from the flagged page that bought it to the other
 * flagged pages of its chapter — and the one condition on it.
 *
 * The final-QA repair pass parses one `Chapter.productionBrief` per chapter for
 * the whole pass and briefs each of that chapter's flagged pages from it, so
 * page 10's repaired beat is what page 14 is told page 10 covers. That carry is
 * the feature. But the loop's repair is decided a whole page of rewrites before
 * anyone knows whether the page keeps a draft written to it, and a rejected
 * rewrite leaves the page shipping its pre-repair prose — which is exactly why
 * the durable chapter write waits (`pageReviewRecovery.test.ts`). The in-memory
 * copy waits with it, on the same take: the loop answers with the merged brief
 * only for a page that kept a draft the repair briefed, and this map takes that
 * answer. It used to be the repair *mutating* the per-chapter parse the moment
 * the planner call returned, which is how the row and the pass's own memory of
 * the chapter came to disagree about what page 10 delivered.
 *
 * Its own file rather than `compileExportQuality.test.ts`'s: these drive two
 * flagged pages of one chapter through the whole loop and read what the *second*
 * one was briefed against, and that suite is at its size budget besides.
 */

vi.mock("@book-maker/db", async () => (await import("./testing/compileExportMocks.js")).dbModuleMock());
vi.mock("../runtime/config.js", async () => (await import("./testing/compileExportMocks.js")).configModuleMock());
vi.mock(
  "../generation/projectInput.js",
  async () => (await import("./testing/compileExportMocks.js")).projectInputModuleMock()
);
vi.mock(
  "../generation/exportPublication.js",
  async () => (await import("./testing/compileExportMocks.js")).exportPublicationModuleMock()
);
vi.mock("../runtime/dispatch.js", async () => (await import("./testing/compileExportMocks.js")).dispatchModuleMock());
vi.mock(
  "../runtime/jobLifecycle.js",
  async () => (await import("./testing/compileExportMocks.js")).jobLifecycleModuleMock()
);
vi.mock(
  "../providers/loggedAdapters.js",
  async () => (await import("./testing/compileExportMocks.js")).loggedAdaptersModuleMock()
);
vi.mock(
  "../generation/embeddingWrites.js",
  async () => (await import("./testing/compileExportMocks.js")).embeddingWritesModuleMock()
);
vi.mock(
  "../generation/entityState.js",
  async () => (await import("./testing/compileExportMocks.js")).entityStateModuleMock()
);
vi.mock("./characters.js", async () => (await import("./testing/compileExportMocks.js")).charactersModuleMock());
vi.mock(
  "../generation/bookHelpers.js",
  async () => (await import("./testing/compileExportMocks.js")).bookHelpersModuleMock()
);
vi.mock("../generation/finalQaPageTargets.js", async () => {
  const actual =
    await vi.importActual<typeof import("../generation/finalQaPageTargets.js")>(
      "../generation/finalQaPageTargets.js"
    );
  return (await import("./testing/compileExportMocks.js")).finalQaPageTargetsModuleMock(actual);
});
vi.mock(
  "../generation/storyStateStore.js",
  async () => (await import("./testing/compileExportMocks.js")).storyStateStoreModuleMock()
);
// The default, with the style auditor stubbed away: nothing here turns on the
// audit, and an auditor that never runs keeps the keeper comparison a plain
// score comparison — which is what decides whether the repair was kept.
vi.mock(
  "../generation/qualityEnrichment.js",
  async () => (await import("./testing/compileExportMocks.js")).qualityEnrichmentModuleMock()
);
vi.mock(
  "../generation/qualitySettings.js",
  async () => (await import("./testing/compileExportMocks.js")).qualitySettingsModuleMock()
);
// The loop is the real one, and so is `repairPageBriefForRecovery` behind it:
// what this suite measures is where their in-memory repair ends up.
vi.mock("../generation/pageReview.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/pageReview.js")>("../generation/pageReview.js");
  return (await import("./testing/compileExportMocks.js")).pageReviewModuleMock(actual);
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return (await import("./testing/compileExportMocks.js")).coreModuleMock(actual);
});

import { repairPagesFromFinalQa } from "./compileExportRepair.js";
import { isDefaultCompileQualityFeature, mocks } from "./testing/compileExportMocks.js";

/** A brief as this suite reads it back off a rewrite's options. */
type ReadableChapterBrief = { pages: Array<{ pageIndex: number; beat: string }>; from?: unknown };

const report = (score: number, overrides: Record<string, unknown> = {}): PageQualityReport =>
  ({
    approved: false,
    score,
    issues: [],
    requiredRevisions: [],
    notes: "",
    checks: { repetitionOk: true, progressionOk: true },
    ...overrides
  }) as unknown as PageQualityReport;

/** The verdict that puts a page into brief repair at its recovery attempt. */
const blamesTheBrief = (score: number) => report(score, { checks: { repetitionOk: false, progressionOk: true } });

const draftNamed = (name: string) => ({
  title: name,
  markdown: `${name} text.`,
  summary: `${name} summary.`,
  imagePrompt: null,
  continuityNotes: [] as string[]
});

const beat = (pageIndex: number, text: string) => ({
  pageIndex,
  chapterIndex: 1,
  purpose: text,
  beat: text,
  requiredContinuity: [] as string[],
  endingPressure: ""
});

const storedChapterBrief = () => ({
  chapterIndex: 1,
  title: "The vault",
  summary: "The crew reaches the vault.",
  continuityFocus: [] as string[],
  pages: [beat(1, "Reach the vault"), beat(2, "Repeat the approach")]
});

const finalQa = (repairPageIndexes: number[]): FinalBookQa =>
  ({ approved: false, issues: [], repairPageIndexes }) as unknown as FinalBookQa;

function exportPage(index: number, chapterId: string | null): ExportPageForRepair {
  return {
    id: `page-${index}`,
    index,
    title: `Page ${index}`,
    markdown: `Page ${index} prose.`,
    summary: `Page ${index} summary.`,
    imagePrompt: null,
    status: "COMPLETED",
    chapter: chapterId ? { id: chapterId, index: 1, productionBrief: { chapter: chapterId } } : null
  } as unknown as ExportPageForRepair;
}

describe("a brief repair between the flagged pages of one chapter", () => {
  // Whole-book, so no page here spends an embedding call: only the brief the
  // next page is handed is under test.
  const strategy = {
    executionMode: "whole-book",
    reviewPageDraft: vi.fn(),
    revisePageDraft: vi.fn(),
    repairPageBrief: vi.fn()
  };

  const baseOptions = (overrides: Record<string, unknown> = {}) =>
    ({
      projectId: "project-1",
      input: { targetPages: 2, mediaSettings: {} },
      plan: { title: "Book", chapters: [] },
      providers: { text: {}, embedding: {} },
      strategy,
      quality: { enabled: isDefaultCompileQualityFeature },
      finalQa: finalQa([1, 2]),
      generationJobId: "gj-1",
      ...overrides
    }) as never;

  /**
   * Stages the export set and the page writes over it, so an approved page 1
   * does not hand its slot page 2's identity partway through the pass.
   */
  const stagePages = (pages: ExportPageForRepair[]): ExportPageForRepair[] => {
    mocks.prisma.page.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: object }) => ({
      ...pages.find((page) => page.id === where.id),
      ...data
    }));
    return pages;
  };

  /** One queue of verdicts per page, the last of them repeating. */
  const reviewsByPage = (verdicts: Record<number, PageQualityReport[]>) => {
    const taken = new Map<number, number>();
    strategy.reviewPageDraft.mockImplementation(async ({ pageIndex }: { pageIndex: number }) => {
      const queue = verdicts[pageIndex] ?? [report(85, { approved: true })];
      const at = taken.get(pageIndex) ?? 0;
      taken.set(pageIndex, at + 1);
      return queue[Math.min(at, queue.length - 1)];
    });
  };

  /** The chapter brief a page's own first rewrite was handed. */
  const chapterBriefHandedTo = (pageIndex: number): ReadableChapterBrief =>
    mocks.revisePageDraftWithRestart.mock.calls
      .map((call) => call[0] as { reviseOptions: { pageIndex: number; chapterBrief: ReadableChapterBrief } })
      .find((call) => call.reviseOptions.pageIndex === pageIndex)!.reviseOptions.chapterBrief;

  const beatFor = (brief: ReadableChapterBrief | undefined, pageIndex: number): string | undefined =>
    brief?.pages.find((page) => page.pageIndex === pageIndex)?.beat;

  /** Every review of one page, in order: the seed's, then each rewrite's. */
  const reviewsOf = (pageIndex: number) =>
    strategy.reviewPageDraft.mock.calls
      .map((call) => call[0] as { pageIndex: number; chapterBrief: ReadableChapterBrief })
      .filter((call) => call.pageIndex === pageIndex);

  /** Every loop rewrite of one page, in order: attempt 2, attempt 3, … */
  const loopRewritesOf = (pageIndex: number) =>
    strategy.revisePageDraft.mock.calls
      .map((call) => call[0] as { pageIndex: number; chapterBrief: ReadableChapterBrief; pageBrief: { beat: string } })
      .filter((call) => call.pageIndex === pageIndex);

  /** What the compare-and-swap wrote, if it ran. */
  const chapterWrite = () =>
    mocks.prisma.chapter.updateMany.mock.calls[0]?.[0] as
      | { data: { productionBrief: ReadableChapterBrief } }
      | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.continuityNote.findMany.mockResolvedValue([]);
    mocks.keeperStoryExtractForSave.mockResolvedValue(null);
    mocks.pageReportFromFinalQa.mockReturnValue(report(30));
    // A fresh brief per parse, stamped with the row it came from, so "one parse
    // per chapter" and "each page got its own copy" are separable.
    mocks.parseChapterBrief.mockImplementation((productionBrief: unknown) => ({
      ...storedChapterBrief(),
      from: productionBrief
    }));
    mocks.loadPagesForExport.mockResolvedValue([]);
    mocks.revisePageDraftWithRestart.mockResolvedValue(draftNamed("Rewrite"));
    strategy.revisePageDraft.mockResolvedValue(draftNamed("Rewrite"));
    strategy.repairPageBrief.mockImplementation(async ({ pageIndex }: { pageIndex: number }) =>
      beat(pageIndex, `Fresh beat for page ${pageIndex}`)
    );
    mocks.prisma.chapter.findUnique.mockResolvedValue({ productionBrief: storedChapterBrief() });
    mocks.prisma.chapter.updateMany.mockResolvedValue({ count: 1 });
  });

  it("parses one brief per chapter for the whole pass, and hands it to every page of that chapter", async () => {
    // The parse is what a repair has to reach past the page that bought it:
    // re-parsing `page.chapter.productionBrief` per page handed every later page
    // the pre-loop snapshot, told to stay clear of an assignment the earlier
    // page no longer had and free to re-collide with the fresh one. The pages of
    // one chapter are handed that parse itself — the per-page defensive copy
    // this pass used to make went away with the mutation it was defending
    // against — and a page of another chapter is handed its own.
    const pages = stagePages([exportPage(1, "chapter-a"), exportPage(2, "chapter-a"), exportPage(3, "chapter-b")]);
    reviewsByPage({});

    await repairPagesFromFinalQa(baseOptions({ pages, finalQa: finalQa([1, 2, 3]) }));

    expect(mocks.parseChapterBrief).toHaveBeenCalledTimes(2);
    expect(chapterBriefHandedTo(2)).toBe(chapterBriefHandedTo(1));
    expect(chapterBriefHandedTo(3).from).not.toEqual(chapterBriefHandedTo(1).from);
  });

  it("leaves the chapter's shared brief exactly as parsed when a page repairs and is rejected", async () => {
    // The mutation check, on the object the pass actually shares. Page 1 buys a
    // repair on its last attempt and keeps a draft from before it, so nothing
    // about the chapter may have moved — including through the brief page 1's
    // own rewrites were briefed off, which is a *different* object for exactly
    // this reason.
    const pages = stagePages([exportPage(1, "chapter-a"), exportPage(2, "chapter-a")]);
    reviewsByPage({ 1: [blamesTheBrief(70), blamesTheBrief(40), report(40)] });

    await repairPagesFromFinalQa(baseOptions({ pages, assertOwnership: async () => {} }));

    expect(strategy.repairPageBrief).toHaveBeenCalledTimes(1);
    expect(chapterBriefHandedTo(1).pages).toEqual(storedChapterBrief().pages);
    expect(chapterBriefHandedTo(2)).toBe(chapterBriefHandedTo(1));
  });

  it("does not publish the repaired brief ahead of the page when ownership is lost after the loop", async () => {
    // The repair and its stand-down finish under this compile. Ownership moves
    // during the provider work after the loop, before the page publication
    // fence. The old loop had already committed Chapter.productionBrief in
    // this window, while the page write correctly stood down.
    const pages = stagePages([exportPage(1, "chapter-a")]);
    reviewsByPage({ 1: [blamesTheBrief(40), blamesTheBrief(40), report(85, { approved: true })] });
    const superseded = new Error("superseded");
    let lost = false;
    mocks.keeperStoryExtractForSave.mockImplementationOnce(async () => {
      lost = true;
      return null;
    });

    await expect(
      repairPagesFromFinalQa(
        baseOptions({
          pages,
          finalQa: finalQa([1]),
          assertOwnership: async () => {
            if (lost) throw superseded;
          }
        })
      )
    ).rejects.toBe(superseded);

    expect(strategy.repairPageBrief).toHaveBeenCalledTimes(1);
    // The binding ownership assertion is deliberately inside the publication
    // transaction now. It rejects on the first statement, before either staged
    // write, so the transaction exists but has nothing to commit.
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(mocks.prisma.chapter.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.chapter.updateMany).not.toHaveBeenCalled();
  });

  /**
   * Balanced: `finalQaRevisionsFor` is 3 and recovery is clamped onto the third
   * rewrite, so page 1 repairs its brief on the loop's **last** attempt and
   * exactly one candidate is ever briefed against the repair. Whether that
   * candidate is the one the page keeps is the whole difference between these
   * two.
   */
  describe("page 1's repair, page 2's briefing", () => {
    it("leaves page 2 briefed against the beat that shipped when page 1's rewrite is rejected", async () => {
      // The finding. Committed to the pass's per-chapter parse at the repair,
      // page 1 shipped its pre-repair prose as FAILED_QA while page 2 was
      // drafted and reviewed against a chapter claiming page 1 covers a beat
      // page 1 never delivered — and saying nothing about the beat it did.
      const pages = stagePages([exportPage(1, "chapter-a"), exportPage(2, "chapter-a")]);
      // The seed scores highest, so the keeper is the draft from *before* the
      // repair — `best.revision` 1 against a repair from rewrite 3.
      reviewsByPage({ 1: [blamesTheBrief(70), blamesTheBrief(40), report(40)] });

      await repairPagesFromFinalQa(baseOptions({ pages, assertOwnership: async () => {} }));

      expect(strategy.repairPageBrief).toHaveBeenCalledTimes(1);
      // Page 1's own remaining rewrite still read the repair: that is what the
      // planner call was bought for, and it is page-local.
      expect(loopRewritesOf(1).at(-1)?.pageBrief.beat).toBe("Fresh beat for page 1");
      expect(beatFor(loopRewritesOf(1).at(-1)?.chapterBrief, 1)).toBe("Fresh beat for page 1");
      // Page 2 is not, because page 1 kept nothing written to it.
      expect(beatFor(chapterBriefHandedTo(2), 1)).toBe("Reach the vault");
      expect(beatFor(reviewsOf(2)[0]?.chapterBrief, 1)).toBe("Reach the vault");
      // And the row the pass's memory has to agree with was left alone.
      expect(mocks.prisma.chapter.updateMany).not.toHaveBeenCalled();
    });

    it("briefs page 2 against the repair once page 1 keeps the rewrite it briefed", async () => {
      // The feature, and the reason the carry exists at all: page 1 shipped
      // prose written to the fresh beat, so page 2 is told that is what page 1
      // covers. Acceptance is the gate, not the repair.
      const pages = stagePages([exportPage(1, "chapter-a"), exportPage(2, "chapter-a")]);
      reviewsByPage({ 1: [blamesTheBrief(40), blamesTheBrief(40), report(85, { approved: true })] });

      await repairPagesFromFinalQa(baseOptions({ pages, assertOwnership: async () => {} }));

      expect(beatFor(chapterBriefHandedTo(2), 1)).toBe("Fresh beat for page 1");
      expect(beatFor(reviewsOf(2)[0]?.chapterBrief, 1)).toBe("Fresh beat for page 1");
      // Page 2's own beat is untouched by page 1's repair, so it is still
      // briefed to write its own assignment.
      expect(beatFor(chapterBriefHandedTo(2), 2)).toBe("Repeat the approach");
      // The durable row moved on exactly the same condition, which is the
      // property: the pass's memory of the chapter and `Chapter.productionBrief`
      // cannot disagree about whether a repair was earned.
      expect(beatFor(chapterWrite()?.data.productionBrief, 1)).toBe("Fresh beat for page 1");
    });

    it("rolls page 1 back and never carries its repair when every chapter CAS loses", async () => {
      const pages = stagePages([exportPage(1, "chapter-a"), exportPage(2, "chapter-a")]);
      reviewsByPage({ 1: [blamesTheBrief(40), blamesTheBrief(40), report(85, { approved: true })] });
      const movingBrief = (label: string) => ({ ...storedChapterBrief(), continuityFocus: [label] });
      mocks.prisma.chapter.findUnique
        .mockResolvedValueOnce({ productionBrief: movingBrief("Sibling A") })
        .mockResolvedValueOnce({ productionBrief: movingBrief("Sibling B") })
        .mockResolvedValueOnce({ productionBrief: movingBrief("Sibling C") });
      mocks.prisma.chapter.updateMany.mockResolvedValue({ count: 0 });
      let stagedPage: ExportPageForRepair | null = null;
      let durablePage = pages[0]!;
      const tx = {
        page: {
          update: vi.fn(async ({ data }: { data: object }) => {
            stagedPage = { ...pages[0]!, ...data } as ExportPageForRepair;
            return stagedPage;
          })
        },
        chapter: mocks.prisma.chapter,
        imageAsset: mocks.prisma.imageAsset,
        generationJob: mocks.prisma.generationJob
      };
      mocks.prisma.$transaction.mockImplementationOnce(
        async (run: (client: typeof tx) => Promise<unknown>) => {
          const result = await run(tx);
          durablePage = stagedPage!;
          return result;
        }
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      await expect(
        repairPagesFromFinalQa(baseOptions({ pages, assertOwnership: async () => {} }))
      ).rejects.toMatchObject({
        name: "ChapterBriefPublicationRejectedError",
        chapterId: "chapter-a",
        outcome: "lost-race"
      });
      warn.mockRestore();

      expect(tx.page.update).toHaveBeenCalledTimes(1);
      expect(mocks.prisma.chapter.updateMany).toHaveBeenCalledTimes(3);
      expect(durablePage).toBe(pages[0]);
      expect(mocks.prisma.page.update).not.toHaveBeenCalled();
      // Page 2 never starts, so the rejected merge cannot become its briefing.
      expect(mocks.revisePageDraftWithRestart).toHaveBeenCalledTimes(1);
      expect(reviewsOf(2)).toEqual([]);
    });

    it("carries an accepted repair even where the compile is allowed no durable write", async () => {
      // No fence, so this pass passes no `chapterId` and the repair reaches no
      // row — and the per-chapter parse is then the only carrier there is. A
      // compile that cannot honestly claim the book still owes the chapter's
      // later flagged pages the beat it just paid a planner call for.
      const pages = stagePages([exportPage(1, "chapter-a"), exportPage(2, "chapter-a")]);
      reviewsByPage({ 1: [blamesTheBrief(40), blamesTheBrief(40), report(85, { approved: true })] });

      await repairPagesFromFinalQa(baseOptions({ pages }));

      expect(beatFor(chapterBriefHandedTo(2), 1)).toBe("Fresh beat for page 1");
      expect(mocks.prisma.chapter.updateMany).not.toHaveBeenCalled();
    });
  });
});

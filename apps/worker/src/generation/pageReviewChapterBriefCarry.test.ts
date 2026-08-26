import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageQualityReport } from "@book-maker/core";
import type { ChapterSetup } from "../runtime/jobTypes.js";
import { balancedPageQaQualityContext } from "../testing/qualityGateFixtures.js";
import { GeneratedPagePublicationClaimLostError } from "./pagePublication.js";

/**
 * How a brief repair travels between the pages of one chapter on the
 * *drafting* side — and the one condition on it.
 *
 * The book passes hand a single `ChapterSetup.brief` to every page of a
 * chapter, so page 1's assignment is what page 2 is told page 1 covers. A page
 * that reaches quality recovery buys a re-planned beat, and the chapter's later
 * pages have to hear about it — but only once that page has kept a draft the
 * beat briefed, because a rejected rewrite leaves it shipping its pre-repair
 * prose. That is the same condition `Chapter.productionBrief` waits for, and
 * the row and the pass's memory of the chapter may not disagree about it.
 *
 * The repair used to reach that shared brief by `Object.assign`, at the moment
 * the planner call returned and with nothing yet decided: the compile's repair
 * pass fixed that for itself with a per-page copy
 * (`handlers/compileExportBriefCarry.test.ts`), and these three passes were
 * left with the defect. The seam answers it now, so this suite drives a real
 * book pass through the real loop and the real repair, and reads what the
 * chapter's *second* page was briefed against.
 */

const mocks = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    project: { update: vi.fn() },
    researchSource: { findMany: vi.fn() },
    page: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    continuityNote: { createMany: vi.fn() },
    chapter: { findUnique: vi.fn(), updateMany: vi.fn() }
  },
  prepareChapterSetups: vi.fn(),
  resetBookForDirectGeneration: vi.fn(),
  loadDirectResumeContext: vi.fn(),
  directResumeStateForContext: vi.fn()
}));

vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  Prisma: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../runtime/dispatch.js", () => ({
  enqueueWorkerJob: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  maybeEnqueueCover: vi.fn()
}));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn(), updateJobProgress: vi.fn() }));
vi.mock("./bookState.js", () => ({
  checkpointWholeBookDraftPages: vi.fn(),
  directResumeStateForContext: mocks.directResumeStateForContext,
  effectiveWholeBookDraftContext: vi.fn(),
  loadDirectResumeContext: mocks.loadDirectResumeContext,
  persistAcceptedWholeBookTarget: vi.fn(),
  prepareChapterSetups: mocks.prepareChapterSetups,
  priorPageContextsFromStored: vi.fn(() => []),
  rebuildChapterSetupsFromStored: vi.fn(),
  reportAcceptedWholeBookDraft: vi.fn(),
  resetBookForDirectGeneration: mocks.resetBookForDirectGeneration
}));
vi.mock("./characterReferences.js", () => ({ ensureCharacterReferenceAssets: vi.fn() }));
vi.mock("./bookHelpers.js", () => ({
  chapterSetupsForPlan: vi.fn(),
  reviewWholeBookDraftPages: vi.fn(),
  styleExcerptsForPage: async () => [],
  formatQualityFailure: () => "quality failure detail",
  // The brief repair's compare-and-swap reads the row back through this.
  parseChapterBrief: (value: unknown) => value ?? undefined
}));
vi.mock("./wholeBookPageReview.js", () => ({ reviewWholeBookDraftPages: vi.fn() }));
vi.mock("./generationContext.js", async () => {
  const actual = await vi.importActual<typeof import("./generationContext.js")>("./generationContext.js");
  return {
    chapterSetupForPage: actual.chapterSetupForPage,
    loadContinuityNotes: async () => [],
    loadResearchNotesForGeneration: async () => []
  };
});
vi.mock("./qualityEnrichment.js", () => ({
  persistKeeperStoryDelta: vi.fn(),
  // The seed report straight through: what the reviewer said is what the loop
  // starts from, so the verdict queues below are the whole of the fixture.
  enrichPageQualityReport: async ({ report }: { report: PageQualityReport }) => ({
    report,
    extract: null,
    storyState: { promises: [], facts: [], entities: {}, unanswered: [] }
  }),
  keeperStoryExtractForSave: async () => null,
  persistStoryExtract: vi.fn(),
  // No style auditor, which keeps the keeper comparison a plain score
  // comparison — and that comparison is what decides whether the repair is kept.
  revisedDraftStyleAuditor: () => undefined
}));
vi.mock("./qualitySettings.js", () => ({
  loadQualityContext: async () => balancedPageQaQualityContext(),
  applyPlanThinkingBoost: vi.fn()
}));
vi.mock("./embeddingWrites.js", () => ({
  storeEmbedding: vi.fn(),
  prepareEmbedding: vi.fn(),
  writePreparedEmbedding: vi.fn(),
  // Whole-book: no page here spends an embedding call.
  strategyUsesSemanticMemory: () => false
}));
vi.mock("./entityState.js", () => ({ updateEntityStateFromPage: vi.fn() }));
vi.mock("./researchMemory.js", () => ({ retrieveSemanticResearchNotes: async () => [] }));

import { generateBookChapterWholePass } from "./bookPasses.js";

/** A brief as this suite reads it back off a review's options. */
type ReadableChapterBrief = { pages: Array<{ pageIndex: number; beat: string }> };

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

/** The verdict that puts a page into brief repair at its recovery candidate. */
const blamesTheBrief = (score: number) => report(score, { checks: { repetitionOk: false, progressionOk: true } });

const draftNamed = (name: string, index: number) => ({
  index,
  title: name,
  markdown: `${name} text.`,
  summary: `${name} summary.`,
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

const chapterBriefFixture = () => ({
  chapterIndex: 1,
  title: "The vault",
  summary: "The crew reaches the vault.",
  continuityFocus: [] as string[],
  pages: [beat(1, "Reach the vault"), beat(2, "Repeat the approach")]
});

const chapterSetup = (): ChapterSetup =>
  ({
    chapter: { index: 1, title: "Chapter 1", summary: "The vault", targetPages: 2, keyBeats: [] },
    startPage: 1,
    endPage: 2,
    brief: chapterBriefFixture()
  }) as unknown as ChapterSetup;

describe("a brief repair between the pages of one chapter, drafted through a book pass", () => {
  // Balanced: four candidates per page, with recovery clamped onto the fourth,
  // so page 1 repairs its brief on the loop's **last** attempt and exactly one
  // candidate is ever briefed against the repair. Whether that candidate is the
  // one the page keeps is the whole difference between these two.
  const strategy = {
    id: "test-strategy",
    executionMode: "whole-book",
    shouldIllustratePage: () => false,
    generateChapterDraft: vi.fn(),
    reviewPageDraft: vi.fn(),
    revisePageDraft: vi.fn(),
    repairPageBrief: vi.fn()
  };

  const baseOptions = () =>
    ({
      projectId: "project-1",
      planId: "plan-1",
      input: { targetPages: 2, mediaSettings: {} },
      plan: { title: "Book", chapters: [], promises: [] },
      providers: { text: {}, embedding: {} },
      strategy,
      generationJobId: "gj-1"
    }) as never;

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

  /** Every review of one page, in order: the seed's, then each rewrite's. */
  const reviewsOf = (pageIndex: number) =>
    strategy.reviewPageDraft.mock.calls
      .map((call) => call[0] as { pageIndex: number; chapterBrief: ReadableChapterBrief })
      .filter((call) => call.pageIndex === pageIndex);

  /** Every rewrite of one page, in order: candidate 2, candidate 3, … */
  const rewritesOf = (pageIndex: number) =>
    strategy.revisePageDraft.mock.calls
      .map((call) => call[0] as { pageIndex: number; chapterBrief: ReadableChapterBrief; pageBrief: { beat: string } })
      .filter((call) => call.pageIndex === pageIndex);

  const beatFor = (brief: ReadableChapterBrief | undefined, pageIndex: number): string | undefined =>
    brief?.pages.find((page) => page.pageIndex === pageIndex)?.beat;

  /** What the compare-and-swap wrote, if it ran. */
  const chapterWrite = () =>
    mocks.prisma.chapter.updateMany.mock.calls[0]?.[0] as
      | { where: { id: string }; data: { productionBrief: ReadableChapterBrief } }
      | undefined;

  /**
   * The one setup the pass briefs both pages from, and the brief object it
   * starts out holding — kept apart so "nothing mutated it" and "the pass moved
   * on from it" are separate questions.
   */
  let setup: ChapterSetup;
  let sharedBrief: ChapterSetup["brief"];

  beforeEach(() => {
    vi.clearAllMocks();
    setup = chapterSetup();
    sharedBrief = setup.brief;
    mocks.loadDirectResumeContext.mockResolvedValue({ chapters: [], pages: [] });
    mocks.directResumeStateForContext.mockReturnValue({ kind: "fresh" });
    mocks.prepareChapterSetups.mockResolvedValue([setup]);
    mocks.resetBookForDirectGeneration.mockResolvedValue(new Map([[1, "ch-1"]]));
    mocks.prisma.researchSource.findMany.mockResolvedValue([]);
    mocks.prisma.$transaction.mockImplementation(
      async (run: (tx: typeof mocks.prisma) => Promise<unknown>) => run(mocks.prisma)
    );
    mocks.prisma.page.findUnique.mockResolvedValue(null);
    mocks.prisma.page.create.mockImplementation(async ({ data }: { data: { index: number } }) => ({
      id: `page-row-${data.index}`,
      revision: 1
    }));
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.chapter.findUnique.mockResolvedValue({ productionBrief: chapterBriefFixture() });
    mocks.prisma.chapter.updateMany.mockResolvedValue({ count: 1 });
    strategy.generateChapterDraft.mockResolvedValue({
      pages: [draftNamed("Page one", 1), draftNamed("Page two", 2)]
    });
    strategy.revisePageDraft.mockImplementation(async ({ pageIndex }: { pageIndex: number }) =>
      draftNamed("Rewrite", pageIndex)
    );
    strategy.repairPageBrief.mockImplementation(async ({ pageIndex }: { pageIndex: number }) =>
      beat(pageIndex, `Fresh beat for page ${pageIndex}`)
    );
  });

  it("leaves page 2 briefed against the beat that shipped when page 1's rewrite is rejected", async () => {
    // The finding on the drafting side. Written through the shared brief at the
    // repair, page 1 shipped its pre-repair prose as FAILED_QA while page 2 was
    // drafted and reviewed against a chapter claiming page 1 covers a beat page
    // 1 never delivered — and against a brief the chapter row disagreed with,
    // since the durable write was correctly declined.
    //
    // The seed scores highest, so the keeper is the draft from *before* the
    // repair: `best.revision` 1 against a repair from candidate 4.
    reviewsByPage({ 1: [blamesTheBrief(70), blamesTheBrief(40), blamesTheBrief(40), report(40)] });

    await generateBookChapterWholePass(baseOptions());

    expect(strategy.repairPageBrief).toHaveBeenCalledTimes(1);
    // Page 1's own last rewrite still read the repair: that is what the planner
    // call was bought for, and it is page-local.
    expect(rewritesOf(1).at(-1)?.pageBrief.beat).toBe("Fresh beat for page 1");
    expect(beatFor(rewritesOf(1).at(-1)?.chapterBrief, 1)).toBe("Fresh beat for page 1");
    // Page 2 is not, because page 1 kept nothing written to it.
    expect(beatFor(reviewsOf(2)[0]?.chapterBrief, 1)).toBe("Reach the vault");
    // The row the pass's memory has to agree with was left alone, and so was
    // the pass's memory: same object, same contents.
    expect(mocks.prisma.chapter.updateMany).not.toHaveBeenCalled();
    expect(setup.brief).toBe(sharedBrief);
    expect(sharedBrief).toEqual(chapterBriefFixture());
  });

  it("briefs page 2 against the repair once page 1 keeps the rewrite it briefed", async () => {
    // The feature, and the reason a chapter-wide carry exists at all: page 1
    // shipped prose written to the fresh beat, so page 2 is told that is what
    // page 1 covers. Acceptance is the gate, not the repair.
    reviewsByPage({
      1: [blamesTheBrief(40), blamesTheBrief(40), blamesTheBrief(40), report(85, { approved: true })]
    });

    await generateBookChapterWholePass(baseOptions());

    expect(beatFor(reviewsOf(2)[0]?.chapterBrief, 1)).toBe("Fresh beat for page 1");
    // Page 2's own beat is untouched by page 1's repair, so it is still briefed
    // to write its own assignment.
    expect(beatFor(reviewsOf(2)[0]?.chapterBrief, 2)).toBe("Repeat the approach");
    // The durable row moved on exactly the same condition, which is the
    // property: the pass's memory of the chapter and `Chapter.productionBrief`
    // cannot disagree about whether a repair was earned.
    expect(chapterWrite()?.where.id).toBe("ch-1");
    expect(beatFor(chapterWrite()?.data.productionBrief, 1)).toBe("Fresh beat for page 1");
  });

  it("stands the pass down before page 2 when page 1 is superseded at completion", async () => {
    reviewsByPage({
      1: [blamesTheBrief(40), blamesTheBrief(40), blamesTheBrief(40), report(85, { approved: true })]
    });
    mocks.prisma.page.updateMany.mockImplementation(
      async ({ where }: { where: { index?: number } }) => ({ count: where.index === 1 ? 0 : 1 })
    );

    await expect(generateBookChapterWholePass(baseOptions())).rejects.toBeInstanceOf(
      GeneratedPagePublicationClaimLostError
    );

    expect(reviewsOf(2)).toEqual([]);
    expect(setup.brief).toBe(sharedBrief);
    expect(beatFor(setup.brief as unknown as ReadableChapterBrief, 1)).toBe("Reach the vault");
  });

  it("carries the accepted repair by rebinding the setup, never by writing into the brief", async () => {
    // The mutation check. `ChapterSetup.brief` is one object per chapter and the
    // pass holds it across every page, so a repair reaching page 2 is only ever
    // allowed to be a *replacement* — the brief page 1 was briefed off is the
    // same object page 2 would have been briefed off had page 1 kept nothing.
    reviewsByPage({
      1: [blamesTheBrief(40), blamesTheBrief(40), blamesTheBrief(40), report(85, { approved: true })]
    });

    await generateBookChapterWholePass(baseOptions());

    expect(sharedBrief).toEqual(chapterBriefFixture());
    expect(setup.brief).not.toBe(sharedBrief);
    expect(beatFor(setup.brief as unknown as ReadableChapterBrief, 1)).toBe("Fresh beat for page 1");
  });

  it("leaves the chapter alone entirely when no page reaches recovery", async () => {
    reviewsByPage({});

    await generateBookChapterWholePass(baseOptions());

    expect(strategy.repairPageBrief).not.toHaveBeenCalled();
    expect(strategy.revisePageDraft).not.toHaveBeenCalled();
    expect(mocks.prisma.chapter.updateMany).not.toHaveBeenCalled();
    expect(setup.brief).toBe(sharedBrief);
    expect(reviewsOf(2)[0]?.chapterBrief).toBe(sharedBrief);
  });
});

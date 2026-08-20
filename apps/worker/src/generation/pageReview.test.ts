import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterBrief, PageProductionBeat, PageQualityReport } from "@book-maker/core";

const mocks = vi.hoisted(() => ({
  prisma: {
    page: { upsert: vi.fn() },
    continuityNote: { createMany: vi.fn() },
    chapter: { findUnique: vi.fn(), updateMany: vi.fn() }
  },
  enqueueWorkerJob: vi.fn(),
  updateJobProgress: vi.fn(),
  prepareEmbedding: vi.fn(),
  writePreparedEmbedding: vi.fn(),
  updateEntityStateFromPage: vi.fn(),
  loadContinuityNotes: vi.fn(),
  keeperStoryExtractForSave: vi.fn(),
  persistStoryExtract: vi.fn(),
  // Controllable: `reviewAndSaveGeneratedPage` pins its excerpts out of
  // whatever this returns, and the whole of finding C is that it used to load
  // nothing at all.
  loadStyleLockPages: vi.fn(
    async (
      _projectId?: string,
      _pageIndex?: number,
      _recencyPages?: Array<Record<string, unknown>>
    ): Promise<Array<Record<string, unknown>>> => []
  ),
  enrichPageQualityReport: vi.fn(),
  // The style audit's provider boundary. `withStyleAudit` above it stays real.
  auditPageStyle: vi.fn(),
  qualityEnabled: vi.fn((_feature: string): boolean => false)
}));

/**
 * The enrichment pass is stubbed, but the excerpts it is *handed* are not
 * incidental: they are the pin this function derives once and hands to the
 * enrichment pass and the review loop alike, so the tests below read them off
 * the call rather than off the answer.
 */
const stubbedEnrichment = async ({ report }: { report: unknown }) => ({
  report,
  extract: null,
  storyState: { promises: [], facts: [], entities: {}, unanswered: [] }
});

vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  Prisma: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../runtime/dispatch.js", () => ({ enqueueWorkerJob: mocks.enqueueWorkerJob }));
vi.mock("../runtime/jobLifecycle.js", () => ({ updateJobProgress: mocks.updateJobProgress }));
vi.mock("./embeddingWrites.js", () => ({
  prepareEmbedding: mocks.prepareEmbedding,
  writePreparedEmbedding: mocks.writePreparedEmbedding,
  // Mirrors the real predicate so fixtures choose their mode explicitly.
  strategyUsesSemanticMemory: (strategy: { executionMode?: string }) =>
    strategy?.executionMode === "sequential-pages"
}));
vi.mock("./entityState.js", () => ({ updateEntityStateFromPage: mocks.updateEntityStateFromPage }));
vi.mock("./researchMemory.js", () => ({ retrieveSemanticResearchNotes: async () => [] }));
vi.mock("./generationContext.js", () => ({
  loadContinuityNotes: mocks.loadContinuityNotes,
  loadResearchNotesForGeneration: async () => []
}));
vi.mock("./qualitySettings.js", () => ({
  loadQualityContext: async () => ({
    settings: {},
    tier: "balanced",
    enabled: (feature: string) => mocks.qualityEnabled(feature)
  }),
  applyPlanThinkingBoost: vi.fn()
}));
vi.mock("./qualityEnrichment.js", async () => {
  const actual = await vi.importActual<typeof import("./qualityEnrichment.js")>("./qualityEnrichment.js");
  return {
    enrichPageQualityReport: mocks.enrichPageQualityReport,
    // The real factory: whether the handler builds an auditor at all, and out
    // of which excerpts, is exactly what the style-audit tests below measure.
    revisedDraftStyleAuditor: actual.revisedDraftStyleAuditor,
    keeperStoryExtractForSave: mocks.keeperStoryExtractForSave,
    persistStoryExtract: mocks.persistStoryExtract
  };
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return { ...actual, auditPageStyle: mocks.auditPageStyle };
});
vi.mock("./bookHelpers.js", async () => {
  const { pagesForStyleExcerpts, pinStyleExcerpts, sampleExcerptsFromInput } = await vi.importActual<
    typeof import("@book-maker/core")
  >("@book-maker/core");
  return {
    formatQualityFailure: () => "quality failure detail",
    loadStyleLockPages: mocks.loadStyleLockPages,
    parseChapterBrief: (value: unknown) => (value ? value : undefined),
    // The real pin, the mocked loader: so the suite still observes
    // `loadStyleLockPages` while the helper under test is the same composition.
    styleExcerptsForPage: async (options: {
      projectId: string;
      pageIndex: number;
      recencyPages: Array<{ index: number; title: string; markdown: string; summary: string }>;
      input: Parameters<typeof sampleExcerptsFromInput>[0];
      quality: { enabled: (feature: string) => boolean };
    }) => {
      if (!options.quality.enabled("styleExcerpts")) {
        return [];
      }
      const lockPages = (await mocks.loadStyleLockPages(
        options.projectId,
        options.pageIndex,
        options.recencyPages
      )) as Array<{ index: number; title: string; markdown: string; summary: string }>;
      return pinStyleExcerpts(
        pagesForStyleExcerpts(options.recencyPages, lockPages),
        sampleExcerptsFromInput(options.input)
      );
    }
  };
});

import {
  repairPageBriefForRecovery,
  reviewAndSaveGeneratedPage,
  revisePageDraftWithRestart,
  runPageQualityLoop
} from "./pageReview.js";
import { MAX_PAGE_QA_CANDIDATES } from "./tuning.js";

const report = (score: number, overrides: Partial<PageQualityReport> = {}): PageQualityReport =>
  ({
    approved: false,
    score,
    issues: [],
    requiredRevisions: [],
    notes: "",
    checks: { repetitionOk: true, progressionOk: true },
    ...overrides
  }) as unknown as PageQualityReport;

const draftNamed = (name: string) => ({
  title: name,
  markdown: `${name} text.`,
  summary: `${name} summary.`,
  continuityNotes: [] as string[]
});

/** Gate stub in the shape `loadQualityContext` answers with. */
const qualityGates = (...enabled: string[]) => ({ enabled: (feature: string) => enabled.includes(feature) });

/** A page long enough for `pinStyleExcerpts` to accept it as a style anchor. */
const anchorPage = (index: number, voice: string) => ({
  index,
  title: `Page ${index}`,
  markdown: `${voice} ${"prose ".repeat(20)}`,
  summary: `Summary ${index}`
});

beforeEach(() => {
  // Set here rather than in each suite's own `beforeEach`, which clears calls
  // but keeps implementations: one test's excerpts or verdict would otherwise
  // be the next one's default.
  mocks.enrichPageQualityReport.mockImplementation(stubbedEnrichment);
  mocks.auditPageStyle.mockResolvedValue({ styleOk: true, styleIssues: [] });
  mocks.qualityEnabled.mockReturnValue(false);
  mocks.loadStyleLockPages.mockResolvedValue([]);
});

describe("runPageQualityLoop style audit", () => {
  /** The excerpts a caller pins once and the loop is expected to reuse whole. */
  const excerpts = ["Opening voice, pinned.", "Second page voice, pinned."];

  type LoopCall = { styleExcerpts?: string[]; report: PageQualityReport };

  const strategyApproving = () => ({
    revisePageDraft: vi.fn(async (_options: LoopCall) => draftNamed("Rewrite")),
    reviewPageDraft: vi.fn(async (_options: LoopCall) => report(85, { approved: true }))
  });

  /** Rejects once, then approves — so one rewrite runs before the audit. */
  const strategyRejectingOnce = () => ({
    revisePageDraft: vi.fn(async (_options: LoopCall) => draftNamed("Rewrite")),
    reviewPageDraft: vi
      .fn<(options: LoopCall) => Promise<PageQualityReport>>()
      .mockResolvedValueOnce(report(40))
      .mockResolvedValue(report(85, { approved: true }))
  });

  const loopWith = (overrides: Record<string, unknown>) =>
    runPageQualityLoop({
      projectId: "project-1",
      input: {} as never,
      plan: {} as never,
      pageIndex: 4,
      draft: draftNamed("Initial"),
      report: report(50),
      previousPages: [],
      continuityNotes: [],
      textModel: {} as never,
      maxCandidates: MAX_PAGE_QA_CANDIDATES,
      reviseContext: "Page 4",
      quality: qualityGates("styleAuditor"),
      styleExcerpts: excerpts,
      ...overrides
    } as never);

  const auditedWith = () =>
    mocks.auditPageStyle.mock.calls.map((call) => call[0] as { markdown: string; styleExcerpts: string[] });

  beforeEach(() => vi.clearAllMocks());

  it("builds its auditor out of the very array it revises and reviews with", async () => {
    // The finding this closes: every caller used to hand-assemble the excerpts
    // and an auditor built from them, and nothing checked the two were the same
    // set. The loop owns both now, so the identity is asserted here once — by
    // reference, so a second derivation fails even where the two agree today.
    const strategy = strategyApproving();
    mocks.auditPageStyle.mockResolvedValue({ styleOk: true, styleIssues: [] });

    await loopWith({ strategy });

    expect(strategy.revisePageDraft.mock.calls[0]![0].styleExcerpts).toBe(excerpts);
    expect(strategy.reviewPageDraft.mock.calls[0]![0].styleExcerpts).toBe(excerpts);
    expect(auditedWith()[0]!.styleExcerpts).toBe(excerpts);
  });

  it("builds no auditor with the gate off, or with nothing pinned to compare against", async () => {
    await loopWith({ strategy: strategyApproving(), quality: qualityGates() });
    expect(mocks.auditPageStyle).not.toHaveBeenCalled();

    await loopWith({ strategy: strategyApproving(), styleExcerpts: [] });
    expect(mocks.auditPageStyle).not.toHaveBeenCalled();
  });

  it("audits the seed report the caller hands in when nothing has audited it yet", async () => {
    // The chat rewrite and the final-QA repair both seed this loop with a
    // report straight off `reviewPageDraft`, and both used to run their own
    // copy of this block before calling in.
    const strategy = strategyApproving();

    const outcome = await loopWith({ strategy, report: report(85, { approved: true }) });

    expect(auditedWith().map((call) => call.markdown)).toEqual(["Initial text."]);
    expect(strategy.revisePageDraft).not.toHaveBeenCalled();
    expect(outcome.approved).toBe(true);
    expect(outcome.revision).toBe(1);
  });

  it("does not pay for the seed audit twice when the enrichment pass already ran it", async () => {
    // `withStyleAudit` stamps `stylePenalty` on everything it returns, so a
    // page job's enriched seed says it has been audited. Auditing it again is a
    // second provider call on the same draft, out of the same per-page budget.
    const strategy = strategyApproving();

    await loopWith({ strategy, report: report(85, { approved: true, stylePenalty: 0 } as never) });

    expect(mocks.auditPageStyle).not.toHaveBeenCalled();
  });

  it("re-audits an approved revision and keeps revising when the audit rejects it", async () => {
    const strategy = strategyApproving();
    mocks.auditPageStyle
      .mockResolvedValueOnce({ styleOk: false, styleIssues: ["Register drifts into lecture mode."] })
      .mockResolvedValue({ styleOk: true, styleIssues: [] });

    const outcome = await loopWith({ strategy });

    // The reviewer approved the first rewrite; the audit rejected it, so the
    // loop revised again, and the second rewrite passed both gates.
    expect(mocks.auditPageStyle).toHaveBeenCalledTimes(2);
    expect(strategy.revisePageDraft).toHaveBeenCalledTimes(2);
    expect(outcome.approved).toBe(true);
    expect(outcome.revision).toBe(3);
  });

  it("does not audit a revision the reviewer already rejected", async () => {
    const strategy = strategyRejectingOnce();

    const outcome = await loopWith({ strategy, pageIndex: 2 });

    expect(mocks.auditPageStyle).toHaveBeenCalledTimes(1);
    expect(auditedWith()[0]!.markdown).toBe("Rewrite text.");
    expect(outcome.approved).toBe(true);
  });

  it("tells the auditor a register change the reader asked for, and holds every rewrite to it", async () => {
    // Finding B. The excerpts are the book's opening pages, so "make page 12
    // more dramatic" *is* a register shift: audited by the plain rules it was
    // rejected, the approval was flipped, the small user-edit budget went on
    // pulling the page back toward the voice the reader asked it to leave, and
    // the edit was delivered FAILED_QA.
    const strategy = strategyRejectingOnce();

    await loopWith({ strategy, report: report(50), userRequest: "make page 12 more dramatic" });

    expect(auditedWith()[0]).toMatchObject({ userRequest: "make page 12 more dramatic" });
    const briefings = strategy.revisePageDraft.mock.calls.map((call) => call[0].report.requiredRevisions);
    expect(briefings).toHaveLength(2);
    for (const briefing of briefings) {
      expect(briefing).toContain("Keep the user's requested edit applied: make page 12 more dramatic");
    }
  });

  it("says nothing about a user request on a page nobody asked to change", async () => {
    const strategy = strategyApproving();

    await loopWith({ strategy });

    expect(auditedWith()[0]).not.toHaveProperty("userRequest");
    expect(strategy.revisePageDraft.mock.calls[0]![0].report.requiredRevisions).toEqual([]);
  });
});

describe("repairPageBriefForRecovery", () => {
  const chapterBriefFixture = (): ChapterBrief =>
    ({
      chapterIndex: 1,
      pages: [
        { pageIndex: 5, requiredContinuity: [] },
        { pageIndex: 6, requiredContinuity: [] }
      ],
      continuityFocus: []
    }) as unknown as ChapterBrief;

  const repairedBeat = (): PageProductionBeat =>
    ({ pageIndex: 6, requiredContinuity: ["fresh angle"] }) as unknown as PageProductionBeat;

  const strategy = { repairPageBrief: vi.fn() };

  const callOptions = () =>
    ({
      strategy,
      input: {},
      plan: {},
      chapterBrief: chapterBriefFixture(),
      chapterId: "chapter-1",
      pageBrief: { pageIndex: 6, requiredContinuity: [] },
      pageIndex: 6,
      draft: draftNamed("Six"),
      qualityReport: report(40),
      previousPages: [],
      continuityNotes: [],
      textModel: {},
      context: "Page 6"
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    strategy.repairPageBrief.mockResolvedValue(repairedBeat());
  });

  it("merges the repair into a freshly-read chapter brief and writes it back conditionally", async () => {
    mocks.prisma.chapter.findUnique.mockResolvedValue({ productionBrief: chapterBriefFixture() });
    mocks.prisma.chapter.updateMany.mockResolvedValue({ count: 1 });

    await repairPageBriefForRecovery(callOptions());

    expect(mocks.prisma.chapter.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.chapter.updateMany).toHaveBeenCalledWith({
      where: { id: "chapter-1", productionBrief: { equals: chapterBriefFixture() } },
      data: { productionBrief: expect.objectContaining({ pages: expect.arrayContaining([repairedBeat()]) }) }
    });
  });

  it("retries against the winner's brief instead of clobbering it when a concurrent repair lands first", async () => {
    // A sibling page's repair (for page 7) committed between our read and our
    // write: the CAS misses, and the retry must fold page 6's repair onto the
    // *winner's* brief — including page 7's repair — not overwrite it.
    const staleBrief = chapterBriefFixture();
    const winnerBrief: ChapterBrief = {
      ...staleBrief,
      pages: [...staleBrief.pages, { pageIndex: 7, requiredContinuity: ["sibling repair"] } as never]
    };
    mocks.prisma.chapter.findUnique
      .mockResolvedValueOnce({ productionBrief: staleBrief })
      .mockResolvedValueOnce({ productionBrief: winnerBrief });
    mocks.prisma.chapter.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    await repairPageBriefForRecovery(callOptions());

    expect(mocks.prisma.chapter.updateMany).toHaveBeenCalledTimes(2);
    const secondCall = mocks.prisma.chapter.updateMany.mock.calls[1]![0] as {
      where: { productionBrief: { equals: ChapterBrief } };
      data: { productionBrief: ChapterBrief };
    };
    expect(secondCall.where.productionBrief.equals).toBe(winnerBrief);
    expect(secondCall.data.productionBrief.pages.map((page) => page.pageIndex)).toEqual([5, 6, 7]);
  });

  it("does not persist the repaired brief when ownership went during the repair call", async () => {
    // The one write on the drafting side of the page save, and the chapter's
    // other pages read it back — so a delivery that lost the book across the
    // repair call must not leave its opinion of the beats behind.
    mocks.prisma.chapter.findUnique.mockResolvedValue({ productionBrief: chapterBriefFixture() });
    const assertOwnership = vi.fn().mockRejectedValue(new Error("lost its durable lease"));

    await expect(repairPageBriefForRecovery({ ...(callOptions() as object), assertOwnership } as never)).rejects.toThrow(
      "lost its durable lease"
    );

    expect(strategy.repairPageBrief).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.chapter.updateMany).not.toHaveBeenCalled();
  });

  it("gives up and logs rather than looping forever when every attempt loses the race", async () => {
    mocks.prisma.chapter.findUnique.mockResolvedValue({ productionBrief: chapterBriefFixture() });
    mocks.prisma.chapter.updateMany.mockResolvedValue({ count: 0 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await repairPageBriefForRecovery(callOptions());

    expect(result).toEqual(repairedBeat());
    expect(mocks.prisma.chapter.updateMany).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("lost the CAS race"));
    warn.mockRestore();
  });
});

describe("revisePageDraftWithRestart", () => {
  const strategyWith = (revise: ReturnType<typeof vi.fn>) => ({ revisePageDraft: revise }) as never;

  beforeEach(() => vi.clearAllMocks());

  it("returns the first successful revision", async () => {
    const revise = vi.fn().mockResolvedValue(draftNamed("Fixed"));

    await expect(
      revisePageDraftWithRestart({ strategy: strategyWith(revise), reviseOptions: {} as never, context: "Page 1" })
    ).resolves.toMatchObject({ title: "Fixed" });
    expect(revise).toHaveBeenCalledTimes(1);
  });

  it("restarts after failures and surfaces the last error when the budget runs out", async () => {
    const revise = vi.fn().mockRejectedValue(new Error("provider hiccup"));

    await expect(
      revisePageDraftWithRestart({
        strategy: strategyWith(revise),
        reviseOptions: {} as never,
        context: "Page 1",
        maxRestarts: 2
      })
    ).rejects.toThrow("provider hiccup");
    expect(revise).toHaveBeenCalledTimes(3);
    expect(mocks.updateJobProgress).toHaveBeenCalledTimes(2);
  });

  it("succeeds on a restart within the budget", async () => {
    const revise = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider hiccup"))
      .mockResolvedValueOnce(draftNamed("Recovered"));

    await expect(
      revisePageDraftWithRestart({
        strategy: strategyWith(revise),
        reviseOptions: {} as never,
        context: "Page 1",
        maxRestarts: 1
      })
    ).resolves.toMatchObject({ title: "Recovered" });
  });
});

describe("reviewAndSaveGeneratedPage", () => {
  const strategy = {
    id: "test-strategy",
    // Sequential-pages: the one mode whose jobs read semantic memory, so the
    // embedding/entity-state assertions below exercise a real write path.
    executionMode: "sequential-pages",
    reviewPageDraft: vi.fn(),
    revisePageDraft: vi.fn(),
    repairPageBrief: vi.fn(),
    shouldIllustratePage: vi.fn()
  };

  const baseOptions = () =>
    ({
      projectId: "project-1",
      planId: "plan-1",
      input: { mediaSettings: {} },
      plan: { title: "Book", chapters: [] },
      providers: { text: {}, embedding: {} },
      strategy,
      draft: { ...draftNamed("First"), index: 3 },
      chapterId: null,
      previousPages: [],
      generationJobId: "gj-1"
    }) as never;

  const storyExtract = { storyDelta: { facts: ["The robin flew."] }, contradictions: [] };
  const preparedVector = { vectorLiteral: "[0.1,0.2]", error: null };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadContinuityNotes.mockResolvedValue([]);
    mocks.prisma.page.upsert.mockResolvedValue({ id: "page-row-1", revision: 1 });
    strategy.shouldIllustratePage.mockReturnValue(false);
    mocks.keeperStoryExtractForSave.mockResolvedValue(storyExtract);
    mocks.prepareEmbedding.mockResolvedValue(preparedVector);
  });

  it("saves an approved first draft as COMPLETED at revision 1", async () => {
    strategy.reviewPageDraft.mockResolvedValue(report(90, { approved: true }));

    const context = await reviewAndSaveGeneratedPage(baseOptions());

    expect(strategy.revisePageDraft).not.toHaveBeenCalled();
    expect(mocks.prisma.page.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId_index: { projectId: "project-1", index: 3 } },
        create: expect.objectContaining({ status: "COMPLETED", revision: 1, title: "First" }),
        update: expect.objectContaining({ status: "COMPLETED", revision: 1, title: "First" })
      })
    );
    expect(mocks.prepareEmbedding).toHaveBeenCalledWith("First summary.", expect.anything());
    expect(mocks.writePreparedEmbedding).toHaveBeenCalledWith(
      { projectId: "project-1", scope: "page:3", sourceId: "page-row-1", text: "First summary." },
      preparedVector
    );
    expect(context).toEqual({ index: 3, title: "First", markdown: "First text.", summary: "First summary." });
  });

  it("records continuity notes and queues the illustration for an approved page", async () => {
    strategy.reviewPageDraft.mockResolvedValue(report(90, { approved: true }));
    strategy.shouldIllustratePage.mockReturnValue(true);
    mocks.prisma.page.upsert.mockResolvedValue({ id: "page-row-1", revision: 2 });
    const options = baseOptions() as {
      draft: ReturnType<typeof draftNamed> & { index: number; imagePrompt?: string }
    };
    options.draft.imagePrompt = "A robin on a branch";
    options.draft.continuityNotes = ["The robin is named Pip."];

    await reviewAndSaveGeneratedPage(options as never);

    expect(mocks.prisma.continuityNote.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          projectId: "project-1",
          pageId: "page-row-1",
          scope: "page:3",
          body: "The robin is named Pip.",
          tags: ["page", "3", "test-strategy"]
        })
      ]
    });
    expect(mocks.updateEntityStateFromPage).toHaveBeenCalledWith("project-1", 3, ["The robin is named Pip."]);
    expect(mocks.enqueueWorkerJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "GENERATE_IMAGE",
        payload: { pageId: "page-row-1", planId: "plan-1", prompt: "A robin on a branch" },
        dedupeKey: "generate-image:page-row-1:plan-1:2"
      })
    );
  });

  it("keeps the best draft, not the last, when no rewrite is approved", async () => {
    // Scores 40 → 70 → 55…: the sixth-rewrite-worse-than-second shape. The
    // page must be saved FAILED_QA at the score-70 draft, and the flagged page
    // must skip continuity, embedding, and illustration until it is repaired.
    let rewrite = 1;
    strategy.revisePageDraft.mockImplementation(async () => draftNamed(`Rewrite ${(rewrite += 1)}`));
    strategy.reviewPageDraft
      .mockResolvedValueOnce(report(40))
      .mockResolvedValueOnce(report(70))
      .mockResolvedValue(report(55));

    const context = await reviewAndSaveGeneratedPage(baseOptions());

    expect(strategy.reviewPageDraft).toHaveBeenCalledTimes(MAX_PAGE_QA_CANDIDATES);
    expect(mocks.prisma.page.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "FAILED_QA",
          revision: 2,
          title: "Rewrite 2",
          qualityReport: expect.objectContaining({ score: 70 })
        })
      })
    );
    expect(mocks.prepareEmbedding).not.toHaveBeenCalled();
    expect(mocks.writePreparedEmbedding).not.toHaveBeenCalled();
    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
    expect(mocks.prisma.continuityNote.createMany).not.toHaveBeenCalled();
    // A flagged page still publishes its story delta: the final review rewrites
    // the page and needs the state the keeper actually left behind.
    expect(mocks.persistStoryExtract).toHaveBeenCalledTimes(1);
    expect(context).toMatchObject({ index: 3, title: "Rewrite 2" });
  });

  /** The book's opening pages, which is what a style lock is. */
  const lockPages = [anchorPage(1, "opening-voice"), anchorPage(2, "second-voice")];
  const pinned = lockPages.map((page) => page.markdown.trim());

  /** The recency window a continuation hands in: pages 23–24, not the opening. */
  const continuationWindow = [anchorPage(23, "late-voice"), anchorPage(24, "later-voice")];

  const savedReport = () =>
    (mocks.prisma.page.upsert.mock.calls[0]![0] as { create: { qualityReport: Record<string, unknown> } }).create
      .qualityReport;

  /** The style lock the loop's first rewrite was anchored to. */
  const revisedWith = () => (strategy.revisePageDraft.mock.calls[0]![0] as { styleExcerpts?: string[] }).styleExcerpts;

  /** The pin the enrichment pass was handed — the one array everything reads. */
  const enrichedWith = () =>
    (mocks.enrichPageQualityReport.mock.calls[0]![0] as { styleExcerpts?: string[] }).styleExcerpts;

  const withStyleLock = () => {
    mocks.loadStyleLockPages.mockResolvedValue(lockPages);
    strategy.reviewPageDraft.mockResolvedValueOnce(report(50)).mockResolvedValue(report(85, { approved: true }));
    strategy.revisePageDraft.mockResolvedValue(draftNamed("Rewrite"));
  };

  it("pins the book's opening voice, not the window the caller drafted from", async () => {
    // This path loaded no style lock at all, so the enrichment pass fell back to
    // pinning from `previousPages` — and `continueBook` hands in the last
    // eighteen pages, so a continuation at page 41 was anchored to pages 23 and
    // 24. Every other rewrite path takes the real lock; this was the one left.
    mocks.qualityEnabled.mockImplementation((feature: string) => feature === "styleExcerpts");
    withStyleLock();
    const options = { ...(baseOptions() as object), previousPages: continuationWindow } as never;

    await reviewAndSaveGeneratedPage(options);

    expect(mocks.loadStyleLockPages).toHaveBeenCalledWith("project-1", 3, continuationWindow);
    expect(enrichedWith()).toEqual(pinned);
    expect(enrichedWith()!.join(" ")).not.toMatch(/late-voice|later-voice/);
    // One derivation, three readers: the first review, the enrichment pass and
    // the loop's own anchor are the same array rather than copies that happen
    // to agree. The first review used to omit the lock entirely.
    expect(strategy.reviewPageDraft.mock.calls[0]![0].styleExcerpts).toBe(enrichedWith());
    expect(revisedWith()).toBe(enrichedWith());
  });

  it("loads no style lock at all when the excerpts gate is off", async () => {
    withStyleLock();

    await reviewAndSaveGeneratedPage(baseOptions());

    expect(mocks.loadStyleLockPages).not.toHaveBeenCalled();
    expect(enrichedWith()).toEqual([]);
    expect(strategy.reviewPageDraft.mock.calls[0]![0].styleExcerpts).toBeUndefined();
    expect(revisedWith()).toBeUndefined();
  });

  it("audits an approved revision against the very array the loop revised with", async () => {
    // The auditor is the loop's, built out of the excerpts the loop was handed,
    // and the assertion is by reference: deriving them a second way fails here
    // even where the two derivations agree today.
    mocks.qualityEnabled.mockImplementation(
      (feature: string) => feature === "styleExcerpts" || feature === "styleAuditor"
    );
    withStyleLock();

    await reviewAndSaveGeneratedPage(baseOptions());

    expect(mocks.auditPageStyle).toHaveBeenCalledTimes(1);
    const audited = mocks.auditPageStyle.mock.calls[0]![0] as { markdown: string; styleExcerpts: string[] };
    expect(audited.markdown).toBe("Rewrite text.");
    expect(audited.styleExcerpts).toEqual(pinned);
    expect(audited.styleExcerpts).toBe(revisedWith());
    // Zero rather than absent: it is what marks the report as audited at all.
    expect(savedReport().stylePenalty).toBe(0);
  });

  it("builds no auditor with the gate off, or with nothing pinned to compare against", async () => {
    mocks.qualityEnabled.mockImplementation((feature: string) => feature === "styleExcerpts");
    withStyleLock();

    // Excerpts pinned, auditor gate off: the rewrite is still anchored to them.
    await reviewAndSaveGeneratedPage(baseOptions());

    expect(mocks.auditPageStyle).not.toHaveBeenCalled();
    expect(revisedWith()).toEqual(pinned);
    expect(savedReport()).not.toHaveProperty("stylePenalty");

    // Auditor gate on, excerpts gate off: nothing is even loaded to pin.
    vi.clearAllMocks();
    mocks.prisma.page.upsert.mockResolvedValue({ id: "page-row-1", revision: 1 });
    mocks.enrichPageQualityReport.mockImplementation(stubbedEnrichment);
    mocks.qualityEnabled.mockImplementation((feature: string) => feature === "styleAuditor");
    withStyleLock();
    await reviewAndSaveGeneratedPage(baseOptions());

    expect(mocks.loadStyleLockPages).not.toHaveBeenCalled();
    expect(mocks.auditPageStyle).not.toHaveBeenCalled();
  });

  it("carries a failed audit's penalty and issues into the report it saves", async () => {
    mocks.qualityEnabled.mockImplementation(
      (feature: string) => feature === "styleExcerpts" || feature === "styleAuditor"
    );
    mocks.loadStyleLockPages.mockResolvedValue(lockPages);
    // The reviewer approves the first rewrite and rejects the rest, so the
    // audited draft is the keeper and its report is what the page is saved on.
    strategy.reviewPageDraft
      .mockResolvedValueOnce(report(50))
      .mockResolvedValueOnce(report(85, { approved: true }))
      .mockResolvedValue(report(40));
    strategy.revisePageDraft.mockResolvedValue(draftNamed("Rewrite"));
    mocks.auditPageStyle.mockResolvedValue({
      styleOk: false,
      styleIssues: ["Register drifts into lecture mode.", "Rhythm ignores the opening."]
    });

    await reviewAndSaveGeneratedPage(baseOptions());

    expect(mocks.prisma.page.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ status: "FAILED_QA" }) })
    );
    expect(savedReport()).toMatchObject({ score: 85, stylePenalty: 30 });
    expect(savedReport().issues).toContain("Register drifts into lecture mode.");
  });

  it("spends at most two re-audits on a page, and starts the next page with a fresh budget", async () => {
    // The reviewer approves every rewrite and the audit rejects every one, so
    // nothing but the counter can stop the two gates trading provider calls.
    mocks.qualityEnabled.mockImplementation(
      (feature: string) => feature === "styleExcerpts" || feature === "styleAuditor"
    );
    withStyleLock();
    mocks.auditPageStyle.mockResolvedValue({ styleOk: false, styleIssues: ["Register drifts."] });

    await reviewAndSaveGeneratedPage(baseOptions());

    // Two, then the third approval stands unaudited and ends the loop.
    expect(mocks.auditPageStyle).toHaveBeenCalledTimes(2);
    expect(savedReport()).not.toHaveProperty("stylePenalty");

    // The closure is built once per call, so the next page pays for its own.
    strategy.reviewPageDraft.mockResolvedValueOnce(report(50)).mockResolvedValue(report(85, { approved: true }));
    await reviewAndSaveGeneratedPage(baseOptions());

    expect(mocks.auditPageStyle).toHaveBeenCalledTimes(4);
  });
});

describe("reviewAndSaveGeneratedPage ownership fence", () => {
  // The structural-insert shape: a delivery drafting under a durable lease that
  // a replacement can take over mid-page. Everything the save publishes after
  // the page row — the story delta, the continuity notes, the entity state and
  // the embedding — is read back by *later* pages, so a delivery that has lost
  // the book must leave none of it behind. The page row itself is the winner's
  // to redo: it is keyed on project+index and the winner drafts the same ids.
  const strategy = {
    id: "test-strategy",
    executionMode: "sequential-pages",
    reviewPageDraft: vi.fn(),
    revisePageDraft: vi.fn(),
    repairPageBrief: vi.fn(),
    shouldIllustratePage: vi.fn()
  };

  const storyExtract = { storyDelta: { facts: ["The robin flew."] }, contradictions: [] };

  const fencedOptions = (assertOwnership: () => Promise<void>) =>
    ({
      projectId: "project-1",
      planId: "plan-1",
      input: { mediaSettings: {} },
      plan: { title: "Book", chapters: [] },
      providers: { text: {}, embedding: {} },
      strategy,
      draft: { ...draftNamed("First"), index: 3, imagePrompt: "A robin", continuityNotes: ["The robin is named Pip."] },
      chapterId: null,
      previousPages: [],
      generationJobId: "gj-1",
      assertOwnership
    }) as never;

  /** Every write the page save publishes for later pages to read back. */
  const expectNothingPublished = () => {
    expect(mocks.persistStoryExtract).not.toHaveBeenCalled();
    expect(mocks.prisma.continuityNote.createMany).not.toHaveBeenCalled();
    expect(mocks.updateEntityStateFromPage).not.toHaveBeenCalled();
    expect(mocks.writePreparedEmbedding).not.toHaveBeenCalled();
    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
  };

  /** Holds for the first `holdFor` barriers, then reports takeover. */
  const fenceLostAfter = (holdFor: number) => {
    let barriers = 0;
    return vi.fn(async () => {
      barriers += 1;
      if (barriers > holdFor) {
        throw new Error("Structural page edit delivery lost its durable lease");
      }
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadContinuityNotes.mockResolvedValue([]);
    mocks.prisma.page.upsert.mockResolvedValue({ id: "page-row-1", revision: 1 });
    strategy.shouldIllustratePage.mockReturnValue(true);
    strategy.reviewPageDraft.mockResolvedValue(report(90, { approved: true }));
    mocks.keeperStoryExtractForSave.mockResolvedValue(storyExtract);
    mocks.prepareEmbedding.mockResolvedValue({ vectorLiteral: "[0.1,0.2]", error: null });
  });

  it("publishes the whole tail while the fence holds, and asks it three times", async () => {
    const fence = fenceLostAfter(Number.POSITIVE_INFINITY);

    await reviewAndSaveGeneratedPage(fencedOptions(fence));

    // Before the page upsert, before the provider calls, and before the writes.
    expect(fence).toHaveBeenCalledTimes(3);
    expect(mocks.persistStoryExtract).toHaveBeenCalledWith(expect.objectContaining({ extract: storyExtract }));
    expect(mocks.prisma.continuityNote.createMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateEntityStateFromPage).toHaveBeenCalledTimes(1);
    expect(mocks.writePreparedEmbedding).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueWorkerJob).toHaveBeenCalledTimes(1);
  });

  it("spends no provider call and publishes nothing when ownership goes right after the page upsert", async () => {
    // Lost before the story extract: the barrier after the upsert is what stops
    // a delivery that no longer owns the book paying for state it may not write.
    const fence = fenceLostAfter(1);

    await expect(reviewAndSaveGeneratedPage(fencedOptions(fence))).rejects.toThrow("lost its durable lease");

    expect(mocks.prisma.page.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.keeperStoryExtractForSave).not.toHaveBeenCalled();
    expect(mocks.prepareEmbedding).not.toHaveBeenCalled();
    expectNothingPublished();
  });

  it("publishes nothing when ownership goes during the provider calls, after the model answered", async () => {
    // Lost after the model call, before the write: the extract and the vector
    // are in hand, and the publish barrier is what keeps them out of the book.
    const fence = fenceLostAfter(2);

    await expect(reviewAndSaveGeneratedPage(fencedOptions(fence))).rejects.toThrow("lost its durable lease");

    expect(mocks.keeperStoryExtractForSave).toHaveBeenCalledTimes(1);
    expect(mocks.prepareEmbedding).toHaveBeenCalledTimes(1);
    expectNothingPublished();
  });

  it("does not even save the page when ownership is already gone before the upsert", async () => {
    const fence = fenceLostAfter(0);

    await expect(reviewAndSaveGeneratedPage(fencedOptions(fence))).rejects.toThrow("lost its durable lease");

    expect(mocks.prisma.page.upsert).not.toHaveBeenCalled();
    expect(mocks.keeperStoryExtractForSave).not.toHaveBeenCalled();
    expectNothingPublished();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageQualityReport } from "@book-maker/core";
import {
  balancedPagePipelineQualityContext,
  pagePipelineQualityGates
} from "../testing/qualityGateFixtures.js";

const mocks = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    page: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    continuityNote: { createMany: vi.fn() },
    chapter: { findUnique: vi.fn(), updateMany: vi.fn() }
  },
  enqueueWorkerJob: vi.fn(),
  updateJobProgress: vi.fn(),
  prepareEmbedding: vi.fn(),
  writePreparedEmbedding: vi.fn(),
  updateEntityStateFromPage: vi.fn(),
  loadContinuityNotes: vi.fn(),
  loadResearchNotesForGeneration: vi.fn(),
  retrieveSemanticResearchNotes: vi.fn(),
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
vi.mock("./researchMemory.js", () => ({
  retrieveSemanticResearchNotes: mocks.retrieveSemanticResearchNotes
}));
vi.mock("./generationContext.js", () => ({
  loadContinuityNotes: mocks.loadContinuityNotes,
  loadResearchNotesForGeneration: mocks.loadResearchNotesForGeneration
}));
vi.mock("./qualitySettings.js", () => ({
  loadQualityContext: async () =>
    balancedPagePipelineQualityContext({ otherFeatureEnabled: mocks.qualityEnabled }),
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
  reviewAndSaveGeneratedPage,
  runPageQualityLoop
} from "./pageReview.js";
import { pageQaCandidatesFor } from "./tuning.js";

/** The candidate budget the fixtures run under: no tier recorded is balanced. */
const BALANCED_CANDIDATES = pageQaCandidatesFor({ mediaSettings: {} } as never);

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
const qualityGates = (...enabled: string[]) =>
  pagePipelineQualityGates({ additionalFeatures: enabled });
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
  mocks.loadResearchNotesForGeneration.mockResolvedValue([]);
  mocks.retrieveSemanticResearchNotes.mockResolvedValue([]);
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
      maxCandidates: BALANCED_CANDIDATES,
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

describe("runPageQualityLoop conditional Smart unslop", () => {
  it("accepts an unchanged contextual no-op without spending another unslop rewrite", async () => {
    const candidateDraft = {
      title: "Treatment",
      markdown:
        "Here's the thing: the valve stayed shut. At its core, the test measures pressure. " +
        "The result serves as a testament to calibration.",
      summary: "The operator tests a valve.",
      continuityNotes: [] as string[]
    };
    const candidateReport = report(70, {
      issues: ["Smart unslop candidate scan found 3 possible signals."],
      requiredRevisions: ["Inspect the candidates contextually."],
      checks: {
        placeholderFree: true,
        promptLeakFree: true,
        titleClean: true,
        repetitionOk: true,
        progressionOk: true,
        styleNatural: false
      }
    });
    const approved = report(94, { approved: true });
    const strategy = {
      revisePageDraft: vi.fn(async () => candidateDraft),
      reviewPageDraft: vi.fn(async () => approved)
    };

    const outcome = await runPageQualityLoop({
      projectId: "project-1",
      strategy,
      input: {} as never,
      plan: {} as never,
      pageIndex: 4,
      draft: candidateDraft,
      report: candidateReport,
      previousPages: [],
      continuityNotes: [],
      textModel: {} as never,
      maxCandidates: BALANCED_CANDIDATES,
      reviseContext: "Page 4",
      quality: qualityGates()
    } as never);

    expect(strategy.revisePageDraft).toHaveBeenCalledTimes(1);
    expect(strategy.reviewPageDraft).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ approved: true, draft: candidateDraft, revision: 2, attempts: 2 });
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
    mocks.prisma.$transaction.mockImplementation(
      async (run: (tx: typeof mocks.prisma) => Promise<unknown>) => run(mocks.prisma)
    );
    mocks.loadContinuityNotes.mockResolvedValue([]);
    mocks.prisma.page.findUnique.mockResolvedValue(null);
    mocks.prisma.page.create.mockResolvedValue({ id: "page-row-1", revision: 1 });
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    mocks.enqueueWorkerJob.mockResolvedValue({ id: "image-job" });
    strategy.shouldIllustratePage.mockReturnValue(false);
    mocks.keeperStoryExtractForSave.mockResolvedValue(storyExtract);
    mocks.prepareEmbedding.mockResolvedValue(preparedVector);
  });

  it("stages and completes an approved first draft at revision 1", async () => {
    strategy.reviewPageDraft.mockResolvedValue(report(90, { approved: true }));

    const context = await reviewAndSaveGeneratedPage(baseOptions());

    expect(strategy.revisePageDraft).not.toHaveBeenCalled();
    expect(mocks.prisma.page.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: "project-1",
        index: 3,
        status: "GENERATING",
        revision: 1,
        title: "First"
      })
    });
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "page-row-1", status: "GENERATING", revision: 1 }),
        data: expect.objectContaining({ status: "COMPLETED" })
      })
    );
    expect(mocks.prepareEmbedding).toHaveBeenCalledWith("First summary.", expect.anything());
    expect(mocks.writePreparedEmbedding).toHaveBeenCalledWith(
      { projectId: "project-1", scope: "page:3", sourceId: "page-row-1", text: "First summary." },
      preparedVector
    );
    expect(context.page).toEqual({ index: 3, title: "First", markdown: "First text.", summary: "First summary." });
    // Nothing repaired its brief, so the caller's copy of the chapter is left alone.
    expect(context.repairedChapterBrief).toBeUndefined();
  });

  it("replays a settled row for an ordinary caller and refuses it for a deferred one", async () => {
    // The early return is a redelivery replay for a caller that publishes here.
    // A `deferPublication` caller publishes the page itself, so the same fact is
    // a lost claim: returning `{ page }` with no candidate left four call sites
    // each inventing "returned no candidate" for a row another delivery owns.
    strategy.reviewPageDraft.mockResolvedValue(report(90, { approved: true }));
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-row-1",
      status: "COMPLETED",
      title: "Someone else",
      markdown: "Their prose.",
      summary: "Their summary.",
      imagePrompt: null,
      revision: 4,
      updatedAt: new Date()
    });

    const replayed = await reviewAndSaveGeneratedPage(baseOptions());
    expect(replayed).toEqual({ page: { index: 3, title: "Someone else", markdown: "Their prose.", summary: "Their summary." } });
    expect(strategy.reviewPageDraft).not.toHaveBeenCalled();

    const fence = vi.fn(async () => undefined);
    await expect(
      reviewAndSaveGeneratedPage({ ...(baseOptions() as object), deferPublication: true, assertOwnership: fence } as never)
    ).rejects.toThrow("lost its optimistic publication claim");
    // The caller's own fence is asked first, so a lost lease wins with its own
    // stand-down error instead of this generic one.
    expect(fence).toHaveBeenCalledOnce();
    expect(strategy.reviewPageDraft).not.toHaveBeenCalled();
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
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

    expect(strategy.reviewPageDraft).toHaveBeenCalledTimes(BALANCED_CANDIDATES);
    expect(mocks.prisma.page.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
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
    expect(context.page).toMatchObject({ index: 3, title: "Rewrite 2" });
  });

  it("keeps URL-less semantic hits out of the shared page-review revision prompt", async () => {
    const citeable = "Boundary papers: Commission records.";
    mocks.qualityEnabled.mockImplementation((feature: string) => feature === "claimRetrieve");
    mocks.loadResearchNotesForGeneration.mockResolvedValue([citeable]);
    mocks.retrieveSemanticResearchNotes.mockResolvedValue([
      "Grounding summary: URL-less bootstrap claim.",
      citeable
    ]);
    strategy.reviewPageDraft
      .mockResolvedValueOnce(report(40, { groundedOk: false, issues: ["Needs revision."] }))
      .mockResolvedValue(report(90, { approved: true }));
    strategy.revisePageDraft.mockResolvedValue(draftNamed("Rewrite"));

    await reviewAndSaveGeneratedPage(baseOptions());

    expect(mocks.retrieveSemanticResearchNotes).toHaveBeenCalledTimes(1);
    expect(strategy.revisePageDraft).toHaveBeenCalledWith(
      expect.objectContaining({ retrievedResearch: [citeable] })
    );
  });

  /** The book's opening pages, which is what a style lock is. */
  const lockPages = [anchorPage(1, "opening-voice"), anchorPage(2, "second-voice")];
  const pinned = lockPages.map((page) => page.markdown.trim());

  /** The recency window a continuation hands in: pages 23–24, not the opening. */
  const continuationWindow = [anchorPage(23, "late-voice"), anchorPage(24, "later-voice")];

  const savedReport = () =>
    (mocks.prisma.page.create.mock.calls[0]![0] as { data: { qualityReport: Record<string, unknown> } }).data
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
    mocks.prisma.page.findUnique.mockResolvedValue(null);
    mocks.prisma.page.create.mockResolvedValue({ id: "page-row-1", revision: 1 });
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
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

    expect(mocks.prisma.page.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED_QA" }) })
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

  const fencedOptions = (assertOwnership: () => Promise<void>, overrides: Record<string, unknown> = {}) =>
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
      assertOwnership,
      ...overrides
    }) as never;

  const recoveryBeat = (beat: string) => ({
    pageIndex: 3,
    chapterIndex: 1,
    purpose: beat,
    beat,
    requiredContinuity: [] as string[],
    endingPressure: ""
  });

  const keptBriefRepairOptions = (assertOwnership: () => Promise<void>) => {
    const originalBeat = recoveryBeat("Repeat the opening");
    const repairedBeat = recoveryBeat("Reveal the hidden stair");
    const chapterBrief = {
      chapterIndex: 1,
      title: "The stair",
      summary: "A hidden route opens.",
      continuityFocus: [] as string[],
      pages: [originalBeat]
    };
    const rejected = report(40, { checks: { repetitionOk: false, progressionOk: true } as never });
    strategy.reviewPageDraft
      // Initial review, then both ordinary rewrites: all still blame the brief.
      .mockResolvedValueOnce(rejected)
      .mockResolvedValueOnce(rejected)
      .mockResolvedValueOnce(rejected)
      // Balanced recovery is candidate four; this is the kept repaired draft.
      .mockResolvedValueOnce(report(90, { approved: true }));
    strategy.revisePageDraft.mockResolvedValue(draftNamed("Recovered"));
    strategy.repairPageBrief.mockResolvedValue(repairedBeat);
    return {
      options: fencedOptions(assertOwnership, { chapterId: "chapter-1", chapterBrief }),
      chapterBrief,
      repairedBeat
    };
  };

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
    mocks.prisma.$transaction.mockImplementation(
      async (run: (tx: typeof mocks.prisma) => Promise<unknown>) => run(mocks.prisma)
    );
    mocks.loadContinuityNotes.mockResolvedValue([]);
    mocks.prisma.page.findUnique.mockResolvedValue(null);
    mocks.prisma.page.create.mockResolvedValue({ id: "page-row-1", revision: 1 });
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    mocks.enqueueWorkerJob.mockResolvedValue({ id: "image-job" });
    strategy.shouldIllustratePage.mockReturnValue(true);
    strategy.reviewPageDraft.mockResolvedValue(report(90, { approved: true }));
    mocks.keeperStoryExtractForSave.mockResolvedValue(storyExtract);
    mocks.prepareEmbedding.mockResolvedValue({ vectorLiteral: "[0.1,0.2]", error: null });
  });

  it("publishes the whole tail while the fence holds, and asks it three times", async () => {
    const fence = fenceLostAfter(Number.POSITIVE_INFINITY);

    await reviewAndSaveGeneratedPage(fencedOptions(fence));

    // Before the page stage, before the provider calls, and before the writes.
    expect(fence).toHaveBeenCalledTimes(3);
    expect(mocks.persistStoryExtract).toHaveBeenCalledWith(expect.objectContaining({ extract: storyExtract }));
    expect(mocks.prisma.continuityNote.createMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateEntityStateFromPage).toHaveBeenCalledTimes(1);
    expect(mocks.writePreparedEmbedding).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueWorkerJob).toHaveBeenCalledTimes(1);
  });

  it("spends no provider call and publishes nothing when ownership goes right after the page stage", async () => {
    // Lost before the story extract: the barrier after the stage is what stops
    // a delivery that no longer owns the book paying for state it may not write.
    const fence = fenceLostAfter(1);

    await expect(reviewAndSaveGeneratedPage(fencedOptions(fence))).rejects.toThrow("lost its durable lease");

    expect(mocks.prisma.page.create).toHaveBeenCalledTimes(1);
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

  it("does not even save the page when ownership is already gone before the stage", async () => {
    const fence = fenceLostAfter(0);

    await expect(reviewAndSaveGeneratedPage(fencedOptions(fence))).rejects.toThrow("lost its durable lease");

    expect(mocks.prisma.page.create).not.toHaveBeenCalled();
    expect(mocks.keeperStoryExtractForSave).not.toHaveBeenCalled();
    expectNothingPublished();
  });

  it("keeps both the repaired chapter brief and page behind the publication fence", async () => {
    // This is the old split-write window. The repair's post-model stand-down
    // succeeds, then a replacement takes the structural lease before the page
    // publication barrier. Previously the loop had already committed the
    // chapter CAS here, leaving its repaired assignment durable while this
    // delivery's page never landed.
    const fence = fenceLostAfter(1);
    const { options } = keptBriefRepairOptions(fence);

    await expect(reviewAndSaveGeneratedPage(options)).rejects.toThrow("lost its durable lease");

    expect(strategy.repairPageBrief).toHaveBeenCalledTimes(1);
    expect(fence).toHaveBeenCalledTimes(2);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.prisma.page.create).not.toHaveBeenCalled();
    expect(mocks.prisma.chapter.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.chapter.updateMany).not.toHaveBeenCalled();
    expectNothingPublished();
  });

  it("publishes a kept page and its repaired chapter brief on one transaction client", async () => {
    const fence = fenceLostAfter(Number.POSITIVE_INFINITY);
    const { options, chapterBrief, repairedBeat } = keptBriefRepairOptions(fence);
    const tx = {
      page: { create: vi.fn().mockResolvedValue({ id: "page-row-1", revision: 4 }) },
      chapter: {
        findUnique: vi.fn().mockResolvedValue({ productionBrief: chapterBrief }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      }
    };
    mocks.prisma.$transaction.mockImplementationOnce(
      async (run: (client: typeof tx) => Promise<unknown>) => run(tx)
    );

    const saved = await reviewAndSaveGeneratedPage(options);

    expect(saved.repairedChapterBrief?.pages).toEqual([repairedBeat]);
    expect(tx.page.create).toHaveBeenCalledTimes(1);
    expect(tx.chapter.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.chapter.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.page.create.mock.invocationCallOrder[0]!).toBeLessThan(
      tx.chapter.findUnique.mock.invocationCallOrder[0]!
    );
    // Neither half escapes onto the root client around the transaction.
    expect(mocks.prisma.page.create).not.toHaveBeenCalled();
    expect(mocks.prisma.chapter.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.chapter.updateMany).not.toHaveBeenCalled();
  });

  it("rolls the kept page back when the repaired brief loses every transaction CAS", async () => {
    const fence = fenceLostAfter(Number.POSITIVE_INFINITY);
    const { options, chapterBrief } = keptBriefRepairOptions(fence);
    const movingBrief = (label: string) => ({ ...chapterBrief, continuityFocus: [label] });
    let stagedPage: Record<string, unknown> | null = null;
    let durablePage: Record<string, unknown> | null = null;
    const tx = {
      page: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          stagedPage = data;
          return { id: "page-row-1", revision: 4 };
        })
      },
      chapter: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ productionBrief: movingBrief("Sibling A") })
          .mockResolvedValueOnce({ productionBrief: movingBrief("Sibling B") })
          .mockResolvedValueOnce({ productionBrief: movingBrief("Sibling C") }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 })
      }
    };
    mocks.prisma.$transaction.mockImplementationOnce(
      async (run: (client: typeof tx) => Promise<unknown>) => {
        const result = await run(tx);
        durablePage = stagedPage;
        return result;
      }
    );

    const save = reviewAndSaveGeneratedPage(options);

    await expect(save).rejects.toMatchObject({
      name: "ChapterBriefPublicationRejectedError",
      chapterId: "chapter-1",
      outcome: "lost-race"
    });
    expect(tx.page.create).toHaveBeenCalledTimes(1);
    expect(tx.chapter.updateMany).toHaveBeenCalledTimes(3);
    expect(durablePage).toBeNull();
    // Rejection means there is no returned `repairedChapterBrief` for a caller
    // to adopt, and neither half escaped through the root client.
    expect(mocks.prisma.page.create).not.toHaveBeenCalled();
    expect(mocks.prisma.chapter.updateMany).not.toHaveBeenCalled();
    expectNothingPublished();
  });
});

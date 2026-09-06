import { beforeEach, describe, expect, it, vi } from "vitest";
import { PageQualityReport } from "@book-maker/core";
import { stubbedEnrichment, mocks, BALANCED_CANDIDATES, report, draftNamed, qualityGates, anchorPage } from "./testing/pageReviewHarness.js";
import { reviewAndSaveGeneratedPage, runPageQualityLoop } from "./pageReview.js";

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

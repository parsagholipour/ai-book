import { beforeEach, describe, expect, it, vi } from "vitest";
import { PageQualityReport, createProjectSchema, makeFallbackPlan, JEV_SELECTION } from "@book-maker/core";
import { mocks, LOOP_CANDIDATES, report, draftNamed, qualityGates } from "./testing/pageReviewHarness.js";
import { reviewAndSaveGeneratedPage, runPageQualityLoop, reviewPageWithQualityGates } from "./pageReview.js";

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
      maxCandidates: LOOP_CANDIDATES,
      reviseContext: "Page 4",
      quality: qualityGates("styleAuditor"),
      styleExcerpts: excerpts,
      ...overrides
    } as never);

  const auditedWith = () =>
    mocks.auditPageStyle.mock.calls.map((call) => call[0] as { markdown: string; styleExcerpts: string[] });

  beforeEach(() => vi.clearAllMocks());

  it("spends its whole budget on a page that never improves and keeps its strongest draft", async () => {
    const strategy = {
      revisePageDraft: vi.fn(async () => draftNamed("No improvement")),
      reviewPageDraft: vi.fn(async () => report(40))
    };
    const outcome = await loopWith({ strategy, maxCandidates: 3, quality: qualityGates() });
    expect(strategy.revisePageDraft).toHaveBeenCalledTimes(2);
    expect(outcome.attempts).toBe(3);
    expect(outcome.approved).toBe(false);
    expect(outcome.revision).toBe(1);
    expect(outcome.draft.title).toBe("Initial");
    expect(outcome.report.score).toBe(50);
  });

  it.each([false, true])("keeps the original naming baseline across repair candidates (caller original: %s)", async (callerOriginal) => {
    const originalMarkdown = "Wise Turtle set the fourth lantern on its proper post.";
    const initial = { ...draftNamed("Initial"), markdown: originalMarkdown };
    const strategy = strategyRejectingOnce();
    await loopWith({ strategy, quality: qualityGates(), draft: callerOriginal ? draftNamed("Already revised") : initial,
      ...(callerOriginal ? { originalDraft: initial } : {}) });
    expect(strategy.reviewPageDraft).toHaveBeenCalledTimes(2);
    for (const [request] of strategy.reviewPageDraft.mock.calls)
      expect(request).toMatchObject({ repairOriginalMarkdown: originalMarkdown });
  });

  it("builds its auditor out of the very array it revises and reviews with", async () => {
    // The finding this closes: every caller used to hand-assemble the excerpts
    // and an auditor built from them, and nothing checked the two were the same
    // set. The loop owns both now, so the identity is asserted here once — by
    // reference, so a second derivation fails even where the two agree today.
    const strategy = strategyApproving();
    mocks.auditPageStyle.mockResolvedValue({ styleOk: true, styleIssues: [] });

    const decisions = { resolve: vi.fn() };
    await loopWith({ strategy, decisions, userRequest: "Use a formal register." });

    expect(strategy.revisePageDraft.mock.calls[0]![0].styleExcerpts).toBe(excerpts);
    expect(strategy.reviewPageDraft.mock.calls[0]![0].styleExcerpts).toBe(excerpts);
    expect(auditedWith()[0]!.styleExcerpts).toBe(excerpts);
    expect(mocks.auditPageStyle).toHaveBeenCalledWith(expect.objectContaining({
      decisions, pageIndex: 4, userRequest: "Use a formal register."
    }));
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
  it.each(["seed", "revision"])("spends confirmation once on the %s while still repairing other failures and preserving the reader request", async (stage) => {
    const input = createProjectSchema.parse({ prompt: "Explain treatment", targetPages: 8 });
    const plan = makeFallbackPlan(input);
    const candidate = { ...draftNamed("Treatment"), markdown: "The basin is not a tank. It is a settling chamber. Chlorine is not an ordinary additive. It is a timed disinfectant. The reservoir is not spare storage. It is a buffer for peak demand." };
    const rejected = report(75, { issues: ["Repair a separate continuity defect."] });
    const approved = report(94, { approved: true });
    const choose = vi.fn(async () => ({
      ...JEV_SELECTION, selectedOption: "legitimate_use",
      probabilities: { legitimate_use: 0.9, contextual_defect: 0.05, needs_review: 0.05 }
    }));
    const decisions = { resolve: async () => ({ choose }) };
    const strategy = {
      revisePageDraft: vi.fn(async () => candidate),
      reviewPageDraft: vi.fn().mockResolvedValueOnce(rejected).mockResolvedValue(approved)
    };
    const userRequest = "Keep the parallel technical distinctions.";
    const initialReport = stage === "seed" ? await reviewPageWithQualityGates({
      strategy: strategy as never, quality: qualityGates(), decisions, userRequest,
      reviewOptions: { input, plan, pageIndex: 4, draft: candidate, previousPages: [], continuityNotes: [], textModel: {} as never }
    }) : rejected;
    const outcome = await runPageQualityLoop({
      projectId: "project-1", strategy: strategy as never, input, plan, pageIndex: 4,
      draft: candidate, report: { ...initialReport }, previousPages: [], continuityNotes: [],
      textModel: {} as never, decisions, userRequest, quality: qualityGates(),
      maxCandidates: LOOP_CANDIDATES, reviseContext: "Page 4"
    });
    expect(outcome.approved).toBe(true);
    expect(choose).toHaveBeenCalledTimes(1);
    expect(strategy.revisePageDraft).toHaveBeenCalledTimes(stage === "seed" ? 1 : 2);
    expect(strategy.revisePageDraft).toHaveBeenCalledWith(expect.objectContaining({ editInstruction: userRequest }));
    expect(choose.mock.calls[0]).toEqual([expect.objectContaining({ context: expect.stringContaining(userRequest) })]);
  });

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
      maxCandidates: LOOP_CANDIDATES,
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
    mocks.prepareEmbedding.mockResolvedValue(preparedVector);
  });

  it("stages and completes an approved first draft at revision 1", async () => {
    mocks.reviewPage.mockResolvedValue(report(90, { approved: true }));

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
  });

  it("replays a settled row for an ordinary caller and refuses it for a deferred one", async () => {
    // The early return is a redelivery replay for a caller that publishes here.
    // A `deferPublication` caller publishes the page itself, so the same fact is
    // a lost claim: returning `{ page }` with no candidate left four call sites
    // each inventing "returned no candidate" for a row another delivery owns.
    mocks.reviewPage.mockResolvedValue(report(90, { approved: true }));
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

  it("saves a failing draft as drafted, FAILED_QA, with no rewrite and nothing published for later pages", async () => {
    mocks.reviewPage.mockResolvedValue(report(40));

    const context = await reviewAndSaveGeneratedPage(baseOptions());

    expect(strategy.reviewPageDraft).not.toHaveBeenCalled();
    expect(strategy.revisePageDraft).not.toHaveBeenCalled();
    expect(mocks.prisma.page.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "FAILED_QA", revision: 1, title: "First", qualityReport: expect.objectContaining({ score: 40 }) })
    }));
    expect(mocks.prepareEmbedding).not.toHaveBeenCalled();
    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
    expect(mocks.prisma.continuityNote.createMany).not.toHaveBeenCalled();
    expect(context.page).toMatchObject({ index: 3, title: "First" });
  });
});

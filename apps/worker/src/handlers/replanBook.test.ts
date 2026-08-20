import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  prisma: {
    bookEditOperation: { update: vi.fn() },
    page: { findMany: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []) },
    project: { update: vi.fn(), findUnique: vi.fn() },
    planVersion: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    character: { deleteMany: vi.fn(), createMany: vi.fn() },
    location: { deleteMany: vi.fn(), createMany: vi.fn() },
    researchSource: { deleteMany: vi.fn(), createMany: vi.fn() },
    $transaction: vi.fn()
  },
  revisePlan: vi.fn(),
  enqueueWorkerJob: vi.fn(),
  nextPlanVersion: vi.fn(),
  loadStyleLockPages: vi.fn(
    async (
      _projectId?: string,
      _pageIndex?: number,
      _recencyPages?: Array<Record<string, unknown>>
    ): Promise<Array<Record<string, unknown>>> => []
  ),
  loadContinuityNotes: vi.fn(async (): Promise<string[]> => []),
  qualityEnabled: vi.fn((_feature: string): boolean => false),
  // The style audit's provider boundary; `withStyleAudit` above it stays real.
  auditPageStyle: vi.fn()
}));

vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  Prisma: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../runtime/dispatch.js", () => ({ enqueueWorkerJob: mocks.enqueueWorkerJob }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn(), updateJobProgress: vi.fn() }));
vi.mock("../generation/generationContext.js", () => ({ loadContinuityNotes: mocks.loadContinuityNotes }));
vi.mock("../generation/qualitySettings.js", () => ({
  loadQualityContext: async () => ({
    settings: {},
    tier: "balanced",
    enabled: (feature: string) => mocks.qualityEnabled(feature)
  }),
  applyPlanThinkingBoost: vi.fn()
}));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ text: {} }) }));
vi.mock("../generation/bookHelpers.js", async () => {
  const { pagesForStyleExcerpts, pinStyleExcerpts, sampleExcerptsFromInput } = await vi.importActual<
    typeof import("@book-maker/core")
  >("@book-maker/core");
  return {
    getProjectOrThrow: async (id: string) => ({ id, currentPlanId: "plan-1", targetPages: 12 }),
    invalidateProjectExports: vi.fn(),
    nextPlanVersion: mocks.nextPlanVersion,
    parseChapterBrief: () => null,
    planInputSnapshot: (input: { targetPages: number }) => ({ targetPages: input.targetPages }),
    // The real deep clone, not a stub: the mediaSettings write-back is exactly
    // what these tests exist to observe.
    planMediaSettingsSnapshot: (input: { mediaSettings: unknown }) => JSON.parse(JSON.stringify(input.mediaSettings)),
    strategyForInput: () => ({ revisePlan: mocks.revisePlan }),
    toPriorPageContext: (page: unknown) => page,
    // Controllable: `rewritePageForUserRequest` builds its style lock — and so
    // the auditor — out of whatever this returns.
    loadStyleLockPages: mocks.loadStyleLockPages,
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
vi.mock("../generation/storyStateStore.js", () => ({
  seedProjectStoryState: vi.fn()
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    auditPageStyle: mocks.auditPageStyle,
    bookPlanSchema: { parse: () => ({ chapters: [] }) },
    createProviders: () => ({})
  };
});

import { seedProjectStoryState } from "../generation/storyStateStore.js";
import { replanBook, rewritePageForUserRequest } from "./replanBook.js";

const sourceSnapshot = {
  prompt: "A guide to budget shops with enough detail to parse correctly.",
  category: "BUSINESS",
  targetPages: 12,
  complexity: 5,
  temperature: 0.7,
  language: "en",
  mediaSettings: {
    fullIllustrations: true,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral",
    mobile: { targetPages: 12, imagesEnabled: true }
  }
};

function replanJob(payload: Record<string, unknown>): Job {
  return {
    data: {
      projectId: "project-copy",
      operationId: "operation-1",
      request: "make it 3 pages",
      sourceProjectId: "project-1",
      sourcePlanId: "plan-1",
      ...payload
    }
  } as unknown as Job;
}

describe("replanBook page budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.planVersion.findUnique.mockResolvedValue({
      id: "plan-1",
      inputSnapshot: sourceSnapshot,
      planningPackage: {},
      messages: []
    });
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<void>) => {
      await run({
        planVersion: {
          updateMany: vi.fn(),
          update: vi.fn(),
          create: async () => ({ id: "plan-2" })
        },
        project: { update: mocks.prisma.project.update, findUnique: mocks.prisma.project.findUnique },
        character: mocks.prisma.character,
        location: mocks.prisma.location,
        researchSource: mocks.prisma.researchSource
      });
    });
    mocks.prisma.project.findUnique.mockResolvedValue({ mediaSettings: null });
    mocks.nextPlanVersion.mockResolvedValue(2);
    mocks.revisePlan.mockResolvedValue({ title: "Revised", chapters: [], characters: [], locations: [], researchNotes: [] });
    mocks.enqueueWorkerJob.mockResolvedValue({ id: "job-generate" });
  });
  afterEach(() => vi.clearAllMocks());

  it("plans against the requested page count rather than the source book's", async () => {
    await replanBook(replanJob({ targetPages: 3 }));

    // The plan is revised from the *source* book's input snapshot, which still
    // says 12. Left to it, the planner is instructed to hit 12 and
    // normalizePlanPageTargets pads the revised chapters back up to it — which
    // is how a three-chapter plan came out as an eight-page book.
    expect(mocks.revisePlan).toHaveBeenCalledWith(expect.objectContaining({ targetPages: 3 }));
    expect(seedProjectStoryState).toHaveBeenCalledWith("project-copy", []);
    // The row and the snapshot the next edit reads have to agree.
    expect(mocks.prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ targetPages: 3 }) })
    );
  });

  it("keeps the source plan's page count when the replan named no length", async () => {
    await replanBook(replanJob({}));

    expect(mocks.revisePlan).toHaveBeenCalledWith(expect.objectContaining({ targetPages: 12 }));
  });

  const writtenMediaSettings = () =>
    mocks.prisma.project.update.mock.calls
      .map((call) => (call[0] as { data: Record<string, unknown> }).data.mediaSettings)
      .find((value) => value !== undefined) as Record<string, unknown>;

  it("writes the resize into the mobile metadata the app's settings sheet reads", async () => {
    await replanBook(replanJob({ targetPages: 3 }));

    expect(writtenMediaSettings().mobile).toMatchObject({ targetPages: 3, lengthPreset: "custom", pageCountMode: "custom" });
  });

  it("merges over the live row instead of replacing it", async () => {
    // The target row owns presentation preferences the plan snapshot has
    // schema-stripped, and — for a replan copy — its provenance markers.
    mocks.prisma.project.findUnique.mockResolvedValue({
      mediaSettings: {
        chapterHeadingStyle: "title_only",
        chapterHeadingLabel: "Part",
        includeSources: false,
        mobile: { revisionOfProjectId: "project-1", targetPages: 3 }
      }
    });

    await replanBook(replanJob({ targetPages: 3 }));

    const written = writtenMediaSettings();
    expect(written).toMatchObject({
      chapterHeadingStyle: "title_only",
      chapterHeadingLabel: "Part",
      includeSources: false,
      // The snapshot's generation settings still land.
      fullIllustrations: true
    });
    expect(written.mobile).toMatchObject({ revisionOfProjectId: "project-1", targetPages: 3 });
  });
});


describe("rewritePageForUserRequest style audit", () => {
  const strategy = { revisePageDraft: vi.fn(), reviewPageDraft: vi.fn() };

  const priorPage = (index: number) => ({
    index,
    title: `Page ${index}`,
    markdown: `Page ${index} prose, long enough to serve as a style anchor.`,
    summary: `Page ${index} summary.`
  });

  const draftNamed = (name: string) => ({
    title: name,
    markdown: `${name} text.`,
    summary: `${name} summary.`,
    imagePrompt: null,
    continuityNotes: [] as string[]
  });

  const report = (score: number, approved = false) => ({
    approved,
    score,
    issues: [] as string[],
    requiredRevisions: [] as string[],
    notes: "",
    checks: { repetitionOk: true, progressionOk: true }
  });

  const rewriteOptions = () =>
    ({
      projectId: "project-1",
      page: {
        id: "page-3",
        index: 3,
        title: "Page 3",
        markdown: "Page 3 prose.",
        summary: "Page 3 summary.",
        imagePrompt: null,
        chapterId: null,
        chapter: null
      },
      input: { targetPages: 12, mediaSettings: {} },
      plan: { title: "Book", chapters: [], voiceGuide: ["Warm and plain."] },
      strategy,
      providers: { text: {} },
      request: "make page 3 more dramatic",
      // Handed in by `applyBookEdit`, one context for the whole edit.
      quality: { enabled: (feature: string) => mocks.qualityEnabled(feature) },
      generationJobId: "gj-1"
    }) as never;

  /** The style lock the first rewrite was anchored to. */
  const revisedWith = () => (strategy.revisePageDraft.mock.calls[0]![0] as { styleExcerpts?: string[] }).styleExcerpts;

  const auditCalls = () =>
    mocks.auditPageStyle.mock.calls.map((call) => call[0] as unknown as { markdown: string; styleExcerpts: string[] });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.qualityEnabled.mockReturnValue(false);
    mocks.loadContinuityNotes.mockResolvedValue([]);
    mocks.loadStyleLockPages.mockResolvedValue([]);
    mocks.auditPageStyle.mockResolvedValue({ styleOk: true, styleIssues: [] });
    // Newest first, the way the handler reads them before reversing.
    mocks.prisma.page.findMany.mockResolvedValue([priorPage(11)]);
    strategy.revisePageDraft.mockResolvedValue(draftNamed("Rewrite"));
  });
  afterEach(() => vi.clearAllMocks());

  it("audits the rewrite against the very lock it was written against", async () => {
    // A chat rewrite lands mid-book, so its excerpts come from the loaded
    // style-lock pages rather than the recency window it sits in. The auditor
    // is asserted to hold that same array by reference, which is what stops a
    // second derivation drifting from the one the rewrite used.
    mocks.qualityEnabled.mockImplementation(
      (feature: string) => feature === "styleExcerpts" || feature === "styleAuditor"
    );
    mocks.loadStyleLockPages.mockResolvedValue([priorPage(1), priorPage(2)]);
    strategy.reviewPageDraft.mockResolvedValue(report(85, true));

    const result = await rewritePageForUserRequest(rewriteOptions());

    expect(mocks.loadStyleLockPages).toHaveBeenCalledWith("project-1", 3, [priorPage(11)]);
    expect(revisedWith()).toEqual([priorPage(1).markdown, priorPage(2).markdown]);
    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0]!.markdown).toBe("Rewrite text.");
    expect(auditCalls()[0]!.styleExcerpts).toBe(revisedWith());
    // Zero rather than absent: it is what marks the report as audited at all.
    expect((result.qualityReport as unknown as { stylePenalty?: number }).stylePenalty).toBe(0);
  });

  it("tells the auditor the register change was the reader's own request", async () => {
    // The excerpts are the book's *opening* pages, so "make page 3 more
    // dramatic" is a register shift by construction. Audited by the plain rules
    // it came back rejected, the reviewer's approval was flipped, the edit's
    // three-candidate budget went on pulling the page back toward the voice the
    // reader had just asked it to leave, and the edit was delivered FAILED_QA —
    // which then feeds `failedQaPageIndexes` into the next compile's repair.
    mocks.qualityEnabled.mockImplementation(
      (feature: string) => feature === "styleExcerpts" || feature === "styleAuditor"
    );
    mocks.loadStyleLockPages.mockResolvedValue([priorPage(1), priorPage(2)]);
    strategy.reviewPageDraft.mockResolvedValue(report(85, true));

    await rewritePageForUserRequest(rewriteOptions());

    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0]).toMatchObject({ userRequest: "make page 3 more dramatic" });
  });

  it("holds every quality rewrite to the edit the reader paid for", async () => {
    mocks.qualityEnabled.mockReturnValue(false);
    // Rejected outright, so the loop rewrites: the requested edit is already in
    // the draft, and a revision that repairs quality by undoing it delivers the
    // page the reader started from.
    strategy.reviewPageDraft.mockResolvedValue(report(40));

    await rewritePageForUserRequest(rewriteOptions());

    const briefings = strategy.revisePageDraft.mock.calls
      .slice(1)
      .map((call) => (call[0] as { report: { requiredRevisions: string[] } }).report.requiredRevisions);
    expect(briefings.length).toBeGreaterThan(0);
    for (const briefing of briefings) {
      expect(briefing).toContain("Keep the user's requested edit applied: make page 3 more dramatic");
    }
  });

  it("builds no auditor with the gate off, or with nothing pinned to compare against", async () => {
    mocks.qualityEnabled.mockImplementation((feature: string) => feature === "styleExcerpts");
    mocks.loadStyleLockPages.mockResolvedValue([priorPage(1), priorPage(2)]);
    strategy.reviewPageDraft.mockResolvedValue(report(85, true));

    // Excerpts pinned, auditor gate off: the rewrite is still anchored.
    const anchored = await rewritePageForUserRequest(rewriteOptions());

    expect(mocks.auditPageStyle).not.toHaveBeenCalled();
    expect(revisedWith()).toEqual([priorPage(1).markdown, priorPage(2).markdown]);
    expect(anchored.qualityReport).not.toHaveProperty("stylePenalty");

    // Auditor gate on, excerpts gate off: nothing is even loaded to pin.
    vi.clearAllMocks();
    mocks.qualityEnabled.mockImplementation((feature: string) => feature === "styleAuditor");
    mocks.prisma.page.findMany.mockResolvedValue([priorPage(11)]);
    strategy.revisePageDraft.mockResolvedValue(draftNamed("Rewrite"));
    strategy.reviewPageDraft.mockResolvedValue(report(85, true));
    await rewritePageForUserRequest(rewriteOptions());

    expect(mocks.loadStyleLockPages).not.toHaveBeenCalled();
    expect(mocks.auditPageStyle).not.toHaveBeenCalled();
  });

  it("carries a failed audit's penalty and issues into the report it returns", async () => {
    mocks.qualityEnabled.mockImplementation(
      (feature: string) => feature === "styleExcerpts" || feature === "styleAuditor"
    );
    mocks.loadStyleLockPages.mockResolvedValue([priorPage(1), priorPage(2)]);
    // Approved once, then rejected: the audited draft stays the keeper, so its
    // report is the one the edit is saved on.
    strategy.reviewPageDraft.mockResolvedValueOnce(report(85, true)).mockResolvedValue(report(40));
    mocks.auditPageStyle.mockResolvedValue({
      styleOk: false,
      styleIssues: ["Register drifts into lecture mode.", "Rhythm ignores the opening."]
    });

    const result = await rewritePageForUserRequest(rewriteOptions());

    expect(result.qualityReport).toMatchObject({ approved: false, score: 85, stylePenalty: 30 });
    expect(result.qualityReport.issues).toContain("Register drifts into lecture mode.");
    expect(result.qualityReport.requiredRevisions).toContain("Revise style: Register drifts into lecture mode.");
  });

  it("spends at most two style audits on a page, and gives the next page a fresh budget", async () => {
    // The reviewer approves every rewrite and the audit rejects every one, so
    // nothing but the counter can stop the two gates trading provider calls.
    mocks.qualityEnabled.mockImplementation(
      (feature: string) => feature === "styleExcerpts" || feature === "styleAuditor"
    );
    mocks.loadStyleLockPages.mockResolvedValue([priorPage(1), priorPage(2)]);
    strategy.reviewPageDraft.mockResolvedValue(report(85, true));
    mocks.auditPageStyle.mockResolvedValue({ styleOk: false, styleIssues: ["Register drifts."] });

    const first = await rewritePageForUserRequest(rewriteOptions());

    // Two, then the third approval stands unaudited and ends the loop.
    expect(mocks.auditPageStyle).toHaveBeenCalledTimes(2);
    expect(first.qualityReport).not.toHaveProperty("stylePenalty");

    // The closure is built once per rewrite, so the next page pays its own.
    await rewritePageForUserRequest(rewriteOptions());

    expect(mocks.auditPageStyle).toHaveBeenCalledTimes(4);
  });
});

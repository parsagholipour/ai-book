import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  prisma: {
    page: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    planVersion: { findUnique: vi.fn() },
    continuityNote: { findMany: vi.fn(), createMany: vi.fn() }
  },
  reviewPageDraft: vi.fn(),
  generatePageDraft: vi.fn(),
  revisePageDraft: vi.fn(),
  enqueueNextPageIfReady: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  enqueueWorkerJob: vi.fn(),
  storeEmbedding: vi.fn(),
  loadEntityStateLines: vi.fn(async () => [] as string[]),
  loadProjectStoryState: vi.fn(async () => ({
    promises: [] as Array<Record<string, unknown>>,
    facts: [] as Array<Record<string, unknown>>,
    entities: {},
    unanswered: [] as string[]
  })),
  strategyOverrides: { shouldIllustratePage: (): boolean => false },
  inputForPlanVersion: vi.fn(() => ({ mediaSettings: {} })),
  generateBestOfPageDrafts: vi.fn(
    async (options: { draftPage: (opts: unknown) => Promise<unknown>; baseOptions: unknown }) =>
      options.draftPage(options.baseOptions)
  ),
  qualityEnabled: vi.fn((_feature?: string) => false)
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("../runtime/dispatch.js", () => ({
  enqueueNextPageIfReady: mocks.enqueueNextPageIfReady,
  enqueueWorkerJob: mocks.enqueueWorkerJob,
  maybeEnqueueCompile: mocks.maybeEnqueueCompile
}));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn(), updateJobProgress: vi.fn() }));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ text: {}, embedding: {} }) }));
vi.mock("../generation/semanticMemory.js", () => ({
  RECENT_PAGE_WINDOW: 6,
  embedSemanticQuery: async () => undefined,
  loadEntityStateLines: mocks.loadEntityStateLines,
  retrieveSemanticPageMemory: async () => [],
  retrieveSemanticResearchNotes: async () => [],
  storeEmbedding: mocks.storeEmbedding,
  updateEntityStateFromPage: vi.fn()
}));
vi.mock("../generation/generationContext.js", () => ({
  loadContinuityNotes: async () => [],
  loadResearchNotesForGeneration: async () => []
}));
vi.mock("../generation/projectInput.js", () => ({ inputForPlanVersion: mocks.inputForPlanVersion }));
vi.mock("../generation/bookHelpers.js", () => ({
  formatQualityFailure: () => "",
  getProjectOrThrow: async () => ({ id: "project-1" }),
  parseChapterBrief: () => undefined,
  strategyForInput: () => ({
    generatePageDraft: mocks.generatePageDraft,
    reviewPageDraft: mocks.reviewPageDraft,
    revisePageDraft: mocks.revisePageDraft,
    shouldIllustratePage: (...args: unknown[]) =>
      (mocks.strategyOverrides.shouldIllustratePage as (...args: unknown[]) => boolean)(...args)
  }),
  toPriorPageContext: (page: unknown) => page
}));
// Three candidates keep the test loop short; the real ceiling only changes how
// many rewrites run, not which draft is kept. The review loop itself is the
// real runPageQualityLoop — only the strategy underneath is mocked.
vi.mock("../generation/tuning.js", () => ({
  MAX_PAGE_QA_CANDIDATES: 3,
  MAX_PAGE_QA_REWRITE_ATTEMPTS: 2,
  MAX_PAGE_REVISE_RESTARTS: 1,
  PAGE_QA_RECOVERY_CANDIDATE: 4
}));
vi.mock("../generation/qualitySettings.js", () => ({
  loadQualityContext: async () => ({
    settings: {},
    tier: "balanced",
    enabled: (feature: string) => mocks.qualityEnabled(feature)
  }),
  applyPlanThinkingBoost: vi.fn()
}));
vi.mock("../generation/storyStateStore.js", () => ({
  loadProjectStoryState: mocks.loadProjectStoryState,
  persistPageStoryDelta: vi.fn(),
  rebuildProjectStoryState: vi.fn(),
  seedProjectStoryState: vi.fn()
}));
vi.mock("../generation/qualityEnrichment.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/qualityEnrichment.js")>(
    "../generation/qualityEnrichment.js"
  );
  return {
    ...actual,
    enrichPageQualityReport: async ({ report }: { report: unknown }) => ({
      report,
      extract: null,
      storyState: { promises: [], facts: [], entities: {}, unanswered: [] },
      styleExcerpts: []
    }),
    persistKeeperStoryDelta: vi.fn()
  };
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    generateBestOfPageDrafts: mocks.generateBestOfPageDrafts,
    bookPlanSchema: { parse: () => ({ premise: "A tale.", chapters: [] }) },
    createProviders: () => ({})
  };
});

import { generatePage } from "./generatePage.js";

const draftNamed = (name: string) => ({
  title: name,
  markdown: `${name} text.`,
  summary: `${name} summary.`,
  imagePrompt: null,
  continuityNotes: []
});

const report = (score: number) => ({ approved: false, score, issues: [], requiredRevisions: [], notes: "" });

const job = { id: "job-1", data: { projectId: "project-1", pageId: "page-1", planId: "plan-1" } } as unknown as Job;

describe("generatePage quality loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadEntityStateLines.mockResolvedValue([]);
    mocks.loadProjectStoryState.mockResolvedValue({
      promises: [],
      facts: [],
      entities: {},
      unanswered: []
    });
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-1",
      index: 1,
      chapterId: null,
      chapter: null
    });
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", inputSnapshot: {}, planningPackage: {} });
    mocks.prisma.page.findMany.mockResolvedValue([]);
    mocks.prisma.continuityNote.findMany.mockResolvedValue([]);
    mocks.prisma.page.update.mockResolvedValue({});
    mocks.strategyOverrides.shouldIllustratePage = () => false;
    mocks.inputForPlanVersion.mockReturnValue({ mediaSettings: {} });
    mocks.generateBestOfPageDrafts.mockImplementation(
      async (options: { draftPage: (opts: unknown) => Promise<unknown>; baseOptions: unknown }) =>
        options.draftPage(options.baseOptions)
    );
    mocks.qualityEnabled.mockReturnValue(false);
  });
  afterEach(() => vi.clearAllMocks());

  it("saves the highest-scoring draft when no rewrite is approved, not the last one", async () => {
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.revisePageDraft
      .mockResolvedValueOnce(draftNamed("Second"))
      .mockResolvedValueOnce(draftNamed("Third"));
    // Scores 40 → 70 → 55: the sixth-rewrite-worse-than-second shape in miniature.
    mocks.reviewPageDraft
      .mockResolvedValueOnce(report(40))
      .mockResolvedValueOnce(report(70))
      .mockResolvedValueOnce(report(55));

    await generatePage(job);

    const failedSave = mocks.prisma.page.update.mock.calls
      .map((call) => (call[0] as { data: Record<string, unknown> }).data)
      .find((data) => data.status === "FAILED_QA");
    expect(failedSave).toMatchObject({
      title: "Second",
      markdown: "Second text.",
      revision: 2
    });
    expect((failedSave!.qualityReport as { score: number }).score).toBe(70);
    expect(mocks.enqueueNextPageIfReady).toHaveBeenCalledWith("project-1", "plan-1", expect.anything());
  });

  it("saves an approved draft as-is", async () => {
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    const completedSave = mocks.prisma.page.update.mock.calls
      .map((call) => (call[0] as { data: Record<string, unknown> }).data)
      .find((data) => data.status === "COMPLETED");
    expect(completedSave).toMatchObject({ title: "First", revision: 1 });
    expect(mocks.revisePageDraft).not.toHaveBeenCalled();
  });

  it("queues the illustration before saving the page as COMPLETED", async () => {
    // A sibling page's maybeEnqueueCompile call must never observe this page
    // as terminal with no open image job behind it — the image job has to
    // exist strictly before the COMPLETED write lands.
    mocks.strategyOverrides.shouldIllustratePage = () => true;
    mocks.generatePageDraft.mockResolvedValue({ ...draftNamed("First"), imagePrompt: "A robin on a branch" });
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });
    const callOrder: string[] = [];
    mocks.enqueueWorkerJob.mockImplementation(async () => callOrder.push("enqueue-image"));
    mocks.prisma.page.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      if (data.status === "COMPLETED") {
        callOrder.push("save-completed");
      }
      return {};
    });

    await generatePage(job);

    expect(callOrder).toEqual(["enqueue-image", "save-completed"]);
    expect(mocks.enqueueWorkerJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "GENERATE_IMAGE",
        payload: { pageId: "page-1", planId: "plan-1", prompt: "A robin on a branch" }
      })
    );
  });

  it("does not enqueue an illustration for a page the strategy won't illustrate", async () => {
    mocks.strategyOverrides.shouldIllustratePage = () => false;
    mocks.generatePageDraft.mockResolvedValue({ ...draftNamed("First"), imagePrompt: "A robin on a branch" });
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    expect(mocks.enqueueWorkerJob).not.toHaveBeenCalled();
  });

  it("passes both entity-state and story-state lines into the page draft", async () => {
    mocks.loadEntityStateLines.mockResolvedValue(["Jack (protagonist) — as of page 3: at Oakhaven"]);
    mocks.loadProjectStoryState.mockResolvedValue({
      promises: [{ id: "p1", text: "Find the seal", status: "open", openedAtPage: 1 }],
      facts: [],
      entities: {},
      unanswered: []
    });
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    expect(mocks.generatePageDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        entityState: [
          "Jack (protagonist) — as of page 3: at Oakhaven",
          "Promise p1 [open]: Find the seal"
        ]
      })
    );
  });

  it("still best-ofs sequential drafts when draftCandidates is 2 even if quality bestOfPolish is off", async () => {
    mocks.inputForPlanVersion.mockReturnValue({ mediaSettings: { draftCandidates: 2 } });
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    expect(mocks.generateBestOfPageDrafts).toHaveBeenCalledWith(
      expect.objectContaining({ candidateCount: 2 })
    );
    expect(mocks.generatePageDraft).toHaveBeenCalled();
  });

  it("loads pages 1 and 2 for style excerpts when the recency window has dropped them", async () => {
    mocks.qualityEnabled.mockImplementation((feature?: string) => feature === "styleExcerpts");
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-21",
      index: 21,
      chapterId: null,
      chapter: null
    });
    const recencyPages = Array.from({ length: 18 }, (_, offset) =>
      completedPage(offset + 3, `late-${offset + 3}`)
    );
    const styleLockPages = [completedPage(1, "opening-voice"), completedPage(2, "second-voice")];
    mocks.prisma.page.findMany.mockImplementation(
      async (args: { where?: { index?: { lt?: number; in?: number[] } }; take?: number }) => {
        if (args.take === 18) {
          return recencyPages;
        }
        const wanted = args.where?.index?.in ?? [];
        return styleLockPages.filter((page) => wanted.includes(page.index));
      }
    );
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    expect(mocks.prisma.page.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ index: { in: [1, 2] } }) })
    );
    expect(mocks.generatePageDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        previousPages: recencyPages,
        styleExcerpts: [
          expect.stringContaining("opening-voice"),
          expect.stringContaining("second-voice")
        ]
      })
    );
    const draftArgs = mocks.generatePageDraft.mock.calls[0]?.[0] as {
      previousPages: Array<{ index: number }>;
      styleExcerpts: string[];
    };
    expect(draftArgs.previousPages.map((page) => page.index)).toEqual(
      recencyPages.map((page) => page.index)
    );
    expect(draftArgs.styleExcerpts.join(" ")).not.toMatch(/late-17|late-18/);
  });

  it("does not reload pages 1 and 2 when they are already in the recency window", async () => {
    mocks.qualityEnabled.mockImplementation((feature?: string) => feature === "styleExcerpts");
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-5",
      index: 5,
      chapterId: null,
      chapter: null
    });
    const recencyPages = [completedPage(1, "opening-voice"), completedPage(2, "second-voice"), completedPage(3, "third"), completedPage(4, "fourth")];
    mocks.prisma.page.findMany.mockResolvedValue(recencyPages);
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    expect(mocks.prisma.page.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.generatePageDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        previousPages: recencyPages,
        styleExcerpts: [
          expect.stringContaining("opening-voice"),
          expect.stringContaining("second-voice")
        ]
      })
    );
  });
});

function completedPage(index: number, voice: string) {
  return {
    index,
    title: `Page ${index}`,
    markdown: `${voice} ${"prose ".repeat(20)}`,
    summary: `Summary ${index}`
  };
}

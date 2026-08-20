import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  prisma: {
    page: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    planVersion: { findUnique: vi.fn() },
    continuityNote: { findMany: vi.fn(), createMany: vi.fn() }
  },
  // `beforePageIndex` is optional *here* only so a stand-in can show what an
  // unbounded retrieval would have answered; the real signature requires it.
  retrieveSemanticPageMemory: vi.fn(
    async (_options: { beforePageIndex?: number; excludePageIndexes: number[] }) => [] as string[]
  ),
  reviewPageDraft: vi.fn(),
  generatePageDraft: vi.fn(),
  revisePageDraft: vi.fn(),
  enqueueNextPageIfReady: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  enqueueWorkerJob: vi.fn(),
  storeEmbedding: vi.fn(),
  loadContinuityNotes: vi.fn(),
  loadResearchNotesForGeneration: vi.fn(),
  embedSemanticQuery: vi.fn(),
  lexicalTermsForQuery: vi.fn(),
  repairPageEmbeddings: vi.fn(),
  loadQualityContext: vi.fn(),
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

vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  Prisma: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../runtime/dispatch.js", () => ({
  enqueueNextPageIfReady: mocks.enqueueNextPageIfReady,
  enqueueWorkerJob: mocks.enqueueWorkerJob,
  maybeEnqueueCompile: mocks.maybeEnqueueCompile
}));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn(), updateJobProgress: vi.fn() }));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ text: {}, embedding: {} }) }));
vi.mock("../generation/embeddingRepair.js", () => ({ repairPageEmbeddings: mocks.repairPageEmbeddings }));
vi.mock("../generation/embeddingWrites.js", () => ({ storeEmbedding: mocks.storeEmbedding }));
vi.mock("../generation/entityState.js", () => ({
  loadEntityStateLines: mocks.loadEntityStateLines,
  updateEntityStateFromPage: vi.fn()
}));
vi.mock("../generation/researchMemory.js", () => ({ retrieveSemanticResearchNotes: async () => [] }));
vi.mock("../generation/semanticRecall.js", () => ({
  RECENT_PAGE_WINDOW: 6,
  embedSemanticQuery: mocks.embedSemanticQuery,
  lexicalTermsForQuery: mocks.lexicalTermsForQuery,
  retrieveSemanticPageMemory: mocks.retrieveSemanticPageMemory
}));
vi.mock("../generation/generationContext.js", () => ({
  loadContinuityNotes: mocks.loadContinuityNotes,
  loadResearchNotesForGeneration: mocks.loadResearchNotesForGeneration
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
  loadQualityContext: mocks.loadQualityContext,
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
// The mocked window (6 above), so the recency load is discriminated by the
// constant the handler passes rather than by a copy of its value.
import { RECENT_PAGE_WINDOW } from "../generation/semanticRecall.js";
// Not mocked: the handler's own stop-request test has to be the real one, or a
// suite could pass while a stop was being masked by a sibling's failure.
import { StopRequestedError } from "../runtime/jobTypes.js";

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
    mocks.prisma.page.findFirst.mockResolvedValue(null);
    mocks.prisma.continuityNote.findMany.mockResolvedValue([]);
    mocks.loadContinuityNotes.mockResolvedValue([]);
    mocks.loadResearchNotesForGeneration.mockResolvedValue([]);
    mocks.embedSemanticQuery.mockResolvedValue(undefined);
    mocks.lexicalTermsForQuery.mockReturnValue([]);
    mocks.repairPageEmbeddings.mockResolvedValue(undefined);
    mocks.loadQualityContext.mockImplementation(async () => qualityContextStub());
    // clearAllMocks keeps implementations, so restore the default here rather
    // than leaking one test's stand-in retrieval into the next.
    mocks.retrieveSemanticPageMemory.mockImplementation(async () => []);
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

  it("owns new continuity notes by the stable page id", async () => {
    mocks.generatePageDraft.mockResolvedValue({
      ...draftNamed("First"),
      continuityNotes: ["Pip keeps the brass key."]
    });
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    expect(mocks.prisma.continuityNote.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ pageId: "page-1", scope: "page:1", body: "Pip keeps the brass key." })]
    });
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

  it("does not best-of sequential drafts when quality bestOfPolish is off even if draftCandidates is 2", async () => {
    mocks.inputForPlanVersion.mockReturnValue({ mediaSettings: { draftCandidates: 2 } });
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    expect(mocks.generateBestOfPageDrafts).not.toHaveBeenCalled();
    expect(mocks.generatePageDraft).toHaveBeenCalled();
  });

  it("best-ofs sequential drafts when bestOfPolish is on and draftCandidates is 2", async () => {
    mocks.qualityEnabled.mockImplementation((feature?: string) => feature === "bestOfPolish");
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
        if (args.take === RECENT_PAGE_WINDOW) {
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

  it("clamps lookupStoredPage to earlier completed pages and excludes this page from memory search", async () => {
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-10",
      index: 10,
      chapterId: null,
      chapter: null
    });
    mocks.prisma.page.findFirst.mockResolvedValue({
      index: 9,
      title: "Earlier",
      summary: "Earlier summary",
      markdown: "Earlier markdown"
    });
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    const draftArgs = mocks.generatePageDraft.mock.calls[0]?.[0] as {
      lookupStoredPage: (index: number) => Promise<unknown>;
      searchStoredMemory: (query: string) => Promise<string[]>;
    };

    await expect(draftArgs.lookupStoredPage(9)).resolves.toEqual({
      index: 9,
      title: "Earlier",
      summary: "Earlier summary",
      markdown: "Earlier markdown"
    });
    expect(mocks.prisma.page.findFirst).toHaveBeenCalledWith({
      where: { projectId: "project-1", index: 9, status: "COMPLETED" },
      select: { index: true, title: true, summary: true, markdown: true }
    });

    mocks.prisma.page.findFirst.mockClear();
    await expect(draftArgs.lookupStoredPage(10)).resolves.toBeNull();
    await expect(draftArgs.lookupStoredPage(11)).resolves.toBeNull();
    expect(mocks.prisma.page.findFirst).not.toHaveBeenCalled();

    mocks.retrieveSemanticPageMemory.mockClear();
    await draftArgs.searchStoredMemory("brass key");
    expect(mocks.retrieveSemanticPageMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        queryText: "brass key",
        excludePageIndexes: expect.arrayContaining([10]),
        beforePageIndex: 10
      })
    );
  });

  /**
   * The retry shape: page 30 is redrafted after FAILED_QA, so pages after it
   * are already COMPLETED and embedded. `search_memory` is described to the
   * model as "earlier pages of this book", so it has to be clamped exactly
   * like `lookupStoredPage` — the page-memory retrieval is bounded, not the
   * hits filtered afterwards, which is why the stand-in below honours
   * `beforePageIndex` the way the SQL does (`packages/db/src/hybridRetrieval.test.ts`).
   */
  it("never lets search_memory or the context pack reach a page after this one", async () => {
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-30",
      index: 30,
      chapterId: null,
      chapter: null
    });
    const embedded = [
      { index: 29, text: "The vault stands sealed." },
      { index: 41, text: "The vault opens and the archive burns." }
    ];
    mocks.retrieveSemanticPageMemory.mockImplementation(async (options) =>
      embedded
        .filter(
          (row) =>
            row.index < (options.beforePageIndex ?? Number.POSITIVE_INFINITY) &&
            !options.excludePageIndexes.includes(row.index)
        )
        .map((row) => `Page ${row.index}: ${row.text}`)
    );
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    const draftArgs = mocks.generatePageDraft.mock.calls[0]?.[0] as {
      semanticMemory: string[];
      searchStoredMemory: (query: string) => Promise<string[]>;
    };

    expect(draftArgs.semanticMemory).toEqual(["Page 29: The vault stands sealed."]);
    await expect(draftArgs.searchStoredMemory("the vault")).resolves.toEqual([
      "Page 29: The vault stands sealed."
    ]);
    expect(mocks.retrieveSemanticPageMemory).toHaveBeenLastCalledWith(
      expect.objectContaining({ queryText: "the vault", beforePageIndex: 30 })
    );
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

  /**
   * The page critical path used to be one strictly serial await chain, and
   * four of its steps read nothing the others write. They are one fan-out now,
   * so the assertion that matters is that they are genuinely *in flight*
   * together — a regression back to one await at a time still produces the
   * same values, and every other test in this file would still pass.
   */
  it("issues the independent context loads together, not one await at a time", async () => {
    const barrier = concurrencyBarrier(6);
    mocks.prisma.page.findMany.mockImplementation(async (args: { take?: number }) => {
      if (args?.take === RECENT_PAGE_WINDOW) {
        await barrier.arrive("previousPages");
      }
      return [];
    });
    mocks.loadContinuityNotes.mockImplementation(async () => {
      await barrier.arrive("continuityNotes");
      return [];
    });
    mocks.embedSemanticQuery.mockImplementation(async () => {
      await barrier.arrive("queryVector");
      return [0.25];
    });
    mocks.loadEntityStateLines.mockImplementation(async () => {
      await barrier.arrive("entityState");
      return [];
    });
    mocks.loadQualityContext.mockImplementation(async () => {
      await barrier.arrive("quality");
      return qualityContextStub();
    });
    mocks.loadProjectStoryState.mockImplementation(async () => {
      await barrier.arrive("storyState");
      return emptyStoryState();
    });
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    try {
      await generatePage(job);
    } finally {
      barrier.dispose();
    }

    expect(barrier.timedOut).toBe(false);
    expect([...barrier.inFlightTogether].sort()).toEqual([
      "continuityNotes",
      "entityState",
      "previousPages",
      "quality",
      "queryVector",
      "storyState"
    ]);
  });

  /**
   * The other half of the same change: what is left serial is serial because
   * it has to be. The research retrieval and the page-memory retrieval both
   * spend the one embedded vector, and the repair pass writes the very
   * embedding rows the retrieval reads, so it may never be moved beside it.
   */
  it("keeps the vector, the embedding repair and the memory retrieval in dependency order", async () => {
    const order: string[] = [];
    mocks.prisma.page.findUnique.mockResolvedValue({
      id: "page-10",
      index: 10,
      chapterId: null,
      chapter: null
    });
    mocks.embedSemanticQuery.mockImplementation(async () => {
      order.push("embed");
      return [0.5];
    });
    mocks.loadResearchNotesForGeneration.mockImplementation(async () => {
      order.push("research");
      return [];
    });
    mocks.repairPageEmbeddings.mockImplementation(async () => {
      order.push("repair");
    });
    mocks.retrieveSemanticPageMemory.mockImplementation(async () => {
      order.push("retrieve");
      return [];
    });
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    expect(order).toEqual(["embed", "research", "repair", "retrieve"]);
    expect(mocks.loadResearchNotesForGeneration).toHaveBeenCalledWith(
      "project-1",
      expect.anything(),
      undefined,
      expect.objectContaining({ vector: [0.5] })
    );
    // RECENT_PAGE_WINDOW is mocked to 6 above, so a page-10 job repairs below 4.
    expect(mocks.repairPageEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", beforeIndex: 4 })
    );
    expect(mocks.retrieveSemanticPageMemory).toHaveBeenCalledWith(
      expect.objectContaining({ vector: [0.5], beforePageIndex: 10 })
    );
  });

  it("hands the composed brief's needles to the continuity load", async () => {
    mocks.lexicalTermsForQuery.mockReturnValue(["Pip", "Oakhaven"]);
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    expect(mocks.lexicalTermsForQuery).toHaveBeenCalledWith(
      expect.objectContaining({ premise: "A tale." }),
      "A tale."
    );
    expect(mocks.loadContinuityNotes).toHaveBeenCalledWith("project-1", {
      queryTerms: ["Pip", "Oakhaven"],
      // And the page being drafted, which is the same clamp the page-memory
      // retrieval takes: a FAILED_QA redraft sits in a book whose later pages
      // have already written notes about this page's own cast.
      beforePageIndex: 1
    });
  });

  /**
   * `Promise.all` would report whichever load lost the race, and a stop request
   * is the one rejection several of these loads can raise at all — the rest of
   * their failures are caught and degraded. Masking it retries a run the reader
   * already cancelled, on their credits.
   */
  it("aborts with the stop request even when a sibling load rejected first", async () => {
    const stopped = new StopRequestedError();
    mocks.loadQualityContext.mockRejectedValue(new Error("connection terminated unexpectedly"));
    mocks.loadProjectStoryState.mockImplementation(async () => {
      throw stopped;
    });

    await expect(generatePage(job)).rejects.toBe(stopped);
    expect(mocks.generatePageDraft).not.toHaveBeenCalled();
  });

  it("reports the failure the serial chain would have thrown when two loads fail", async () => {
    // Quality rejects first in wall-clock terms; continuity came first in the
    // chain this fan-out replaced, so it is the failure the job must report.
    mocks.loadQualityContext.mockRejectedValue(new Error("quality settings unavailable"));
    mocks.loadContinuityNotes.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("continuity notes unavailable");
    });

    await expect(generatePage(job)).rejects.toThrow("continuity notes unavailable");
  });

  it("waits for every independent load to settle before failing the job", async () => {
    let entityStateSettled = false;
    mocks.loadQualityContext.mockRejectedValue(new Error("quality settings unavailable"));
    mocks.loadEntityStateLines.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      entityStateSettled = true;
      return [];
    });

    await expect(generatePage(job)).rejects.toThrow("quality settings unavailable");
    // Promise.all would have thrown out of the handler with this one still
    // running, leaving its warn line or its write behind the job's settlement.
    expect(entityStateSettled).toBe(true);
    expect(mocks.generatePageDraft).not.toHaveBeenCalled();
  });
});

function qualityContextStub() {
  return {
    settings: {} as Record<string, unknown>,
    tier: "balanced",
    enabled: (feature: string): boolean => mocks.qualityEnabled(feature)
  };
}

function emptyStoryState() {
  return {
    promises: [] as Array<Record<string, unknown>>,
    facts: [] as Array<Record<string, unknown>>,
    entities: {},
    unanswered: [] as string[]
  };
}

/**
 * Releases only once `expected` participants have arrived, so a load that waits
 * on it can get past only by being in flight beside the others. The timeout is
 * the safety valve: a chain that went back to one await at a time would
 * otherwise deadlock the test instead of failing it, so the gate opens, records
 * that it had to, and lets `timedOut` carry the verdict.
 */
function concurrencyBarrier(expected: number, timeoutMs = 250) {
  const arrived: string[] = [];
  let inFlightTogether: string[] = [];
  let timedOut = false;
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    inFlightTogether = [...arrived];
    release();
  }, timeoutMs);
  return {
    get timedOut(): boolean {
      return timedOut;
    },
    get inFlightTogether(): string[] {
      return inFlightTogether;
    },
    async arrive(name: string): Promise<void> {
      arrived.push(name);
      if (arrived.length >= expected) {
        clearTimeout(timer);
        inFlightTogether = [...arrived];
        release();
      }
      await released;
    },
    dispose(): void {
      clearTimeout(timer);
      release();
    }
  };
}

function completedPage(index: number, voice: string) {
  return {
    index,
    title: `Page ${index}`,
    markdown: `${voice} ${"prose ".repeat(20)}`,
    summary: `Summary ${index}`
  };
}

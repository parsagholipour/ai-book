import { vi } from "vitest";
import type { Job } from "bullmq";
import { dbScopeMocks } from "../../testing/dbScopeMocks.js";
import { balancedPagePipelineQualityContext } from "../../testing/qualityGateFixtures.js";

/**
 * Module mocks and fixtures shared by the `generatePage*.test.ts` suites.
 *
 * `generatePage.ts` has two halves that are tested apart — the context a page is
 * drafted from (`generatePageContext.test.ts`) and what becomes of the draft
 * (`generatePage.test.ts`) — but one handler, so both suites have to stand the
 * same eighteen modules up. Kept here they stand them up identically, and a
 * mock that drifts cannot make one suite measure a handler the other one is not
 * running.
 *
 * This file keeps its runtime imports to `vitest` and the two dependency-free
 * helpers under `src/testing`; neither helper imports a runtime module. Vitest
 * calls the factories below from inside `vi.mock(...)`, and reaching any module
 * that transitively imports a mocked module from there deadlocks the mock
 * registry — the suite hangs instead of failing. The `bullmq` import above is
 * type-only and erased.
 */

export const mocks = {
  prisma: {
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(mocks.prisma)),
    page: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    imageAsset: { findMany: vi.fn(), deleteMany: vi.fn() },
    planVersion: { findUnique: vi.fn() },
    chapter: { findUnique: vi.fn(), updateMany: vi.fn() },
    continuityNote: { findMany: vi.fn(), createMany: vi.fn() }
  },
  // `beforePageIndex` is optional *here* only so a stand-in can show what an
  // unbounded retrieval would have answered; the real signature requires it.
  retrieveSemanticPageMemory: vi.fn(
    async (_options: { beforePageIndex?: number; excludePageIndexes: number[] }) => [] as string[]
  ),
  reviewPageDraft: vi.fn(),
  parseChapterBrief: vi.fn((_value?: unknown): unknown => undefined),
  generatePageDraft: vi.fn(),
  revisePageDraft: vi.fn(),
  advanceJobStep: vi.fn(),
  enqueueNextPageIfReady: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  enqueueWorkerJob: vi.fn(),
  storeEmbedding: vi.fn(),
  loadContinuityNotes: vi.fn(),
  loadResearchNotesForGeneration: vi.fn(),
  retrieveSemanticResearchNotes: vi.fn(),
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
  qualityEnabled: vi.fn((_feature?: string) => false),
  pageQualityEnabled: vi.fn((_feature?: string) => true),
  // The gate review the handler calls. A generated page gets its local checks
  // only, so the suites decide the verdict through `reviewPageDraft` here, the
  // way they always have, rather than through real local checks on fixture prose.
  reviewPage: vi.fn(async (options: { reviewOptions: unknown }) => mocks.reviewPageDraft(options.reviewOptions)),
  // The style audit's provider boundary; `withStyleAudit` above it stays real.
  auditPageStyle: vi.fn()
};

export const dbModuleMock = () => ({ prisma: mocks.prisma, Prisma: {}, ...dbScopeMocks() });

export const dispatchModuleMock = () => ({
  enqueueNextPageIfReady: mocks.enqueueNextPageIfReady,
  enqueueWorkerJob: mocks.enqueueWorkerJob,
  maybeEnqueueCompile: mocks.maybeEnqueueCompile
});

export const jobLifecycleModuleMock = () => ({ advanceJobStep: mocks.advanceJobStep, updateJobProgress: vi.fn() });

export const configModuleMock = () => ({ config: {} });

export const loggedAdaptersModuleMock = () => ({ createLoggedProviders: () => ({ text: {}, embedding: {} }) });

export const embeddingRepairModuleMock = () => ({ repairPageEmbeddings: mocks.repairPageEmbeddings });

export const embeddingWritesModuleMock = () => ({ storeEmbedding: mocks.storeEmbedding });

export const entityStateModuleMock = () => ({
  loadEntityStateLines: mocks.loadEntityStateLines,
  updateEntityStateFromPage: vi.fn()
});

export const researchMemoryModuleMock = () => ({
  retrieveSemanticResearchNotes: mocks.retrieveSemanticResearchNotes
});

export const semanticRecallModuleMock = () => ({
  RECENT_PAGE_WINDOW: 6,
  embedSemanticQuery: mocks.embedSemanticQuery,
  lexicalTermsForQuery: mocks.lexicalTermsForQuery,
  retrieveSemanticPageMemory: mocks.retrieveSemanticPageMemory
});

export const generationContextModuleMock = () => ({
  loadContinuityNotes: mocks.loadContinuityNotes,
  loadResearchNotesForGeneration: mocks.loadResearchNotesForGeneration
});

export const projectInputModuleMock = () => ({ inputForPlanVersion: mocks.inputForPlanVersion });

/**
 * The real style-lock loader is kept: the "loads pages 1 and 2" case measures
 * the query it makes against the mocked prisma, not a restatement of it.
 */
export const bookHelpersModuleMock = (actual: typeof import("../../generation/bookHelpers.js")) => ({
  formatQualityFailure: () => "",
  getProjectOrThrow: async () => ({ id: "project-1", currentPlanId: "plan-1" }),
  loadStyleLockPages: actual.loadStyleLockPages,
  styleExcerptsForPage: actual.styleExcerptsForPage,
  parseChapterBrief: mocks.parseChapterBrief,
  strategyForInput: () => ({
    generatePageDraft: mocks.generatePageDraft,
    reviewPageDraft: mocks.reviewPageDraft,
    revisePageDraft: mocks.revisePageDraft,
    shouldIllustratePage: (...args: unknown[]) =>
      (mocks.strategyOverrides.shouldIllustratePage as (...args: unknown[]) => boolean)(...args)
  }),
  toPriorPageContext: (page: unknown) => page
});

/**
 * One revise restart over the real module, not instead of it: hand-listing the
 * exports failed both suites with "No export is defined on the mock" the first
 * time one was added, rather than with anything about the code under test.
 */
export const tuningModuleMock = (actual: typeof import("../../generation/tuning.js")) => ({
  ...actual,
  MAX_PAGE_REVISE_RESTARTS: 1
});

export const qualitySettingsModuleMock = () => ({
  loadQualityContext: mocks.loadQualityContext,
  applyPlanThinkingBoost: vi.fn()
});

export const storyStateStoreModuleMock = () => ({
  loadProjectStoryState: mocks.loadProjectStoryState,
  persistPageStoryDelta: vi.fn(),
  rebuildProjectStoryState: vi.fn(),
  seedProjectStoryState: vi.fn()
});

export const qualityEnrichmentModuleMock = (
  actual: typeof import("../../generation/qualityEnrichment.js")
) => ({
  ...actual,
  persistKeeperStoryDelta: vi.fn()
});

export const pageQualityGateReviewModuleMock = (
  actual: typeof import("../../generation/pageQualityGateReview.js")
) => ({
  ...actual,
  reviewPageWithQualityGates: mocks.reviewPage
});

export const coreModuleMock = (actual: typeof import("@book-maker/core")) => ({
  ...actual,
  auditPageStyle: mocks.auditPageStyle,
  bookPlanSchema: { parse: () => ({ premise: "A tale.", chapters: [] }) },
  createProviders: () => ({})
});

export const draftNamed = (name: string) => ({
  title: name,
  markdown: `${name} text.`,
  summary: `${name} summary.`,
  imagePrompt: null,
  continuityNotes: []
});

export const report = (score: number) => ({
  approved: false,
  score,
  issues: [],
  requiredRevisions: [],
  notes: ""
});

export const job = {
  id: "job-1",
  data: { projectId: "project-1", pageId: "page-1", planId: "plan-1" }
} as unknown as Job;

export function completedPage(index: number, voice: string) {
  return {
    index,
    title: `Page ${index}`,
    markdown: `${voice} ${"prose ".repeat(20)}`,
    summary: `Summary ${index}`
  };
}

export function qualityContextStub() {
  return balancedPagePipelineQualityContext({
    defaultFeatureEnabled: mocks.pageQualityEnabled,
    otherFeatureEnabled: mocks.qualityEnabled
  });
}

export function emptyStoryState() {
  return {
    promises: [] as Array<Record<string, unknown>>,
    facts: [] as Array<Record<string, unknown>>,
    entities: {},
    unanswered: [] as string[]
  };
}

/**
 * The default world a `generatePage` test starts from: page 1 of a plan with no
 * chapters, every load answering empty, every gate off. A test names only the
 * one thing it is about.
 */
export function resetGeneratePageMocks() {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(
    async (run: (tx: typeof mocks.prisma) => Promise<unknown>) => run(mocks.prisma)
  );
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
    chapter: null,
    status: "PENDING",
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    title: "First",
    markdown: "First text.",
    summary: "First summary.",
    imagePrompt: null,
    revision: 1
  });
  mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", inputSnapshot: {}, planningPackage: {} });
  mocks.prisma.page.findMany.mockResolvedValue([]);
  mocks.prisma.imageAsset.findMany.mockResolvedValue([]);
  mocks.prisma.page.findFirst.mockResolvedValue(null);
  mocks.prisma.continuityNote.findMany.mockResolvedValue([]);
  mocks.prisma.chapter.findUnique.mockResolvedValue(null);
  mocks.prisma.chapter.updateMany.mockResolvedValue({ count: 1 });
  mocks.parseChapterBrief.mockReturnValue(undefined);
  mocks.loadContinuityNotes.mockResolvedValue([]);
  mocks.loadResearchNotesForGeneration.mockResolvedValue([]);
  mocks.retrieveSemanticResearchNotes.mockResolvedValue([]);
  mocks.embedSemanticQuery.mockResolvedValue(undefined);
  mocks.lexicalTermsForQuery.mockReturnValue([]);
  mocks.repairPageEmbeddings.mockResolvedValue(undefined);
  mocks.loadQualityContext.mockImplementation(async () => qualityContextStub());
  // clearAllMocks keeps implementations, so restore the default here rather
  // than leaking one test's stand-in retrieval into the next.
  mocks.retrieveSemanticPageMemory.mockImplementation(async () => []);
  mocks.prisma.page.update.mockResolvedValue({});
  mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
  mocks.enqueueWorkerJob.mockResolvedValue({ id: "image-job" });
  mocks.strategyOverrides.shouldIllustratePage = () => false;
  mocks.inputForPlanVersion.mockReturnValue({ mediaSettings: {} });
  mocks.qualityEnabled.mockReturnValue(false);
  mocks.pageQualityEnabled.mockReturnValue(true);
  mocks.auditPageStyle.mockResolvedValue({ styleOk: true, styleIssues: [] });
}

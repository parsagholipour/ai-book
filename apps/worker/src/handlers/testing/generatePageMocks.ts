import { vi } from "vitest";
import type { Job } from "bullmq";
import { dbScopeMocks } from "../../testing/dbScopeMocks.js";

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
 * This file must import nothing but `vitest` at runtime. `dbScopeMocks` is the
 * one exception because it imports nothing at all, not even `vitest`. Vitest
 * calls the factories below from inside `vi.mock(...)`, and reaching any module
 * that transitively imports a mocked module from there deadlocks the mock
 * registry — the suite hangs instead of failing. The `bullmq` import above is
 * type-only and erased.
 */

export const mocks = {
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
  qualityEnabled: vi.fn((_feature?: string) => false),
  enrichPageQualityReport: vi.fn(),
  // The style audit's provider boundary; `withStyleAudit` above it stays real.
  auditPageStyle: vi.fn()
};

export const dbModuleMock = () => ({ prisma: mocks.prisma, Prisma: {}, ...dbScopeMocks() });

export const dispatchModuleMock = () => ({
  enqueueNextPageIfReady: mocks.enqueueNextPageIfReady,
  enqueueWorkerJob: mocks.enqueueWorkerJob,
  maybeEnqueueCompile: mocks.maybeEnqueueCompile
});

export const jobLifecycleModuleMock = () => ({ advanceJobStep: vi.fn(), updateJobProgress: vi.fn() });

export const configModuleMock = () => ({ config: {} });

export const loggedAdaptersModuleMock = () => ({ createLoggedProviders: () => ({ text: {}, embedding: {} }) });

export const embeddingRepairModuleMock = () => ({ repairPageEmbeddings: mocks.repairPageEmbeddings });

export const embeddingWritesModuleMock = () => ({ storeEmbedding: mocks.storeEmbedding });

export const entityStateModuleMock = () => ({
  loadEntityStateLines: mocks.loadEntityStateLines,
  updateEntityStateFromPage: vi.fn()
});

export const researchMemoryModuleMock = () => ({ retrieveSemanticResearchNotes: async () => [] });

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
  getProjectOrThrow: async () => ({ id: "project-1" }),
  loadStyleLockPages: actual.loadStyleLockPages,
  styleExcerptsForPage: actual.styleExcerptsForPage,
  parseChapterBrief: () => undefined,
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
 * Three candidates keep the test loop short; the real ceiling only changes how
 * many rewrites run, not which draft is kept. The review loop itself is the
 * real `runPageQualityLoop` — only the strategy underneath is mocked.
 */
export const tuningModuleMock = () => ({
  MAX_PAGE_QA_CANDIDATES: 3,
  MAX_PAGE_QA_REWRITE_ATTEMPTS: 2,
  MAX_PAGE_REVISE_RESTARTS: 1,
  PAGE_QA_RECOVERY_CANDIDATE: 4
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
  enrichPageQualityReport: mocks.enrichPageQualityReport,
  persistKeeperStoryDelta: vi.fn()
});

export const coreModuleMock = (actual: typeof import("@book-maker/core")) => ({
  ...actual,
  generateBestOfPageDrafts: mocks.generateBestOfPageDrafts,
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
  return {
    settings: {} as Record<string, unknown>,
    tier: "balanced",
    enabled: (feature: string): boolean => mocks.qualityEnabled(feature)
  };
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
  // The handler pins once and hands the same array to the draft, the
  // enrichment pass and the review loop — which is where the auditor is built
  // from — so the test below can assert all three by reference.
  mocks.enrichPageQualityReport.mockImplementation(async ({ report }: { report: unknown }) => ({
    report,
    extract: null,
    storyState: emptyStoryState()
  }));
  mocks.auditPageStyle.mockResolvedValue({ styleOk: true, styleIssues: [] });
}

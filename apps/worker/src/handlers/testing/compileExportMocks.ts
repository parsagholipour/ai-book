import { vi } from "vitest";
import type { Job } from "bullmq";
import type { QualityFeatureId, StoryState } from "@book-maker/core";
import { dbScopeMocks } from "../../testing/dbScopeMocks.js";

/**
 * Module mocks shared by the `compileExport*.test.ts` suites.
 *
 * This file must import nothing but `vitest` at runtime — the imports above are
 * type-only and erased. Vitest calls the factories below from inside
 * `vi.mock(...)`, and reaching any module that transitively imports a mocked
 * module from there deadlocks the mock registry.
 */

export const mocks = {
  prisma: {
    planVersion: { findUnique: vi.fn() },
    project: { findUnique: vi.fn(), update: vi.fn() },
    page: { update: vi.fn() },
    continuityNote: { findMany: vi.fn(), createMany: vi.fn() },
    generationJob: { update: vi.fn() }
  },
  revisePageDraftWithRestart: vi.fn(),
  pageReportFromFinalQa: vi.fn(),
  loadPagesForExport: vi.fn(),
  // The repair pins its style anchor through the shared loader, which answers
  // with COMPLETED pages only. Empty by default: the in-memory export set
  // already holds the book's opening pages whenever they are accepted.
  loadStyleLockPages: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
  storeEmbedding: vi.fn(),
  generateJsonWithRetry: vi.fn(),
  // Mutable so the whole-handler suite can point storage at a temp dir.
  config: { BOOK_STORAGE_DIR: "", IMAGE_STORAGE_DIR: "", PUBLIC_API_URL: "http://localhost:4001" },
  strategy: {
    executionMode: "whole-book",
    compileMarkdown: vi.fn(),
    // Delegates to the plain mocks so every existing assertion on
    // `compileMarkdown` / `generatePdf` keeps observing the handler unchanged.
    compileMarkdownWithPageAnchors: vi.fn((input: unknown) => ({
      markdown: mocks.strategy.compileMarkdown(input),
      pageAnchors: [],
      hasCoverPage: false,
      hasContents: false
    })),
    generatePdf: vi.fn(),
    generatePdfWithPageMap: vi.fn(async (markdown: unknown, options: Record<string, unknown>) => {
      const { pageMapPlan: _pageMapPlan, ...rest } = options;
      return { pdf: await mocks.strategy.generatePdf(markdown, rest) };
    }),
    runFinalBookQa: vi.fn()
  },
  inputForPlanVersion: vi.fn(),
  createReaderChaptersForExport: vi.fn(),
  generateBookEpub: vi.fn(),
  exportPublicationSuperseded: vi.fn(),
  pendingExportPaths: vi.fn(),
  publishCompiledExports: vi.fn(),
  discardPendingExports: vi.fn(),
  maybeEnqueueCharacterCandidatePreparation: vi.fn(),
  loadProjectStoryState: vi.fn(
    async (): Promise<StoryState> => ({ promises: [], facts: [], entities: {}, unanswered: [] })
  ),
  rebuildProjectStoryState: vi.fn(
    async (): Promise<StoryState> => ({ promises: [], facts: [], entities: {}, unanswered: [] })
  ),
  rebuildStoryStateFromPages: vi.fn(
    async (): Promise<StoryState> => ({ promises: [], facts: [], entities: {}, unanswered: [] })
  ),
  persistKeeperStoryDelta: vi.fn(),
  // The style audit's provider boundary. A suite that opts into the real
  // `revisedDraftStyleAuditor` runs the real `withStyleAudit` on top of this,
  // so the only thing standing in for a model is the audit verdict itself.
  auditPageStyle: vi.fn(
    async (_options: {
      markdown: string;
      styleExcerpts: string[];
    }): Promise<{ styleOk: boolean; styleIssues: string[] }> => ({ styleOk: true, styleIssues: [] })
  ),
  loadQualityContext: vi.fn(async () => ({
    settings: {},
    tier: "balanced" as const,
    enabled: (_feature: QualityFeatureId): boolean => false
  }))
};

export const dbModuleMock = () => ({
  prisma: mocks.prisma,
  Prisma: {},
  researchCitationsForExport: async () => [],
  ...dbScopeMocks()
});

export const configModuleMock = () => ({ config: mocks.config });

export const projectInputModuleMock = () => ({ inputForPlanVersion: mocks.inputForPlanVersion });

export const exportPublicationModuleMock = () => ({
  discardPendingExports: mocks.discardPendingExports,
  exportPublicationSuperseded: mocks.exportPublicationSuperseded,
  pendingExportPaths: mocks.pendingExportPaths,
  publishCompiledExports: mocks.publishCompiledExports
});

export const dispatchModuleMock = () => ({ parallelPageWaveSize: () => 1 });

export const jobLifecycleModuleMock = () => ({
  advanceJobStep: vi.fn(),
  editOperationIdFromJob: (job: Job) => (typeof job.data.operationId === "string" ? job.data.operationId : null),
  updateJobProgress: vi.fn()
});

export const loggedAdaptersModuleMock = () => ({ createLoggedProviders: () => ({ text: {}, embedding: {} }) });

export const embeddingWritesModuleMock = () => ({
  storeEmbedding: mocks.storeEmbedding,
  // Mirrors the real predicate so fixtures choose their mode explicitly.
  strategyUsesSemanticMemory: (strategy: { executionMode?: string }) => strategy?.executionMode === "sequential-pages"
});

export const charactersModuleMock = () => ({
  maybeEnqueueCharacterCandidatePreparation: mocks.maybeEnqueueCharacterCandidatePreparation
});

export const bookHelpersModuleMock = () => ({
  extractRepairPageIndexes: (finalQa: { repairPageIndexes?: number[] }) => finalQa.repairPageIndexes ?? [],
  loadPagesForExport: mocks.loadPagesForExport,
  loadStyleLockPages: mocks.loadStyleLockPages,
  pageReportFromFinalQa: mocks.pageReportFromFinalQa,
  parseChapterBrief: () => undefined,
  strategyForInput: () => mocks.strategy,
  toFinalQaPage: (page: unknown) => page,
  toPriorPageContext: (page: unknown) => page,
  formatQualityFailure: () => "quality failure detail"
});

export const storyStateStoreModuleMock = () => ({
  loadProjectStoryState: mocks.loadProjectStoryState,
  rebuildProjectStoryState: mocks.rebuildProjectStoryState,
  rebuildStoryStateFromPages: mocks.rebuildStoryStateFromPages
});

/**
 * Opt-in, the way `pageReviewModuleMock` is: called with no argument the style
 * auditor is stubbed to `undefined` — what the real factory answers with the
 * gate off, and the shape a suite that does not care about the audit wants,
 * since it costs that suite nothing. Called with the actual module the real
 * factory runs, and the audit reaches `mocks.auditPageStyle` through the core
 * mock. Only a suite that asserts on the audit should opt in; the default keeps
 * every other one unchanged.
 */
export const qualityEnrichmentModuleMock = (actual?: typeof import("../../generation/qualityEnrichment.js")) => ({
  persistKeeperStoryDelta: mocks.persistKeeperStoryDelta,
  revisedDraftStyleAuditor: actual ? actual.revisedDraftStyleAuditor : vi.fn(() => undefined)
});

export const qualitySettingsModuleMock = () => ({
  loadQualityContext: mocks.loadQualityContext,
  applyPlanThinkingBoost: vi.fn()
});

/** The loop is the real one — only the initial rewrite helper is mocked, so loop
 * rewrites still go through the strategy's `revisePageDraft`. */
export const pageReviewModuleMock = (actual: typeof import("../../generation/pageReview.js")) => ({
  runPageQualityLoop: actual.runPageQualityLoop,
  revisePageDraftWithRestart: mocks.revisePageDraftWithRestart
});

export const coreModuleMock = (actual: typeof import("@book-maker/core")) => ({
  ...actual,
  generateJsonWithRetry: mocks.generateJsonWithRetry,
  // The style audit's one model call, mocked at the barrel because
  // `qualityEnrichment.ts` imports it from there. `withStyleAudit` stays real,
  // so a suite opting into the auditor measures the real penalty arithmetic.
  auditPageStyle: mocks.auditPageStyle,
  // The chapterization call, spied rather than stubbed away: the whole point of
  // the repair suite is whether it happens at all.
  createReaderChaptersForExport: mocks.createReaderChaptersForExport,
  generateBookEpub: mocks.generateBookEpub,
  bookPlanSchema: { parse: (value: unknown) => value },
  // The real factory builds live adapters and demands provider keys.
  createProviders: () => ({ text: {}, embedding: {}, image: {} })
});

import { vi } from "vitest";
import type { Job } from "bullmq";
import type { QualityFeatureId, StoryState } from "@book-maker/core";
import { dbScopeMocks } from "../../testing/dbScopeMocks.js";

type MockGenerationJobSelection =
  | {
      projectId: string | undefined;
      type: string | undefined;
      status: string;
      payload: unknown;
    }
  | { qualityReport: unknown }
  | null;

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
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(mocks.prisma)),
    planVersion: { findUnique: vi.fn() },
    // `updateMany` is the revision CAS taken inside a repaired page's
    // publication transaction. A successful claim is the ordinary default;
    // interleaving suites stage `{ count: 0 }` for a paid edit that committed
    // after the repair's preceding advisory fence read.
    project: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    page: { update: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    imageAsset: {
      findMany: vi.fn(
        async (): Promise<Array<{ id: string; path: string; metadata: unknown }>> => []
      ),
      deleteMany: vi.fn()
    },
    // The compare-and-swap behind `repairPageBriefForRecovery`, and the whole
    // reason it is here: the persisted chapter brief is read back by every later
    // *drafting* job, so it outlives the compile and is the one write the repair
    // pass declines when its caller answered for nothing. Supplying
    // `assertOwnership` is what buys it. These two mocks are how the suites
    // assert that bargain in both directions — the write happens with a fence
    // and does not happen without one.
    chapter: { findUnique: vi.fn(), updateMany: vi.fn() },
    continuityNote: { findMany: vi.fn(), createMany: vi.fn() },
    generationJob: {
      count: vi.fn(async () => 0),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }): Promise<MockGenerationJobSelection> => {
        if (where.id !== "image-job-1") {
          return null;
        }
        const upsertCalls = mocks.prisma.generationJob.upsert.mock.calls as unknown as Array<[
          { create?: { projectId?: string; type?: string; payload?: unknown } }
        ]>;
        const latestUpsert = upsertCalls.at(-1)?.[0];
        return latestUpsert?.create
          ? {
              projectId: latestUpsert.create.projectId,
              type: latestUpsert.create.type,
              status: "QUEUED",
              payload: latestUpsert.create.payload
            }
          : null;
      }),
      update: vi.fn(),
      updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
      upsert: vi.fn(async () => ({ id: "image-job-1", status: "QUEUED" }))
    }
  },
  revisePageDraftWithRestart: vi.fn(),
  // Which pages the final-QA repair redrafts is a test hook, so a fixture names
  // them on its own verdict. A `vi.fn` rather than a plain function because the
  // bound it is called with — the compiled book's last page, never the plan's
  // target — is itself asserted on.
  extractRepairPageIndexes: vi.fn((finalQa: { repairPageIndexes?: number[] }, _lastPage: number) =>
    finalQa.repairPageIndexes ?? []
  ),
  pageReportFromFinalQa: vi.fn(),
  // Stubbed to "this chapter has no brief" by default. A suite that cares
  // *how often* it is asked — the repair pass parses one brief per chapter for
  // the whole pass, not one per page — controls it here.
  parseChapterBrief: vi.fn((_productionBrief?: unknown): unknown => undefined),
  loadPagesForExport: vi.fn(),
  // The stand-down's own re-read, which is a different query from the one
  // above: four scalar columns and no joins, because all it decides is which
  // page indexes moved. Separate here for the same reason it is separate in
  // `bookHelpers.ts` — a suite that stages one and asserts on the other would
  // be measuring the wrong read.
  //
  // Answering, like `loadStyleLockPages` beside it, rather than resolving
  // `undefined`. A stand-down suite that forgets to stage this used to reach
  // `pagesTheCompileNoLongerSpeaksFor(reviewed, undefined)`, whose throw on
  // `current.map` is swallowed by `withdrawnQualityVerdict`'s best-effort pass
  // — so the suite silently measured the *retraction* branch while its
  // assertions read as claims about which findings survived the filter, and
  // went green. An empty manuscript is a defined answer to the same question
  // (every reviewed page moved), which is a branch a suite can be wrong about
  // out loud.
  loadPageTextSnapshot: vi.fn(
    async (): Promise<Array<{ index: number; title: string; markdown: string; revision: number }>> => []
  ),
  // The repair pins its style anchor through the shared loader, which answers
  // with COMPLETED pages only. Empty by default: the in-memory export set
  // already holds the book's opening pages whenever they are accepted.
  loadStyleLockPages: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
  // The two halves of a repaired page's embedding. Split at the provider seam
  // so the call can be spent before the repair's ownership fence and only the
  // insert sits behind it, which is what makes "wrote nothing after the book
  // changed hands" assertable on the write alone.
  prepareEmbedding: vi.fn(async (_text: string) => ({ vectorLiteral: "[0]", error: null })),
  writePreparedEmbedding: vi.fn(),
  updateEntityStateFromPage: vi.fn(),
  dispatchWorkerGenerationJob: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
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
  // The keeper story delta, split the same way and for the same reason: the
  // extract is the model call, the persist is the write behind the fence.
  // Null by default, which is what the gate answers with `storyExtractAudit`
  // off — so the write never runs unless a suite stages an extract for it.
  keeperStoryExtractForSave: vi.fn(async (): Promise<unknown> => null),
  persistStoryExtract: vi.fn(),
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

/**
 * `DbNull` is a real value here rather than `undefined`, because one write
 * depends on which of the two it is. A stand-down that cannot re-read the
 * manuscript *retracts* its verdict — `recordCompileQualityReport(…, null)`
 * clears `GenerationJob.qualityReport` with `Prisma.DbNull`, which is what makes
 * `loadProjectQualityReport` fall past the row instead of serving a claim about
 * prose that may be gone. With `Prisma: {}` that write reads as
 * `{ qualityReport: undefined }`, which is Prisma's "leave this column alone"
 * and indistinguishable, in an assertion, from never having been made.
 */
/** The sentinel the suites assert a retraction with. */
export const DB_NULL = "Prisma.DbNull";

export const dbModuleMock = () => ({
  prisma: mocks.prisma,
  Prisma: { DbNull: DB_NULL },
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

export const dispatchModuleMock = () => ({
  dispatchWorkerGenerationJob: mocks.dispatchWorkerGenerationJob,
  maybeEnqueueCompile: mocks.maybeEnqueueCompile,
  parallelPageWaveSize: () => 1
});

export const jobLifecycleModuleMock = () => ({
  advanceJobStep: vi.fn(),
  editOperationIdFromJob: (job: Job) => (typeof job.data.operationId === "string" ? job.data.operationId : null),
  updateJobProgress: vi.fn()
});

export const loggedAdaptersModuleMock = () => ({ createLoggedProviders: () => ({ text: {}, embedding: {} }) });

export const embeddingWritesModuleMock = () => ({
  prepareEmbedding: mocks.prepareEmbedding,
  writePreparedEmbedding: mocks.writePreparedEmbedding,
  // Mirrors the real predicate so fixtures choose their mode explicitly.
  strategyUsesSemanticMemory: (strategy: { executionMode?: string }) => strategy?.executionMode === "sequential-pages"
});

export const entityStateModuleMock = () => ({
  updateEntityStateFromPage: mocks.updateEntityStateFromPage
});

export const charactersModuleMock = () => ({
  maybeEnqueueCharacterCandidatePreparation: mocks.maybeEnqueueCharacterCandidatePreparation
});

/**
 * Only `extractRepairPageIndexes` is stubbed, over the real module.
 *
 * Everything else this module answers is measured rather than staged — above
 * all `extractRepairPageIndexesFromText`, which is what `exportQualityReview.ts`
 * maps each complaint on the reader's quality card with, and `lastPageIndex`,
 * which is the bound both of them are asked in. Spreading the actual module is
 * what keeps those real; stubbing the whole of it would quietly turn the card
 * assertions into assertions about this file.
 */
export const finalQaPageTargetsModuleMock = (actual: typeof import("../../generation/finalQaPageTargets.js")) => ({
  ...actual,
  extractRepairPageIndexes: mocks.extractRepairPageIndexes
});

export const bookHelpersModuleMock = () => ({
  loadPagesForExport: mocks.loadPagesForExport,
  loadPageTextSnapshot: mocks.loadPageTextSnapshot,
  loadStyleLockPages: mocks.loadStyleLockPages,
  pageReportFromFinalQa: mocks.pageReportFromFinalQa,
  parseChapterBrief: (productionBrief: unknown) => mocks.parseChapterBrief(productionBrief),
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
  keeperStoryExtractForSave: mocks.keeperStoryExtractForSave,
  persistStoryExtract: mocks.persistStoryExtract,
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

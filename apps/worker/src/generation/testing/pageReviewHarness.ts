import { beforeEach, vi } from "vitest";
import type { PageQualityReport } from "@book-maker/core";
import {
  balancedPagePipelineQualityContext,
  pagePipelineQualityGates
} from "../../testing/qualityGateFixtures.js";

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
  // The gate review, real by default (`beforeEach`). A generated page's save
  // (`reviewAndSaveGeneratedPage`) runs only its local checks, so a suite about
  // what happens after the verdict stubs it with the verdict it needs.
  reviewPage: vi.fn(),
  // The style audit's provider boundary. `withStyleAudit` above it stays real.
  auditPageStyle: vi.fn(),
  qualityEnabled: vi.fn((_feature: string): boolean => false)
}));

vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  Prisma: {},
  ...(await import("../../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../../runtime/dispatch.js", () => ({ enqueueWorkerJob: mocks.enqueueWorkerJob }));
vi.mock("../../runtime/jobLifecycle.js", () => ({ updateJobProgress: mocks.updateJobProgress }));
vi.mock("../embeddingWrites.js", () => ({
  prepareEmbedding: mocks.prepareEmbedding,
  writePreparedEmbedding: mocks.writePreparedEmbedding,
  // Mirrors the real predicate so fixtures choose their mode explicitly.
  strategyUsesSemanticMemory: (strategy: { executionMode?: string }) =>
    strategy?.executionMode === "sequential-pages"
}));
vi.mock("../entityState.js", () => ({ updateEntityStateFromPage: mocks.updateEntityStateFromPage }));
vi.mock("../researchMemory.js", () => ({
  retrieveSemanticResearchNotes: mocks.retrieveSemanticResearchNotes
}));
vi.mock("../generationContext.js", () => ({
  loadContinuityNotes: mocks.loadContinuityNotes,
  loadResearchNotesForGeneration: mocks.loadResearchNotesForGeneration
}));
vi.mock("../qualitySettings.js", () => ({
  loadQualityContext: async () =>
    balancedPagePipelineQualityContext({ otherFeatureEnabled: mocks.qualityEnabled }),
  applyPlanThinkingBoost: vi.fn()
}));
vi.mock("../pageQualityGateReview.js", async () => {
  const actual = await vi.importActual<typeof import("../pageQualityGateReview.js")>("../pageQualityGateReview.js");
  return { ...actual, reviewPageWithQualityGates: mocks.reviewPage };
});
vi.mock("../qualityEnrichment.js", async () => {
  const actual = await vi.importActual<typeof import("../qualityEnrichment.js")>("../qualityEnrichment.js");
  return {
    // The real factory: whether the handler builds an auditor at all, and out
    // of which excerpts, is exactly what the style-audit tests below measure.
    revisedDraftStyleAuditor: actual.revisedDraftStyleAuditor,
  };
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return { ...actual, auditPageStyle: mocks.auditPageStyle };
});
vi.mock("../bookHelpers.js", async () => {
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

/**
 * The candidate budget the loop fixtures run under: the seed plus three
 * rewrites. (It used to be Balanced's page-QA budget, read from `tuning.ts`;
 * the tier budgets went with the generated-page review loop on 2026-10-16.)
 */
const LOOP_CANDIDATES = 4;

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

beforeEach(async () => {
  const actualGateReview = await vi.importActual<typeof import("../pageQualityGateReview.js")>("../pageQualityGateReview.js");
  mocks.reviewPage.mockImplementation(actualGateReview.reviewPageWithQualityGates);
  // Set here rather than in each suite's own `beforeEach`, which clears calls
  // but keeps implementations: one test's excerpts or verdict would otherwise
  // be the next one's default.
  mocks.auditPageStyle.mockResolvedValue({ styleOk: true, styleIssues: [] });
  mocks.qualityEnabled.mockReturnValue(false);
  mocks.loadStyleLockPages.mockResolvedValue([]);
  mocks.loadResearchNotesForGeneration.mockResolvedValue([]);
  mocks.retrieveSemanticResearchNotes.mockResolvedValue([]);
});

export { mocks, LOOP_CANDIDATES, report, draftNamed, qualityGates, anchorPage };

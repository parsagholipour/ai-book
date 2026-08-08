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
  revisePageDraftWithRestart: vi.fn(),
  enqueueNextPageIfReady: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  enqueueWorkerJob: vi.fn(),
  storeEmbedding: vi.fn()
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
  loadEntityStateLines: async () => [],
  retrieveSemanticPageMemory: async () => [],
  storeEmbedding: mocks.storeEmbedding,
  updateEntityStateFromPage: vi.fn()
}));
vi.mock("../generation/generationContext.js", () => ({ loadResearchNotesForGeneration: async () => [] }));
vi.mock("../generation/projectInput.js", () => ({ inputForPlanVersion: () => ({ mediaSettings: {} }) }));
vi.mock("../generation/bookHelpers.js", () => ({
  formatQualityFailure: () => "",
  getProjectOrThrow: async () => ({ id: "project-1" }),
  parseChapterBrief: () => undefined,
  strategyForInput: () => ({
    generatePageDraft: mocks.generatePageDraft,
    reviewPageDraft: mocks.reviewPageDraft,
    shouldIllustratePage: () => false
  }),
  toPriorPageContext: (page: unknown) => page
}));
// Three candidates keep the test loop short; the real ceiling only changes how
// many rewrites run, not which draft is kept.
vi.mock("../generation/tuning.js", () => ({ MAX_PAGE_QA_CANDIDATES: 3, MAX_PAGE_QA_REWRITE_ATTEMPTS: 2 }));
vi.mock("../generation/pageReview.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/pageReview.js")>("../generation/pageReview.js");
  return {
    bestDraftCandidate: actual.bestDraftCandidate,
    pageRevisionMessage: () => "",
    pageRewriteReport: (report: unknown) => report,
    repairPageBriefForRecovery: vi.fn(),
    replacePageBriefInChapterBrief: vi.fn(),
    revisePageDraftWithRestart: mocks.revisePageDraftWithRestart,
    shouldRepairPageBriefForRecovery: () => false
  };
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    bestOfCandidateCount: () => 1,
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
  });
  afterEach(() => vi.clearAllMocks());

  it("saves the highest-scoring draft when no rewrite is approved, not the last one", async () => {
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.revisePageDraftWithRestart
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
    expect(mocks.enqueueNextPageIfReady).toHaveBeenCalledWith("project-1", "plan-1");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith("project-1", "plan-1");
  });

  it("saves an approved draft as-is", async () => {
    mocks.generatePageDraft.mockResolvedValue(draftNamed("First"));
    mocks.reviewPageDraft.mockResolvedValueOnce({ ...report(88), approved: true });

    await generatePage(job);

    const completedSave = mocks.prisma.page.update.mock.calls
      .map((call) => (call[0] as { data: Record<string, unknown> }).data)
      .find((data) => data.status === "COMPLETED");
    expect(completedSave).toMatchObject({ title: "First", revision: 1 });
    expect(mocks.revisePageDraftWithRestart).not.toHaveBeenCalled();
  });
});

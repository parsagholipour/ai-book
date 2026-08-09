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
  strategyOverrides: { shouldIllustratePage: (): boolean => false }
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
vi.mock("../generation/generationContext.js", () => ({
  loadContinuityNotes: async () => [],
  loadResearchNotesForGeneration: async () => []
}));
vi.mock("../generation/projectInput.js", () => ({ inputForPlanVersion: () => ({ mediaSettings: {} }) }));
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
    mocks.strategyOverrides.shouldIllustratePage = () => false;
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
});

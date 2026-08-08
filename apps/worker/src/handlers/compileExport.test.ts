import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FinalBookQa, ManuscriptQualityIssue, PageQualityReport } from "@book-maker/core";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";

const mocks = vi.hoisted(() => ({
  prisma: {
    planVersion: { findUnique: vi.fn() },
    project: { findUnique: vi.fn(), update: vi.fn() },
    page: { update: vi.fn() },
    continuityNote: { findMany: vi.fn(), createMany: vi.fn() },
    generationJob: { update: vi.fn() }
  },
  revisePageDraftWithRestart: vi.fn(),
  pageRewriteReport: vi.fn(),
  pageReportFromFinalQa: vi.fn(),
  loadPagesForExport: vi.fn(),
  storeEmbedding: vi.fn(),
  generateJsonWithRetry: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../runtime/dispatch.js", () => ({ parallelPageWaveSize: () => 1 }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn(), updateJobProgress: vi.fn() }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ text: {}, embedding: {} }) }));
vi.mock("../generation/semanticMemory.js", () => ({ storeEmbedding: mocks.storeEmbedding }));
vi.mock("../generation/researchLinks.js", () => ({ researchCitationsForExport: async () => [] }));
vi.mock("./characters.js", () => ({ maybeEnqueueCharacterCandidatePreparation: vi.fn() }));
vi.mock("../generation/bookHelpers.js", () => ({
  extractRepairPageIndexes: (finalQa: { repairPageIndexes?: number[] }) => finalQa.repairPageIndexes ?? [],
  loadPagesForExport: mocks.loadPagesForExport,
  pageReportFromFinalQa: mocks.pageReportFromFinalQa,
  parseChapterBrief: () => undefined,
  strategyForInput: () => ({}),
  toFinalQaPage: (page: unknown) => page,
  toPriorPageContext: (page: unknown) => page,
  formatQualityFailure: () => "quality failure detail"
}));
vi.mock("../generation/pageReview.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/pageReview.js")>("../generation/pageReview.js");
  return {
    bestDraftCandidate: actual.bestDraftCandidate,
    pageRewriteReport: mocks.pageRewriteReport,
    revisePageDraftWithRestart: mocks.revisePageDraftWithRestart
  };
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return { ...actual, generateJsonWithRetry: mocks.generateJsonWithRetry };
});

import {
  dedupeQualityIssues,
  qualitySummaryMessage,
  repairPagesFromFinalQa,
  runBoundedChapterQualityReview
} from "./compileExport.js";
import { MAX_FINAL_QA_REVISIONS_PER_PAGE, PAGE_QA_RECOVERY_CANDIDATE } from "../generation/tuning.js";
import { StopRequestedError } from "../runtime/jobTypes.js";

const report = (score: number, approved = false): PageQualityReport =>
  ({ approved, score, issues: [], requiredRevisions: [], notes: "" }) as unknown as PageQualityReport;

const draftNamed = (name: string) => ({
  title: name,
  markdown: `${name} text.`,
  summary: `${name} summary.`,
  imagePrompt: null,
  continuityNotes: [] as string[]
});

function exportPage(index: number, overrides: Partial<ExportPageForRepair> = {}): ExportPageForRepair {
  return {
    id: `page-${index}`,
    index,
    title: `Page ${index}`,
    markdown: `Page ${index} prose.`,
    summary: `Page ${index} summary.`,
    imagePrompt: null,
    status: "COMPLETED",
    chapter: null,
    ...overrides
  } as unknown as ExportPageForRepair;
}

const finalQa = (repairPageIndexes: number[]): FinalBookQa =>
  ({ approved: repairPageIndexes.length === 0, issues: [], repairPageIndexes }) as unknown as FinalBookQa;

describe("repairPagesFromFinalQa", () => {
  const strategy = { reviewPageDraft: vi.fn() };

  const baseOptions = (overrides: Record<string, unknown> = {}) =>
    ({
      projectId: "project-1",
      input: { targetPages: 2, mediaSettings: {} },
      plan: { title: "Book", chapters: [] },
      providers: { text: {}, embedding: {} },
      strategy,
      pages: [exportPage(1), exportPage(2)],
      finalQa: finalQa([2]),
      generationJobId: "gj-1",
      ...overrides
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.continuityNote.findMany.mockResolvedValue([]);
    mocks.pageReportFromFinalQa.mockReturnValue(report(30));
    mocks.pageRewriteReport.mockImplementation((qaReport: unknown) => qaReport);
    mocks.loadPagesForExport.mockResolvedValue([exportPage(1), exportPage(2)]);
    mocks.prisma.page.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...exportPage(2),
      ...data
    }));
  });

  it("returns undefined when final QA flagged nothing", async () => {
    await expect(repairPagesFromFinalQa(baseOptions({ finalQa: finalQa([]) }))).resolves.toBeUndefined();
    expect(mocks.revisePageDraftWithRestart).not.toHaveBeenCalled();
  });

  it("repairs a flagged page to COMPLETED and reloads the export set", async () => {
    mocks.revisePageDraftWithRestart.mockResolvedValue({ ...draftNamed("Repaired"), continuityNotes: ["Pip stays."] });
    strategy.reviewPageDraft.mockResolvedValue(report(85, true));

    const result = await repairPagesFromFinalQa(baseOptions());

    expect(mocks.prisma.page.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "page-2" },
        data: expect.objectContaining({
          title: "Repaired",
          status: "COMPLETED",
          revision: { increment: 1 }
        })
      })
    );
    expect(mocks.prisma.continuityNote.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ scope: "page:2", body: "Pip stays.", tags: ["page", "2", "final-qa-repair"] })]
    });
    expect(mocks.storeEmbedding).toHaveBeenCalledWith(
      "project-1",
      "page:2",
      "page-2",
      "Repaired summary.",
      expect.anything()
    );
    expect(mocks.loadPagesForExport).toHaveBeenCalledWith("project-1");
    expect(result).toHaveLength(2);
  });

  it("also repairs pages flagged by page-level QA, deduped and in order", async () => {
    mocks.revisePageDraftWithRestart.mockResolvedValue(draftNamed("Repaired"));
    strategy.reviewPageDraft.mockResolvedValue(report(85, true));

    await repairPagesFromFinalQa(baseOptions({ finalQa: finalQa([2]), extraPageIndexes: [2, 1] }));

    const updatedIds = mocks.prisma.page.update.mock.calls.map((call) => (call[0] as { where: { id: string } }).where.id);
    expect(updatedIds).toEqual(["page-1", "page-2"]);
  });

  it("skips flagged indexes that have no page row", async () => {
    await repairPagesFromFinalQa(baseOptions({ finalQa: finalQa([7]) }));

    expect(mocks.revisePageDraftWithRestart).not.toHaveBeenCalled();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
  });

  it("keeps the best draft as FAILED_QA when no rewrite is approved", async () => {
    let rewrite = 0;
    mocks.revisePageDraftWithRestart.mockImplementation(async () => draftNamed(`Rewrite ${(rewrite += 1)}`));
    strategy.reviewPageDraft
      .mockResolvedValueOnce(report(40))
      .mockResolvedValueOnce(report(70))
      .mockResolvedValue(report(55));

    await repairPagesFromFinalQa(baseOptions());

    expect(strategy.reviewPageDraft).toHaveBeenCalledTimes(MAX_FINAL_QA_REVISIONS_PER_PAGE);
    expect(mocks.prisma.page.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "page-2" },
        data: expect.objectContaining({
          title: "Rewrite 2",
          status: "FAILED_QA",
          revision: { increment: MAX_FINAL_QA_REVISIONS_PER_PAGE },
          qualityReport: expect.objectContaining({ score: 70 })
        })
      })
    );
    // A flagged page skips embedding until a repair actually lands.
    expect(mocks.storeEmbedding).not.toHaveBeenCalled();
  });

  it("enters recovery one attempt earlier than the page loops, because it counts from the first rewrite", async () => {
    mocks.revisePageDraftWithRestart.mockResolvedValue(draftNamed("Rewrite"));
    strategy.reviewPageDraft.mockResolvedValue(report(40));

    await repairPagesFromFinalQa(baseOptions());

    for (const call of mocks.pageRewriteReport.mock.calls) {
      expect(call[2]).toBe(PAGE_QA_RECOVERY_CANDIDATE - 1);
    }
    expect(mocks.pageRewriteReport.mock.calls.map((call) => call[1])).toEqual([2, 3, 4, 5, 6]);
  });
});

describe("runBoundedChapterQualityReview", () => {
  const baseOptions = (pages: ExportPageForRepair[]) =>
    ({
      input: { language: "en", mediaSettings: {} },
      plan: { title: "Book", chapters: [{ index: 1, title: "Openings" }] },
      pages,
      textModel: {},
      projectId: "project-1"
    }) as never;

  beforeEach(() => vi.clearAllMocks());

  it("returns nothing for an empty book without calling the model", async () => {
    await expect(runBoundedChapterQualityReview(baseOptions([]))).resolves.toEqual([]);
    expect(mocks.generateJsonWithRetry).not.toHaveBeenCalled();
  });

  it("groups chapterless pages into synthetic chapters of eight and tags issues as model warnings", async () => {
    mocks.generateJsonWithRetry.mockResolvedValue({
      data: {
        issues: [
          { code: "CHAPTER_TRANSITION", message: "Abrupt jump.", guidance: "Bridge it.", affectedPageIndexes: [8, 9] }
        ]
      }
    });
    const pages = Array.from({ length: 9 }, (_, index) => exportPage(index + 1));

    const issues = await runBoundedChapterQualityReview(baseOptions(pages));

    const payload = JSON.parse(
      (mocks.generateJsonWithRetry.mock.calls[0]![1] as { messages: Array<{ content: string }> }).messages[1]!.content
    );
    expect(payload.chapters.map((chapter: { index: number }) => chapter.index)).toEqual([1, 2]);
    expect(payload.chapters[0].title).toBe("Openings");
    expect(payload.chapters[1].title).toBe("Chapter 2");
    expect(payload.transitions).toHaveLength(1);
    expect(issues).toEqual([
      expect.objectContaining({ code: "CHAPTER_TRANSITION", severity: "warning", source: "model" })
    ]);
  });

  it("treats a model failure as no issues, but still propagates a user stop", async () => {
    mocks.generateJsonWithRetry.mockRejectedValue(new Error("model outage"));
    await expect(runBoundedChapterQualityReview(baseOptions([exportPage(1)]))).resolves.toEqual([]);

    mocks.generateJsonWithRetry.mockRejectedValue(new StopRequestedError());
    await expect(runBoundedChapterQualityReview(baseOptions([exportPage(1)]))).rejects.toBeInstanceOf(
      StopRequestedError
    );
  });
});

describe("quality report helpers", () => {
  const issue = (overrides: Partial<ManuscriptQualityIssue> = {}): ManuscriptQualityIssue =>
    ({
      code: "CHAPTER_COHERENCE",
      severity: "warning",
      source: "model",
      message: "Wanders.",
      guidance: "Tighten.",
      affectedPageIndexes: [1],
      ...overrides
    }) as ManuscriptQualityIssue;

  it("dedupes issues by code, message, and affected pages", () => {
    const kept = dedupeQualityIssues([
      issue(),
      issue(),
      issue({ affectedPageIndexes: [2] }),
      issue({ message: "Different." })
    ]);
    expect(kept).toHaveLength(3);
  });

  it("summarizes each quality state", () => {
    expect(qualitySummaryMessage({ state: "blocked", issues: [issue()] } as never)).toBe(
      "Review required: 1 integrity issue must be fixed before export."
    );
    expect(qualitySummaryMessage({ state: "review_recommended", issues: [issue(), issue()] } as never)).toBe(
      "Export complete with 2 review recommendations."
    );
    expect(qualitySummaryMessage({ state: "passed", issues: [] } as never)).toBe(
      "Export complete. Quality checks passed."
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FinalBookQa, ManuscriptQualityIssue } from "@book-maker/core";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";

vi.mock("@book-maker/db", async () => (await import("./testing/compileExportMocks.js")).dbModuleMock());
vi.mock("../runtime/config.js", async () => (await import("./testing/compileExportMocks.js")).configModuleMock());
vi.mock(
  "../generation/projectInput.js",
  async () => (await import("./testing/compileExportMocks.js")).projectInputModuleMock()
);
vi.mock(
  "../generation/exportPublication.js",
  async () => (await import("./testing/compileExportMocks.js")).exportPublicationModuleMock()
);
vi.mock("../runtime/dispatch.js", async () => (await import("./testing/compileExportMocks.js")).dispatchModuleMock());
vi.mock(
  "../runtime/jobLifecycle.js",
  async () => (await import("./testing/compileExportMocks.js")).jobLifecycleModuleMock()
);
vi.mock(
  "../providers/loggedAdapters.js",
  async () => (await import("./testing/compileExportMocks.js")).loggedAdaptersModuleMock()
);
vi.mock(
  "../generation/embeddingWrites.js",
  async () => (await import("./testing/compileExportMocks.js")).embeddingWritesModuleMock()
);
vi.mock(
  "../generation/entityState.js",
  async () => (await import("./testing/compileExportMocks.js")).entityStateModuleMock()
);
vi.mock("./characters.js", async () => (await import("./testing/compileExportMocks.js")).charactersModuleMock());
vi.mock(
  "../generation/bookHelpers.js",
  async () => (await import("./testing/compileExportMocks.js")).bookHelpersModuleMock()
);
vi.mock(
  "../generation/storyStateStore.js",
  async () => (await import("./testing/compileExportMocks.js")).storyStateStoreModuleMock()
);
vi.mock(
  "../generation/qualityEnrichment.js",
  async () => (await import("./testing/compileExportMocks.js")).qualityEnrichmentModuleMock()
);
vi.mock(
  "../generation/qualitySettings.js",
  async () => (await import("./testing/compileExportMocks.js")).qualitySettingsModuleMock()
);
vi.mock("../generation/pageReview.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/pageReview.js")>("../generation/pageReview.js");
  return (await import("./testing/compileExportMocks.js")).pageReviewModuleMock(actual);
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return (await import("./testing/compileExportMocks.js")).coreModuleMock(actual);
});

import { dedupeQualityIssues, qualitySummaryMessage } from "./compileExport.js";
import { failedQaPageIndexesForCompile } from "./compileExportCitationRepair.js";
import { repairPagesFromFinalQa } from "./compileExportRepair.js";
import { mocks } from "./testing/compileExportMocks.js";

function exportPage(index: number, overrides: Partial<ExportPageForRepair> = {}): ExportPageForRepair {
  return {
    id: `page-${index}`,
    index,
    title: `Page ${index}`,
    markdown: `Page ${index} prose.`,
    summary: `Page ${index} summary.`,
    imagePrompt: null,
    revision: 1,
    status: "COMPLETED",
    images: [],
    chapter: null,
    ...overrides
  } as unknown as ExportPageForRepair;
}

/** The defect screen's verdict, naming the pages it would have repaired in its own `Page N:` form. */
const finalQa = (pageIndexes: number[]): FinalBookQa =>
  ({ approved: pageIndexes.length === 0, score: pageIndexes.length ? 60 : 100, notes: "",
    issues: pageIndexes.map((index) => `Page ${index}: A drafting note was left in.`),
    requiredFixes: pageIndexes.map((index) => `Page ${index}: Remove the note.`) }) as unknown as FinalBookQa;

/**
 * The compile's one repair (2026-10-16): the defect screen's scoped patch, at most three pages, whole
 * finding groups, one verified candidate published atomically. The per-page rewrite loop these suites
 * used to drive went with the old final review.
 */
describe("repairPagesFromFinalQa", () => {
  const baseOptions = (overrides: Record<string, unknown> = {}) =>
    ({
      projectId: "project-1",
      planId: "plan-1",
      input: { targetPages: 2, mediaSettings: { modelTier: "fast" } },
      plan: { title: "Book", chapters: [] },
      providers: { text: {}, embedding: {} },
      strategy: { executionMode: "whole-book", shouldIllustratePage: () => false },
      pages: [exportPage(1), exportPage(2)],
      finalQa: finalQa([2]),
      generationJobId: "gj-1",
      ...overrides
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.repairQuickDraftPages.mockReset();
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    mocks.loadPagesForExport.mockResolvedValue([exportPage(1), exportPage(2)]);
    mocks.prisma.page.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...exportPage(2), ...data }));
  });

  it("preserves the saved manuscript when the repair exhausts its output allowance", async () => {
    const error = Object.assign(new Error("OpenAI response was incomplete: max_output_tokens."), { name: "OpenAIResponseError" });
    mocks.repairQuickDraftPages.mockRejectedValueOnce(error);
    const unavailable = vi.fn();
    await expect(repairPagesFromFinalQa(baseOptions({ onRepairPageUnavailable: unavailable }))).resolves.toBeUndefined();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(unavailable).toHaveBeenCalledWith("page-2", 2, error);
  });

  it.each(["StopRequestedError", "AbortError"])("never contains %s as an unavailable repair", async (name) => {
    const error = Object.assign(new Error("stopped"), { name });
    mocks.repairQuickDraftPages.mockRejectedValueOnce(error);
    const unavailable = vi.fn();
    await expect(repairPagesFromFinalQa(baseOptions({ onRepairPageUnavailable: unavailable }))).rejects.toBe(error);
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("does not downgrade a failed page publication to a provider warning", async () => {
    const error = new Error("database connection closed");
    mocks.repairQuickDraftPages.mockImplementationOnce(async ({ pages }) =>
      pages.map((page) => page.index === 2 ? { ...page, markdown: "Repaired prose." } : page));
    mocks.prisma.page.update.mockRejectedValueOnce(error);
    const unavailable = vi.fn();
    await expect(repairPagesFromFinalQa(baseOptions({ onRepairPageUnavailable: unavailable }))).rejects.toBe(error);
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("returns undefined when the screen flagged nothing, and spends nothing", async () => {
    await expect(repairPagesFromFinalQa(baseOptions({ finalQa: finalQa([]) }))).resolves.toBeUndefined();
    expect(mocks.repairQuickDraftPages).not.toHaveBeenCalled();
  });

  it("also repairs pages flagged by page-level QA, deduped and in order, within its three-page cap", async () => {
    mocks.repairQuickDraftPages.mockImplementationOnce(async ({ pages, targetPageIndexes }) =>
      pages.map((page) => targetPageIndexes.includes(page.index) ? { ...page, markdown: `Repaired ${page.index}.` } : page));
    const pages = [1, 2, 3, 4].map((index) => exportPage(index));

    await repairPagesFromFinalQa(baseOptions({ pages, finalQa: finalQa([2]), extraPageIndexes: [4, 2, 1, 3] }));

    expect(mocks.repairQuickDraftPages).toHaveBeenCalledWith(expect.objectContaining({ targetPageIndexes: [1, 2, 3] }));
    const updatedIds = mocks.prisma.page.update.mock.calls.map((call) => (call[0] as { where: { id: string } }).where.id);
    expect(updatedIds).toEqual(["page-1", "page-2", "page-3"]);
  });

  it("does not repair a FAILED_QA page whose only issues demand an unavailable source identity", async () => {
    const sourceOnly = exportPage(2, { status: "FAILED_QA", qualityReport: { approved: false, issues: [
      "Despite the page brief explicitly requiring a named testimony or archive, the page provides no specific dispatch date."
    ] } } as never);
    const pages = [exportPage(1), sourceOnly];
    const extraPageIndexes = failedQaPageIndexesForCompile(pages, []);

    await expect(repairPagesFromFinalQa(baseOptions({ pages, finalQa: finalQa([]), extraPageIndexes })))
      .resolves.toBeUndefined();

    expect(extraPageIndexes).toEqual([]);
    expect(failedQaPageIndexesForCompile(pages, ["Boundary papers: Commission records."])).toEqual([2]);
    expect(mocks.repairQuickDraftPages).not.toHaveBeenCalled();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
  });

  it("skips flagged indexes that have no page row, and reports no pass at all", async () => {
    // A verdict naming only pages the manuscript does not hold answers `undefined`, the same as a
    // verdict that flagged nothing, so the caller derives no second verdict over an unrepaired book.
    await expect(repairPagesFromFinalQa(baseOptions({ finalQa: finalQa([7]) }))).resolves.toBeUndefined();
    expect(mocks.repairQuickDraftPages).not.toHaveBeenCalled();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
  });

  it("gates on the compile's own quality context and loads none of its own", async () => {
    await repairPagesFromFinalQa(baseOptions());
    expect(mocks.loadQualityContext).not.toHaveBeenCalled();
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

  it("preserves distinct finding identities, repair operations and severity before scoring", () => {
    const kept = dedupeQualityIssues([
      issue({ provenance: { findingId: "first", primaryPageIndex: 1 } }),
      issue({ provenance: { findingId: "second", primaryPageIndex: 1 } }),
      issue({ provenance: { kind: "repair", repairOperationId: "operation-1" } }),
      issue({ provenance: { kind: "repair", repairOperationId: "operation-2" } }),
      issue({ severity: "error", provenance: { findingId: "first", primaryPageIndex: 1 } })
    ]);
    expect(kept).toHaveLength(5);
  });

  it("counts grouped findings in the export summary", () => {
    expect(qualitySummaryMessage({ state: "review_recommended", issues: [issue(), issue(), issue()],
      findings: [{ id: "one", severity: "warning", issueIndexes: [0, 1, 2] }] } as never)).toBe(
      "Export complete with 1 review recommendation."
    );
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

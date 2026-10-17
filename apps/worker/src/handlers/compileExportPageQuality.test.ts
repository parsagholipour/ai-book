import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "bullmq";
import type { ManuscriptQualityReport } from "@book-maker/core";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";

const repairPages = vi.hoisted(() => vi.fn());
vi.mock("./compileExportRepair.js", () => ({ repairPagesFromFinalQa: repairPages }));
vi.mock("./compileFinalization.js", async () => (await import("./testing/compileExportMocks.js")).compileFinalizationModuleMock());
vi.mock("../generation/finalizationIllustrations.js", async () => (await import("./testing/compileExportMocks.js")).finalizationIllustrationsModuleMock());
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

import { compileExport } from "./compileExport.js";
import { ExportRepairFenceUnreadableError } from "./compileExportFence.js";
import { pendingExportPaths } from "../generation/exportArtifacts.js";
import { pagesOutsideStoredQualityProvenance, storedQualityProvenance } from "./compileExportQualityProvenance.js";
import { mocks } from "./testing/compileExportMocks.js";

// Recorded Quick page-13 rejection, reduced to the fields that were lost at export.
const objection = "Rabbit turns lantern two’s inward-facing number enough to read it, which conflicts with the required continuity that the number remains turned inward.";
const revision = "Show Rabbit identifying lantern two’s number without turning it, or otherwise clarify that it remains turned inward.";
const rejectedReport = { approved: false, score: 82, issues: [objection], requiredRevisions: [revision] };
const job = { data: { projectId: "project-1", planId: "plan-1", generationJobId: "gj-1", contentRevision: 4 } } as Job;

function savedPages(): ExportPageForRepair[] {
  return Array.from({ length: 30 }, (_, position) => ({
    id: `page-${position + 1}`, index: position + 1, revision: 1,
    title: `Page ${position + 1}`, markdown: `Rabbit and Turtle stop at marker ${position + 1}.`,
    summary: "They check a marker.", imagePrompt: null, images: [], chapter: null,
    status: position === 12 || position === 23 ? "FAILED_QA" : "COMPLETED",
    qualityReport: position === 12 || position === 23 ? rejectedReport : { approved: true, score: 95 }
  }));
}
function reports(): ManuscriptQualityReport[] {
  return mocks.prisma.generationJob.update.mock.calls
    .flatMap(([args]) => args.data.qualityReport ? [args.data.qualityReport as ManuscriptQualityReport] : []);
}

describe("page QA findings on the exported quality card", () => {
  let storage: string;
  let pages: ExportPageForRepair[];
  beforeEach(async () => {
    vi.clearAllMocks();
    pages = savedPages();
    storage = await mkdtemp(join(tmpdir(), "compile-page-quality-"));
    mocks.config.BOOK_STORAGE_DIR = storage;
    mocks.config.IMAGE_STORAGE_DIR = join(storage, "images");
    mocks.strategy.executionMode = "whole-book";
    // The defect screen is the compile's one review; a Quick Draft book takes it whatever its shape.
    mocks.inputForPlanVersion.mockReturnValue({ prompt: "Rabbit and Turtle find lanterns.", category: "FICTION",
      targetPages: 30, complexity: 3, language: "en", mediaSettings: { fullIllustrations: false, modelTier: "fast" } });
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", inputSnapshot: null,
      planningPackage: { title: "Lanterns", premise: "A walk home.", audience: "adults", chapters: [] } });
    mocks.prisma.project.findUnique.mockResolvedValue({ id: "project-1", title: "Lanterns", status: "GENERATING",
      contentRevision: 4, authorName: null, mediaSettings: {}, pages, images: [], research: [] });
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "fast" as unknown as "balanced",
      enabled: (feature: string) => feature === "finalBookQa" || feature === "pageQaRewrite" });
    // The repair spent its budget and returned these saved keepers. The screen passes.
    repairPages.mockImplementation(async () => pages);
    mocks.loadLeasedPagesForExport.mockImplementation(async (_projectId, snapshot) => snapshot);
    mocks.strategy.compileMarkdown.mockReturnValue("# Lanterns\n\nRabbit and Turtle walk home.\n");
    mocks.createReaderChaptersForExport.mockResolvedValue({ source: "deterministic", chapters: [] });
    mocks.exportPublicationSuperseded.mockResolvedValue(false);
    mocks.pendingExportPaths.mockImplementation((directory) => pendingExportPaths(directory, "test"));
    mocks.publishCompiledExports.mockResolvedValue({ published: true, characterPreparationJobId: null });
    mocks.loadProjectStoryState.mockResolvedValue({ promises: [], facts: [], entities: {}, unanswered: [] });
    mocks.rebuildProjectStoryState.mockResolvedValue({ promises: [], facts: [], entities: {}, unanswered: [] });
  });
  afterEach(async () => { await rm(storage, { recursive: true, force: true }); });

  it("preserves rejected keeper findings and guidance even when the screen approves, while publishing exports", async () => {
    await compileExport(job);
    const report = reports().at(-1)!;
    // Page QA's rejections are console diagnostics (6 of 16 labelled real, 2026-10-15): the reader's
    // grade is a pass and names no page, while the operator keeps every finding and its guidance.
    expect(report).toMatchObject({ state: "passed", affectedPageIndexes: [], readerFindings: [] });
    for (const index of [13, 24]) {
      expect(report.issues).toContainEqual(expect.objectContaining({ code: "PAGE_QA_UNRESOLVED",
        severity: "warning", source: "model", message: expect.stringContaining(objection),
        guidance: expect.stringContaining(revision), affectedPageIndexes: [index] }));
    }
    expect(pagesOutsideStoredQualityProvenance(storedQualityProvenance(report)!.reviewedPages, pages).size).toBe(0);
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(expect.objectContaining({ status: "COMPLETE" }));
    expect(mocks.strategy.generatePdfWithPageMap).toHaveBeenCalledOnce();
    expect(mocks.generateBookEpub).toHaveBeenCalledOnce();
    expect(mocks.generateBookDocx).toHaveBeenCalledOnce();
    expect(repairPages).toHaveBeenCalledOnce();
    // The book is read once; the verdict after the repair is derived, never read again.
    expect(mocks.reviewQuickDraftManuscript).toHaveBeenCalledOnce();
  });

  it("reads a Quick Draft book once: a verified repair settles its findings and the screen's others stand", async () => {
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "fast" as unknown as "balanced", enabled: () => true });
    const finding = (page: number, problem: string) => ({ targets: [page], kind: "contradiction", problem, fix: "Make them agree.",
      evidence: [{ pageIndex: page, quote: `marker ${page}` }, { pageIndex: page - 1, quote: `marker ${page - 1}` }] });
    mocks.reviewQuickDraftManuscript.mockResolvedValueOnce({ approved: false, score: 60, notes: "Focused screen.",
      issues: ["Page 13: The lantern number turns.", "Page 24: The marker count changes."],
      requiredFixes: ["Page 13: Make them agree.", "Page 24: Make them agree."],
      focusedReview: { rejectedFindings: 0, repairGroups: [[13], [24]],
        findings: [finding(13, "The lantern number turns."), finding(24, "The marker count changes.")] } } as never);
    const repaired = pages.map((page) => page.index === 13 ? { ...page, revision: 2, markdown: "Rabbit reads the number in place." } : page);
    repairPages.mockImplementation(async (options: Parameters<typeof import("./compileExportRepair.js").repairPagesFromFinalQa>[0]) => {
      // As the scoped repair publishes: one group claimed, then published with its verification.
      await options.onRepairGroupStarted!([{ id: "page-13", index: 13 }]);
      await options.onRepairGroupPublished!({} as never, repaired);
      return repaired;
    });
    await compileExport(job);
    expect(mocks.reviewQuickDraftManuscript).toHaveBeenCalledOnce();
    const report = reports().at(-1)!;
    const screen = report.issues.filter((issue) => /lantern number|marker count/.test(issue.message));
    expect(screen.map((issue) => issue.affectedPageIndexes)).toEqual([[24]]);
  });

  it("uses the post-repair keeper, removing a rejection only when that page is now approved", async () => {
    const repaired = pages.map((page) => page.index === 13 ? { ...page, revision: 2, markdown: "Rabbit reads the inward number without moving it.",
      status: "COMPLETED", qualityReport: { approved: true, score: 95, issues: ["An accepted editorial note."] } } : page);
    repairPages.mockResolvedValue(repaired);
    await compileExport(job);
    const report = reports().at(-1)!;
    expect(report.issues.filter((issue) => issue.code === "PAGE_QA_UNRESOLVED").map((issue) => issue.affectedPageIndexes)).toEqual([[24]]);
    expect(pagesOutsideStoredQualityProvenance(storedQualityProvenance(report)!.reviewedPages, repaired).size).toBe(0);
  });

  it("withdraws stale page findings on a superseded compile while preserving findings for unchanged pages", async () => {
    mocks.publishCompiledExports.mockResolvedValue({ published: false, characterPreparationJobId: null });
    mocks.loadPageTextSnapshot.mockResolvedValue(pages.map((page) => page.index === 13
      ? { ...page, revision: 2, markdown: "The reader corrected this page." } : page));
    await compileExport(job);
    const pagesNamed = (report: ManuscriptQualityReport) => [...new Set(report.issues.flatMap((issue) => issue.affectedPageIndexes))].sort((a, b) => a - b);
    expect(pagesNamed(reports()[0]!)).toEqual([13, 24]);
    const withdrawn = reports().at(-1)!;
    expect(withdrawn.state).toBe("passed");
    expect(pagesNamed(withdrawn)).toEqual([24]);
  });

  it("keeps an interrupted repair and its unresolved page on the console after withdrawing obsolete findings", async () => {
    mocks.reviewQuickDraftManuscript.mockResolvedValueOnce({ approved: false, score: 60, notes: "Focused screen.",
      issues: ["Page 13: still contains the old defect."], requiredFixes: ["Page 13: remove the old defect."],
      focusedReview: { rejectedFindings: 0, repairGroups: [[13]], findings: [{ targets: [13], kind: "contradiction",
        problem: "still contains the old defect.", fix: "remove the old defect.",
        evidence: [{ pageIndex: 13, quote: "marker 13" }, { pageIndex: 12, quote: "marker 12" }] }] } } as never);
    const repaired = pages.map((page) => page.index === 13
      ? { ...page, revision: 2, markdown: "Rabbit reads the number without moving it.",
        status: "COMPLETED", qualityReport: { approved: true, score: 95 } }
      : page.index === 24 ? { ...page, qualityReport: null } : page);
    repairPages.mockRejectedValueOnce(new ExportRepairFenceUnreadableError(
      new Error("Connection terminated unexpectedly"), 2, { pagesRepaired: 1, pagesTargeted: 2 }
    ));
    mocks.loadPagesForExport.mockResolvedValue(repaired);
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try { await compileExport(job); } finally { logged.mockRestore(); }
    expect(reports().at(-1)).toMatchObject({ state: "passed", issues: [
      { code: "FINAL_QA_REPAIR_INCOMPLETE", affectedPageIndexes: [24] },
      { code: "PAGE_QA_UNRESOLVED", severity: "warning", affectedPageIndexes: [24] }
    ] });
    expect(mocks.reviewQuickDraftManuscript).toHaveBeenCalledOnce();
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(expect.objectContaining({ status: "COMPLETE" }));
  });
});

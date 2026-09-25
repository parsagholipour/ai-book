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
// One export of one module, over the real rest of it: which pages the final-QA
// repair redrafts is a test hook, while the per-message extractor behind the
// reader's quality card and the page bound both questions are asked in stay
// real, so the card assertions below measure the actual mapping.
vi.mock("../generation/finalQaPageTargets.js", async () => {
  const actual =
    await vi.importActual<typeof import("../generation/finalQaPageTargets.js")>(
      "../generation/finalQaPageTargets.js"
    );
  return (await import("./testing/compileExportMocks.js")).finalQaPageTargetsModuleMock(actual);
});
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
    mocks.inputForPlanVersion.mockReturnValue({ prompt: "Rabbit and Turtle find lanterns.", category: "FICTION",
      targetPages: 30, complexity: 3, language: "en", mediaSettings: { finalReview: true, fullIllustrations: false } });
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", inputSnapshot: null,
      planningPackage: { title: "Lanterns", premise: "A walk home.", audience: "adults", chapters: [] } });
    mocks.prisma.project.findUnique.mockResolvedValue({ id: "project-1", title: "Lanterns", status: "GENERATING",
      contentRevision: 4, authorName: null, mediaSettings: {}, pages, images: [], research: [] });
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "balanced", enabled: () => false });
    // The repair spent its budget and returned these saved keepers. Whole-book QA passes.
    repairPages.mockImplementation(async () => pages);
    mocks.loadLeasedPagesForExport.mockImplementation(async (_projectId, snapshot) => snapshot);
    mocks.strategy.runFinalBookQa.mockResolvedValue({ approved: true, issues: [], requiredFixes: [], repairPageIndexes: [] });
    mocks.strategy.compileMarkdown.mockReturnValue("# Lanterns\n\nRabbit and Turtle walk home.\n");
    mocks.createReaderChaptersForExport.mockResolvedValue({ source: "deterministic", chapters: [] });
    mocks.exportPublicationSuperseded.mockResolvedValue(false);
    mocks.pendingExportPaths.mockImplementation((directory) => pendingExportPaths(directory, "test"));
    mocks.publishCompiledExports.mockResolvedValue({ published: true, characterPreparationJobId: null });
    mocks.loadProjectStoryState.mockResolvedValue({ promises: [], facts: [], entities: {}, unanswered: [] });
    mocks.rebuildProjectStoryState.mockResolvedValue({ promises: [], facts: [], entities: {}, unanswered: [] });
  });
  afterEach(async () => { await rm(storage, { recursive: true, force: true }); });

  it("preserves rejected keeper findings and guidance even when final book QA approves, while publishing exports", async () => {
    await compileExport(job);
    const report = reports().at(-1)!;
    expect(report).toMatchObject({ state: "review_recommended", affectedPageIndexes: [13, 24] });
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
    expect(mocks.strategy.runFinalBookQa).toHaveBeenCalledTimes(2);
  });

  it("uses the post-repair keeper, removing a rejection only when that page is now approved", async () => {
    const repaired = pages.map((page) => page.index === 13 ? { ...page, revision: 2, markdown: "Rabbit reads the inward number without moving it.",
      status: "COMPLETED", qualityReport: { approved: true, score: 95, issues: ["An accepted editorial note."] } } : page);
    repairPages.mockResolvedValue(repaired);
    await compileExport(job);
    const report = reports().at(-1)!;
    expect(report.affectedPageIndexes).toEqual([24]);
    expect(report.issues.filter((issue) => issue.code === "PAGE_QA_UNRESOLVED")).toHaveLength(1);
    expect(pagesOutsideStoredQualityProvenance(storedQualityProvenance(report)!.reviewedPages, repaired).size).toBe(0);
  });

  it("withdraws stale page findings on a superseded compile while preserving findings for unchanged pages", async () => {
    mocks.publishCompiledExports.mockResolvedValue({ published: false, characterPreparationJobId: null });
    mocks.loadPageTextSnapshot.mockResolvedValue(pages.map((page) => page.index === 13
      ? { ...page, revision: 2, markdown: "The reader corrected this page." } : page));
    await compileExport(job);
    expect(reports()[0]!.affectedPageIndexes).toEqual([13, 24]);
    const withdrawn = reports().at(-1)!;
    expect(withdrawn.state).toBe("review_recommended");
    expect(withdrawn.affectedPageIndexes).toEqual([24]);
  });

  it("keeps an interrupted repair blocked and its unresolved page visible after withdrawing obsolete findings", async () => {
    mocks.strategy.runFinalBookQa.mockResolvedValue({ approved: false,
      issues: ["Page 13 still contains the old defect."], requiredFixes: [], repairPageIndexes: [13, 24] });
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
    expect(reports().at(-1)).toMatchObject({ state: "blocked", issues: [
      { code: "FINAL_QA_REPAIR_INCOMPLETE", affectedPageIndexes: [24] },
      { code: "PAGE_QA_UNRESOLVED", severity: "warning", affectedPageIndexes: [24] }
    ] });
    expect(mocks.strategy.runFinalBookQa).toHaveBeenCalledOnce();
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(expect.objectContaining({ status: "REVIEW_REQUIRED" }));
  });
});

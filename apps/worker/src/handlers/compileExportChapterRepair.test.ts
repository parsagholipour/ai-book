import { beforeEach, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
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
import { pendingExportPaths } from "../generation/exportArtifacts.js";
import { mocks, isDefaultCompileQualityFeature } from "./testing/compileExportMocks.js";

const pages = Array.from({ length: 12 }, (_, i) => ({ id: `page-${i + 1}`, index: i + 1, title: `Page ${i + 1}`,
  markdown: `Page ${i + 1} prose about the walk home and everything seen along it.`, summary: `Page ${i + 1} summary.`,
  imagePrompt: null, status: "COMPLETED", images: [], chapter: null }));
const job = (payload: Record<string, unknown>) => ({ data: { projectId: "project-1", planId: "plan-1", generationJobId: "gj-1", ...payload } }) as unknown as Job;
// A Quick Draft book: the compile's one review (the defect screen) and its scoped repair run on it.
// The chapter-transition sweep and the per-page repair loop went with the old final review (2026-10-16).
const input = { title: "The Long Walk", prompt: "A book about walking home.", category: "KIDS", targetPages: 12,
  complexity: 3, temperature: 0.6, language: "en", mediaSettings: { modelTier: "fast", generationStrategy: "draft-then-polish" } };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.inputForPlanVersion.mockReturnValue(input);
  mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", planningPackage: { title: input.title, chapters: [], promises: [] }, inputSnapshot: null });
  mocks.prisma.project.findUnique.mockResolvedValue({ id: "project-1", status: "GENERATING", title: input.title, contentRevision: 4, mediaSettings: {}, pages, images: [], research: [] });
  mocks.strategy.compileMarkdown.mockReturnValue("# The Long Walk\n\nProse.\n");
  mocks.createReaderChaptersForExport.mockResolvedValue({ chapters: [], source: "model" });
  mocks.generateJsonWithRetry.mockResolvedValue({ data: { issues: [] } });
  mocks.exportPublicationSuperseded.mockResolvedValue(false);
  mocks.pendingExportPaths.mockImplementation((path: string) => pendingExportPaths(path, "test"));
  mocks.publishCompiledExports.mockResolvedValue({ published: true, characterPreparationJobId: null });
  mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "balanced", enabled: isDefaultCompileQualityFeature });
  mocks.repairQuickDraftPages.mockReset();
});
function persistedQualityReport(): { issues: Array<{ code: string }> } {
  const call = mocks.prisma.generationJob.update.mock.calls.find(([arg]) => arg.data?.qualityReport);
  if (!call) throw new Error("Quality report was not saved");
  return call[0].data.qualityReport;
}

it("carries a stored manuscript finding into the scoped repair when the screen approves", async () => {
  const guidance = "Add the brief walk from the entrance to the clearing and leave the neighbors waiting.";
  const failedPages = pages.map((page) => page.index === 5 ? { ...page, status: "FAILED_QA", qualityReport: {
    approved: false, score: 60, issues: ["The entrance-to-clearing transition is missing."], requiredRevisions: [guidance], notes: "Batch manuscript finding."
  } } : page);
  mocks.prisma.project.findUnique.mockResolvedValue({ id: "project-1", status: "GENERATING", title: input.title, contentRevision: 4, mediaSettings: {}, pages: failedPages, images: [], research: [] });
  mocks.repairQuickDraftPages.mockImplementationOnce(async ({ pages: book }) =>
    book.map((page) => page.index === 5 ? { ...page, markdown: `${page.markdown} They walked down to the clearing.` } : page));
  mocks.loadPagesForExport.mockResolvedValue(pages);
  await compileExport(job({ contentRevision: 4 }));
  expect(mocks.reviewQuickDraftManuscript).toHaveBeenCalledOnce();
  expect(mocks.repairQuickDraftPages).toHaveBeenCalledOnce();
  expect(mocks.repairQuickDraftPages).toHaveBeenCalledWith(expect.objectContaining({
    targetPageIndexes: [5], instruction: expect.stringContaining(guidance) }));
  expect(mocks.prisma.page.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "page-5" },
    data: expect.objectContaining({ markdown: expect.stringContaining("They walked down to the clearing.") }) }));
});

it("publishes unsupported evidence as warnings without buying a repair", async () => {
  const advisedPages = pages.map((page) => page.index === 5 ? { ...page, qualityReport: { approved: true, score: 95,
    qualityAdvisories: [{ check: "style", status: "unverified", message: "The critic requested another scene after the ending." }] } } : page);
  mocks.prisma.project.findUnique.mockResolvedValue({ id: "project-1", status: "GENERATING", title: input.title, contentRevision: 4, mediaSettings: {}, pages: advisedPages, images: [], research: [] });
  await compileExport(job({ contentRevision: 4 }));
  expect(mocks.repairQuickDraftPages).not.toHaveBeenCalled();
  expect(persistedQualityReport().issues).toContainEqual(expect.objectContaining({ code: "STYLE_REVIEW_UNVERIFIED", severity: "warning", affectedPageIndexes: [5] }));
});

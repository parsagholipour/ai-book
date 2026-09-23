import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "bullmq";

const coverageReview = vi.hoisted(() => vi.fn());

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
  return { ...(await import("./testing/compileExportMocks.js")).coreModuleMock(actual), reviewManuscriptCoverage: coverageReview };
});

import { compileExport } from "./compileExport.js";
import { pendingExportPaths } from "../generation/exportArtifacts.js";
import { isDefaultCompileQualityFeature, mocks } from "./testing/compileExportMocks.js";

describe("brief coverage at publication", () => {
  let storage: string;
  const input = { prompt: "A book about cryptography.", category: "SCIENCE", targetPages: 12,
    complexity: 7, temperature: 0.8, language: "en", mediaSettings: { finalReview: true } };
  const plan = { title: "Public Keys", premise: "Public key cryptography.", audience: "adults", chapters: [] };
  const pages = Array.from({ length: 12 }, (_, index) => ({ id: `page-${index + 1}`, index: index + 1,
    title: `Page ${index + 1}`, markdown: "", summary: "An explanation.", imagePrompt: null,
    status: "COMPLETED", images: [], chapter: null }));
  const projectRecord = () => ({ id: "project-1", title: plan.title, status: "COMPLETE", contentRevision: 4,
    authorName: null, mediaSettings: {}, pages, images: [], research: [] });
  const job = (payload: Record<string, unknown>) => ({ data: {
    projectId: "project-1", planId: "plan-1", generationJobId: "gj-1", ...payload
  } }) as unknown as Job;
  const persistedQualityReport = () => {
    const update = mocks.prisma.generationJob.update.mock.calls.find((call) => call[0].data?.qualityReport);
    return update![0].data.qualityReport as { state: string; issues: Array<{ code: string; severity: string }> };
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.strategy.executionMode = "composed-chapters";
    mocks.createReaderChaptersForExport.mockResolvedValue({ source: "deterministic", chapters: [] });
    coverageReview.mockResolvedValue({ status: "reviewed", requirements: [], issues: [] });
    storage = await mkdtemp(join(tmpdir(), "compile-chapter-length-"));
    mocks.config.BOOK_STORAGE_DIR = storage;
    mocks.config.IMAGE_STORAGE_DIR = join(storage, "images");
    await mkdir(join(storage, "project-1"), { recursive: true });
    mocks.inputForPlanVersion.mockReturnValue(input);
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", planningPackage: plan, inputSnapshot: null });
    mocks.strategy.runFinalBookQa.mockResolvedValue({ approved: true, issues: [], requiredFixes: [], repairPageIndexes: [] });
    mocks.strategy.compileMarkdown.mockReturnValue("# Public Keys\n\nProse.\n");
    mocks.generateJsonWithRetry.mockResolvedValue({ data: { issues: [] } });
    mocks.exportPublicationSuperseded.mockResolvedValue(false);
    mocks.pendingExportPaths.mockImplementation((projectDir: string) => pendingExportPaths(projectDir, "test"));
    mocks.publishCompiledExports.mockResolvedValue({ published: true, characterPreparationJobId: null });
    mocks.loadProjectStoryState.mockResolvedValue({ promises: [], facts: [], entities: {}, unanswered: [] });
    mocks.rebuildProjectStoryState.mockResolvedValue({ promises: [], facts: [], entities: {}, unanswered: [] });
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "balanced", enabled: isDefaultCompileQualityFeature });
  });
  afterEach(async () => { mocks.strategy.executionMode = "whole-book"; await rm(storage, { recursive: true, force: true }); });

  it("flags Balanced's explicitly requested comparison table when extraction is disabled", async () => {
    mocks.inputForPlanVersion.mockReturnValue({ ...input, prompt: "Explain public keys. Include at least one useful comparison table." });
    mocks.prisma.project.findUnique.mockResolvedValue({ ...projectRecord(), pages: pages.map((page) => ({ ...page, markdown: `A different explanation on page ${page.index}.` })) });
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "balanced", enabled: () => false });
    coverageReview.mockResolvedValue({ status: "reviewed", requirements: [], issues: [{
      code: "MISSING_BRIEF_REQUIREMENT", severity: "warning", source: "model",
      message: "The requested comparison table is missing.", guidance: "Add the requested comparison table.", affectedPageIndexes: []
    }] });
    await compileExport(job({ contentRevision: 4 }));
    expect(persistedQualityReport().issues).toContainEqual(expect.objectContaining({ code: "MISSING_BRIEF_REQUIREMENT" }));
    expect(coverageReview).toHaveBeenCalledWith(expect.objectContaining({ brief: expect.stringContaining("comparison table"), pages: expect.any(Array) }));
  });

  it("does not accuse Premium of an unpaid promise after the manuscript review finds its payoff", async () => {
    const promise = "Clearly explain the conceptual difference between the discrete logarithm problem and integer factorization.";
    const state = { promises: [{ id: "plan-1", text: promise, status: "open" as const, openedAtPage: 0 }], facts: [], entities: {}, unanswered: [] };
    mocks.rebuildProjectStoryState.mockResolvedValue(state);
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", planningPackage: { ...plan, promises: [promise] }, inputSnapshot: null });
    mocks.prisma.project.findUnique.mockResolvedValue({ ...projectRecord(), pages: pages.map((page) => ({ ...page, markdown: "Factoring recovers prime factors of a composite; a discrete logarithm recovers an exponent in a group." })) });
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "balanced", enabled: () => true });
    await compileExport(job({ contentRevision: 4 }));
    expect(persistedQualityReport().issues.map((issue) => issue.code)).not.toContain("UNPAID_PROMISE");
    expect(coverageReview).toHaveBeenCalledWith(expect.objectContaining({ promises: expect.arrayContaining([promise]) }));
  });
  it("records manuscript-reviewed missing promises as warnings and publishes the available book", async () => {
    mocks.prisma.project.findUnique.mockResolvedValue({ ...projectRecord(), pages: pages.map((page) => ({ ...page, markdown: "An explanation of public keys." })) });
    coverageReview.mockResolvedValue({ status: "reviewed", requirements: [], issues: [{
      code: "UNPAID_PROMISE", severity: "warning", source: "model",
      message: "The promised forward secrecy explanation is missing.", guidance: "Add the explanation.", affectedPageIndexes: []
    }] });
    await compileExport(job({ contentRevision: 4 }));
    expect(persistedQualityReport()).toMatchObject({ state: "review_recommended", issues: expect.arrayContaining([
      expect.objectContaining({ code: "UNPAID_PROMISE", severity: "warning", source: "model" })
    ]) });
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(expect.objectContaining({ status: "COMPLETE" }));
  });

  it.each([2, 6])("reviews and exports the current %i chapters even when the plan proposed four", async (count) => {
    const currentPages = pages.map((page, position) => ({ ...page, markdown: `Final prose on page ${page.index}.`,
      chapter: { index: Math.floor(position / (12 / count)) + 1,
        title: `Revised division ${Math.floor(position / (12 / count)) + 1}`, summary: "Current grouping." } }));
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", planningPackage: { ...plan,
      chapters: Array.from({ length: 4 }, (_, index) => ({ index: index + 1, title: `Initial ${index + 1}`,
        summary: "Provisional grouping.", targetPages: 3, keyBeats: [] })) }, inputSnapshot: null });
    mocks.prisma.project.findUnique.mockResolvedValue({ ...projectRecord(), pages: currentPages });
    await compileExport(job({ contentRevision: 4 }));
    const exported = mocks.strategy.compileMarkdown.mock.calls[0]![0].readerChapters;
    const reviewed = coverageReview.mock.calls[0]![0].chapters;
    expect(reviewed).toHaveLength(count);
    expect(reviewed).toEqual(exported.map(({ summary: _summary, ...chapter }: { summary: string }) => chapter));
    expect(reviewed[0]).toMatchObject({ title: "Revised division 1", startPageIndex: 1, endPageIndex: 12 / count });
    expect(mocks.createReaderChaptersForExport).not.toHaveBeenCalled();
  });

  it("resolves a per-page book's final grouping once and shares it with review and export", async () => {
    mocks.strategy.executionMode = "whole-book";
    const chapters = [
      { index: 1, title: "Current opening", summary: "Opening.", startPageIndex: 1, endPageIndex: 6 },
      { index: 2, title: "Current ending", summary: "Ending.", startPageIndex: 7, endPageIndex: 12 }
    ];
    mocks.createReaderChaptersForExport.mockResolvedValue({ source: "model", chapters });
    mocks.prisma.project.findUnique.mockResolvedValue({ ...projectRecord(), pages: pages.map((page) => ({ ...page, markdown: `Final prose on page ${page.index}.` })) });
    await compileExport(job({ contentRevision: 4 }));
    expect(mocks.createReaderChaptersForExport).toHaveBeenCalledOnce();
    expect(coverageReview.mock.calls[0]![0].chapters).toEqual(chapters.map(({ summary: _summary, ...chapter }) => chapter));
    expect(mocks.strategy.compileMarkdown.mock.calls[0]![0].readerChapters).toEqual(chapters);
  });

});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "bullmq";

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
import { pendingExportPaths } from "../generation/exportArtifacts.js";
import { isDefaultCompileQualityFeature, mocks } from "./testing/compileExportMocks.js";

describe("composed chapter length at publication", () => {
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
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "balanced", enabled: isDefaultCompileQualityFeature });
  });
  afterEach(async () => { await rm(storage, { recursive: true, force: true }); });

  it.each([false, true])("flags a short composed chapter in the exported report (skipFinalReview=%s)", async (skipFinalReview) => {
    const chapters = [
      { id: "chapter-1", index: 1, title: "Public keys", targetPages: 4 },
      { id: "chapter-2", index: 2, title: "Applications", targetPages: 8 }
    ];
    const manuscript = pages.map((page) => ({ ...page,
      chapter: chapters[page.index <= 4 ? 0 : 1],
      markdown: Array.from({ length: page.index <= 4 ? (page.index === 4 ? 341 : 343) : 500 }, (_, i) => `${String.fromCharCode(97 + page.index)}${i.toString(36).replace(/\d/g, (digit) => String.fromCharCode(107 + Number(digit)))}`).join(" ")
    }));
    mocks.prisma.project.findUnique.mockResolvedValue({ ...projectRecord(), pages: manuscript });
    mocks.strategy.executionMode = "composed-chapters";
    try {
      await compileExport(job({ contentRevision: 4, skipFinalReview }));
    } finally {
      mocks.strategy.executionMode = "whole-book";
    }
    expect(persistedQualityReport().issues).toContainEqual(expect.objectContaining({
      code: "CHAPTER_LENGTH_SHORTFALL", severity: "error", affectedPageIndexes: [1, 2, 3, 4],
      message: expect.stringContaining("1370 readable words against a 1720-word minimum")
    }));
    expect(persistedQualityReport().issues.filter((issue) => issue.severity === "error").map((issue) => issue.code)).toEqual(["CHAPTER_LENGTH_SHORTFALL"]);
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(expect.objectContaining({ status: "REVIEW_REQUIRED" }));
  });

});

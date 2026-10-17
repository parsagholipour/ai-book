import { objectStore } from "@book-maker/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { ReaderChapter } from "@book-maker/core";

/**
 * An author's book — imported, or written in the Studio — through the whole
 * compile: its own chapters and never the model's, its own typography, only
 * the checks that ask whether it is whole, and a Studio picture book one sheet
 * per page. Same module mocks as `compileExport.test.ts`.
 */
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
import { EXPORT_PUBLICATION_PROJECT_STATUS } from "@book-maker/core";
import { isDefaultCompileQualityFeature, mocks } from "./testing/compileExportMocks.js";

const studio = (layout: "flow" | "picture") => ({
  finalReview: false, coverArtSource: "design",
  mobile: { studio: { layout, kind: layout === "picture" ? "picture" : "story", createdAt: "2026-09-29T00:00:00.000Z" } }
});
const imported = { finalReview: false, mobile: { import: { filename: "novel.docx" } } };
const inputFor = (mediaSettings: Record<string, unknown>, category = "STORY", targetPages = 6) => ({
  title: "Harbour Lights", prompt: "Author-written manuscript: Harbour Lights", category, targetPages,
  complexity: 5, temperature: 0.7, language: "en", mediaSettings
});
const plan = { title: "Harbour Lights", premise: "An author's book.", audience: "General readers", chapters: [] };

function page(index: number, chapter: { id: string; index: number; title: string } | null) {
  return {
    id: `page-${index}`, index, title: `${chapter?.title ?? "Page"} · ${index}`,
    markdown: `Prose on page ${index} that the author wrote.`, summary: `Page ${index}.`,
    imagePrompt: null, status: "COMPLETED", revision: 1, images: [],
    chapter: chapter ? { ...chapter, summary: "", productionBrief: null } : null
  };
}
const twoChapters = () => [1, 2, 3, 4, 5, 6].map((index) =>
  page(index, index <= 3 ? { id: "chapter-1", index: 1, title: "Chapter 1" } : { id: "chapter-2", index: 2, title: "The Storm" }));

// A Studio publish's own compile: skip-review, owning the EDITING revision it was queued for.
const publishJob = () => ({
  data: {
    projectId: "project-1", planId: "plan-1", generationJobId: "gj-publish", contentRevision: 5,
    skipFinalReview: true, [EXPORT_PUBLICATION_PROJECT_STATUS]: "EDITING"
  }
}) as unknown as Job;

const compiledInput = () =>
  mocks.strategy.compileMarkdownWithPageAnchors.mock.calls.at(-1)![0] as {
    authorManuscript?: boolean; storyPageLayout?: string; readerChapters: ReaderChapter[];
  };

function stage(mediaSettings: Record<string, unknown>, pages = twoChapters(), category = "STORY") {
  mocks.inputForPlanVersion.mockReturnValue(inputFor(mediaSettings, category, pages.length));
  mocks.prisma.project.findUnique.mockResolvedValue({
    id: "project-1", title: "Harbour Lights", status: "EDITING", contentRevision: 5, authorName: "A. Author",
    mediaSettings, pages, images: [{ id: "cover-1", type: "COVER", path: "/assets/images/project-1/cover.jpg" }], research: []
  });
}

describe("compileExport for an author's book", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.strategy.executionMode = "whole-book";
    mocks.prisma.generationJob.count.mockResolvedValue(0);
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", planningPackage: plan, inputSnapshot: null });
    mocks.strategy.compileMarkdown.mockReturnValue("# Harbour Lights\n\nProse.\n");
    mocks.createReaderChaptersForExport.mockResolvedValue({ chapters: [], source: "model" });
    mocks.exportPublicationSuperseded.mockResolvedValue(false);
    mocks.pendingExportPaths.mockImplementation((projectDir: string) => pendingExportPaths(projectDir, "test"));
    mocks.publishCompiledExports.mockResolvedValue({ published: true, characterPreparationJobId: null });
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "balanced", enabled: isDefaultCompileQualityFeature });
    await objectStore().delete("books/project-1/book.md");
    stage(studio("flow"));
  });

  it("prints a Studio book in the author's chapters and titles, and never asks a model for them", async () => {
    await compileExport(publishJob());

    expect(mocks.createReaderChaptersForExport).not.toHaveBeenCalled();
    expect(mocks.generateJsonWithRetry).not.toHaveBeenCalled();
    expect(compiledInput().authorManuscript).toBe(true);
    expect(compiledInput().storyPageLayout).toBeUndefined();
    expect(compiledInput().readerChapters.map((chapter) => [chapter.title, chapter.startPageIndex, chapter.endPageIndex]))
      .toEqual([["Chapter 1", 1, 3], ["The Storm", 4, 6]]);
    expect(mocks.strategy.generatePdf).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ targetPageCount: undefined }));
    expect(mocks.runDeterministicManuscriptChecks).toHaveBeenCalledWith(expect.objectContaining({ authorManuscript: true }));
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(expect.objectContaining({
      contentRevision: 5, expectedProjectStatus: "EDITING", status: "COMPLETE", ownsProjectStatus: true
    }));
  });

  it("hands a one-chapter import to the plan's partition, still without the model", async () => {
    stage(imported, [1, 2, 3, 4, 5, 6].map((index) => page(index, { id: "chapter-1", index: 1, title: "Everything" })));

    await compileExport(publishJob());

    expect(mocks.createReaderChaptersForExport).not.toHaveBeenCalled();
    expect(compiledInput().readerChapters).toEqual([]);
    expect(compiledInput().authorManuscript).toBe(true);
  });

  it("keeps the model grouping for a generated book of the same shape", async () => {
    stage({ finalReview: false }, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((index) => page(index, null)));

    await compileExport(publishJob());

    expect(mocks.createReaderChaptersForExport).toHaveBeenCalledTimes(1);
    expect(compiledInput().authorManuscript).toBe(false);
  });

  it("gives a Studio picture book one printed sheet per page, whatever its category and length", async () => {
    stage(studio("picture"), [page(1, null)], "CUSTOM");

    await compileExport(publishJob());

    expect(compiledInput().storyPageLayout).toBe("separate");
  });

  it("never gives an import the generated short-kids layout", async () => {
    stage(imported, [1, 2, 3, 4, 5, 6, 7, 8].map((index) => page(index, null)), "KIDS");

    await compileExport(publishJob());

    expect(compiledInput().storyPageLayout).toBeUndefined();
  });

  it("publishes an author's own \"Page 3\" heading, which fails a generated compile", async () => {
    mocks.strategy.compileMarkdown.mockReturnValue("# Harbour Lights\n\nIntro.\n\n## Page 3\n\nThe hall.\n");

    await expect(compileExport(publishJob())).resolves.toEqual({ durableCompletionCommitted: true });

    stage({ finalReview: false });
    await expect(compileExport(publishJob())).rejects.toThrow(/page-number heading/);
  });

  it("holds an author's chapter to no composed length budget, whatever strategy auto resolved to", async () => {
    // The shortfall is a console diagnostic on a generated book; an author's book never measures it.
    const lastReportCodes = () => {
      const calls = mocks.prisma.generationJob.update.mock.calls as Array<[{ data?: { qualityReport?: { issues?: Array<{ code: string }> } } }]>;
      const report = calls.map((call) => call[0].data?.qualityReport).filter((value) => value && typeof value === "object").at(-1);
      return (report?.issues ?? []).map((issue) => issue.code);
    };
    mocks.strategy.executionMode = "composed-chapters";
    try {
      await compileExport(publishJob());
      expect(mocks.publishCompiledExports).toHaveBeenLastCalledWith(expect.objectContaining({ status: "COMPLETE" }));
      expect(lastReportCodes()).not.toContain("CHAPTER_LENGTH_SHORTFALL");

      stage({ finalReview: false });
      await compileExport(publishJob());
      expect(lastReportCodes()).toContain("CHAPTER_LENGTH_SHORTFALL");
      expect(mocks.publishCompiledExports).toHaveBeenLastCalledWith(expect.objectContaining({ status: "COMPLETE" }));
    } finally {
      mocks.strategy.executionMode = "whole-book";
    }
  });

  it("stands a Studio publish down while its cover is open, and hands the compile to the cover's fan-in", async () => {
    mocks.prisma.generationJob.count.mockResolvedValue(1);

    const completion = await compileExport(publishJob());

    expect(completion.lifecycleSettlement).toBe("defer-to-successor");
    expect(mocks.strategy.compileMarkdownWithPageAnchors).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
    await completion.afterJobCompleted?.();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith(
      "project-1", "plan-1",
      expect.objectContaining({ review: expect.objectContaining({ skipFinalReview: true }), expectedProjectStatus: "EDITING" }),
      { contentRevision: 5, completedPredecessorId: "gj-publish" }
    );
  });
});

describe("compileExport for a generated book its owner took over", () => {
  // What `POST /manuscript/takeover` leaves: the generation settings kept, the
  // Studio record added to the plan's snapshot, every hero detached into a line.
  const takenOver = {
    finalReview: true, fullIllustrations: true, coverArtSource: "ai", includeSources: true,
    mobile: { studio: { layout: "flow", kind: "nonfiction", createdAt: "2026-09-30T00:00:00.000Z", origin: "takeover" } }
  };
  const figure = '```figure\n{"kind":"bar","title":"Ships","categories":["1950","1960"],"series":[{"name":"Ships","values":[3,5]}]}\n```';
  const line = "![Illustration](/assets/images/project-1/page-page-1-k1.jpg)";
  const takenOverPages = () => twoChapters().map((entry) =>
    entry.index === 1 ? { ...entry, markdown: `${line}\n\nThe harbour was quiet.` }
      : entry.index === 2 ? { ...entry, markdown: `Ships came in.\n\n${figure}` }
        : entry);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.strategy.executionMode = "composed-chapters";
    mocks.prisma.generationJob.count.mockResolvedValue(0);
    mocks.prisma.planVersion.findUnique.mockResolvedValue({ id: "plan-1", planningPackage: plan, inputSnapshot: null });
    mocks.strategy.compileMarkdown.mockReturnValue("# Harbour Lights\n\nProse.\n");
    mocks.exportPublicationSuperseded.mockResolvedValue(false);
    mocks.pendingExportPaths.mockImplementation((projectDir: string) => pendingExportPaths(projectDir, "test"));
    mocks.publishCompiledExports.mockResolvedValue({ published: true, characterPreparationJobId: null });
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "balanced", enabled: isDefaultCompileQualityFeature });
    stage(takenOver, takenOverPages(), "SCIENCE");
  });

  it("compiles by the author rules, in the book's chapters, with no final review and no model call", async () => {
    try {
      await compileExport(publishJob());
    } finally {
      mocks.strategy.executionMode = "whole-book";
    }
    expect(compiledInput().authorManuscript).toBe(true);
    expect(mocks.createReaderChaptersForExport).not.toHaveBeenCalled();
    expect(mocks.generateJsonWithRetry).not.toHaveBeenCalled();
    expect(compiledInput().readerChapters.map((chapter) => [chapter.title, chapter.startPageIndex, chapter.endPageIndex]))
      .toEqual([["Chapter 1", 1, 3], ["The Storm", 4, 6]]);
    expect(mocks.publishCompiledExports).toHaveBeenLastCalledWith(expect.objectContaining({ status: "COMPLETE" }));
  });

  it("prints every picture from its line alone, keeps the figure, and still asks for the Sources list", async () => {
    try {
      await compileExport(publishJob());
    } finally {
      mocks.strategy.executionMode = "whole-book";
    }
    const input = mocks.strategy.compileMarkdownWithPageAnchors.mock.calls.at(-1)![0] as {
      pages: Array<{ index: number; markdown: string; imagePath?: string }>;
      includeSources?: boolean;
    };
    // A detached hero has no row on the page, so nothing prints it a second time.
    expect(input.pages.every((entry) => entry.imagePath === undefined)).toBe(true);
    expect(input.pages.map((entry) => entry.markdown).join("\n").split(line)).toHaveLength(2);
    expect(input.pages[1]!.markdown).toContain(figure);
    expect(input.includeSources).toBe(true);
  });
});

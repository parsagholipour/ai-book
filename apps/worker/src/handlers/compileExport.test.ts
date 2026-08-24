import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "bullmq";
import { bookPdfCoverNumbering, type QualityFeatureId, type ReaderChapter } from "@book-maker/core";

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
import { readerChapterCachePath, writeCachedReaderChapters } from "../generation/readerChapterCache.js";
import {
  DETACHED_FROM_PROJECT_LIFECYCLE,
  EXPORT_REPAIR_FORMAT,
  PRESENTATION_ONLY_RECOMPILE,
  PRESENTATION_RECOMPILE_FALLBACK_STATUS,
  readerChapterFingerprint
} from "@book-maker/core";
import { mocks } from "./testing/compileExportMocks.js";

describe("compileExport reader chapters", () => {
  // A detached repair is queued by a status read or a download for as long as a
  // compiled file is missing, every five minutes, and nobody was charged for any
  // of them — so it may make no provider call. The reader-chapter call is the
  // one that survived `skipFinalReview`, because the cache that normally covers
  // it is written only when the model answered usably: a book compiled before
  // the cache existed has no entry at all.
  const dirs: string[] = [];

  const plan = { title: "The Long Walk", premise: "A walk home.", audience: "adults", chapters: [] };
  const input = {
    title: "The Long Walk",
    prompt: "A book about walking home.",
    category: "fiction",
    targetPages: 12,
    complexity: 3,
    temperature: 0.6,
    language: "en",
    mediaSettings: { finalReview: true }
  };

  function compilePage(index: number) {
    return {
      id: `page-${index}`,
      index,
      title: `Page ${index}`,
      markdown: `Page ${index} prose about the long walk home and everything seen along it.`,
      summary: `Page ${index} summary.`,
      imagePrompt: null,
      status: "COMPLETED",
      images: [],
      chapter: null
    };
  }

  const pages = Array.from({ length: 12 }, (_, index) => compilePage(index + 1));
  const publishedMarkdown = "# Published layout\n\nExact compiled prose.\n";
  const publishedChapterMarkdown = [
    '<section class="book-contents" aria-labelledby="book-contents-title">',
    '  <ol class="book-contents__list">',
    '    <li class="book-contents__item">',
    '      <span class="book-contents__name">Setting Out</span>',
    '      <span class="book-contents__page">1</span>',
    "    </li>",
    '    <li class="book-contents__item">',
    '      <span class="book-contents__name">Coming Home</span>',
    '      <span class="book-contents__page">7</span>',
    "    </li>",
    "  </ol>",
    "</section>",
    "",
    "Published prose."
  ].join("\n");
  const markdownPages = pages.map((page) => ({
    index: page.index,
    title: page.title,
    markdown: page.markdown,
    summary: page.summary,
    imagePath: undefined,
    imageAlt: "Illustration"
  }));
  const projectRecord = (pdfPageMap: unknown = undefined) => ({
    id: "project-1",
    title: plan.title,
    status: "COMPLETE",
    contentRevision: 4,
    authorName: null,
    mediaSettings: {},
    pages,
    images: [],
    research: [],
    ...(pdfPageMap === undefined ? {} : { pdfPageMap })
  });

  const job = (payload: Record<string, unknown> = {}) =>
    ({
      data: { projectId: "project-1", planId: "plan-1", generationJobId: "gj-1", ...payload }
    }) as unknown as Job;

  const repairJob = () =>
    job({
      skipFinalReview: true,
      contentRevision: 4,
      [DETACHED_FROM_PROJECT_LIFECYCLE]: true,
      [EXPORT_REPAIR_FORMAT]: "pdf"
    });

  const compiledChapters = () =>
    (mocks.strategy.compileMarkdown.mock.calls[0]![0] as { readerChapters: ReaderChapter[] }).readerChapters;

  /** What the model would answer, so a regression fails on the assertion. */
  const modelChapters: ReaderChapter[] = [
    { index: 1, title: "Setting Out", summary: "The road begins.", startPageIndex: 1, endPageIndex: 6 },
    { index: 2, title: "Coming Home", summary: "The road ends.", startPageIndex: 7, endPageIndex: 12 }
  ];

  beforeEach(async () => {
    vi.clearAllMocks();
    const storage = await mkdtemp(join(tmpdir(), "compile-export-"));
    dirs.push(storage);
    mocks.config.BOOK_STORAGE_DIR = storage;
    mocks.config.IMAGE_STORAGE_DIR = join(storage, "images");
    await mkdir(join(storage, "project-1"), { recursive: true });
    await writeFile(join(storage, "project-1", "book.md"), publishedMarkdown, "utf8");
    mocks.inputForPlanVersion.mockReturnValue(input);
    mocks.prisma.planVersion.findUnique.mockResolvedValue({
      id: "plan-1",
      planningPackage: plan,
      inputSnapshot: null
    });
    mocks.prisma.project.findUnique.mockResolvedValue(projectRecord());
    mocks.strategy.runFinalBookQa.mockResolvedValue({
      approved: true,
      issues: [],
      requiredFixes: [],
      repairPageIndexes: []
    });
    mocks.strategy.compileMarkdown.mockReturnValue("# The Long Walk\n\nProse.\n");
    mocks.createReaderChaptersForExport.mockResolvedValue({ chapters: modelChapters, source: "model" });
    mocks.generateJsonWithRetry.mockResolvedValue({ data: { issues: [] } });
    mocks.exportPublicationSuperseded.mockResolvedValue(false);
    mocks.pendingExportPaths.mockImplementation((projectDir: string) => ({
      markdown: join(projectDir, ".book-test.md"),
      pdf: join(projectDir, ".book-test.pdf"),
      epub: join(projectDir, ".book-test.epub")
    }));
    mocks.publishCompiledExports.mockImplementation(async (options: { characterPreparation?: unknown }) => ({
      published: true,
      characterPreparationJobId: options.characterPreparation ? "character-job-1" : null
    }));
    mocks.loadProjectStoryState.mockResolvedValue({ promises: [], facts: [], entities: {}, unanswered: [] });
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "balanced",
      enabled: (_feature: QualityFeatureId): boolean => false
    });
  });

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs.length = 0;
  });

  it("reconstructs and republishes book.md when a manual edit queue failure left every export missing", async () => {
    await rm(join(mocks.config.BOOK_STORAGE_DIR, "project-1", "book.md"));

    await expect(compileExport(repairJob())).resolves.toEqual({ durableCompletionCommitted: true });

    expect(mocks.createReaderChaptersForExport).not.toHaveBeenCalled();
    expect(mocks.strategy.compileMarkdown).toHaveBeenCalledTimes(1);
    expect(mocks.strategy.generatePdf).toHaveBeenCalledWith(
      "# The Long Walk\n\nProse.\n",
      expect.objectContaining({ outputPath: expect.stringContaining(".book-test.pdf") })
    );
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({
        repairFormat: "pdf",
        publishReconstructedMarkdown: true,
        ownsProjectStatus: false,
        generationAttemptId: null,
        editOperationId: null,
        characterPreparation: null
      })
    );
    await expect(
      readFile(join(mocks.config.BOOK_STORAGE_DIR, "project-1", ".book-test.md"), "utf8")
    ).resolves.toBe("# The Long Walk\n\nProse.\n");
  });

  it("preserves the compatible pre-edit chapter layout when applyBookEdit falls through to repair", async () => {
    const projectDir = join(mocks.config.BOOK_STORAGE_DIR, "project-1");
    await rm(join(projectDir, "book.md"));
    await writeCachedReaderChapters(projectDir, "fingerprint-before-the-edit", {
      chapters: modelChapters,
      source: "model"
    });

    await compileExport(repairJob());

    expect(mocks.createReaderChaptersForExport).not.toHaveBeenCalled();
    expect(compiledChapters()).toEqual(modelChapters);
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({ repairFormat: "pdf", publishReconstructedMarkdown: true })
    );
  });

  it("renders a repair from the exact published markdown without regrouping chapters", async () => {
    const projectDir = join(mocks.config.BOOK_STORAGE_DIR, "project-1");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "book.md"), publishedMarkdown, "utf8");

    await compileExport(repairJob());

    expect(mocks.createReaderChaptersForExport).not.toHaveBeenCalled();
    // The free deterministic recompile runs only to be byte-compared; its
    // output differs from the published manuscript here, so the exact
    // published bytes are what renders — unmeasured.
    expect(mocks.strategy.compileMarkdown).toHaveBeenCalledTimes(1);
    expect(mocks.strategy.generatePdf).toHaveBeenCalledWith(
      publishedMarkdown,
      expect.objectContaining({ outputPath: expect.stringContaining(".book-test.pdf") })
    );
    expect(mocks.generateBookEpub).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({
        repairFormat: "pdf",
        generationJobId: "gj-1",
        // Unmeasured: the published bytes won, so this PDF skipped the
        // Contents reprint the stored map includes. Ranges are replaced with
        // a cover-skip stub so chrome matches the footer; chat stays on
        // model indexes.
        pdfPageMap: bookPdfCoverNumbering(false)
      })
    );
  });

  it("publishes a successful measurement from a detached repair", async () => {
    const pageMap = {
      version: 2 as const,
      totalPdfPages: 15,
      hasCoverPage: false,
      pages: [{ index: 1, startPdfPage: 2, endPdfPage: 15 }]
    };
    mocks.strategy.compileMarkdown.mockReturnValue(publishedMarkdown);
    mocks.strategy.generatePdfWithPageMap.mockResolvedValueOnce({ pdf: Buffer.from("pdf"), pageMap } as never);

    await compileExport(repairJob());

    expect(mocks.createReaderChaptersForExport).not.toHaveBeenCalled();
    // Byte-equal: the recompile's anchor plan is honest for the published
    // manuscript, so the repair renders measured with the plan attached…
    expect(mocks.strategy.generatePdfWithPageMap).toHaveBeenCalledWith(
      publishedMarkdown,
      expect.objectContaining({ pageMapPlan: expect.objectContaining({ pageAnchors: expect.any(Array) }) })
    );
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({ pdfPageMap: pageMap })
    );
  });

  it.each([
    [
      "a legacy version-1 map",
      {
        version: 1,
        totalPdfPages: 14,
        hasCoverPage: true,
        pages: [{ index: 1, startPdfPage: 1, endPdfPage: 14 }]
      }
    ],
    ["a null map", null],
    [
      "an existing version-2 map",
      {
        version: 2,
        totalPdfPages: 14,
        hasCoverPage: true,
        pages: [{ index: 1, startPdfPage: 2, endPdfPage: 14 }]
      }
    ]
  ])("replaces %s after a detached repair fails to remeasure", async (_label, storedMap) => {
    mocks.prisma.project.findUnique.mockResolvedValueOnce(projectRecord(storedMap));
    mocks.strategy.compileMarkdown.mockReturnValue(publishedMarkdown);

    await compileExport(repairJob());

    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({ pdfPageMap: bookPdfCoverNumbering(false) })
    );
  });

  it("publishes the measured page map with the compile, stamped inside the publisher", async () => {
    const pageMap = {
      version: 2 as const,
      totalPdfPages: 15,
      hasCoverPage: true,
      pages: [{ index: 1, startPdfPage: 3, endPdfPage: 15 }]
    };
    mocks.strategy.generatePdfWithPageMap.mockResolvedValueOnce({ pdf: Buffer.from("pdf"), pageMap } as never);

    await compileExport(job({ contentRevision: 4, skipFinalReview: true }));

    // The compiled anchor plan rode into the render…
    expect(mocks.strategy.generatePdfWithPageMap).toHaveBeenCalledWith(
      "# The Long Walk\n\nProse.\n",
      expect.objectContaining({ pageMapPlan: expect.objectContaining({ pageAnchors: expect.any(Array) }) })
    );
    // …and the measured map rode into the publication for the transaction to stamp.
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({ pdfPageMap: pageMap })
    );
  });

  it("records cover-skip when a measurable render could not be measured", async () => {
    // The default generatePdfWithPageMap mock returns no pageMap: the render
    // happened, the measurement failed. Ranges from a previous compile would
    // mistranslate this pagination, but chrome still needs to know the CSS
    // skipped the cover — the plan's hasCoverPage, not a cleared column.
    mocks.strategy.compileMarkdownWithPageAnchors.mockReturnValueOnce({
      markdown: mocks.strategy.compileMarkdown({}),
      pageAnchors: [],
      hasCoverPage: true,
      hasContents: false
    });
    await compileExport(job({ contentRevision: 4, skipFinalReview: true }));

    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({ pdfPageMap: bookPdfCoverNumbering(true) })
    );
  });

  it("replaces ranges with cover-skip when a no-plan repair renders published markdown", async () => {
    // No anchor plan exists for a markdown this process did not compile, so the
    // render skips markers and the Contents reprint. Same `book.md` is not the
    // same pagination — the reprint exists because digit width moves breaks —
    // and a map from the other Chromium pass would mistranslate chat targets.
    // Cover-skip is still recorded from the manuscript's first sheet.
    await compileExport(repairJob());

    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({ pdfPageMap: bookPdfCoverNumbering(false) })
    );
  });

  it("records cover-skip from an unmeasured manuscript that opens on a cover", async () => {
    await writeFile(
      join(mocks.config.BOOK_STORAGE_DIR, "project-1", "book.md"),
      "![Cover](/assets/images/p/cover.jpg)\n\n# Published layout\n\nExact compiled prose.\n",
      "utf8"
    );

    await compileExport(repairJob());

    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({ pdfPageMap: bookPdfCoverNumbering(true) })
    );
  });

  it("uses published markdown even when a reader-chapter cache exists", async () => {
    await mkdir(join(mocks.config.BOOK_STORAGE_DIR, "project-1"), { recursive: true });
    await writeCachedReaderChapters(
      join(mocks.config.BOOK_STORAGE_DIR, "project-1"),
      readerChapterFingerprint({ input: input as never, plan: plan as never, pages: markdownPages }),
      { chapters: modelChapters, source: "model" }
    );

    await compileExport(repairJob());

    expect(mocks.createReaderChaptersForExport).not.toHaveBeenCalled();
    // Called once for the byte comparison; the published bytes still win.
    expect(mocks.strategy.compileMarkdown).toHaveBeenCalledTimes(1);
    expect(mocks.strategy.generatePdf).toHaveBeenCalledWith(
      publishedMarkdown,
      expect.objectContaining({ outputPath: expect.stringContaining(".book-test.pdf") })
    );
  });

  it("skips the model quality review on a repair, whose verdict nothing reads", async () => {
    await compileExport(repairJob());

    expect(mocks.strategy.runFinalBookQa).not.toHaveBeenCalled();
    expect(mocks.generateJsonWithRetry).not.toHaveBeenCalled();
  });

  it("still calls the model for a charged compile that misses the cache", async () => {
    await compileExport(job({ contentRevision: 4 }));

    expect(mocks.createReaderChaptersForExport).toHaveBeenCalledTimes(1);
    expect(compiledChapters()).toEqual(modelChapters);
    // And the answer is kept, so the repairs that follow are the free case.
    expect(
      JSON.parse(await readFile(readerChapterCachePath(join(mocks.config.BOOK_STORAGE_DIR, "project-1")), "utf8"))
    ).toMatchObject({ chapters: modelChapters });
  });

  it("starts no voice-character detection from a repair, which is a model call of its own", async () => {
    // The fan-out's own dedupe key is scoped to the generation attempt, and a
    // repair has none — so nothing downstream would have stopped it.
    await compileExport(repairJob());

    expect(mocks.maybeEnqueueCharacterCandidatePreparation).not.toHaveBeenCalled();
  });

  it("still fans out voice-character detection from a charged compile", async () => {
    const completion = await compileExport(job({ contentRevision: 4 }));

    expect(mocks.maybeEnqueueCharacterCandidatePreparation).not.toHaveBeenCalled();
    await completion.afterJobCompleted?.();
    expect(mocks.maybeEnqueueCharacterCandidatePreparation).toHaveBeenCalledWith(
      "project-1",
      "plan-1",
      "character-job-1"
    );
    expect(completion.durableCompletionCommitted).toBe(true);
  });

  it("still fans out voice-character detection from an edit's recompile, keyed to the legacy project/plan key", async () => {
    // An edit is charged work whose prose is new, and a book whose detection
    // never ran must still be able to earn it — but its attempt paid for the
    // edit, not for re-discovery, so the null attempt collapses repeated edits
    // onto the one spent legacy key instead of paying a discovery call each.
    await compileExport(
      job({ contentRevision: 4, skipFinalReview: true, attemptId: "attempt-edit", operationId: "operation-1" })
    );

    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({
        characterPreparation: { planId: "plan-1", attemptId: null }
      })
    );
  });

  it("passes paid attempt and edit settlement into the atomic publication", async () => {
    await compileExport(
      job({ contentRevision: 4, attemptId: "attempt-1", operationId: "operation-1" })
    );

    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({
        generationAttemptId: "attempt-1",
        editOperationId: "operation-1",
        characterPreparation: { planId: "plan-1", attemptId: "attempt-1" }
      })
    );
  });

  it("keeps a presentation-only cache miss model-free and preserves its prior settled status", async () => {
    await writeFile(
      join(mocks.config.BOOK_STORAGE_DIR, "project-1", "book.md"),
      publishedChapterMarkdown,
      "utf8"
    );
    await compileExport(
      job({
        contentRevision: 4,
        skipFinalReview: true,
        [PRESENTATION_ONLY_RECOMPILE]: true,
        [PRESENTATION_RECOMPILE_FALLBACK_STATUS]: "REVIEW_REQUIRED"
      })
    );

    expect(mocks.createReaderChaptersForExport).not.toHaveBeenCalled();
    expect(compiledChapters()).toEqual(modelChapters.map((chapter) => ({ ...chapter, summary: "" })));
    expect(mocks.strategy.runFinalBookQa).not.toHaveBeenCalled();
    expect(mocks.generateJsonWithRetry).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCharacterCandidatePreparation).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({
        ownsProjectStatus: true,
        status: "REVIEW_REQUIRED",
        pdfPageMap: bookPdfCoverNumbering(false),
        generationAttemptId: null,
        editOperationId: null,
        characterPreparation: null
      })
    );
  });

  /** The quality report this compile persisted onto its own job row. */
  function persistedQualityReport(): {
    state: string;
    issues: Array<{
      code: string;
      severity: string;
      source: string;
      message: string;
      affectedPageIndexes: number[];
    }>;
  } {
    const qualityUpdate = mocks.prisma.generationJob.update.mock.calls.find(
      (call) => (call[0] as { data?: { qualityReport?: { state?: string } } }).data?.qualityReport
    );
    if (!qualityUpdate) {
      throw new Error("expected compile to persist a qualityReport");
    }
    return (
      qualityUpdate[0] as {
        data: {
          qualityReport: {
            state: string;
            issues: Array<{
              code: string;
              severity: string;
              source: string;
              message: string;
              affectedPageIndexes: number[];
            }>;
          };
        };
      }
    ).data.qualityReport;
  }

  function withUnpaidPromise(): void {
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "balanced",
      enabled: (feature: QualityFeatureId) => feature === "storyExtractAudit"
    });
    mocks.rebuildProjectStoryState.mockResolvedValue({
      promises: [{ id: "p1", text: "The lantern will be lit.", status: "open", openedAtPage: 0 }],
      facts: [],
      entities: {},
      unanswered: []
    });
  }

  it("records unpaid plan promises as warnings so compile is not blocked", async () => {
    withUnpaidPromise();

    await compileExport(job({ contentRevision: 4 }));

    const report = persistedQualityReport();
    // A deterministic warning recommends review but never blocks: the project
    // still publishes COMPLETE, not REVIEW_REQUIRED. arrayContaining because
    // the fixture's identical filler pages also earn a REPEATED_PHRASE warning.
    expect(report.state).toBe("review_recommended");
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNPAID_PROMISE",
          severity: "warning",
          source: "deterministic"
        })
      ])
    );
    expect(report.issues.every((issue) => issue.severity === "warning")).toBe(true);
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(expect.objectContaining({ status: "COMPLETE" }));
  });

  it("carries each final-QA complaint's own pages onto the reader's quality card", async () => {
    // The card draws one page list under each message and opens Edit Mode at
    // its first page, so a page borrowed from a neighbouring complaint sends
    // the reader to prose nobody complained about. One verdict, three
    // complaints, three different answers.
    mocks.strategy.runFinalBookQa.mockResolvedValue({
      approved: false,
      issues: [
        "The opening on page 1 is generic scene-setting.",
        "Chapter 4 restates the same argument twice on page 9.",
        "The pacing sags throughout."
      ],
      requiredFixes: [],
      // Nothing to redraft, so the repair pass stands down and this verdict is
      // the one the card is built from.
      repairPageIndexes: []
    });

    await compileExport(job({ contentRevision: 4 }));

    const card = persistedQualityReport().issues.filter((issue) => issue.code === "WHOLE_BOOK_REVIEW");
    expect(card.map((issue) => [issue.message, issue.affectedPageIndexes])).toEqual([
      ["The opening on page 1 is generic scene-setting.", [1]],
      ["Chapter 4 restates the same argument twice on page 9.", [9]],
      ["The pacing sags throughout.", []]
    ]);
  });

  it("bounds the card by the book it compiled, not by the plan's page count", async () => {
    // The two numbers genuinely disagree — the deterministic checks report
    // `pages.length !== expectedPageCount` as an integrity issue of its own, and
    // `effectiveSavedWholeBookExportContext` adopts a drafted count only inside
    // half again the plan's. Twenty pages against a plan of twelve is a
    // structural insert whose plan snapshot lagged it, and bounded by the plan
    // every complaint about the pages past twelve was dropped: no "Pages …"
    // line and no tap target, for pages the reader can open right now.
    mocks.prisma.project.findUnique.mockResolvedValue({
      ...projectRecord(),
      pages: Array.from({ length: 20 }, (_, position) => compilePage(position + 1))
    });
    // Approved, so the repair pass stands down and this verdict's required fix
    // is the whole of what the card is built from.
    mocks.strategy.runFinalBookQa.mockResolvedValue({
      approved: true,
      issues: [],
      requiredFixes: ["Page 19 trails off mid-thought."],
      repairPageIndexes: []
    });

    await compileExport(job({ contentRevision: 4 }));

    const card = persistedQualityReport().issues.filter((issue) => issue.code === "WHOLE_BOOK_REVIEW");
    expect(card.map((issue) => [issue.message, issue.affectedPageIndexes])).toEqual([
      ["Page 19 trails off mid-thought.", [19]]
    ]);
  });

  it("keeps a deterministic-only recompile from re-grading a book on warnings alone", async () => {
    // Every `skipFinalReview` recompile — an undo, a verified exact replacement,
    // a chat edit's apply — owns the quality verdict and re-runs the whole-book
    // checks over prose the edit never touched. Reading a warning off one of
    // those downgraded a book that had passed to "review recommended" for good:
    // the repair pass only rewrites `severity === "error"`, so nothing could
    // clear it and every later recompile re-asserted it.
    withUnpaidPromise();

    await compileExport(job({ contentRevision: 4, skipFinalReview: true }));

    const report = persistedQualityReport();
    expect(report.state).toBe("passed");
    // Recorded all the same — the row is where an operator reads what this
    // compile saw. Only the state is the claim the app's quality card acts on.
    expect(report.issues.map((issue) => issue.code)).toContain("UNPAID_PROMISE");
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(expect.objectContaining({ status: "COMPLETE" }));
  });

  it.each([
    ["a full compile", {}],
    ["a deterministic-only recompile", { skipFinalReview: true }]
  ])("blocks %s on an integrity error", async (_label, payload) => {
    // Publication integrity is never bypassed by an edit: the warning gate
    // above must not reach errors.
    mocks.prisma.project.findUnique.mockResolvedValue({
      ...projectRecord(),
      pages: pages.map((page) => (page.index === 2 ? { ...page, markdown: "TODO: write this page." } : page))
    });

    await compileExport(job({ contentRevision: 4, ...payload }));

    expect(persistedQualityReport().state).toBe("blocked");
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({ status: "REVIEW_REQUIRED" })
    );
  });

  it("runs the final-QA repair and the integrity pass under one quality context", async () => {
    // The repair pass used to load its own, so an operator saving the Quality
    // tab between the two loads split one compile across two revisions: the
    // pages rewritten under one gate set, the report that ships them under
    // another. The second revision here enables nothing, so either half
    // reading it drops its assertion below.
    mocks.loadQualityContext
      .mockResolvedValueOnce({
        settings: {},
        tier: "balanced",
        enabled: (feature: QualityFeatureId) => feature === "styleExcerpts" || feature === "storyExtractAudit"
      })
      .mockResolvedValue({
        settings: {},
        tier: "balanced",
        enabled: (_feature: QualityFeatureId): boolean => false
      });
    mocks.rebuildProjectStoryState.mockResolvedValue({
      promises: [{ id: "p1", text: "The lantern will be lit.", status: "open", openedAtPage: 0 }],
      facts: [],
      entities: {},
      unanswered: []
    });
    // Flagged once, so the repair pass runs; the rerun after it approves.
    mocks.strategy.runFinalBookQa.mockResolvedValueOnce({
      approved: false,
      issues: [],
      requiredFixes: [],
      repairPageIndexes: [2]
    });
    const repairedMarkdown = "Repaired page 2 prose about the walk home and everything seen along it.";
    mocks.revisePageDraftWithRestart.mockResolvedValue({
      title: "Page 2",
      markdown: repairedMarkdown,
      summary: "Page 2 summary.",
      imagePrompt: null,
      continuityNotes: []
    });
    mocks.prisma.continuityNote.findMany.mockResolvedValue([]);
    mocks.prisma.page.update.mockResolvedValue({ ...compilePage(2), markdown: repairedMarkdown });
    mocks.loadPagesForExport.mockResolvedValue(pages);
    const reviewPageDraft = vi.fn().mockResolvedValue({
      approved: true,
      score: 90,
      issues: [],
      requiredRevisions: [],
      notes: ""
    });
    Object.assign(mocks.strategy, { reviewPageDraft });

    try {
      await compileExport(job({ contentRevision: 4 }));
    } finally {
      delete (mocks.strategy as { reviewPageDraft?: unknown }).reviewPageDraft;
    }

    // The repair pass read the first revision: `styleExcerpts` was on, so the
    // rewrite of page 2 was anchored to the book's opening page.
    const revise = mocks.revisePageDraftWithRestart.mock.calls[0]![0] as {
      reviseOptions: { styleExcerpts?: string[] };
    };
    expect(revise.reviseOptions.styleExcerpts).toEqual([pages[0]!.markdown]);
    // And so did the integrity pass after it: `storyExtractAudit` was on, so
    // the plan's unpaid promise reached the report the compile publishes.
    const qualityUpdate = mocks.prisma.generationJob.update.mock.calls.find(
      (call) => (call[0] as { data?: { qualityReport?: unknown } }).data?.qualityReport
    );
    const report = (qualityUpdate![0] as { data: { qualityReport: { issues: Array<{ code: string }> } } }).data
      .qualityReport;
    expect(report.issues.map((issue) => issue.code)).toContain("UNPAID_PROMISE");
    expect(mocks.loadQualityContext).toHaveBeenCalledTimes(1);
  });

  it("stands down before spending on repaired-book QA when an edit lands after repair", async () => {
    mocks.strategy.runFinalBookQa.mockResolvedValueOnce({
      approved: false,
      issues: ["Page 2 needs repair."],
      requiredFixes: ["Repair page 2."],
      repairPageIndexes: [2]
    });
    const repairedMarkdown = "Repaired page 2 prose about the walk home and everything seen along it.";
    mocks.revisePageDraftWithRestart.mockResolvedValue({
      title: "Page 2",
      markdown: repairedMarkdown,
      summary: "Page 2 summary.",
      imagePrompt: null,
      continuityNotes: []
    });
    mocks.prisma.continuityNote.findMany.mockResolvedValue([]);
    let repairPublished = false;
    mocks.prisma.page.update.mockImplementation(async () => {
      repairPublished = true;
      return { ...compilePage(2), markdown: repairedMarkdown };
    });
    mocks.loadPagesForExport.mockResolvedValue(pages);
    mocks.exportPublicationSuperseded.mockImplementation(async () => repairPublished);
    Object.assign(mocks.strategy, {
      reviewPageDraft: vi.fn().mockResolvedValue({
        approved: true,
        score: 90,
        issues: [],
        requiredRevisions: [],
        notes: ""
      })
    });

    try {
      await compileExport(job({ contentRevision: 4 }));
    } finally {
      delete (mocks.strategy as { reviewPageDraft?: unknown }).reviewPageDraft;
    }

    expect(repairPublished).toBe(true);
    // The first call graded the pre-repair book. The exact fence observes the
    // edit before a second provider call can grade or spend on obsolete pages.
    expect(mocks.strategy.runFinalBookQa).toHaveBeenCalledTimes(1);
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
    expect(mocks.strategy.generatePdf).not.toHaveBeenCalled();
  });

});

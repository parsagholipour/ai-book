import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "bullmq";
import type { FinalBookQa, ManuscriptQualityIssue, PageQualityReport, ReaderChapter } from "@book-maker/core";
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
  pageReportFromFinalQa: vi.fn(),
  loadPagesForExport: vi.fn(),
  storeEmbedding: vi.fn(),
  generateJsonWithRetry: vi.fn(),
  // Mutable so the whole-handler suite below can point storage at a temp dir.
  config: { BOOK_STORAGE_DIR: "", IMAGE_STORAGE_DIR: "", PUBLIC_API_URL: "http://localhost:4001" },
  strategy: {
    executionMode: "whole-book",
    compileMarkdown: vi.fn(),
    generatePdf: vi.fn(),
    runFinalBookQa: vi.fn()
  },
  inputForPlanVersion: vi.fn(),
  createReaderChaptersForExport: vi.fn(),
  generateBookEpub: vi.fn(),
  exportPublicationSuperseded: vi.fn(),
  pendingExportPaths: vi.fn(),
  publishCompiledExports: vi.fn(),
  discardPendingExports: vi.fn(),
  maybeEnqueueCharacterCandidatePreparation: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: {},
  researchCitationsForExport: async () => []
}));
vi.mock("../runtime/config.js", () => ({ config: mocks.config }));
vi.mock("../generation/projectInput.js", () => ({ inputForPlanVersion: mocks.inputForPlanVersion }));
vi.mock("../generation/exportPublication.js", () => ({
  discardPendingExports: mocks.discardPendingExports,
  exportPublicationSuperseded: mocks.exportPublicationSuperseded,
  pendingExportPaths: mocks.pendingExportPaths,
  publishCompiledExports: mocks.publishCompiledExports
}));
vi.mock("../runtime/dispatch.js", () => ({ parallelPageWaveSize: () => 1 }));
vi.mock("../runtime/jobLifecycle.js", () => ({
  advanceJobStep: vi.fn(),
  editOperationIdFromJob: (job: Job) =>
    typeof job.data.operationId === "string" ? job.data.operationId : null,
  updateJobProgress: vi.fn()
}));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({ text: {}, embedding: {} }) }));
vi.mock("../generation/semanticMemory.js", () => ({
  storeEmbedding: mocks.storeEmbedding,
  // Mirrors the real predicate so fixtures choose their mode explicitly.
  strategyUsesSemanticMemory: (strategy: { executionMode?: string }) =>
    strategy?.executionMode === "sequential-pages"
}));
vi.mock("./characters.js", () => ({
  maybeEnqueueCharacterCandidatePreparation: mocks.maybeEnqueueCharacterCandidatePreparation
}));
vi.mock("../generation/bookHelpers.js", () => ({
  extractRepairPageIndexes: (finalQa: { repairPageIndexes?: number[] }) => finalQa.repairPageIndexes ?? [],
  loadPagesForExport: mocks.loadPagesForExport,
  pageReportFromFinalQa: mocks.pageReportFromFinalQa,
  parseChapterBrief: () => undefined,
  strategyForInput: () => mocks.strategy,
  toFinalQaPage: (page: unknown) => page,
  toPriorPageContext: (page: unknown) => page,
  formatQualityFailure: () => "quality failure detail"
}));
vi.mock("../generation/pageReview.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/pageReview.js")>("../generation/pageReview.js");
  return {
    // The loop is the real one — the merge target this suite characterizes.
    // Only the initial rewrite helper is mocked; loop rewrites go through the
    // strategy's revisePageDraft.
    runPageQualityLoop: actual.runPageQualityLoop,
    revisePageDraftWithRestart: mocks.revisePageDraftWithRestart
  };
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    generateJsonWithRetry: mocks.generateJsonWithRetry,
    // The chapterization call, spied rather than stubbed away: the whole point
    // of the repair suite below is whether it happens at all.
    createReaderChaptersForExport: mocks.createReaderChaptersForExport,
    generateBookEpub: mocks.generateBookEpub,
    bookPlanSchema: { parse: (value: unknown) => value },
    // The real factory builds live adapters and demands provider keys.
    createProviders: () => ({ text: {}, embedding: {}, image: {} })
  };
});

import {
  compileExport,
  dedupeQualityIssues,
  qualitySummaryMessage,
  repairPagesFromFinalQa,
  runBoundedChapterQualityReview
} from "./compileExport.js";
import { MAX_FINAL_QA_REVISIONS_PER_PAGE } from "../generation/tuning.js";
import { StopRequestedError } from "../runtime/jobTypes.js";
import { readerChapterCachePath, writeCachedReaderChapters } from "../generation/readerChapterCache.js";
import {
  DETACHED_FROM_PROJECT_LIFECYCLE,
  EXPORT_REPAIR_FORMAT,
  PRESENTATION_ONLY_RECOMPILE,
  PRESENTATION_RECOMPILE_FALLBACK_STATUS,
  readerChapterFingerprint
} from "@book-maker/core";

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
  // Sequential-pages so the repaired-page embedding write is exercised; other
  // modes skip it because nothing ever reads their embeddings.
  const strategy = { executionMode: "sequential-pages", reviewPageDraft: vi.fn(), revisePageDraft: vi.fn() };

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
    // The first rewrite comes from the finalQa report; the loop's rewrites go
    // through the strategy. One counter covers both.
    let rewrite = 0;
    mocks.revisePageDraftWithRestart.mockImplementation(async () => draftNamed(`Rewrite ${(rewrite += 1)}`));
    strategy.revisePageDraft.mockImplementation(async () => draftNamed(`Rewrite ${(rewrite += 1)}`));
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
    strategy.revisePageDraft.mockResolvedValue(draftNamed("Rewrite"));
    strategy.reviewPageDraft.mockResolvedValue(report(40));

    await repairPagesFromFinalQa(baseOptions());

    // Loop rewrites are attempts 2..6. This loop counts attempts from the
    // first rewrite — one later than the page loops count candidates — so the
    // recovery escalation must land on attempt PAGE_QA_RECOVERY_CANDIDATE - 1
    // (the third rewrite), not one rewrite later.
    const escalated = strategy.revisePageDraft.mock.calls.map((call) =>
      (call[0] as { report: { issues: string[] } }).report.issues.includes(
        "Earlier generated replacements for this page were still rejected by QA."
      )
    );
    expect(escalated).toEqual([
      false, // attempt 2
      true, // attempt 3 = PAGE_QA_RECOVERY_CANDIDATE - 1
      true,
      true,
      true
    ]);
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
    mocks.prisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      title: plan.title,
      status: "COMPLETE",
      contentRevision: 4,
      authorName: null,
      mediaSettings: {},
      pages,
      images: [],
      research: []
    });
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
    expect(mocks.strategy.compileMarkdown).not.toHaveBeenCalled();
    expect(mocks.strategy.generatePdf).toHaveBeenCalledWith(
      publishedMarkdown,
      expect.objectContaining({ outputPath: expect.stringContaining(".book-test.pdf") })
    );
    expect(mocks.generateBookEpub).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({ repairFormat: "pdf", generationJobId: "gj-1" })
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
    expect(mocks.strategy.compileMarkdown).not.toHaveBeenCalled();
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
        generationAttemptId: null,
        editOperationId: null,
        characterPreparation: null
      })
    );
  });

  it("retires stale EPUB on a presentation reprint whose conversion fails", async () => {
    mocks.generateBookEpub.mockRejectedValue(new Error("converter failed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await compileExport(
      job({
        contentRevision: 4,
        skipFinalReview: true,
        [PRESENTATION_ONLY_RECOMPILE]: true,
        [PRESENTATION_RECOMPILE_FALLBACK_STATUS]: "REVIEW_REQUIRED"
      })
    );

    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({ epubProduced: false, repairFormat: null, status: "REVIEW_REQUIRED" })
    );
    logged.mockRestore();
  });

  it("retires stale EPUB on an undo/manual recompile whose conversion fails", async () => {
    mocks.generateBookEpub.mockRejectedValue(new Error("converter failed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await compileExport(job({ contentRevision: 4, skipFinalReview: true }));

    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({ epubProduced: false, repairFormat: null, ownsProjectStatus: true })
    );
    logged.mockRestore();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "bullmq";

/**
 * What a compile leaves on its durable row when it publishes nothing.
 *
 * `compileExportStandDown.test.ts` covers the door reached from *inside* the
 * final-QA repair. These are the other unpublished exits — the compile's own
 * supersede read just before the render, `publishCompiledExports`'
 * compare-and-set answering somebody else, and open `GENERATE_IMAGE` jobs at
 * the top of the handler. The two late doors differ from the repair catch in
 * the way that made them wrong: both run below `recordCompileQualityReport`,
 * so the row already holds this compile's verdict by the time they decide to
 * stand down. The image-job gate used to retract the column to DbNull instead.
 * Filtering at one door and not the others left a reader who chat-edited page 3
 * mid-compile looking at a `blocked` quality card about prose they had
 * replaced, with nothing coming to overwrite it, because the compile that
 * supersedes this one may own no verdict at all.
 *
 * Plus the guard on the truncated-repair note, which is the same asymmetry one
 * catch over: a trace filed on a path whose entire purpose is to keep a
 * finished, fully paid book away from `markFailed` may not be the thing that
 * sends it there.
 */

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
/**
 * The run logger, replaceable rather than stubbed: `RunLogger.append` swallows
 * its own write failures, so the throw the truncated-repair note has to survive
 * comes from *building* one — a storage directory that cannot be created is the
 * ordinary way to get it.
 */
const { openRunLog } = vi.hoisted(() => ({
  openRunLog: vi.fn((_job: unknown) => ({ append: async (): Promise<void> => undefined }))
}));
vi.mock("../providers/runLogging.js", () => ({ createRunLogger: (job: unknown) => openRunLog(job) }));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return (await import("./testing/compileExportMocks.js")).coreModuleMock(actual);
});

import { compileExport } from "./compileExport.js";
import { qualityReportWithProvenance } from "./compileExportQualityProvenance.js";
import { ExportRepairFenceUnreadableError, recordTruncatedRepairPass } from "./compileExportFence.js";
import { StopRequestedError } from "../runtime/jobTypes.js";
import { DB_NULL, mocks } from "./testing/compileExportMocks.js";

describe("what a superseded compile leaves on its row", () => {
  const plan = { title: "The Long Walk", premise: "A walk home.", audience: "adults", chapters: [] };
  /**
   * No final review, which is the cheapest route past the repair pass entirely
   * — these two doors are below it, and a deterministic *error* blocks from
   * either mode, so the stale card this is about needs no model call to
   * produce.
   */
  const input = {
    title: "The Long Walk",
    prompt: "A book about walking home.",
    category: "fiction",
    targetPages: 2,
    complexity: 3,
    temperature: 0.6,
    language: "en",
    mediaSettings: { finalReview: false }
  };

  const compilePage = (index: number, markdown?: string) => ({
    id: `page-${index}`,
    index,
    title: `Page ${index}`,
    markdown: markdown ?? `Page ${index} prose about the long walk home and everything seen along it.`,
    summary: `Page ${index} summary.`,
    imagePrompt: null,
    revision: 1,
    status: "COMPLETED",
    images: [],
    chapter: null
  });
  /** Page 1 still carries the placeholder the deterministic sweep blocks on. */
  const reviewedPages = [compilePage(1, "Page 1 prose with a TODO still sitting in it."), compilePage(2)];
  /**
   * The book once the reader's chat edit has landed: their prose replaces the
   * placeholder page, and their insert adds a page this compile never read.
   */
  const readersPages = [
    { ...compilePage(1, "Page 1 as the reader rewrote it, with no placeholder left in it."), revision: 2 },
    compilePage(2),
    compilePage(3)
  ];
  /**
   * The same book with a second flagged page, and the reader's edit leaving it
   * alone.
   *
   * One finding is the shape that cannot tell a withdrawal from a retraction:
   * filter it out and there is nothing left to grade, which is its own answer.
   * Two, with one of them about prose nobody touched, is what makes "withheld
   * the stale half and kept the rest" a visible outcome at these doors.
   */
  const reviewedPagesBothFlagged = [
    compilePage(1, "Page 1 prose with a TODO still sitting in it."),
    compilePage(2, "Page 2 prose with a TODO still sitting in it.")
  ];
  const readersPagesKeepingPageTwo = [
    { ...compilePage(1, "Page 1 as the reader rewrote it, with no placeholder left in it."), revision: 2 },
    compilePage(2, "Page 2 prose with a TODO still sitting in it."),
    compilePage(3)
  ];

  /**
   * The four columns the stand-down's own read actually selects. Staged in that
   * shape rather than as whole page rows, so a comparison that reached for an
   * illustration or a chapter would find what the real query answers with:
   * nothing.
   */
  const pageText = (page: { index: number; title: string; markdown: string; revision: number }) => ({
    index: page.index,
    title: page.title,
    markdown: page.markdown,
    revision: page.revision
  });

  const job = (payload: Record<string, unknown> = {}) =>
    ({
      id: "bull-1",
      name: "compile-export",
      data: { projectId: "project-1", planId: "plan-1", generationJobId: "gj-1", contentRevision: 4, ...payload }
    }) as unknown as Job;

  const storageDirs: string[] = [];
  /** Everything below the verdict write, stubbed: this suite claims nothing about the render. */
  const rendersAndTriesToPublish = async (): Promise<void> => {
    const storage = await mkdtemp(join(tmpdir(), "compile-export-verdict-"));
    storageDirs.push(storage);
    mocks.config.BOOK_STORAGE_DIR = storage;
    mocks.config.IMAGE_STORAGE_DIR = join(storage, "images");
    mocks.strategy.compileMarkdown.mockReturnValue("# The Long Walk\n\nProse.\n");
    mocks.createReaderChaptersForExport.mockResolvedValue({ chapters: [], source: "model" });
    mocks.pendingExportPaths.mockImplementation((projectDir: string) => ({
      markdown: join(projectDir, ".book-test.md"),
      pdf: join(projectDir, ".book-test.pdf"),
      epub: join(projectDir, ".book-test.epub")
    }));
  };

  /** What the project's rows hold, for a case that does not want the default fixture. */
  const projectHolding = (projectPages: unknown[]): void => {
    mocks.prisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      title: plan.title,
      status: "COMPLETE",
      contentRevision: 4,
      authorName: null,
      mediaSettings: {},
      pages: projectPages,
      images: [],
      research: []
    });
  };

  type RecordedReport = { state: string; score: number; issues: Array<{ code: string; affectedPageIndexes: number[] }> };
  const recordedReports = (): RecordedReport[] =>
    (mocks.prisma.generationJob.update.mock.calls as Array<[{ data: { qualityReport: RecordedReport } }]>).map(
      (call) => call[0].data.qualityReport
    );

  beforeEach(() => {
    vi.clearAllMocks();
    openRunLog.mockImplementation(() => ({ append: async () => undefined }));
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
      pages: reviewedPages,
      images: [],
      research: []
    });
    // The only caller left on this path is the stand-down's own re-read, which
    // is what makes "the book as it now stands" assertable at all — and it is
    // the narrow loader, not the export set.
    mocks.loadPageTextSnapshot.mockResolvedValue(readersPages.map(pageText));
    mocks.loadQualityContext.mockResolvedValue({ settings: {}, tier: "balanced", enabled: (): boolean => false });
    mocks.exportPublicationSuperseded.mockResolvedValue(false);
    mocks.publishCompiledExports.mockResolvedValue({ published: true, characterPreparationJobId: null });
    // Open-image-job tests below set this to 1. `clearAllMocks` does not
    // restore implementations, so a leftover 1 would send every later case
    // through the early requeue door and fail assertions that expect `{}`.
    mocks.prisma.generationJob.count.mockResolvedValue(0);
    // Same for `findUnique`: open-image-job tests below replace it with a
    // stored report. Later cases must still get the default "not an image
    // job" answer rather than that leftover row.
    mocks.prisma.generationJob.findUnique.mockReset();
    mocks.prisma.generationJob.findUnique.mockResolvedValue(null);
  });

  afterEach(async () => {
    await Promise.all(storageDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    storageDirs.length = 0;
  });

  it("retracts rather than passing when the reader has replaced every page it complained about", async () => {
    // The stale-verdict filter was wired into the repair's catch and nowhere
    // else, so this door — a few statements below the write that stores the
    // report — left the blocked card standing. `loadProjectQualityReport` keeps
    // serving that row until a verdict-owning compile replaces it, and the
    // compile that supersedes this one need not be one: an image edit queues a
    // `MARKDOWN_RECOMPILE_WITHOUT_VERDICT` recompile, and an edit's own
    // recompile reports `finalReviewRan: false`.
    //
    // Filtering alone was not the whole answer, because this book's only
    // finding is about the page the reader replaced: withhold it and what is
    // left grades `passed`, score 100 — "Quality checks passed", written over
    // this compile's own `blocked`, for a book whose only graded prose is
    // exactly the prose that moved. That is the claim the unreadable-manuscript
    // path already refuses, reached from the other side, and with nothing
    // coming to replace it the reader keeps it forever.
    await rendersAndTriesToPublish();
    mocks.exportPublicationSuperseded.mockResolvedValue(true);
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).resolves.toEqual({});
    } finally {
      logged.mockRestore();
    }

    // The row really did hold the stale claim: the verdict is stored before the
    // supersede read, and this is the incident rather than a test of the
    // grader.
    const reports = recordedReports();
    expect(reports[0]).toMatchObject({ state: "blocked" });
    expect(reports[0]?.issues.map((issue) => issue.code)).toContain("PLACEHOLDER_TEXT");
    // And the stand-down took it back down, over the manuscript as it now
    // stands rather than over the one this compile read.
    expect(mocks.loadPageTextSnapshot).toHaveBeenCalledWith("project-1");
    // Through the narrow loader, and only that one. The question is a set of
    // moved page indexes off four scalar columns, and it used to be asked with
    // `loadPagesForExport`: the whole manuscript plus an `images` and a
    // `chapter` join per row, issued at the one moment the compile that
    // superseded this one is rendering and publishing against the same
    // database.
    expect(mocks.loadPagesForExport).not.toHaveBeenCalled();
    // Retracted, not re-graded and not upgraded. `loadProjectQualityReport`
    // selects `not: DbNull`, so the book falls back to the last verdict
    // somebody measured against a manuscript that existed.
    expect((reports.at(-1) as unknown) === DB_NULL).toBe(true);
    expect(reports.some((report) => report?.state === "passed")).toBe(false);
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
  });

  it("keeps the findings the reader left standing, and grades what is left of them", async () => {
    // The other half of that rule, and what keeps the retraction above a filter
    // rather than a blanket: the same door, the same edit, and a second flagged
    // page the reader never touched. A finding about prose this compile read
    // and nothing has moved is exactly as true as it was, so it is still worth
    // a card — and a fresh deterministic sweep is still refused, which is what
    // keeps the reader's third page from arriving as a `PAGE_COUNT_MISMATCH`
    // this compile never measured.
    projectHolding(reviewedPagesBothFlagged);
    mocks.loadPageTextSnapshot.mockResolvedValue(readersPagesKeepingPageTwo.map(pageText));
    await rendersAndTriesToPublish();
    mocks.exportPublicationSuperseded.mockResolvedValue(true);
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).resolves.toEqual({});
    } finally {
      logged.mockRestore();
    }

    const reports = recordedReports();
    expect(reports[0]?.issues.map((issue) => issue.affectedPageIndexes)).toEqual([[1], [2]]);
    const withdrawn = reports.at(-1) as RecordedReport;
    expect((withdrawn as unknown) === DB_NULL).toBe(false);
    expect(withdrawn.issues.map((issue) => issue.affectedPageIndexes)).toEqual([[2]]);
    expect(withdrawn.issues.map((issue) => issue.code)).not.toContain("PAGE_COUNT_MISMATCH");
  });

  it("still records the pass a clean review measured, whatever the reader did next", async () => {
    // The mirror of the retraction, and the reason it is a question about the
    // findings rather than about the report. A review that ran over this
    // manuscript and complained about none of it *measured* its `passed`; the
    // withdrawal has nothing to take away, and the report it writes is the one
    // already on the row, so it upgrades nothing. Retracting here would answer
    // a fixed typo on page 1 by throwing away the only full review this book
    // has had and handing the reader an older compile's verdict instead.
    projectHolding([compilePage(1), compilePage(2)]);
    await rendersAndTriesToPublish();
    mocks.exportPublicationSuperseded.mockResolvedValue(true);
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).resolves.toEqual({});
    } finally {
      logged.mockRestore();
    }

    // The reader's manuscript is the default fixture's: page 1 rewritten and a
    // page inserted, so the book really has moved under this verdict.
    expect(mocks.loadPageTextSnapshot).toHaveBeenCalledWith("project-1");
    const reports = recordedReports();
    expect(reports.map((report) => report?.state)).toEqual(["passed", "passed"]);
    expect(reports.at(-1)?.score).toBe(100);
  });

  it("withdraws them again when the publication claim goes to somebody else", async () => {
    // The third door, and the one with the least margin: the supersede read
    // above is advisory, so a compile that clears it and then loses the
    // compare-and-set inside `publishCompiledExports` is the case where an edit
    // landed in the last few seconds. It published nothing either, and until
    // both doors were the same call it left the same stale card behind.
    await rendersAndTriesToPublish();
    mocks.publishCompiledExports.mockResolvedValue({ published: false, characterPreparationJobId: null });
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).resolves.toEqual({});
    } finally {
      logged.mockRestore();
    }

    expect(mocks.publishCompiledExports).toHaveBeenCalled();
    const reports = recordedReports();
    expect(reports[0]).toMatchObject({ state: "blocked" });
    // Same fixture, same answer: this book's one finding is about the page the
    // reader replaced, so there is nothing left to grade and the row is
    // retracted rather than upgraded to a pass nobody measured.
    expect((reports.at(-1) as unknown) === DB_NULL).toBe(true);
    expect(mocks.discardPendingExports).toHaveBeenCalled();
  });

  it("waits for image fan-in when the preflight saw zero but the locked publication boundary sees one", async () => {
    // `generationJob.count` at handler entry uses an earlier snapshot and its
    // default is zero. A sibling final-QA repair then wins the project lock,
    // commits its durable image row, and the boundary reports the ordered
    // answer. The current compile must complete before re-deriving readiness:
    // the image may already have finished and found this row ACTIVE.
    await rendersAndTriesToPublish();
    mocks.publishCompiledExports.mockResolvedValue({
      published: false,
      blockedByOpenImageJobs: true,
      characterPreparationJobId: null
    });
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const completion = await compileExport(job({
        skipFinalReview: true,
        markdownRecompileWithoutVerdict: true,
        presentationOnlyRecompile: true,
        presentationRecompileFallbackStatus: "REVIEW_REQUIRED",
        exportPublicationProjectStatus: "EDITING"
      }));
      expect(completion.lifecycleSettlement).toBe("defer-to-successor");
      expect(completion.afterJobCompleted).toEqual(expect.any(Function));
      expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
      await completion.afterJobCompleted?.();
    } finally {
      logged.mockRestore();
    }

    expect(mocks.publishCompiledExports).toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith(
      "project-1",
      "plan-1",
      {
        review: { skipFinalReview: true, withoutQualityVerdict: true },
        expectedProjectStatus: "EDITING",
        ownership: { kind: "presentation", fallbackStatus: "REVIEW_REQUIRED" }
      },
      {
        contentRevision: 4,
        completedPredecessorId: "gj-1"
      }
    );
    expect(mocks.discardPendingExports).toHaveBeenCalled();
  });

  const placeholderIssue = (pageIndex: number) => ({
    code: "PLACEHOLDER_TEXT",
    severity: "error" as const,
    source: "deterministic" as const,
    message: `Page ${pageIndex} contains placeholder text.`,
    guidance: "Replace the placeholder in Edit Mode or regenerate the page.",
    affectedPageIndexes: [pageIndex]
  });

  const blockedStoredReport = (...pageIndexes: number[]) => ({
    state: "blocked" as const,
    score: 64,
    issues: pageIndexes.map(placeholderIssue),
    affectedPageIndexes: pageIndexes,
    checkedAt: "2026-01-01T00:00:00.000Z"
  });

  const reportReviewedAgainst = <T extends ReturnType<typeof blockedStoredReport>>(
    report: T,
    snapshot: typeof reviewedPages
  ): T => qualityReportWithProvenance(report, { finalReviewRan: false, reviewedPages: snapshot }) as T;

  it("requeues for open image jobs without writing a pass when it has not measured yet", async () => {
    // First attempt: QA has not run, the column is still null. Standing down
    // with an empty in-memory set would grade `passed` over a previous
    // `blocked` card — the one direction this door may not move a row.
    mocks.prisma.generationJob.count.mockResolvedValue(1);

    const completion = await compileExport(job());

    expect(completion.lifecycleSettlement).toBe("defer-to-successor");
    expect(completion.afterJobCompleted).toEqual(expect.any(Function));
    expect(mocks.prisma.generationJob.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.generationJob.update).not.toHaveBeenCalled();
    expect(mocks.loadPageTextSnapshot).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    await completion.afterJobCompleted?.();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalled();
  });

  it("retracts a legacy stored report whose reviewed manuscript cannot be proved", async () => {
    mocks.prisma.generationJob.count.mockResolvedValue(1);
    mocks.prisma.generationJob.findUnique.mockResolvedValue({ qualityReport: blockedStoredReport(1) });
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).resolves.toMatchObject({
        afterJobCompleted: expect.any(Function)
      });
    } finally {
      logged.mockRestore();
    }

    // The current rows cannot reconstruct a historical snapshot. Retracting
    // lets the reader fall back to the last report measured against known prose.
    expect(recordedReports()).toEqual([DB_NULL]);
    expect(mocks.loadPageTextSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadQualityContext).not.toHaveBeenCalled();
  });

  it("stands down an existing blocked report when open image jobs block, and retracts when every finding has moved", async () => {
    // Redelivery: the previous attempt ran QA, wrote a blocked card, queued a
    // replacement image job and died. Retracting to DbNull was the wrong
    // settlement; standing down withholds the finding about the page that has
    // since moved, and an all-withheld remainder stores null rather than a
    // passed empty report.
    mocks.prisma.generationJob.count.mockResolvedValue(1);
    mocks.prisma.generationJob.findUnique.mockResolvedValue({
      qualityReport: reportReviewedAgainst(blockedStoredReport(1), reviewedPages)
    });
    mocks.loadPageTextSnapshot.mockResolvedValue(readersPages.map(pageText));
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    let completion: { afterJobCompleted?: () => Promise<void> };
    try {
      completion = await compileExport(job());
    } finally {
      logged.mockRestore();
    }

    expect(completion.afterJobCompleted).toEqual(expect.any(Function));
    expect(mocks.prisma.generationJob.updateMany).not.toHaveBeenCalled();
    expect(mocks.loadPageTextSnapshot).toHaveBeenCalledWith("project-1");
    const reports = recordedReports();
    expect((reports.at(-1) as unknown) === DB_NULL).toBe(true);
    expect(reports.some((report) => report?.state === "passed")).toBe(false);
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
  });

  it("does not attach a prior attempt's findings to a same-revision keeper loaded by its redelivery", async () => {
    // Attempt one grades the placeholder, then dies after the durable report
    // write. Before Bull redelivers it, a sibling final-QA repair commits a new
    // keeper and its replacement-image row without changing contentRevision.
    // The redelivery therefore loads the repaired page at handler entry. That
    // live row is not the historical snapshot the stored finding was measured
    // against, even though both deliveries carry revision 4.
    await rendersAndTriesToPublish();
    mocks.exportPublicationSuperseded.mockRejectedValueOnce(
      new Error("simulated worker exit after the quality report write")
    );

    await expect(compileExport(job())).rejects.toThrow("simulated worker exit");

    const priorAttemptReport = recordedReports().at(-1);
    expect(priorAttemptReport).toMatchObject({
      state: "blocked",
      issues: [expect.objectContaining({ code: "PLACEHOLDER_TEXT", affectedPageIndexes: [1] })]
    });

    const repairedKeeper = {
      ...compilePage(1, "Page 1 after the sibling final-QA repair removed the placeholder."),
      revision: 2
    };
    projectHolding([repairedKeeper, compilePage(2)]);
    mocks.prisma.generationJob.count.mockResolvedValue(1);
    mocks.prisma.generationJob.findUnique.mockResolvedValue({ qualityReport: priorAttemptReport });
    mocks.loadPageTextSnapshot.mockResolvedValue([repairedKeeper, compilePage(2)].map(pageText));
    mocks.prisma.generationJob.update.mockClear();
    mocks.loadQualityContext.mockClear();
    mocks.generateJsonWithRetry.mockClear();
    mocks.strategy.runFinalBookQa.mockClear();
    mocks.exportPublicationSuperseded.mockResolvedValue(false);
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).resolves.toMatchObject({
        afterJobCompleted: expect.any(Function)
      });
    } finally {
      logged.mockRestore();
    }

    // The preflight does not re-run either QA half over prose this attempt did
    // not review. It uses the durable reviewed-page provenance only to retract
    // the stale finding.
    expect(mocks.loadQualityContext).not.toHaveBeenCalled();
    expect(mocks.generateJsonWithRetry).not.toHaveBeenCalled();
    expect(mocks.strategy.runFinalBookQa).not.toHaveBeenCalled();
    expect(recordedReports()).toEqual([DB_NULL]);
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
  });

  it("keeps findings about pages that have not moved when open image jobs force a stand-down", async () => {
    // Same door, same edit, and a second flagged page the reader never
    // touched. Reconstructing from the stored report must not invent a
    // `PAGE_COUNT_MISMATCH` about the inserted page this compile never
    // measured.
    projectHolding(reviewedPagesBothFlagged);
    mocks.prisma.generationJob.count.mockResolvedValue(1);
    mocks.prisma.generationJob.findUnique.mockResolvedValue({
      qualityReport: reportReviewedAgainst(blockedStoredReport(1, 2), reviewedPagesBothFlagged)
    });
    mocks.loadPageTextSnapshot.mockResolvedValue(readersPagesKeepingPageTwo.map(pageText));
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).resolves.toMatchObject({
        afterJobCompleted: expect.any(Function)
      });
    } finally {
      logged.mockRestore();
    }

    expect(mocks.prisma.generationJob.updateMany).not.toHaveBeenCalled();
    const withdrawn = recordedReports().at(-1);
    expect((withdrawn as unknown) === DB_NULL).toBe(false);
    expect(withdrawn?.issues.map((issue) => issue.affectedPageIndexes)).toEqual([[2]]);
    expect(withdrawn?.issues.map((issue) => issue.code)).not.toContain("PAGE_COUNT_MISMATCH");
  });

  it("keeps a prior clean report when its durable snapshot exactly matches the redelivery", async () => {
    const cleanReport = {
      state: "passed" as const,
      score: 100,
      issues: [],
      affectedPageIndexes: [],
      checkedAt: "2026-01-01T00:00:00.000Z"
    };
    const cleanPages = [compilePage(1), compilePage(2)];
    projectHolding(cleanPages);
    mocks.prisma.generationJob.count.mockResolvedValue(1);
    mocks.prisma.generationJob.findUnique.mockResolvedValue({
      qualityReport: qualityReportWithProvenance(cleanReport, {
        finalReviewRan: true,
        reviewedPages: cleanPages
      })
    });
    mocks.loadPageTextSnapshot.mockResolvedValue(cleanPages.map(pageText));
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).resolves.toMatchObject({
        afterJobCompleted: expect.any(Function)
      });
    } finally {
      logged.mockRestore();
    }

    expect(recordedReports().at(-1)).toMatchObject({ state: "passed", score: 100, issues: [] });
    expect((recordedReports().at(-1) as unknown) === DB_NULL).toBe(false);
    expect(mocks.loadQualityContext).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
  });

  it("retracts a prior clean report after a reader edit makes its snapshot unproven", async () => {
    const reviewedCleanPages = [compilePage(1), compilePage(2)];
    const cleanReport = qualityReportWithProvenance(
      {
        state: "passed",
        score: 100,
        issues: [],
        affectedPageIndexes: [],
        checkedAt: "2026-01-01T00:00:00.000Z"
      },
      { finalReviewRan: true, reviewedPages: reviewedCleanPages }
    );
    projectHolding(readersPages);
    mocks.prisma.generationJob.count.mockResolvedValue(1);
    mocks.prisma.generationJob.findUnique.mockResolvedValue({ qualityReport: cleanReport });
    mocks.loadPageTextSnapshot.mockResolvedValue(readersPages.map(pageText));
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).resolves.toMatchObject({
        afterJobCompleted: expect.any(Function)
      });
    } finally {
      logged.mockRestore();
    }

    expect(recordedReports()).toEqual([DB_NULL]);
    expect(mocks.loadQualityContext).not.toHaveBeenCalled();
    expect(mocks.generateJsonWithRetry).not.toHaveBeenCalled();
  });

  it("takes the stale verdict down even when it cannot re-read the manuscript", async () => {
    // This is the failure the withdrawal could not survive, and the one door
    // where surviving it matters most: the report is already on the row. The
    // re-read that decides what may still be claimed used to sit inside the
    // best-effort write, so a single timeout against the same unhealthy pool
    // that let the reader's edit race this compile swallowed the *whole* write
    // — and what stayed behind was the unfiltered `blocked` card about the page
    // they had just paid to replace, with nothing coming to overwrite it.
    //
    // Cannot-measure is now its own answer, and it is a retraction rather than
    // a report. Not the snapshot, which asserts findings about prose that may
    // be gone; not an empty report either, which grades `passed` and would tell
    // the reader a book nobody re-measured is fine. `Prisma.DbNull` clears the
    // column, and `loadProjectQualityReport` selects the newest verdict-owning
    // compile whose report is `not: DbNull` — so the book falls back to the
    // last verdict that was measured against a manuscript that existed.
    await rendersAndTriesToPublish();
    mocks.exportPublicationSuperseded.mockResolvedValue(true);
    mocks.loadPageTextSnapshot.mockRejectedValue(new Error("Timed out fetching a new connection from the pool"));
    const warnings: unknown[][] = [];
    const logged = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args);
    });

    try {
      await expect(compileExport(job())).resolves.toEqual({});
    } finally {
      logged.mockRestore();
    }

    const writes = (mocks.prisma.generationJob.update.mock.calls as Array<[{ data: { qualityReport: unknown } }]>)
      .map((call) => call[0].data.qualityReport);
    // The row really did hold the stale claim before the stand-down, which is
    // the incident.
    expect(writes[0]).toMatchObject({ state: "blocked" });
    // And the stand-down still wrote — it did not simply fail to say anything.
    expect(writes.at(-1)).toBe(DB_NULL);
    expect(
      warnings.some(
        ([message]) =>
          message === "Superseded export compile could not re-read the manuscript it is withdrawing findings from"
      )
    ).toBe(true);
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
  });

  it("rides out a blip on that re-read rather than losing the verdict to it", async () => {
    // Retracting is the honest answer to a read that will not come back; it is
    // an expensive answer to one that was merely busy, because this compile is
    // the only thing that ran a full review of this manuscript and the book
    // falls back past a retracted row. So the read is on the same bounded
    // budget the repair's fence is on, for the same reason: the pool it asks is
    // the one the compile that superseded this one is publishing against.
    //
    // Staged on the two-defect book, because a retraction is what this book's
    // *successful* re-read answers with too: the outcome that tells the retry
    // apart from giving up has to be a verdict only a compile that measured the
    // difference could write.
    projectHolding(reviewedPagesBothFlagged);
    await rendersAndTriesToPublish();
    mocks.exportPublicationSuperseded.mockResolvedValue(true);
    mocks.loadPageTextSnapshot
      .mockRejectedValueOnce(new Error("Timed out fetching a new connection from the pool"))
      .mockResolvedValue(readersPagesKeepingPageTwo.map(pageText));
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).resolves.toEqual({});
    } finally {
      logged.mockRestore();
    }

    expect(mocks.loadPageTextSnapshot).toHaveBeenCalledTimes(2);
    const reports = recordedReports();
    // The filtered verdict, not a retraction: the second attempt answered, so
    // this compile knows exactly which of its findings the reader replaced.
    expect((reports.at(-1) as unknown) === DB_NULL).toBe(false);
    expect((reports.at(-1) as RecordedReport).issues.map((issue) => issue.affectedPageIndexes)).toEqual([[2]]);
  });

  it("stands down anyway when the row its corrected verdict would go on has been retired", async () => {
    // Correcting the verdict is one more write against a `GenerationJob` row a
    // retention sweep may have taken away, and it is now made from two doors
    // that used to make no write at all. Unguarded it would travel — P2025 is
    // not an `ExportRepairSupersededError`, and nothing between here and
    // `markFailed` catches it — so adding the correction would have introduced
    // the very outcome it was added to prevent: a finished, fully paid book
    // FAILED, `FULL_BOOK_GENERATION` handed back.
    await rendersAndTriesToPublish();
    mocks.exportPublicationSuperseded.mockResolvedValue(true);
    let stored = 0;
    mocks.prisma.generationJob.update.mockImplementation(async () => {
      stored += 1;
      if (stored > 1) {
        throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
      }
      return {};
    });
    const warnings: unknown[][] = [];
    const logged = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args);
    });

    try {
      await expect(compileExport(job())).resolves.toEqual({});
    } finally {
      mocks.prisma.generationJob.update.mockReset();
      logged.mockRestore();
    }

    expect(
      warnings.filter(([message]) => message === "Superseded export compile could not record its stand-down")
    ).toHaveLength(1);
    // The other half of the same guarantee: a verdict nobody could store does
    // not stop the compile saying, in the two places anyone looks, that it
    // published nothing.
    expect(warnings.some(([message]) => message === "Export compile superseded before publication")).toBe(true);
  });

  it("does not fail a finished book because it could not file the note about its truncated repair", async () => {
    // Called from inside the catch that exists to keep a compile whose pages
    // are all written away from `markFailed`, and awaited bare while its two
    // sibling stand-down writes were wrapped. `RunLogger.append` swallowing its
    // own write failures is not the guarantee — `createRunLogger` builds a path
    // and a stream before there is anything to swallow, and a throw from there
    // marks a fully written book FAILED and refunds `FULL_BOOK_GENERATION` over
    // a note about a pass that had already stopped.
    openRunLog.mockImplementation(() => {
      throw new Error("EACCES: permission denied, mkdir '/storage/project-1/runs'");
    });
    const warnings: unknown[][] = [];
    const logged = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args);
    });

    try {
      await expect(
        recordTruncatedRepairPass({
          job: job(),
          projectId: "project-1",
          generationJobId: "gj-1",
          error: new ExportRepairFenceUnreadableError(new Error("Connection terminated unexpectedly"), 2),
          reviewedPages: [],
          repairedPages: []
        })
      ).resolves.toBeUndefined();
    } finally {
      logged.mockRestore();
    }

    // The console half of the note still went out — it is written before the
    // run log — and the failure to file the other half is itself grepped in the
    // shape every sibling uses.
    expect(
      warnings.some(
        ([message]) => message === "Export compile stopped repairing: its ownership fence could not be read"
      )
    ).toBe(true);
    const [, detail] =
      warnings.find(([message]) => message === "Truncated export repair could not be recorded") ?? [];
    expect(detail).toMatchObject({
      event: "generation.consistency_warning",
      warning: "export_repair_truncation_record_failed",
      projectId: "project-1",
      generationJobId: "gj-1"
    });
  });

  it("still lets a stop raised while filing that note escape", async () => {
    // The guard is as narrow as every other one in this handler: a degrade
    // looks like success, so a swallowed cancellation is a run the reader ended
    // that settles as a finished book.
    openRunLog.mockImplementation(() => {
      throw new StopRequestedError();
    });
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(
        recordTruncatedRepairPass({
          job: job(),
          projectId: "project-1",
          generationJobId: "gj-1",
          error: new ExportRepairFenceUnreadableError(new Error("Connection terminated unexpectedly"), 0),
          reviewedPages: [],
          repairedPages: []
        })
      ).rejects.toBeInstanceOf(StopRequestedError);
    } finally {
      logged.mockRestore();
    }
  });
});

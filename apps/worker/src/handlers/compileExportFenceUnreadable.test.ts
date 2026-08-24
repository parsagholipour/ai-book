import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "bullmq";

/**
 * What a compile does when its repair's ownership fence will not answer at all
 * — which is neither of the two answers the fence was asked for.
 *
 * `compileExportStandDown.test.ts` covers the door the fence opens when the
 * book really did move on: the compile publishes nothing and settles the
 * verdict it can still stand behind. These cases are the opposite shape, which
 * is why they were split out of it. A read that fails is not a supersede, so
 * the compile keeps its slot, stops repairing, re-reads the manuscript and goes
 * on to the two checks that bind — its own supersede read and
 * `publishCompiledExports`' compare-and-set. Carrying on to publication is the
 * whole of what they assert, so unlike the stand-down suite every one of them
 * pays for a storage directory and the render tail.
 *
 * The fork underneath is the compile's liveness question. A re-read that
 * answers is a database this compile can still publish against; a re-read that
 * does not is one it cannot, and that failure settles the row — carrying the
 * fence's own evidence, because nothing else in the run records how far a pass
 * that stopped had got.
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
import { ExportManuscriptUnreadableError, ExportRepairFenceUnreadableError } from "./compileExportFence.js";
import { StopRequestedError } from "../runtime/jobTypes.js";
import { mocks } from "./testing/compileExportMocks.js";
// The real pair, not a stand-in: what `processJob` writes into the run log's
// `job.failed` line is exactly `serializeError(error)` rendered as JSON, and
// whether the fence's evidence survives that is the whole property below.
import { safeJsonStringify, serializeError } from "../runtime/serialization.js";

describe("compileExport when its repair fence cannot be read", () => {
  const plan = { title: "The Long Walk", premise: "A walk home.", audience: "adults", chapters: [] };
  const input = {
    title: "The Long Walk",
    prompt: "A book about walking home.",
    category: "fiction",
    targetPages: 2,
    complexity: 3,
    temperature: 0.6,
    language: "en",
    mediaSettings: { finalReview: true }
  };

  /**
   * Page 2 carries a chapter because the durable write is what the fence
   * guards: a page in no chapter reaches no `casUpdateChapterProductionBrief`,
   * so there would be nothing to stand down from.
   */
  const compilePage = (index: number) => ({
    id: `page-${index}`,
    index,
    title: `Page ${index}`,
    markdown: `Page ${index} prose about the long walk home and everything seen along it.`,
    summary: `Page ${index} summary.`,
    imagePrompt: null,
    revision: 1,
    status: "COMPLETED",
    images: [],
    chapter: index === 2 ? { id: "chapter-a", index: 1, productionBrief: {} } : null
  });
  const pages = [compilePage(1), compilePage(2)];

  const projectRecord = (projectPages: unknown[] = pages) => ({
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

  const job = (payload: Record<string, unknown> = {}) =>
    ({
      // `createRunLogger` names the run log after both, which is how the
      // truncated-repair line below is found on disk.
      id: "bull-1",
      name: "compile-export",
      data: { projectId: "project-1", planId: "plan-1", generationJobId: "gj-1", contentRevision: 4, ...payload }
    }) as unknown as Job;

  /**
   * A repair the reviewer accepts first time, so the pass reaches the end of
   * its one flagged page and the compile goes on to publish. What that leaves
   * assertable is the page write itself: a barrier that gave up would have
   * stopped before it.
   *
   * Returns the cleanup for the reviewer it puts on the shared strategy mock.
   */
  const repairsPageTwoCleanly = () => {
    mocks.revisePageDraftWithRestart.mockResolvedValue({
      title: "Page 2",
      markdown: "A repaired page the reviewer accepts first time.",
      summary: "Page 2 summary.",
      imagePrompt: null,
      continuityNotes: []
    });
    mocks.prisma.page.update.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: object }) => ({
        ...pages.find((page) => page.id === where.id),
        ...data
      })
    );
    Object.assign(mocks.strategy, {
      reviewPageDraft: vi.fn().mockResolvedValue({
        approved: true,
        score: 88,
        issues: [],
        requiredRevisions: [],
        notes: "",
        checks: { repetitionOk: true, progressionOk: true }
      })
    });
    return () => {
      delete (mocks.strategy as Record<string, unknown>).reviewPageDraft;
    };
  };

  /** Final QA flags page 2, so the repair pass runs. */
  const flagPageTwo = () =>
    mocks.strategy.runFinalBookQa.mockResolvedValue({
      approved: false,
      issues: [],
      requiredFixes: [],
      repairPageIndexes: [2]
    });

  /**
   * The render-and-publish tail every case here needs, because reaching it is
   * the point: a compile whose barrier went dark keeps its slot. Everything in
   * it is a stub for work this suite makes no claim about — what is being asked
   * is that `publishCompiledExports` gets called at all, which is the
   * compare-and-set the unreadable barrier defers to.
   */
  const storageDirs: string[] = [];
  const keepsCompiling = async (): Promise<void> => {
    const storage = await mkdtemp(join(tmpdir(), "compile-export-fence-unreadable-"));
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
    mocks.publishCompiledExports.mockResolvedValue({ published: true, characterPreparationJobId: null });
  };

  const persistedQualityReport = () => {
    const write = mocks.prisma.generationJob.update.mock.calls.find(
      (call) => (call[0] as { data?: { qualityReport?: unknown } }).data?.qualityReport
    );
    return (write![0] as { data: { qualityReport: { state: string; issues: Array<Record<string, unknown>> } } }).data
      .qualityReport;
  };

  /**
   * The barrier stops answering mid-pass, and stays quiet until the handler's
   * own manuscript re-read — which is the liveness question the whole
   * unreadable path turns on, so it is where the blip clears by default.
   *
   * `clears` is how many barrier reads answer before the database goes quiet:
   * the pass asks one as it opens a page and one immediately before that page's
   * writes, so `2` puts the failure at the *second* flagged page and leaves the
   * first one repaired — the shape of the incident this is here for, rather
   * than a pass that never got started.
   *
   * `manuscriptStaysUnreadable` is the same blip lasting one read longer: the
   * re-read is a query against the pool that just gave up, so it is at least as
   * likely to fail as to clear, and it is the fork where the compile settles as
   * a failure instead of publishing.
   */
  const barrierGoesDark = async (
    options: { clears?: number; repaired?: unknown[]; manuscriptStaysUnreadable?: boolean } = {}
  ): Promise<void> => {
    await keepsCompiling();
    const clears = options.clears ?? 0;
    let answered = 0;
    let databaseUnreachable = true;
    const barrierAnswer = async (): Promise<boolean> => {
      if (answered < clears) {
        answered += 1;
        return false;
      }
      if (databaseUnreachable) {
        throw new Error("Connection terminated unexpectedly");
      }
      return false;
    };
    mocks.exportPublicationSuperseded.mockImplementation(barrierAnswer);
    // The publication-side ask is now a revision CAS on the transaction
    // client, not another advisory read. It is the same database barrier and
    // therefore participates in this deterministic outage sequence too.
    mocks.prisma.project.updateMany.mockImplementation(async () => ({ count: (await barrierAnswer()) ? 0 : 1 }));
    mocks.loadPagesForExport.mockImplementation(async () => {
      if (options.manuscriptStaysUnreadable) {
        throw new Error("Timed out fetching a new connection from the pool");
      }
      databaseUnreachable = false;
      return options.repaired ?? pages;
    });
  };

  /** The last line of this compile's own run log, which is the file its provider calls are in. */
  const lastRunLogEntry = async (): Promise<Record<string, unknown>> => {
    const lines = await readFile(
      join(mocks.config.BOOK_STORAGE_DIR, "project-1", "runs", "gj-1-compile-export.jsonl"),
      "utf8"
    );
    const last = lines.trim().split("\n").at(-1);
    if (!last) {
      throw new Error("The compile wrote no run log");
    }
    return JSON.parse(last) as Record<string, unknown>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inputForPlanVersion.mockReturnValue(input);
    mocks.prisma.planVersion.findUnique.mockResolvedValue({
      id: "plan-1",
      planningPackage: plan,
      inputSnapshot: null
    });
    mocks.prisma.project.findUnique.mockResolvedValue(projectRecord());
    mocks.prisma.continuityNote.findMany.mockResolvedValue([]);
    mocks.loadPagesForExport.mockResolvedValue(pages);
    mocks.loadProjectStoryState.mockResolvedValue({ promises: [], facts: [], entities: {}, unanswered: [] });
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "balanced",
      enabled: (): boolean => false
    });
    mocks.generateJsonWithRetry.mockResolvedValue({ data: { issues: [] } });
    mocks.exportPublicationSuperseded.mockResolvedValue(false);
  });

  afterEach(async () => {
    await Promise.all(storageDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    storageDirs.length = 0;
  });

  it("rides out a blip at the barrier instead of settling the book on it", async () => {
    // The barrier is two or three indexed reads per repaired page across the
    // minutes a long book's repair takes, so a pool that is briefly full or a
    // connection reset lands on one of them as a matter of course. Unretried,
    // that throw is neither of the fence's answers, nothing above catches it,
    // and a book whose pages are all written reaches `markFailed` — FAILED,
    // with `FULL_BOOK_GENERATION` handed back — because one `SELECT` did not
    // come back. The repair is supposed to notice nothing.
    await keepsCompiling();
    flagPageTwo();
    const restoreStrategy = repairsPageTwoCleanly();
    mocks.exportPublicationSuperseded
      .mockRejectedValueOnce(new Error("Timed out fetching a new connection from the pool"))
      .mockRejectedValueOnce(new Error("Timed out fetching a new connection from the pool"))
      .mockResolvedValue(false);

    try {
      await expect(compileExport(job())).resolves.toEqual({ durableCompletionCommitted: true });
    } finally {
      restoreStrategy();
    }

    expect(mocks.prisma.page.update).toHaveBeenCalledTimes(1);
    expect(mocks.publishCompiledExports).toHaveBeenCalled();
  });

  it("stops repairing but keeps compiling when the barrier cannot be read at all", async () => {
    // A read that will not answer is a third outcome, and guessing either of
    // the other two is worse than admitting it. "Not superseded" would carry on
    // rewriting pages of a book the reader may have just paid to edit, which is
    // the whole thing the fence is threaded through the repair to stop.
    // "Superseded" publishes nothing and writes no project status — and this
    // compile is the kind queued against a live project, so that abandons its
    // immediate handoff and waits for delayed stranded recovery, over a read
    // that may have been a hiccup. So the pass stops and the compile carries on
    // to the checks that actually bind: its own supersede read, and the
    // compare-and-set inside `publishCompiledExports`.
    flagPageTwo();
    await barrierGoesDark();
    const warnings: unknown[][] = [];
    const logged = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args);
    });

    try {
      await expect(compileExport(job())).resolves.toEqual({ durableCompletionCommitted: true });
    } finally {
      logged.mockRestore();
    }

    // Three asks at the barrier — one attempt and two retries — and then it
    // gives up rather than guessing. The fourth is the compile's own supersede
    // read, which is where the question gets answered instead.
    expect(mocks.exportPublicationSuperseded).toHaveBeenCalledTimes(4);
    // Nothing of the book was rewritten past the barrier it could not clear,
    // and the manuscript the render is built from is re-read rather than
    // carried over — a published PDF that disagrees with the page rows has no
    // revision bump behind it and so no recompile ever coming to fix it.
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(mocks.loadPagesForExport).toHaveBeenCalledWith("project-1");
    // The same unreadable ownership answer also forbids the post-repair model
    // spend: there is no exact fence to prove those re-read pages are still
    // this compile's. Deterministic checks and publication CAS still run.
    expect(mocks.strategy.runFinalBookQa).toHaveBeenCalledTimes(1);
    expect(mocks.publishCompiledExports).toHaveBeenCalled();
    expect(
      warnings.filter(([message]) => message === "Export compile superseded before publication")
    ).toHaveLength(0);
  });

  it("reports and renders the re-read manuscript after a partial repair", async () => {
    const original = [
      { ...compilePage(1), markdown: "TODO: replace this original page before publication." },
      compilePage(2)
    ];
    const repairedMarkdown = "Page 1 as the pass repaired it before the ownership fence went quiet.";
    const repaired = [{ ...compilePage(1), markdown: repairedMarkdown }, compilePage(2)];
    mocks.prisma.project.findUnique.mockResolvedValue(projectRecord(original));
    mocks.strategy.runFinalBookQa.mockResolvedValue({
      approved: false,
      issues: [
        "Page 1 still contains the old defect.",
        "Page 2 still needs review.",
        "The pacing sags throughout the book."
      ],
      requiredFixes: [],
      repairPageIndexes: [1, 2]
    });
    mocks.generateJsonWithRetry.mockResolvedValue({
      data: {
        issues: [
          {
            code: "CHAPTER_COHERENCE",
            message: "Page 1 repeats its old scene.",
            guidance: "Revise page 1.",
            affectedPageIndexes: [1]
          },
          {
            code: "CHAPTER_COHERENCE",
            message: "Page 2 shifts tone.",
            guidance: "Review page 2.",
            affectedPageIndexes: [2]
          },
          {
            code: "CHAPTER_TRANSITION",
            message: "The book-wide transition pattern is uneven.",
            guidance: "Review the chapter transitions.",
            affectedPageIndexes: []
          }
        ]
      }
    });
    await barrierGoesDark({ clears: 2, repaired });
    const restoreStrategy = repairsPageTwoCleanly();
    mocks.strategy.compileMarkdown.mockImplementation(
      ({ pages: manuscript }: { pages: Array<{ markdown: string }> }) =>
        `# The Long Walk\n\n${manuscript.map((page) => page.markdown).join("\n\n")}`
    );
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).resolves.toEqual({ durableCompletionCommitted: true });
    } finally {
      restoreStrategy();
      logged.mockRestore();
    }

    expect(mocks.prisma.page.update).toHaveBeenCalledTimes(1);
    const compileInput = mocks.strategy.compileMarkdown.mock.calls[0]![0] as {
      pages: Array<{ markdown: string }>;
    };
    expect(compileInput.pages[0]?.markdown).toBe(repairedMarkdown);
    const report = persistedQualityReport();
    expect(report.issues.map((issue) => issue.code)).not.toContain("PLACEHOLDER_TEXT");
    expect(report).toMatchObject({ state: "blocked" });
    expect(report.issues).toEqual([
      expect.objectContaining({ code: "FINAL_QA_REPAIR_INCOMPLETE", affectedPageIndexes: [] }),
      expect.objectContaining({ code: "CHAPTER_COHERENCE", message: "Page 2 shifts tone." }),
      expect.objectContaining({
        code: "WHOLE_BOOK_REVIEW",
        message: "Page 2 still needs review.",
        affectedPageIndexes: [2]
      })
    ]);
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(expect.objectContaining({ status: "REVIEW_REQUIRED" }));
    const renderedMarkdown = mocks.strategy.generatePdf.mock.calls[0]?.[0] as string;
    expect(renderedMarkdown).toContain(repairedMarkdown);
    expect(renderedMarkdown).not.toContain("TODO: replace this original page");
  });

  it("blocks an unverified FAILED_QA target after every old model finding is withheld", async () => {
    const failedPage = { ...compilePage(2), status: "FAILED_QA" };
    mocks.prisma.project.findUnique.mockResolvedValue(projectRecord([compilePage(1), failedPage]));
    mocks.strategy.runFinalBookQa.mockResolvedValue({
      approved: false,
      issues: ["Page 1 still contains the old defect."],
      requiredFixes: [],
      repairPageIndexes: [1, 2]
    });
    await barrierGoesDark({
      clears: 2,
      repaired: [{ ...compilePage(1), markdown: "Page 1 repaired before the fence failed." }, failedPage]
    });
    const restoreStrategy = repairsPageTwoCleanly();
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await compileExport(job());
    } finally {
      restoreStrategy();
      logged.mockRestore();
    }

    expect(persistedQualityReport()).toMatchObject({
      state: "blocked",
      issues: [{ code: "FINAL_QA_REPAIR_INCOMPLETE", affectedPageIndexes: [2] }]
    });
    expect(mocks.strategy.runFinalBookQa).toHaveBeenCalledTimes(1);
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(
      expect.objectContaining({ status: "REVIEW_REQUIRED" })
    );
  });

  it("says how far its repair pass got, in the run log the render is in", async () => {
    // Stopping the pass is right; stopping it silently is not. The fence keeps
    // each failed read only as the `cause` on the error it raises, the
    // handler's catch drops that error the moment it has pages back, and
    // `markCompleted` overwrites the job's progress line a few steps later — so
    // a pool that was briefly full while page 2 was being repaired shipped an
    // unrepaired book that looks exactly like a repaired one. Both siblings on
    // this path warn; the only one that hides a *partial* pass said nothing at
    // all.
    const repaired = [
      { ...compilePage(1), markdown: "Page 1 as the pass rewrote it before the barrier went quiet." },
      compilePage(2)
    ];
    // Page 1 is repaired and written, and the database goes quiet as page 2 is
    // opened: two barriers cleared, one page rewritten, one page the compile
    // was paid to repair and did not.
    mocks.strategy.runFinalBookQa.mockResolvedValue({
      approved: false,
      issues: [],
      requiredFixes: [],
      repairPageIndexes: [1, 2]
    });
    await barrierGoesDark({ clears: 2, repaired });
    const restoreStrategy = repairsPageTwoCleanly();
    const warnings: unknown[][] = [];
    const logged = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args);
    });

    try {
      await expect(compileExport(job())).resolves.toEqual({ durableCompletionCommitted: true });
    } finally {
      restoreStrategy();
      logged.mockRestore();
    }

    // Structured, in the shape the sibling stand-downs use, because what an
    // operator has to be able to do is grep every book on the box for it.
    const [, detail] =
      warnings.find(
        ([message]) => message === "Export compile stopped repairing: its ownership fence could not be read"
      ) ?? [];
    expect(detail).toMatchObject({
      event: "generation.consistency_warning",
      warning: "export_repair_fence_unreadable",
      projectId: "project-1",
      generationJobId: "gj-1",
      // In pages, because that is the only unit the reader of this line can act
      // on: one of the two pages this pass was paid to repair shipped
      // unrepaired. `barriersCleared` stays beside it as evidence about the
      // fence and no longer as a number anybody divides — see the case below.
      pagesRepaired: 1,
      pagesTargeted: 2,
      barriersCleared: 2,
      pagesRewritten: 1,
      pagesInBook: 2
    });
    // The underlying read failure travels with it. Without it the line says a
    // pass was truncated and nothing about what truncated it, which is the
    // difference between a pool to resize and a failover to explain.
    expect((detail as { error: Error }).error.message).toBe("Connection terminated unexpectedly");
    // And the same facts land in the run log, which is where somebody already
    // holding one book and asking "why is this one unrepaired" looks — in
    // sequence with the provider calls of the very pass that stopped.
    const entry = await lastRunLogEntry();
    expect(entry).toMatchObject({
      event: "export.repair.fence_unreadable",
      pagesRepaired: 1,
      pagesTargeted: 2,
      barriersCleared: 2,
      pagesRewritten: 1,
      pagesInBook: 2,
      error: { message: "Connection terminated unexpectedly" }
    });
    expect(entry.job).toMatchObject({ projectId: "project-1", generationJobId: "gj-1" });
  });

  it("counts the pages it repaired rather than the reads its fence answered", async () => {
    // The number in that line used to be `barriersCleared`, documented — in the
    // error class, in the fence and in the note itself — as two reads per
    // repaired page. It is two only for a page whose loop approves early. A
    // page that reaches `repairPageBriefForRecovery` asks once more after the
    // planner call, so the pass below clears three barriers repairing exactly
    // one page. No arithmetic over the read count can say how many pages ran.
    //
    // Page 1 is given a chapter of its own here because that is what buys the
    // third ask: with no `chapterId` the brief repair has nothing to persist.
    const chaptered = [
      { ...compilePage(1), chapter: { id: "chapter-a", index: 1, productionBrief: {} } },
      compilePage(2)
    ];
    mocks.prisma.project.findUnique.mockResolvedValue(projectRecord(chaptered));
    mocks.strategy.runFinalBookQa.mockResolvedValue({
      approved: false,
      issues: [],
      requiredFixes: [],
      repairPageIndexes: [1, 2]
    });
    // A brief the reviewer keeps blaming, which is what drives the loop into
    // recovery — the one route that reaches the fence twice more.
    mocks.parseChapterBrief.mockReturnValue({
      chapterIndex: 1,
      title: "One",
      summary: "S",
      continuityFocus: [],
      pages: [{ pageIndex: 1, purpose: "Repeat", beat: "Repeat", requiredContinuity: [], endingPressure: "" }]
    });
    mocks.prisma.chapter.findUnique.mockResolvedValue({ productionBrief: {} });
    mocks.prisma.chapter.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.page.update.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: object }) => ({
        ...chaptered.find((page) => page.id === where.id),
        ...data
      })
    );
    mocks.revisePageDraftWithRestart.mockResolvedValue({
      title: "Page 1",
      markdown: "A rewrite the reviewer rejects for repeating an earlier page.",
      summary: "Page 1 summary.",
      imagePrompt: null,
      continuityNotes: []
    });
    let briefRepaired = false;
    Object.assign(mocks.strategy, {
      // Rejected until the brief is repaired, accepted straight after: the
      // repair's write is only taken for a page that keeps a draft it briefed,
      // and it is that write's own ask this case is counting.
      reviewPageDraft: vi.fn(async () => ({
        approved: briefRepaired,
        score: briefRepaired ? 88 : 40,
        issues: [],
        requiredRevisions: [],
        notes: "",
        checks: { repetitionOk: briefRepaired, progressionOk: true }
      })),
      revisePageDraft: vi.fn().mockResolvedValue({
        title: "Page 1",
        markdown: "The rewrite written against the repaired beat.",
        summary: "Page 1 summary.",
        imagePrompt: null,
        continuityNotes: []
      }),
      repairPageBrief: vi.fn(async () => {
        briefRepaired = true;
        return { pageIndex: 1, purpose: "Fresh", beat: "Fresh", requiredContinuity: [], endingPressure: "" };
      })
    });
    // Three cleared asks — page 1's loop entry, brief-repair stand-down and
    // atomic publication claim — and then the database goes quiet as page 2
    // opens.
    await barrierGoesDark({ clears: 3, repaired: chaptered });
    const warnings: unknown[][] = [];
    const logged = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args);
    });

    try {
      await expect(compileExport(job())).resolves.toEqual({ durableCompletionCommitted: true });
    } finally {
      for (const key of ["reviewPageDraft", "revisePageDraft", "repairPageBrief"]) {
        delete (mocks.strategy as Record<string, unknown>)[key];
      }
      mocks.parseChapterBrief.mockReturnValue(undefined);
      logged.mockRestore();
    }

    // The page really did take the expensive route, so the two numbers really
    // do disagree.
    expect(mocks.prisma.chapter.updateMany).toHaveBeenCalled();
    expect(mocks.prisma.page.update).toHaveBeenCalledTimes(1);
    const [, detail] =
      warnings.find(
        ([message]) => message === "Export compile stopped repairing: its ownership fence could not be read"
      ) ?? [];
    expect(detail).toMatchObject({ pagesRepaired: 1, pagesTargeted: 2, barriersCleared: 3 });
  });

  it("counts a page it could not fix as a page it finished", async () => {
    // The count says where the pass stopped, not how well it did. A page whose
    // rewrites all failed review spent its whole budget and saved its best
    // draft as FAILED_QA — every write that page owed is made — so leaving it
    // out would report a pass that stopped one page earlier than it did, which
    // is the same lie in the other direction.
    mocks.strategy.runFinalBookQa.mockResolvedValue({
      approved: false,
      issues: [],
      requiredFixes: [],
      repairPageIndexes: [1, 2]
    });
    mocks.revisePageDraftWithRestart.mockResolvedValue({
      title: "Page 1",
      markdown: "A rewrite the reviewer never accepts.",
      summary: "Page 1 summary.",
      imagePrompt: null,
      continuityNotes: []
    });
    Object.assign(mocks.strategy, {
      reviewPageDraft: vi.fn().mockResolvedValue({
        approved: false,
        score: 40,
        issues: [],
        requiredRevisions: [],
        notes: "",
        checks: { repetitionOk: true, progressionOk: true }
      }),
      revisePageDraft: vi.fn().mockResolvedValue({
        title: "Page 1",
        markdown: "Another rewrite the reviewer never accepts.",
        summary: "Page 1 summary.",
        imagePrompt: null,
        continuityNotes: []
      })
    });
    mocks.prisma.page.update.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: object }) => ({
        ...pages.find((page) => page.id === where.id),
        ...data
      })
    );
    // Page 1 opens, exhausts its budget and saves as FAILED_QA — two cleared
    // asks — and the database goes quiet as page 2 opens.
    await barrierGoesDark({ clears: 2 });
    const warnings: unknown[][] = [];
    const logged = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args);
    });

    try {
      await expect(compileExport(job())).resolves.toEqual({ durableCompletionCommitted: true });
    } finally {
      for (const key of ["reviewPageDraft", "revisePageDraft"]) {
        delete (mocks.strategy as Record<string, unknown>)[key];
      }
      logged.mockRestore();
    }

    expect(mocks.prisma.page.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED_QA" }) })
    );
    const [, detail] =
      warnings.find(
        ([message]) => message === "Export compile stopped repairing: its ownership fence could not be read"
      ) ?? [];
    expect(detail).toMatchObject({ pagesRepaired: 1, pagesTargeted: 2 });
  });

  it("counts only the pages the manuscript actually holds as targets", async () => {
    // A denominator has to name something the pass could have reached. Its
    // targets are a union — the indexes page-level QA flagged, the
    // `affectedPageIndexes` of every error-severity deterministic issue, and
    // the verdict's own, bounded by the book's *highest* index rather than by
    // the pages under it — so a manuscript with a hole in its numbering is
    // named for a page nobody can open. Counting the raw list reported
    // "repaired 1 of 3" for a book with two repairable pages, and an operator
    // deciding whether to re-queue the compile read two unrepaired pages where
    // there was one: the same arithmetic error `barriersCleared` was demoted
    // for, made by the number that replaced it.
    const gapped = [compilePage(1), compilePage(3)];
    mocks.prisma.project.findUnique.mockResolvedValue(projectRecord(gapped));
    mocks.strategy.runFinalBookQa.mockResolvedValue({
      approved: false,
      issues: [],
      requiredFixes: [],
      repairPageIndexes: [1, 2, 3]
    });
    const restoreStrategy = repairsPageTwoCleanly();
    // Over the helper's, which is staged against the ordinary two-page book.
    mocks.prisma.page.update.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: object }) => ({
        ...gapped.find((page) => page.id === where.id),
        ...data
      })
    );
    // Page 1 opens and saves — two cleared asks — and the database goes quiet
    // as page 3 opens. Page 2 is not a page: nothing opens it, nothing skips
    // it any more, and nothing counts it.
    await barrierGoesDark({ clears: 2, repaired: gapped });
    const warnings: unknown[][] = [];
    const logged = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args);
    });

    try {
      await expect(compileExport(job())).resolves.toEqual({ durableCompletionCommitted: true });
    } finally {
      restoreStrategy();
      logged.mockRestore();
    }

    expect(mocks.prisma.page.update.mock.calls.map((call) => (call[0] as { where: { id: string } }).where.id))
      .toEqual(["page-1"]);
    const [, detail] =
      warnings.find(
        ([message]) => message === "Export compile stopped repairing: its ownership fence could not be read"
      ) ?? [];
    expect(detail).toMatchObject({ pagesRepaired: 1, pagesTargeted: 2, barriersCleared: 2 });
  });

  it("settles the compile on the read failure when the manuscript cannot be re-read either", async () => {
    // The re-read is the honest liveness test: a database that cannot answer it
    // is one this compile has nothing left to publish against, so the original
    // failure travels and settles the row rather than the handler publishing
    // against a book it can no longer see.
    flagPageTwo();
    mocks.exportPublicationSuperseded.mockRejectedValue(new Error("Connection terminated unexpectedly"));
    mocks.loadPagesForExport.mockRejectedValue(new Error("Connection terminated unexpectedly"));

    await expect(compileExport(job())).rejects.toThrow("Connection terminated unexpectedly");

    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
  });

  it("carries what the fence knew onto the failure it settles with", async () => {
    // The settlement above is right and the diagnostic used to be the price of
    // it. The re-read throws a driver error, which *replaced* the fence's — and
    // the fence's error is the only record of the repair that had already
    // stopped: `barriersCleared`, and the read it gave up on, carried on the
    // error for one reader, `recordTruncatedRepairPass`, which is below the
    // re-read and never runs on this path. So a book went FAILED with
    // `FULL_BOOK_GENERATION` refunded, its durable `error` column reading a bare
    // connection message and nothing anywhere saying its repair had stopped two
    // barriers in.
    mocks.strategy.runFinalBookQa.mockResolvedValue({
      approved: false,
      issues: [],
      requiredFixes: [],
      repairPageIndexes: [1, 2]
    });
    // Page 1 repaired, the barrier dark as page 2 opens, and the manuscript
    // still unreadable when the handler asks for it back.
    await barrierGoesDark({ clears: 2, manuscriptStaysUnreadable: true });
    const restoreStrategy = repairsPageTwoCleanly();
    const warnings: unknown[][] = [];
    const logged = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args);
    });

    let settled: unknown;
    try {
      settled = await compileExport(job()).catch((error: unknown) => error);
    } finally {
      restoreStrategy();
      logged.mockRestore();
    }

    // Still a failure, and still the re-read's: `markFailed` writes
    // `error.message` onto the row, so the driver's own words stay in front of
    // whoever opens it, with the barrier count in the same sentence.
    expect(settled).toBeInstanceOf(ExportManuscriptUnreadableError);
    const failure = settled as ExportManuscriptUnreadableError;
    expect(failure.message).toContain("Timed out fetching a new connection from the pool");
    // The durable `error` column is read by somebody deciding whether the book
    // that never shipped was nearly repaired or barely started, so the sentence
    // states pages. It used to state the fence's read count, which answers a
    // question nobody asks and, at three asks for any page that reaches a brief
    // repair, cannot be turned into this one.
    expect(failure.message).toContain("repaired 1 of 2 pages");
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
    // One page really was repaired before the barrier went quiet, which is what
    // makes the count a fact about this run rather than a constant.
    expect(mocks.prisma.page.update).toHaveBeenCalledTimes(1);
    // The fence itself is the `cause`, so `error.cause.cause` still reaches the
    // read that went dark for anyone holding the object.
    expect(failure.cause).toBeInstanceOf(ExportRepairFenceUnreadableError);
    expect((failure.cause as ExportRepairFenceUnreadableError).barriersCleared).toBe(2);
    // And the same two facts survive the only trip that matters: `processJob`
    // files `serializeError(error)` as JSON, which spreads own *enumerable*
    // entries and renders a nested `Error` as `{}` — so a cause chain alone
    // reaches the run log as nothing at all.
    const filed = JSON.parse(safeJsonStringify(serializeError(failure))) as Record<string, unknown>;
    expect(filed).toMatchObject({
      name: "ExportManuscriptUnreadableError",
      repairProgress: { pagesRepaired: 1, pagesTargeted: 2 },
      barriersCleared: 2,
      fenceError: { message: "Connection terminated unexpectedly" },
      manuscriptError: { message: "Timed out fetching a new connection from the pool" }
    });
    // What it must not do is file the truncated-pass note. That note is what a
    // compile says about a pass it shipped a book around, and two of its three
    // numbers are measured against the manuscript as re-read — which on this
    // path never came back. The ordering in the handler is what keeps it quiet.
    expect(
      warnings.filter(
        ([message]) => message === "Export compile stopped repairing: its ownership fence could not be read"
      )
    ).toHaveLength(0);
  });

  it("lets a stop raised by the manuscript re-read travel as itself", async () => {
    // The composition is one more place a cancellation could be dressed up as
    // something else: `processJob` tells a stopped run from a failed one with
    // `instanceof`, so wrapping a `StopRequestedError` here would settle a run
    // the reader ended as a FAILED book — the swallow rule reached by composing
    // rather than by catching.
    flagPageTwo();
    mocks.exportPublicationSuperseded.mockRejectedValue(new Error("Connection terminated unexpectedly"));
    mocks.loadPagesForExport.mockRejectedValue(new StopRequestedError());

    await expect(compileExport(job())).rejects.toBeInstanceOf(StopRequestedError);
  });
});

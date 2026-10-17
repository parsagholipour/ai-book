import { readRunLog } from "@book-maker/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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
import { ExportManuscriptUnreadableError, ExportRepairFenceUnreadableError } from "./compileExportFence.js";
import { StopRequestedError } from "../runtime/jobTypes.js";
import { isDefaultCompileQualityFeature, mocks } from "./testing/compileExportMocks.js";
// The real pair, not a stand-in: what `processJob` writes into the run log's
// `job.failed` line is exactly `serializeError(error)` rendered as JSON, and
// whether the fence's evidence survives that is the whole property below.
import { safeJsonStringify, serializeError } from "../runtime/serialization.js";

describe("compileExport when its repair fence cannot be read", () => {
  const plan = { title: "The Long Walk", premise: "A walk home.", audience: "adults", chapters: [] };
  // A Quick Draft book: the defect screen is the compile's one review and its scoped repair the one repair,
  // which reads the fence as it opens, again once its candidate is verified, and then claims the revision
  // inside the transaction that publishes the whole group.
  const input = {
    title: "The Long Walk",
    prompt: "A book about walking home.",
    category: "fiction",
    targetPages: 2,
    complexity: 3,
    temperature: 0.6,
    language: "en",
    mediaSettings: { modelTier: "fast" }
  };

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
    chapter: null
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

  /** The screen's verdict: one grounded finding per named page, plus any page-less messages. */
  const screenFinds = (targets: number[] = [1], otherIssues: string[] = []) =>
    mocks.reviewQuickDraftManuscript.mockResolvedValue({
      approved: false,
      score: 60,
      notes: "Focused screen.",
      issues: [...targets.map((index) => `Page ${index}: The walk starts twice.`), ...otherIssues],
      requiredFixes: targets.map((index) => `Page ${index}: Start it once.`),
      focusedReview: { rejectedFindings: 0, repairGroups: targets.map((index) => [index]),
        findings: targets.map((index) => ({ targets: [index], kind: "duplicate", problem: "The walk starts twice.",
          fix: "Start it once.", evidence: [{ pageIndex: index, quote: `Page ${index} prose` }] })) }
    } as never);

  /** A verified candidate for every target, so what stops the repair is only ever the fence. */
  const repairsTargetsCleanly = () => {
    mocks.repairQuickDraftPages.mockImplementation(async ({ pages: book, targetPageIndexes }) =>
      book.map((page) => targetPageIndexes.includes(page.index) ? { ...page, markdown: `Page ${page.index}, repaired.` } : page));
    mocks.prisma.page.update.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: object }) => ({ ...pages.find((page) => page.id === where.id), ...data })
    );
  };

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
    // The real scratch names under a fixed token: `.book-test.md`, `.book-test.pdf`, …
    mocks.pendingExportPaths.mockImplementation((projectDir: string) => pendingExportPaths(projectDir, "test"));
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
   * The barrier stops answering, and stays quiet until the handler's own
   * manuscript re-read — which is the liveness question the whole unreadable
   * path turns on, so it is where the blip clears by default.
   *
   * `clears` is how many barrier asks answer before the database goes quiet.
   * The scoped repair asks as it opens and again once its candidate is
   * verified, then claims the revision in its publication transaction, so `2`
   * puts the failure at that claim — the latest point a group can be stopped,
   * and still before any page of it is written.
   *
   * `manuscriptStaysUnreadable` is the same blip lasting one read longer: the
   * re-read is a query against the pool that just gave up, so it is at least as
   * likely to fail as to clear, and it is the fork where the compile settles as
   * a failure instead of publishing.
   */
  const barrierGoesDark = async (
    options: { clears?: number; reread?: unknown[]; manuscriptStaysUnreadable?: boolean } = {}
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
    // The publication-side ask is a revision CAS on the transaction client, not
    // another advisory read. It is the same database barrier and therefore
    // participates in this deterministic outage sequence too.
    mocks.prisma.project.updateMany.mockImplementation(async () => ({ count: (await barrierAnswer()) ? 0 : 1 }));
    mocks.loadPagesForExport.mockImplementation(async () => {
      if (options.manuscriptStaysUnreadable) {
        throw new Error("Timed out fetching a new connection from the pool");
      }
      databaseUnreachable = false;
      return options.reread ?? pages;
    });
  };

  /** The latest entry for `event`: the render after the pass appends its own events. */
  const lastRunLogEntry = async (event: string): Promise<Record<string, unknown>> => {
    const lines = await readRunLog("books/project-1/runs/gj-1-compile-export.jsonl");
    const entries = lines.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const last = entries.filter((entry) => entry.event === event).at(-1);
    if (!last) {
      throw new Error(`The compile wrote no ${event} run-log entry`);
    }
    return last;
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
    mocks.prisma.project.updateMany.mockReset().mockResolvedValue({ count: 1 });
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    mocks.loadPagesForExport.mockResolvedValue(pages);
    mocks.loadProjectStoryState.mockResolvedValue({ promises: [], facts: [], entities: {}, unanswered: [] });
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "balanced",
      enabled: isDefaultCompileQualityFeature
    });
    mocks.generateJsonWithRetry.mockResolvedValue({ data: { issues: [] } });
    mocks.exportPublicationSuperseded.mockReset().mockResolvedValue(false);
    mocks.repairQuickDraftPages.mockReset();
    screenFinds();
    repairsTargetsCleanly();
  });

  afterEach(async () => {
    await Promise.all(storageDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    storageDirs.length = 0;
  });

  it("rides out a blip at the barrier instead of settling the book on it", async () => {
    // The barrier is asked two or three times per repair group, and a pool that
    // is briefly full or a connection reset lands on one of them as a matter of
    // course. Unretried, that throw is neither of the fence's answers, nothing
    // above catches it, and a finished book reaches `markFailed` — FAILED, with
    // `FULL_BOOK_GENERATION` handed back — because one `SELECT` did not come
    // back. The repair is supposed to notice nothing.
    await keepsCompiling();
    mocks.exportPublicationSuperseded
      .mockRejectedValueOnce(new Error("Timed out fetching a new connection from the pool"))
      .mockRejectedValueOnce(new Error("Timed out fetching a new connection from the pool"))
      .mockResolvedValue(false);

    await expect(compileExport(job())).resolves.toEqual({ durableCompletionCommitted: true });

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
    // that may have been a hiccup. So the repair stops and the compile carries on
    // to the checks that actually bind: its own supersede read, and the
    // compare-and-set inside `publishCompiledExports`.
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
    // gives up rather than guessing. The compile checks again before chapter
    // resolution and before publishing the final manuscript.
    expect(mocks.exportPublicationSuperseded).toHaveBeenCalledTimes(5);
    // Nothing of the book was rewritten past the barrier it could not clear, no
    // model was paid for a candidate it could not publish, and the manuscript
    // the render is built from is re-read rather than carried over — a
    // published PDF that disagrees with the page rows has no revision bump
    // behind it and so no recompile ever coming to fix it.
    expect(mocks.repairQuickDraftPages).not.toHaveBeenCalled();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(mocks.loadPagesForExport).toHaveBeenCalledWith("project-1");
    // The book was read once; there is no second read for an unanswered fence to forbid.
    expect(mocks.reviewQuickDraftManuscript).toHaveBeenCalledTimes(1);
    expect(mocks.publishCompiledExports).toHaveBeenCalled();
    expect(
      warnings.filter(([message]) => message === "Export compile superseded before publication")
    ).toHaveLength(0);
  });

  it("reports and renders the re-read manuscript when the fence goes dark at the publication claim", async () => {
    // The latest point a group can be stopped: its candidate verified, its
    // claim unanswered. The transaction rolls the whole group back, so the
    // re-read is the manuscript as it stood, and that is what is graded and
    // rendered — with the screen's findings intact, since nothing moved under
    // them, and the incomplete repair on the console.
    screenFinds([1], ["The pacing sags throughout the book."]);
    await barrierGoesDark({ clears: 2 });
    mocks.strategy.compileMarkdown.mockImplementation(
      ({ pages: manuscript }: { pages: Array<{ markdown: string }> }) =>
        `# The Long Walk\n\n${manuscript.map((page) => page.markdown).join("\n\n")}`
    );
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).resolves.toEqual({ durableCompletionCommitted: true });
    } finally {
      logged.mockRestore();
    }

    expect(mocks.repairQuickDraftPages).toHaveBeenCalledOnce();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    const report = persistedQualityReport();
    // The incomplete repair is a pipeline status: an error on the console, never the reader's grade.
    expect(report).toMatchObject({ state: "passed" });
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "FINAL_QA_REPAIR_INCOMPLETE", affectedPageIndexes: [] }),
      expect.objectContaining({ code: "WHOLE_BOOK_REVIEW", message: "Page 1: The walk starts twice.", affectedPageIndexes: [1] }),
      expect.objectContaining({ code: "WHOLE_BOOK_REVIEW", message: "The pacing sags throughout the book.", affectedPageIndexes: [] })
    ]));
    expect(mocks.publishCompiledExports).toHaveBeenCalledWith(expect.objectContaining({ status: "COMPLETE" }));
    const renderedMarkdown = mocks.strategy.generatePdf.mock.calls[0]?.[0] as string;
    expect(renderedMarkdown).toContain(pages[0]!.markdown);
    expect(renderedMarkdown).not.toContain("Page 1, repaired.");
  });

  it("says how far its repair got, in the run log the render is in", async () => {
    // Stopping the repair is right; stopping it silently is not. The fence keeps
    // each failed read only as the `cause` on the error it raises, the
    // handler's catch drops that error the moment it has pages back, and
    // `markCompleted` overwrites the job's progress line a few steps later — so
    // a pool that was briefly full during the repair shipped an unrepaired book
    // that looks exactly like a repaired one.
    await barrierGoesDark({ clears: 2 });
    const warnings: unknown[][] = [];
    const logged = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args);
    });

    try {
      await expect(compileExport(job())).resolves.toEqual({ durableCompletionCommitted: true });
    } finally {
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
      // In pages: the group publishes whole or not at all, so a fence dark at its
      // claim repaired none of the page it was paid to repair.
      pagesRepaired: 0,
      pagesTargeted: 1,
      barriersCleared: 2,
      pagesRewritten: 0,
      pagesInBook: 2
    });
    // The underlying read failure travels with it.
    expect((detail as { error: Error }).error.message).toBe("Connection terminated unexpectedly");
    // And the same facts land in the run log, in sequence with the provider
    // calls of the very repair that stopped.
    const entry = await lastRunLogEntry("export.repair.fence_unreadable");
    expect(entry).toMatchObject({
      event: "export.repair.fence_unreadable",
      pagesRepaired: 0,
      pagesTargeted: 1,
      barriersCleared: 2,
      pagesRewritten: 0,
      pagesInBook: 2,
      error: { message: "Connection terminated unexpectedly" }
    });
    expect(entry.job).toMatchObject({ projectId: "project-1", generationJobId: "gj-1" });
  });

  it("counts only the pages the manuscript actually holds as targets", async () => {
    // A denominator has to name something the repair could have reached. Its
    // targets are a union — the indexes page-level QA flagged, the
    // `affectedPageIndexes` of every error-severity deterministic issue, and
    // the screen's own — so a manuscript with a hole in its numbering can be
    // named for a page nobody can open. The targets are resolved to rows first,
    // and only those are counted.
    const gapped = [compilePage(1), compilePage(3)];
    mocks.prisma.project.findUnique.mockResolvedValue(projectRecord(gapped));
    mocks.loadPagesForExport.mockResolvedValue(gapped);
    screenFinds([1, 2, 3]);
    await barrierGoesDark({ clears: 2, reread: gapped });
    const warnings: unknown[][] = [];
    const logged = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args);
    });

    try {
      await expect(compileExport(job())).resolves.toEqual({ durableCompletionCommitted: true });
    } finally {
      logged.mockRestore();
    }

    expect(mocks.repairQuickDraftPages).toHaveBeenCalledWith(expect.objectContaining({ targetPageIndexes: [1, 3] }));
    const [, detail] =
      warnings.find(
        ([message]) => message === "Export compile stopped repairing: its ownership fence could not be read"
      ) ?? [];
    expect(detail).toMatchObject({ pagesRepaired: 0, pagesTargeted: 2, barriersCleared: 2 });
  });

  it("settles the compile on the read failure when the manuscript cannot be re-read either", async () => {
    // The re-read is the honest liveness test: a database that cannot answer it
    // is one this compile has nothing left to publish against, so the original
    // failure travels and settles the row rather than the handler publishing
    // against a book it can no longer see.
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
    // re-read and never runs on this path.
    await barrierGoesDark({ clears: 2, manuscriptStaysUnreadable: true });
    const warnings: unknown[][] = [];
    const logged = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args);
    });

    let settled: unknown;
    try {
      settled = await compileExport(job()).catch((error: unknown) => error);
    } finally {
      logged.mockRestore();
    }

    // Still a failure, and still the re-read's: `markFailed` writes
    // `error.message` onto the row, so the driver's own words stay in front of
    // whoever opens it, with the repair's progress in the same sentence.
    expect(settled).toBeInstanceOf(ExportManuscriptUnreadableError);
    const failure = settled as ExportManuscriptUnreadableError;
    expect(failure.message).toContain("Timed out fetching a new connection from the pool");
    // The durable `error` column is read by somebody deciding whether the book
    // that never shipped was nearly repaired or barely started, so the sentence
    // states pages.
    expect(failure.message).toContain("repaired 0 of 1 page)");
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    // The fence itself is the `cause`, so `error.cause.cause` still reaches the
    // read that went dark for anyone holding the object.
    expect(failure.cause).toBeInstanceOf(ExportRepairFenceUnreadableError);
    expect((failure.cause as ExportRepairFenceUnreadableError).barriersCleared).toBe(2);
    // And the same facts survive the only trip that matters: `processJob`
    // files `serializeError(error)` as JSON, which spreads own *enumerable*
    // entries and renders a nested `Error` as `{}` — so a cause chain alone
    // reaches the run log as nothing at all.
    const filed = JSON.parse(safeJsonStringify(serializeError(failure))) as Record<string, unknown>;
    expect(filed).toMatchObject({
      name: "ExportManuscriptUnreadableError",
      repairProgress: { pagesRepaired: 0, pagesTargeted: 1 },
      barriersCleared: 2,
      fenceError: { message: "Connection terminated unexpectedly" },
      manuscriptError: { message: "Timed out fetching a new connection from the pool" }
    });
    // What it must not do is file the truncated-pass note. That note is what a
    // compile says about a repair it shipped a book around, measured against the
    // manuscript as re-read — which on this path never came back.
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
    mocks.exportPublicationSuperseded.mockRejectedValue(new Error("Connection terminated unexpectedly"));
    mocks.loadPagesForExport.mockRejectedValue(new StopRequestedError());

    await expect(compileExport(job())).rejects.toBeInstanceOf(StopRequestedError);
  });
});

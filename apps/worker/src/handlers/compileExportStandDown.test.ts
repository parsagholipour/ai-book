import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

/**
 * What a compile does when the manuscript moves out from under its final-QA
 * repair.
 *
 * The repair's ownership fence throws from inside the scoped repair's
 * publication transaction, or from the fence the compile asks right after it,
 * and a compile that lets an unrecognised error
 * travel reaches `markFailed` — which for a verdict-owning row marks a
 * finished, fully paid book FAILED and refunds `FULL_BOOK_GENERATION`. So the
 * properties here are a set: the superseded case stands down the way the
 * compile's own supersede read does, *only* that case does, and what it leaves
 * on the row is the verdict it can still stand behind.
 *
 * Its own file, with a fixture of its own rather than `compileExport.test.ts`'s
 * publication one: a stand-down renders nothing, so a suite that reaches it
 * before the first `mkdir` needs no storage directory, no published markdown and
 * no reader chapters — and `compileExport.test.ts` is at its size budget
 * besides. The fence's *third* answer — the read that will not answer at all —
 * is the opposite shape, because carrying on to publication is the whole of
 * what it asserts, and it has its own file for that reason:
 * `compileExportFenceUnreadable.test.ts`.
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
// Counted, never stubbed: the real checks are what the stand-down's report is
// built from, and how *often* they run is the only thing this wrapper adds.
// `storyDeltaParses` is the same trick one page lower down — it is the per-page
// zod parse inside `reviewedStoryState`, and whether it runs at all is the
// whole of what the unpaid-promise fold costs a compile that will not read it.
const { deterministicSweep, storyDeltaParses } = vi.hoisted(() => ({
  deterministicSweep: vi.fn(),
  storyDeltaParses: vi.fn()
}));

vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  const mocked = (await import("./testing/compileExportMocks.js")).coreModuleMock(actual);
  return {
    ...mocked,
    runDeterministicManuscriptChecks: (options: Parameters<typeof actual.runDeterministicManuscriptChecks>[0]) => {
      deterministicSweep(options);
      return actual.runDeterministicManuscriptChecks(options);
    },
    parseStoryDelta: (value: unknown) => {
      storyDeltaParses(value);
      return actual.parseStoryDelta(value);
    }
  };
});

import { compileExport } from "./compileExport.js";
import { updateJobProgress } from "../runtime/jobLifecycle.js";
import { StopRequestedError } from "../runtime/jobTypes.js";
import { DB_NULL, isDefaultCompileQualityFeature, mocks } from "./testing/compileExportMocks.js";

describe("compileExport final-QA repair stand-down", () => {
  const plan = { title: "The Long Walk", premise: "A walk home.", audience: "adults", chapters: [] };
  const input = {
    title: "The Long Walk",
    prompt: "A book about walking home.",
    category: "fiction",
    targetPages: 2,
    complexity: 3,
    temperature: 0.6,
    language: "en",
    // A Quick Draft book: the defect screen is the compile's one review and its scoped repair the one repair.
    mediaSettings: { modelTier: "fast" }
  };

  /**
   * Page 2 carries a chapter, as a page of a chaptered book does. (It used to
   * matter to the fence: the old per-page repair loop's brief repair wrote the
   * chapter row, and a page in no chapter reached no such write.)
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

  /**
   * The four columns the stand-down's own read selects, and all it selects: a
   * page moved is `index`, `revision`, `title` and `markdown`, never the
   * illustrations or the chapter row. Staged in that shape so nothing here can
   * lean on a join the query no longer asks for.
   */
  const pageText = (page: { index: number; title: string; markdown: string; revision: number }) => ({
    index: page.index,
    title: page.title,
    markdown: page.markdown,
    revision: page.revision
  });

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

  /** The screen's verdict: a grounded finding on page 1, which its scoped repair targets, plus any other messages. */
  const screenFindsPageOne = (otherIssues: string[] = []) =>
    mocks.reviewQuickDraftManuscript.mockResolvedValue({
      approved: false,
      score: 60,
      notes: "Focused screen.",
      issues: ["Page 1: The walk starts twice.", ...otherIssues],
      requiredFixes: ["Page 1: Start it once."],
      focusedReview: { rejectedFindings: 0, repairGroups: [[1]], findings: [{ targets: [1], kind: "duplicate",
        problem: "The walk starts twice.", fix: "Start it once.",
        evidence: [{ pageIndex: 1, quote: "Page 1 prose" }, { pageIndex: 2, quote: "Page 2 prose" }] }] }
    } as never);

  /**
   * The cheapest route into the superseded catch with pages written: the
   * scoped repair publishes page 1, and the reader's edit lands the instant it
   * is saved, so the fence the compile asks right after the repair sees it.
   * `onSaved` runs at that same instant, which is the only place a suite can
   * break the writes *after* the fence without breaking the ones the repair
   * makes on its way to it.
   *
   * Returns a cleanup, kept so the call sites read alike; the scoped repair needs none.
   */
  const supersedeOnFirstRepairedPageSave = (onSaved?: () => void, otherIssues: string[] = []) => {
    screenFindsPageOne(otherIssues);
    mocks.repairQuickDraftPages.mockImplementation(async ({ pages: book }) =>
      book.map((page) => page.index === 1 ? { ...page, markdown: "A repaired page the reviewer accepts first time." } : page));
    mocks.prisma.page.update.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: object }) => {
        // The reader's edit lands the instant page 1's repair is saved: their
        // prose is in, `contentRevision` is past this compile, and their own
        // recompile is queued.
        mocks.exportPublicationSuperseded.mockResolvedValue(true);
        onSaved?.();
        return { ...pages.find((page) => page.id === where.id), ...data };
      }
    );
    return () => undefined;
  };

  /** What Prisma raises for a row a retention sweep has already retired. */
  const retiredRowError = () => Object.assign(new Error("Record to update not found."), { code: "P2025" });


  /** The verdict this compile left on its own durable row. */
  type RecordedReport = { state: string; issues: Array<{ code: string; message: string }> };
  const recordedReport = (): RecordedReport => {
    const calls = mocks.prisma.generationJob.update.mock.calls as Array<
      [{ data: { qualityReport: RecordedReport } }]
    >;
    const last = calls.at(-1);
    if (!last) {
      throw new Error("The compile recorded no quality report");
    }
    return last[0].data.qualityReport;
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
    // The stand-down's own read is a different query — four scalar columns, no
    // joins — so it is staged separately, in the shape it really answers with.
    mocks.loadPageTextSnapshot.mockResolvedValue(pages.map(pageText));
    mocks.loadProjectStoryState.mockResolvedValue({ promises: [], facts: [], entities: {}, unanswered: [] });
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "balanced",
      enabled: isDefaultCompileQualityFeature
    });
    mocks.generateJsonWithRetry.mockResolvedValue({ data: { issues: [] } });
    mocks.exportPublicationSuperseded.mockResolvedValue(false);
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    mocks.repairQuickDraftPages.mockReset();
  });

  it("stands down instead of failing when the book moves on during the repair", async () => {
    // The screen's model finding is what the verdict assertion at the end is about: the
    // screen is the whole of what this compile paid a model for.
    screenFindsPageOne(["Page 2: The chapter loses its thread halfway through."]);
    mocks.repairQuickDraftPages.mockImplementation(async ({ pages: book }) =>
      book.map((page) => page.index === 1 ? { ...page, markdown: "A repaired page." } : page));
    // An edit landed while the repair was inside its model call, so the publication
    // transaction's revision claim misses and nothing is written.
    mocks.prisma.project.updateMany.mockResolvedValue({ count: 0 });
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).resolves.toEqual({});
    } finally {
      logged.mockRestore();
    }

    // It stood down *inside* the repair, not at the compile's own supersede read
    // further down: the repair's model call ran, and its publication did not.
    expect(mocks.repairQuickDraftPages).toHaveBeenCalledOnce();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(mocks.reviewQuickDraftManuscript).toHaveBeenCalledTimes(1);
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
    // Its verdict survives, and that is the one thing standing down may not throw
    // away. This compile ran the whole review; the compile that supersedes it
    // is an edit's recompile with `finalReviewRan: false`, or an image move
    // that owns no verdict at all, so nothing else is going to say what a model
    // thought of this manuscript. Returning empty left the row's `qualityReport`
    // null and `loadProjectQualityReport` reaching past it.
    expect(mocks.prisma.generationJob.update).toHaveBeenCalledWith({
      where: { id: "gj-1" },
      data: {
        qualityReport: expect.objectContaining({
          // The model's complaint is a console diagnostic, so the reader's grade is a
          // measured pass; the finding is still on the row for the operator.
          state: "passed",
          readerFindings: [],
          issues: expect.arrayContaining([
            expect.objectContaining({ code: "WHOLE_BOOK_REVIEW", source: "model",
              message: "Page 2: The chapter loses its thread halfway through." })
          ])
        })
      }
    });
  });

  it("stops writing pages the moment the reader's edit takes the book, and keeps the ones it wrote", async () => {
    // The repair is not only an opinion-writer: it rewrites the manuscript
    // itself, off a `pages` snapshot taken minutes earlier. Its group publishes
    // whole behind the revision claim, and the fence asked right after it is
    // what stops the compile from grading and publishing over the reader's edit.
    const restoreStrategy = supersedeOnFirstRepairedPageSave();
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).resolves.toEqual({});
    } finally {
      restoreStrategy();
      logged.mockRestore();
    }

    // Page 1 stays written — it is an improvement to the manuscript the newer
    // compile is about to publish, not this compile's to take back.
    expect(mocks.prisma.page.update.mock.calls.map((call) => (call[0] as { where: { id: string } }).where.id))
      .toEqual(["page-1"]);
    expect(mocks.reviewQuickDraftManuscript).toHaveBeenCalledTimes(1);
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
  });

  it("stands down even when the row its verdict would go on has been retired", async () => {
    // Everything the stand-down does is bookkeeping about a compile that has
    // already decided to publish nothing, and both of its writes address a
    // `GenerationJob` row a retention sweep or a reconciliation can have taken
    // away while the repair spent minutes in provider calls. Unguarded, the
    // P2025 out of either one travels — it is not an
    // `ExportRepairSupersededError`, so nothing above catches it — and the
    // compile that took this path *precisely* to stay away from `markFailed`
    // arrives there anyway, marking a finished, fully paid book FAILED and
    // refunding `FULL_BOOK_GENERATION`. Returning is the whole assertion: a
    // handler that returns settles through `markCompleted`.
    //
    // Recorded as they are attempted rather than read off the mocks, whose
    // histories the cleanup below wipes along with these implementations.
    const attempted: string[] = [];
    const restoreStrategy = supersedeOnFirstRepairedPageSave(() => {
      // Broken at the save rather than in `beforeEach`, because the compile
      // writes progress of its own on the way to the fence.
      vi.mocked(updateJobProgress).mockImplementation(async () => {
        attempted.push("progress");
        throw new Error("connection terminated");
      });
    });
    mocks.prisma.generationJob.update.mockImplementation(async () => {
      attempted.push("verdict");
      throw retiredRowError();
    });
    const warnings: unknown[][] = [];
    const logged = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args);
    });

    try {
      await expect(compileExport(job())).resolves.toEqual({});
    } finally {
      restoreStrategy();
      // Rejecting implementations rather than call histories, so `clearAllMocks`
      // would leave them on the shared mocks for the next test.
      mocks.prisma.generationJob.update.mockReset();
      vi.mocked(updateJobProgress).mockReset();
      logged.mockRestore();
    }

    // Both writes were attempted — neither is skipped because the other failed
    // — and neither published anything on the way past.
    expect(attempted).toEqual(["verdict", "progress"]);
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
    // Two of them: a failure to record is worth a line each, and the trace is
    // the only thing left of a compile that published nothing.
    expect(
      warnings.filter(([message]) => message === "Superseded export compile could not record its stand-down")
    ).toHaveLength(2);
  });

  it("still lets a stop raised by its own stand-down write escape", async () => {
    // The guard above is narrow in the same way the catch it sits in is: a
    // reader's cancellation reaches these writes through
    // `updateJobProgress`'s stopped-run assertion, and swallowing it would
    // settle a cancelled run as a finished book.
    const restoreStrategy = supersedeOnFirstRepairedPageSave(() => {
      vi.mocked(updateJobProgress).mockRejectedValue(new StopRequestedError());
    });
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).rejects.toBeInstanceOf(StopRequestedError);
    } finally {
      restoreStrategy();
      vi.mocked(updateJobProgress).mockReset();
      logged.mockRestore();
    }
  });

  it("sweeps the manuscript once on the way out", async () => {
    // The deterministic checks are asked for twice on this path — for the
    // error-severity pages the repair redrafts, and for the report the
    // stand-down leaves — and each ask is a synchronous pass over every page of
    // the book on the worker's event loop. Nothing between the two touches
    // `pages`, so the second answer can only be the first one, which makes the
    // second sweep pure cost on a book long enough to feel it.
    const restoreStrategy = supersedeOnFirstRepairedPageSave();
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).resolves.toEqual({});
    } finally {
      restoreStrategy();
      logged.mockRestore();
    }

    // One call, and it is the memoized closure's: the compile returns inside
    // the catch, so the sweep behind the shipped report never runs at all.
    expect(deterministicSweep).toHaveBeenCalledTimes(1);
  });

  it("drops the findings its own repair has already answered", async () => {
    // The stand-down used to record the pre-repair snapshot verbatim, and the
    // repair pass rewrites every error-severity page the sweep named, in
    // ascending order — so a fence that trips on the last flagged page ships a
    // report naming pages it fixed minutes earlier. A deterministic error is
    // the one finding that survives every gate in `buildManuscriptQualityReport`,
    // and nothing was coming to replace it: the compile that supersedes this one
    // may own no verdict at all. So the reader's quality card read `blocked` for
    // a placeholder this compile had already replaced.
    const placeholderPages = [
      { ...compilePage(1), markdown: "Page 1 prose with a TODO still sitting in it." },
      compilePage(2)
    ];
    mocks.prisma.project.findUnique.mockResolvedValue(projectRecord(placeholderPages));
    // What the book holds once the pass has repaired page 1 and lost page 2:
    // the placeholder is gone, and page 2 is prose this compile did review.
    mocks.loadPageTextSnapshot.mockResolvedValue([
      pageText({ ...compilePage(1), markdown: "Page 1 prose the repair pass rewrote without the placeholder." }),
      pageText(compilePage(2))
    ]);
    const restoreStrategy = supersedeOnFirstRepairedPageSave(undefined,
      ["Page 1 still reads as a placeholder.", "Page 2 drifts from its chapter."]);
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).resolves.toEqual({});
    } finally {
      restoreStrategy();
      logged.mockRestore();
    }

    const report = recordedReport();
    // The error named a page whose prose this pass replaced; what is left is a console
    // diagnostic, so the reader's grade is the pass this compile measured.
    expect(report.state).toBe("passed");
    expect(report.issues.map((issue) => issue.code)).not.toContain("PLACEHOLDER_TEXT");
    // The same rule over the model half — a complaint about page 1 is exactly
    // as stale as a deterministic one — and no further: page 2 is untouched
    // prose this compile really did review, so its finding still speaks.
    expect(report.issues.map((issue) => issue.message)).toContain("Page 2 drifts from its chapter.");
    expect(report.issues.map((issue) => issue.message)).not.toContain("Page 1 still reads as a placeholder.");
  });

  it("withholds a whole-book finding once any of the book has moved under it", async () => {
    // The withhold rule was `affectedPageIndexes.some(...)`, and `some` over an
    // empty array is false — so every finding that named no page at all was
    // *kept*. Those are not rare: `qualityIssuesFromFinalQa` maps a complaint
    // that names no page number to `[]`, the chapter sweep's schema allows an
    // empty array, and on the deterministic side `MISSING_PAGES` is exactly
    // that shape. A complaint about the book as a whole is a claim about every
    // page of it, so a stand-down that had just disclaimed the manuscript
    // shipped "the ending never pays off the central promise" as a
    // `review_recommended` verdict stamped `finalReviewRan: true`, about a
    // manuscript this compile had itself rewritten a page of.
    const placeholderPages = [
      { ...compilePage(1), markdown: "Page 1 prose with a TODO still sitting in it." },
      compilePage(2)
    ];
    mocks.prisma.project.findUnique.mockResolvedValue(projectRecord(placeholderPages));
    mocks.loadPageTextSnapshot.mockResolvedValue([
      pageText({ ...compilePage(1), markdown: "Page 1 prose the repair pass rewrote without the placeholder." }),
      pageText(compilePage(2))
    ]);
    const restoreStrategy = supersedeOnFirstRepairedPageSave(undefined,
      ["The ending never pays off the central promise.", "Page 2 drifts from its chapter."]);
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).resolves.toEqual({});
    } finally {
      restoreStrategy();
      logged.mockRestore();
    }

    const messages = recordedReport().issues.map((issue) => issue.message);
    // Withheld: page 1 moved, so the book this complaint was measured against
    // is not the book on the row. Bluntness is the rule rather than a
    // compromise — nothing here can tell a reader's paid rewrite from a fixed
    // typo, and the publishing path answers the same question by re-running
    // final QA over the repaired pages, which a stand-down cannot do.
    expect(messages).not.toContain("The ending never pays off the central promise.");
    // And no further than that: a complaint that names a page it still speaks
    // for is untouched, which is what keeps this a withdrawal rather than a
    // blanket one.
    expect(messages).toContain("Page 2 drifts from its chapter.");
  });

  it("leaves no verdict at all when it cannot re-read the manuscript it is withdrawing from", async () => {
    // The withdrawal rests on one read, and that read sat *inside* the
    // best-effort write — so the pool that made this race possible in the first
    // place could take the whole verdict down with it. At this door the row
    // holds nothing yet, so the compile that owns the book's only model-graded
    // opinion recorded none at all and `loadProjectQualityReport` reached past
    // it; at the two doors below, where the row already holds the unfiltered
    // report, the same failure left a `blocked` card standing about prose the
    // reader had paid to replace.
    //
    // A compile that cannot measure now says so, and says it the same way at
    // every door: the write still happens and it *retracts*. Not the stale
    // snapshot, and not an empty report either — no findings grades `passed`,
    // which would tell the reader a book nobody re-measured is fine and paper
    // over the last verdict anyone did measure.
    const restoreStrategy = supersedeOnFirstRepairedPageSave();
    mocks.loadPageTextSnapshot.mockRejectedValue(new Error("Timed out fetching a new connection from the pool"));
    const warnings: unknown[][] = [];
    const logged = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args);
    });

    try {
      await expect(compileExport(job())).resolves.toEqual({});
    } finally {
      restoreStrategy();
      logged.mockRestore();
    }

    // Retried on the fence's own budget first: the read is one query against a
    // pool that is busy rather than gone, and giving up on it costs the book
    // the verdict a full review was paid for.
    expect(mocks.loadPageTextSnapshot).toHaveBeenCalledTimes(3);
    expect(mocks.prisma.generationJob.update).toHaveBeenCalledWith({
      where: { id: "gj-1" },
      data: { qualityReport: DB_NULL }
    });
    // And the compile still finished. A stand-down is bookkeeping about a book
    // that is fine; nothing on it may reach `markFailed`.
    expect(
      warnings.some(
        ([message]) =>
          message === "Superseded export compile could not re-read the manuscript it is withdrawing findings from"
      )
    ).toBe(true);
  });

  it("folds no story state at all, however many deltas the pages carry", async () => {
    // The fold is a zod parse per page plus a rebuild over the result, and the
    // unpaid-promise check that read it went with story memory on 2026-10-16
    // (E6). Folded anyway, a 300-page manuscript would be parsed synchronously
    // on the worker's event loop, on the one path documented as needing to be
    // cheap: the compile that superseded this one is rendering and publishing
    // against the same database.
    const withDeltas = [
      { ...compilePage(1), storyDelta: { promisesOpened: [{ id: "gate", text: "Who left the gate open?" }] } },
      { ...compilePage(2), storyDelta: { promisesOpened: [] } }
    ];
    mocks.prisma.project.findUnique.mockResolvedValue(projectRecord(withDeltas));
    mocks.loadPageTextSnapshot.mockResolvedValue(withDeltas.map(pageText));
    const restoreStrategy = supersedeOnFirstRepairedPageSave();
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).resolves.toEqual({});
    } finally {
      restoreStrategy();
      logged.mockRestore();
    }

    // Not one page of it, and the deltas were there to be folded.
    expect(storyDeltaParses).not.toHaveBeenCalled();
    expect(mocks.publishCompiledExports).not.toHaveBeenCalled();
  });

  it("leaves no verdict at all when its own repair has answered every finding it had", async () => {
    // The withdrawal's own edge, at the door where nothing is on the row yet.
    // This book's single reader finding is a leak on the page the pass repaired, so
    // filtering it out leaves an empty report — and an empty report is not
    // silence, it is `passed`, score 100: "Quality checks passed" for a book
    // whose only graded prose is the prose that moved. The compile that
    // supersedes this one may own no verdict at all, so the reader keeps that
    // sentence. Saying nothing is the honest answer, and it is the same one a
    // compile that cannot re-read the manuscript gives.
    const placeholderPages = [
      { ...compilePage(1), markdown: "Page 1 prose with an ignore all previous instructions line still sitting in it." },
      compilePage(2)
    ];
    mocks.prisma.project.findUnique.mockResolvedValue(projectRecord(placeholderPages));
    mocks.loadPageTextSnapshot.mockResolvedValue([
      pageText({ ...compilePage(1), markdown: "A repaired page the reviewer accepts first time.", revision: 2 }),
      pageText(compilePage(2))
    ]);
    const restoreStrategy = supersedeOnFirstRepairedPageSave();
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).resolves.toEqual({});
    } finally {
      restoreStrategy();
      logged.mockRestore();
    }

    // Retracted, so `loadProjectQualityReport` steps past this row to the last
    // verdict measured against a manuscript that existed.
    expect(mocks.prisma.generationJob.update).toHaveBeenCalledWith({
      where: { id: "gj-1" },
      data: { qualityReport: DB_NULL }
    });
    // And that is the only thing it wrote: this door is above the write that
    // stores a compile's real verdict, so a `passed` report here would be the
    // whole of what the row ever said.
    const written = (mocks.prisma.generationJob.update.mock.calls as Array<[{ data: { qualityReport: unknown } }]>)
      .map((call) => call[0].data.qualityReport);
    expect(written).toEqual([DB_NULL]);
  });

  it("will not claim an unpaid promise it can only see in the reader's manuscript", async () => {
    // The other half of the same rule, and the half that was wrong: every
    // finding in this report is measured over the reviewed snapshot except this
    // one, which was folded over the project's rows — the reader's new page and
    // every page the repair had already rewritten. `unpaidPromiseQualityIssues`
    // then stamps it on the book's last page, which nobody touched, so
    // `pagesTheCompileNoLongerSpeaksFor` withholds nothing and the warning
    // stood: an UNPAID_PROMISE derived from prose this compile never read,
    // asserted about a book it had just disclaimed, and served to the reader's
    // quality card by `loadProjectQualityReport`. The report cannot invent a
    // finding about prose nobody here reviewed — that is its own stated rule,
    // and this was the one check exempt from it.
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "balanced",
      enabled: (feature: string): boolean =>
        isDefaultCompileQualityFeature(feature) || feature === "storyExtractAudit"
    });
    // What the project's rows now fold to: the promise arrives with the page
    // the reader added while this compile was inside its repair. The reviewed
    // pages carry no delta at all, so it is nowhere in what this compile read.
    mocks.rebuildStoryStateFromPages.mockResolvedValue({
      promises: [{ id: "gate", text: "Who left the gate open?", status: "open", openedAtPage: 3 }],
      facts: [],
      entities: {},
      unanswered: []
    });
    const restoreStrategy = supersedeOnFirstRepairedPageSave();
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).resolves.toEqual({});
    } finally {
      restoreStrategy();
      logged.mockRestore();
    }

    expect(recordedReport().issues.map((issue) => issue.code)).not.toContain("BRIEF_COVERAGE_UNVERIFIED");
  });

  it("withholds an unpaid promise once its own repair has rewritten a page under it", async () => {
    // The finding names the book's last page, and that anchor is a signpost —
    // pay the promise off or retire it there — rather than the prose being
    // complained about. Scored as a location it was unfalsifiable by
    // construction: the repair rewrites in ascending order and stops where the
    // fence went dark, so the pages that move are a prefix, and the last page
    // is the one page a truncated pass never reaches. A pass that had already
    // rewritten the page the promise was opened on — and whose rewrite may have
    // paid it off — therefore stood down complaining about it anyway, off a
    // fold of the pages as it *read* them: `review_recommended`, stamped
    // `finalReviewRan: true`, about a promise this very compile may have
    // answered. It is scored against the whole book now, like every other
    // finding whose subject is the manuscript.
    const opensThePromise = [
      { ...compilePage(1), storyDelta: { promisesOpened: [{ id: "gate", text: "Who left the gate open?" }] } },
      compilePage(2)
    ];
    mocks.prisma.project.findUnique.mockResolvedValue(projectRecord(opensThePromise));
    // The book as it stands once the pass has repaired page 1 and lost page 2:
    // the prose the promise was folded out of is gone, and nothing has touched
    // the last page the finding points at.
    mocks.loadPageTextSnapshot.mockResolvedValue([
      pageText({ ...compilePage(1), markdown: "A repaired page the reviewer accepts first time.", revision: 2 }),
      pageText(compilePage(2))
    ]);
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "balanced",
      enabled: (feature: string): boolean =>
        isDefaultCompileQualityFeature(feature) || feature === "storyExtractAudit"
    });
    const restoreStrategy = supersedeOnFirstRepairedPageSave(undefined, ["Page 2 drifts from its chapter."]);
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(compileExport(job())).resolves.toEqual({});
    } finally {
      restoreStrategy();
      logged.mockRestore();
    }

    const report = recordedReport();
    expect(report.issues.map((issue) => issue.code)).not.toContain("BRIEF_COVERAGE_UNVERIFIED");
    // And no further than that: a complaint about a page this compile really
    // did review and nothing has touched still speaks, which is what keeps
    // this a withdrawal rather than a rule that drops the check on this path.
    expect(report.issues.map((issue) => issue.message)).toContain("Page 2 drifts from its chapter.");
  });

  it("still fails a compile whose repair broke for any other reason", async () => {
    // The narrowness of the catch is the safety property: it takes one class,
    // so a `StopRequestedError` — the one error a handler may never swallow —
    // and every real fault travel out to settlement as they always did.
    screenFindsPageOne();
    mocks.repairQuickDraftPages.mockRejectedValue(new StopRequestedError());

    await expect(compileExport(job())).rejects.toBeInstanceOf(StopRequestedError);
  });
});

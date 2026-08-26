import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FinalBookQa, ManuscriptQualityIssue, PageQualityReport, QualityFeatureId } from "@book-maker/core";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";
import { pageQaQualityGates } from "../testing/qualityGateFixtures.js";

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
// Only `extractRepairPageIndexes` is a test hook here; `lastPageIndex` — the
// bound the repair asks both of its questions in — stays real.
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
// Opted in: this suite is the one that measures the style audit, so it runs
// the real `revisedDraftStyleAuditor` down to the mocked `auditPageStyle`.
vi.mock("../generation/qualityEnrichment.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/qualityEnrichment.js")>(
    "../generation/qualityEnrichment.js"
  );
  return (await import("./testing/compileExportMocks.js")).qualityEnrichmentModuleMock(actual);
});
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

import {
  dedupeQualityIssues,
  qualitySummaryMessage,
  runBoundedChapterQualityReview
} from "./compileExport.js";
import { failedQaPageIndexesForCompile } from "./compileExportCitationRepair.js";
import { repairPagesFromFinalQa } from "./compileExportRepair.js";
import { finalQaRevisionsFor } from "../generation/tuning.js";

/** The revision budget the fixtures run under: no tier recorded is balanced. */
const BALANCED_FINAL_QA_REVISIONS = finalQaRevisionsFor({ mediaSettings: {} } as never);
import { StopRequestedError } from "../runtime/jobTypes.js";
import { mocks } from "./testing/compileExportMocks.js";

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

/** A page long enough for `pinStyleExcerpts` to accept it as a style anchor. */
const lockPage = (index: number) =>
  exportPage(index, { markdown: `Page ${index} prose, long enough to anchor the book's style lock.` });

const qualityGates = (...enabled: QualityFeatureId[]) =>
  pageQaQualityGates({ additionalFeatures: enabled });

const finalQa = (repairPageIndexes: number[]): FinalBookQa =>
  ({ approved: repairPageIndexes.length === 0, issues: [], repairPageIndexes }) as unknown as FinalBookQa;

describe("repairPagesFromFinalQa", () => {
  // Sequential-pages so the repaired-page embedding write is exercised; other
  // modes skip it because nothing ever reads their embeddings.
  const strategy = {
    executionMode: "sequential-pages",
    reviewPageDraft: vi.fn(),
    revisePageDraft: vi.fn(),
    repairPageBrief: vi.fn()
  };

  const baseOptions = (overrides: Record<string, unknown> = {}) =>
    ({
      projectId: "project-1",
      input: { targetPages: 2, mediaSettings: {} },
      plan: { title: "Book", chapters: [] },
      providers: { text: {}, embedding: {} },
      strategy,
      quality: qualityGates(),
      pages: [exportPage(1), exportPage(2)],
      finalQa: finalQa([2]),
      generationJobId: "gj-1",
      ...overrides
    }) as never;

  /** The style lock each rewrite was handed, in repair order. */
  const reviseStyleExcerpts = () =>
    mocks.revisePageDraftWithRestart.mock.calls.map(
      (call) => (call[0] as { reviseOptions: { styleExcerpts?: string[] } }).reviseOptions.styleExcerpts
    );

  /** What each style audit was asked about, in audit order. */
  const auditCalls = () => mocks.auditPageStyle.mock.calls.map((call) => call[0]);

  /** Every page write the repair made, in repair order. */
  const savedPageData = () =>
    mocks.prisma.page.update.mock.calls.map(
      (call) => (call[0] as { data: { status: string; qualityReport: Record<string, unknown> } }).data
    );

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps implementations, so a previous test's verdict would
    // otherwise carry into the next one.
    mocks.auditPageStyle.mockResolvedValue({ styleOk: true, styleIssues: [] });
    mocks.keeperStoryExtractForSave.mockResolvedValue(null);
    mocks.prisma.continuityNote.findMany.mockResolvedValue([]);
    mocks.pageReportFromFinalQa.mockReturnValue(report(30));
    mocks.parseChapterBrief.mockReturnValue(undefined);
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

    const result = await repairPagesFromFinalQa(baseOptions({
      quality: { enabled: (feature: QualityFeatureId) => feature === "pageModelReview" }
    }));

    expect(mocks.prisma.page.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "page-2" }),
        data: expect.objectContaining({
          title: "Repaired",
          status: "COMPLETED",
          revision: { increment: 1 }
        })
      })
    );
    expect(mocks.prisma.continuityNote.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          pageId: "page-2",
          scope: "page:2",
          body: "Pip stays.",
          tags: ["page", "2", "final-qa-repair"]
        })
      ]
    });
    expect(mocks.writePreparedEmbedding).toHaveBeenCalledWith(
      { projectId: "project-1", scope: "page:2", sourceId: "page-2", text: "Repaired summary." },
      expect.anything(),
      expect.anything()
    );
    expect(mocks.loadPagesForExport).toHaveBeenCalledWith("project-1");
    expect(result).toHaveLength(2);
    expect(strategy.reviewPageDraft).toHaveBeenCalledWith(expect.objectContaining({ skipLocalChecks: true }));
    expect(mocks.keeperStoryExtractForSave).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: 2, keeperWasRevised: true, previousExtract: null })
    );
  });

  it("also repairs pages flagged by page-level QA, deduped and in order", async () => {
    mocks.revisePageDraftWithRestart.mockResolvedValue(draftNamed("Repaired"));
    strategy.reviewPageDraft.mockResolvedValue(report(85, true));

    await repairPagesFromFinalQa(baseOptions({ finalQa: finalQa([2]), extraPageIndexes: [2, 1] }));

    const updatedIds = mocks.prisma.page.update.mock.calls.map((call) => (call[0] as { where: { id: string } }).where.id);
    expect(updatedIds).toEqual(["page-1", "page-2"]);
  });

  it("does not revise a FAILED_QA page whose only issues demand an unavailable source identity", async () => {
    const sourceOnly = exportPage(2, { status: "FAILED_QA", qualityReport: { approved: false, issues: [
      "Despite the page brief explicitly requiring a named testimony or archive, the page provides no specific dispatch date."
    ] } });
    const pages = [exportPage(1), sourceOnly];
    const extraPageIndexes = failedQaPageIndexesForCompile(pages, []);

    await expect(repairPagesFromFinalQa(baseOptions({ pages, finalQa: finalQa([]), extraPageIndexes })))
      .resolves.toBeUndefined();

    expect(extraPageIndexes).toEqual([]);
    expect(failedQaPageIndexesForCompile(pages, ["Boundary papers: Commission records."])).toEqual([2]);
    expect(mocks.revisePageDraftWithRestart).not.toHaveBeenCalled();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
  });

  it("asks both of its questions in the book's page numbers, never the plan's", async () => {
    // `input.targetPages` is what the plan asked for; the pages handed in are
    // what was drafted, and `runLocalFinalQa` reports the difference as a
    // mismatch of its own. Bounded by the plan, a complaint about page 3 of this
    // book was dropped before the repair could see it, and the ending
    // heuristic redrafted page 2 — the plan's last page, not the book's.
    mocks.revisePageDraftWithRestart.mockResolvedValue(draftNamed("Repaired"));
    strategy.reviewPageDraft.mockResolvedValue(report(85, true));

    await repairPagesFromFinalQa(
      baseOptions({ pages: [exportPage(1), exportPage(2), exportPage(3)], finalQa: finalQa([3]) })
    );

    expect(mocks.extractRepairPageIndexes).toHaveBeenCalledWith(expect.anything(), 3);
    // And the same number reaches the report that tells the rewrite which
    // complaints page 3 is answering.
    expect(mocks.pageReportFromFinalQa).toHaveBeenCalledWith(expect.anything(), 3, 3);
  });

  it("skips flagged indexes that have no page row, and reports no pass at all", async () => {
    // The pass resolves its targets to rows before it walks them, so an index
    // the manuscript does not hold is not a page it stopped short of — it is
    // not one of its pages. A verdict naming only those answers `undefined`,
    // the same as a verdict that flagged nothing, and the caller spends no
    // second `runFinalBookQa` grading a manuscript no page of which was
    // rewritten. The count a truncated pass reports is the same list, which is
    // what keeps its denominator reachable.
    await expect(repairPagesFromFinalQa(baseOptions({ finalQa: finalQa([7]) }))).resolves.toBeUndefined();

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

    expect(strategy.reviewPageDraft).toHaveBeenCalledTimes(BALANCED_FINAL_QA_REVISIONS);
    expect(mocks.prisma.page.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "page-2" }),
        data: expect.objectContaining({
          title: "Rewrite 2",
          status: "FAILED_QA",
          revision: { increment: BALANCED_FINAL_QA_REVISIONS },
          qualityReport: expect.objectContaining({ score: 70 })
        })
      })
    );
    // A flagged page skips embedding until a repair actually lands — the call
    // as well as the write, since the two are now separate statements.
    expect(mocks.prepareEmbedding).not.toHaveBeenCalled();
    expect(mocks.writePreparedEmbedding).not.toHaveBeenCalled();
    expect(mocks.keeperStoryExtractForSave).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: 2, keeperWasRevised: true })
    );
  });

  it("enters recovery one attempt earlier than the page loops, because it counts from the first rewrite", async () => {
    mocks.revisePageDraftWithRestart.mockResolvedValue(draftNamed("Rewrite"));
    strategy.revisePageDraft.mockResolvedValue(draftNamed("Rewrite"));
    strategy.reviewPageDraft.mockResolvedValue(report(40));

    await repairPagesFromFinalQa(baseOptions());

    // Loop rewrites are attempts 2..N. This loop counts attempts from the
    // first rewrite — one later than the page loops count candidates — so the
    // recovery escalation must land on attempt PAGE_QA_RECOVERY_CANDIDATE - 1
    // (the third rewrite), not one rewrite later. On balanced that is also
    // the budget's final attempt, which the loop's clamp guarantees exists.
    const escalated = strategy.revisePageDraft.mock.calls.map((call) =>
      (call[0] as { report: { issues: string[] } }).report.issues.includes(
        "Earlier generated replacements for this page were still rejected by QA."
      )
    );
    expect(escalated).toEqual([
      false, // attempt 2
      true // attempt 3 = PAGE_QA_RECOVERY_CANDIDATE - 1
    ]);
  });

  /**
   * The brief repair is the one write in this pass that outlives the compile,
   * and a compile has no lease of its own — so the fence is the caller's to
   * supply and supplying it is what buys the durable write. These three pin
   * both halves of that bargain and the answer when the bargain breaks
   * mid-pass.
   */
  describe("durable brief repair", () => {
    /** A flagged page whose reviewer keeps blaming its brief. */
    const collidingBriefPages = () => {
      const pages = [exportPage(1), exportPage(2, { chapter: { id: "chapter-a", index: 1 } as never })];
      mocks.parseChapterBrief.mockImplementation(() => ({
        chapterIndex: 1,
        title: "One",
        summary: "S",
        continuityFocus: [],
        pages: [{ pageIndex: 2, purpose: "Repeat", beat: "Repeat", requiredContinuity: [], endingPressure: "" }]
      }));
      mocks.revisePageDraftWithRestart.mockResolvedValue(draftNamed("Rewrite"));
      strategy.revisePageDraft.mockResolvedValue(draftNamed("Rewrite"));
      // `repetitionOk: false` puts the loop into brief repair at its recovery attempt.
      strategy.reviewPageDraft.mockResolvedValue({
        ...report(40),
        checks: { repetitionOk: false, progressionOk: true }
      });
      strategy.repairPageBrief.mockResolvedValue({
        pageIndex: 2,
        purpose: "Fresh",
        beat: "Fresh",
        requiredContinuity: [],
        endingPressure: ""
      });
      mocks.prisma.chapter.findUnique.mockResolvedValue({
        productionBrief: {
          chapterIndex: 1,
          title: "One",
          summary: "S",
          continuityFocus: [],
          pages: [{ pageIndex: 2, purpose: "Repeat", beat: "Repeat", requiredContinuity: [], endingPressure: "" }]
        }
      });
      mocks.prisma.chapter.updateMany.mockResolvedValue({ count: 1 });
      return pages;
    };

    it("persists the repaired beat once the page keeps the rewrite it briefed", async () => {
      // The beat this pass paid a model call to fix is read back by every later
      // drafting job instead of being thrown away at the end of the compile — but
      // only for a page that shipped prose written to it, so the reviewer blames
      // the brief until the repair lands and accepts the rewrite after it. A
      // rejected one is `pageReviewRecovery.test.ts`'s case.
      const pages = collidingBriefPages();
      const blamed = { ...report(40), checks: { repetitionOk: false, progressionOk: true } };
      strategy.reviewPageDraft.mockResolvedValueOnce(blamed).mockResolvedValueOnce(blamed).mockResolvedValue(report(85, true));

      await repairPagesFromFinalQa(
        baseOptions({ pages, finalQa: finalQa([2]), assertOwnership: async () => {} })
      );

      expect(strategy.repairPageBrief).toHaveBeenCalled();
      expect(mocks.prisma.chapter.updateMany).toHaveBeenCalled();
      expect(savedPageData().map((data) => data.status)).toEqual(["COMPLETED"]);
      // Page + repaired brief publish together; the exact-keeper semantic
      // tail takes its own guarded transaction so a later reader edit cannot
      // inherit stale memory from this repair.
      expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it("keeps the repair in memory when the caller supplied no fence", async () => {
      // A compile with no `contentRevision` cannot honestly claim the book, so
      // it gets no fence — and with no fence this pass passes no `chapterId`,
      // which is the whole gate on the persisted write.
      const pages = collidingBriefPages();

      await repairPagesFromFinalQa(baseOptions({ pages, finalQa: finalQa([2]) }));

      expect(strategy.repairPageBrief).toHaveBeenCalled();
      expect(mocks.prisma.chapter.updateMany).not.toHaveBeenCalled();
    });

    it("writes nothing durable once the fence says the book moved on", async () => {
      // The fence is asked immediately before the compare-and-swap, so a
      // manuscript that moved across the repair's own model call does not get
      // this compile's opinion of its beats. It is the brief repair's own call
      // that loses the book here, rather than the fence refusing from the
      // start, because that is the boundary this test is about.
      const pages = collidingBriefPages();
      const superseded = new Error("superseded");
      let lost = false;
      strategy.repairPageBrief.mockImplementation(async () => {
        lost = true;
        return { pageIndex: 2, purpose: "Fresh", beat: "Fresh", requiredContinuity: [], endingPressure: "" };
      });

      await expect(
        repairPagesFromFinalQa(
          baseOptions({
            pages,
            finalQa: finalQa([2]),
            assertOwnership: async () => {
              if (lost) {
                throw superseded;
              }
            }
          })
        )
      ).rejects.toBe(superseded);

      expect(strategy.repairPageBrief).toHaveBeenCalled();
      expect(mocks.prisma.chapter.updateMany).not.toHaveBeenCalled();
    });

  });

  /**
   * The fence covers the pass's own writes, not only the chapter brief it was
   * first threaded into.
   *
   * A compile holds a `pages` snapshot taken minutes earlier and the reader can
   * chat-edit a finished book the whole time it works, so "the reviewer approved
   * this rewrite" and "the page in the database is still the one I read" are two
   * different questions. Threaded only into `runPageQualityLoop`, the fence
   * reached `repairPageBriefForRecovery` and nothing else — so a page whose loop
   * approved before its third rewrite never asked at all, and the pass wrote
   * over a rewrite the reader had just paid for.
   */
  describe("page writes under the ownership fence", () => {
    /** A pass that loses the book the instant its first repaired page lands. */
    const approvedRepairOfTwoPages = () => {
      mocks.revisePageDraftWithRestart.mockResolvedValue(draftNamed("Repaired"));
      strategy.reviewPageDraft.mockResolvedValue(report(85, true));
      const pages = [exportPage(1), exportPage(2)];
      mocks.prisma.page.update.mockImplementation(
        async ({ where, data }: { where: { id: string }; data: object }) => ({
          ...pages.find((page) => page.id === where.id),
          ...data
        })
      );
      return pages;
    };

    it("makes none of a page's writes once the book moved across its model calls", async () => {
      // The barrier sits after the keeper extract and the embedding call and
      // before every write, so a page whose review finished under one manuscript
      // and whose save would land under another publishes nothing: not the row,
      // not the story delta, not the notes, not the vector.
      const pages = approvedRepairOfTwoPages();
      mocks.revisePageDraftWithRestart.mockResolvedValue({
        ...draftNamed("Repaired"),
        continuityNotes: ["Pip stays."]
      });
      mocks.keeperStoryExtractForSave.mockResolvedValue({ storyDelta: {} });
      const superseded = new Error("superseded");
      let asked = 0;

      await expect(
        repairPagesFromFinalQa(
          baseOptions({
            pages,
            finalQa: finalQa([2]),
            // Answers the loop's entry barrier, refuses the publish one.
            assertOwnership: async () => {
              asked += 1;
              if (asked > 1) {
                throw superseded;
              }
            }
          })
        )
      ).rejects.toBe(superseded);

      // The calls were spent — that is the point of spending them before the
      // barrier — and not one of the writes behind them ran.
      expect(mocks.keeperStoryExtractForSave).toHaveBeenCalled();
      expect(mocks.prepareEmbedding).toHaveBeenCalled();
      expect(mocks.prisma.page.update).not.toHaveBeenCalled();
      expect(mocks.persistStoryExtract).not.toHaveBeenCalled();
      expect(mocks.prisma.continuityNote.createMany).not.toHaveBeenCalled();
      expect(mocks.writePreparedEmbedding).not.toHaveBeenCalled();
    });

    it("fences the flagged page's write too, which is the branch with no chapter write in it", async () => {
      // A page the repair could not fix keeps its best draft as FAILED_QA, and
      // that update is a write over the reader's prose exactly like the approved
      // one. It is also the branch that reaches no `repairPageBriefForRecovery`
      // at all when the reviewer never blames the brief, so the original fence
      // could not have covered it.
      const pages = approvedRepairOfTwoPages();
      strategy.reviewPageDraft.mockResolvedValue(report(40));
      strategy.revisePageDraft.mockResolvedValue(draftNamed("Rewrite"));
      const superseded = new Error("superseded");
      let asked = 0;

      await expect(
        repairPagesFromFinalQa(
          baseOptions({
            pages,
            finalQa: finalQa([2]),
            assertOwnership: async () => {
              asked += 1;
              if (asked > 1) {
                throw superseded;
              }
            }
          })
        )
      ).rejects.toBe(superseded);

      expect(strategy.reviewPageDraft).toHaveBeenCalled();
      expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    });

    it("still writes every page when the caller supplied no fence", async () => {
      // The pass's job is to repair and save; a compile that can answer for
      // nothing — a hand-requeued row with no `contentRevision` — writes its
      // pages the way every compile did before the fence existed, and declines
      // only the chapter brief.
      const pages = approvedRepairOfTwoPages();

      await repairPagesFromFinalQa(baseOptions({ pages, finalQa: finalQa([1, 2]) }));

      expect(mocks.prisma.page.update.mock.calls.map((call) => (call[0] as { where: { id: string } }).where.id))
        .toEqual(["page-1", "page-2"]);
    });
  });

  it("gates on the compile's own quality context and loads none of its own", async () => {
    mocks.revisePageDraftWithRestart.mockResolvedValue(draftNamed("Repaired"));
    strategy.reviewPageDraft.mockResolvedValue(report(85, true));
    const pages = [lockPage(1), lockPage(2)];

    await repairPagesFromFinalQa(baseOptions({ pages, quality: qualityGates("styleExcerpts") }));

    expect(mocks.loadQualityContext).not.toHaveBeenCalled();
    expect(reviseStyleExcerpts()).toEqual([[pages[0]!.markdown]]);

    mocks.revisePageDraftWithRestart.mockClear();
    await repairPagesFromFinalQa(baseOptions({ pages, quality: qualityGates() }));

    expect(mocks.loadQualityContext).not.toHaveBeenCalled();
    expect(reviseStyleExcerpts()).toEqual([undefined]);
  });

  it("pins one style lock as soon as two pages supply it, and answers per page until then", async () => {
    // `pinStyleExcerpts` sorts ascending and keeps the first two substantial
    // pages, so the answer only moves while the opening is still growing: page
    // 1 has nothing behind it and falls back to the import samples, page 2 has
    // one page, and every repair from there on pins the same two — which is
    // what lets the loop hoist it out.
    const pages = [1, 2, 3, 4].map(lockPage);
    mocks.revisePageDraftWithRestart.mockImplementation(
      async (options: { reviseOptions: { pageIndex: number } }) => ({
        ...draftNamed(`Repaired ${options.reviseOptions.pageIndex}`),
        markdown: `Repaired page ${options.reviseOptions.pageIndex} prose, long enough to anchor the lock.`
      })
    );
    strategy.reviewPageDraft.mockResolvedValue(report(85, true));
    mocks.prisma.page.update.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        ...lockPage(Number(where.id.replace("page-", ""))),
        ...data
      })
    );

    await repairPagesFromFinalQa(
      baseOptions({
        input: {
          targetPages: 4,
          mediaSettings: {
            mobile: { import: { styleProfile: { sampleExcerpts: ["Imported voice one.", "Imported voice two."] } } }
          }
        },
        pages,
        quality: qualityGates("styleExcerpts"),
        finalQa: finalQa([1, 2, 3, 4])
      })
    );

    const repaired = (index: number) => `Repaired page ${index} prose, long enough to anchor the lock.`;
    expect(reviseStyleExcerpts()).toEqual([
      ["Imported voice one.", "Imported voice two."],
      [repaired(1), "Imported voice one."],
      [repaired(1), repaired(2)],
      // The hoisted answer, and the one a fourth recomputation would give.
      [repaired(1), repaired(2)]
    ]);
  });

  it("never anchors the repair to a page the QA pipeline rejected", async () => {
    // This pass reads `loadPagesForExport`, which has no status filter, so a
    // FAILED_QA page 1 — a best draft the pipeline *rejected* — became the voice
    // every repaired page in the book was rewritten and audited against, on the
    // last writer before a book ships. The shared style-lock loader answers with
    // COMPLETED pages only, and an opening it cannot supply falls back to the
    // import samples exactly as an absent one does.
    mocks.revisePageDraftWithRestart.mockResolvedValue(draftNamed("Repaired"));
    strategy.reviewPageDraft.mockResolvedValue(report(85, true));
    const pages = [
      exportPage(1, {
        status: "FAILED_QA",
        markdown: "Rejected opening prose, kept as the best draft and long enough to pin."
      }),
      lockPage(2),
      lockPage(3)
    ];

    await repairPagesFromFinalQa(
      baseOptions({
        input: {
          targetPages: 3,
          mediaSettings: { mobile: { import: { styleProfile: { sampleExcerpts: ["Imported voice one."] } } } }
        },
        pages,
        quality: qualityGates("styleExcerpts"),
        finalQa: finalQa([3])
      })
    );

    // Page 3's repair: the only accepted page behind it is page 2, and the
    // loader is asked for the opening the export set could not supply.
    expect(mocks.loadStyleLockPages).toHaveBeenCalledWith("project-1", 3, [pages[1]]);
    expect(reviseStyleExcerpts()[0]).toEqual([pages[1]!.markdown, "Imported voice one."]);
    expect(reviseStyleExcerpts()[0]!.join(" ")).not.toContain("Rejected opening");
  });

  it("does not anchor a later repair to an opening that failed earlier in the same pass", async () => {
    const pages = [lockPage(1), lockPage(2), lockPage(3)];
    mocks.revisePageDraftWithRestart.mockImplementation(
      async (options: { reviseOptions: { pageIndex: number } }) => ({
        ...draftNamed(`Repair ${options.reviseOptions.pageIndex}`),
        markdown: `Repair ${options.reviseOptions.pageIndex} prose, long enough to anchor the lock.`
      })
    );
    strategy.revisePageDraft.mockImplementation(async (options: { pageIndex: number }) => ({
      ...draftNamed(`Rewrite ${options.pageIndex}`),
      markdown: `Rewrite ${options.pageIndex} prose, long enough to anchor the lock.`
    }));
    strategy.reviewPageDraft.mockImplementation(async (options: { pageIndex: number }) =>
      options.pageIndex === 1 ? report(40) : report(85, true)
    );
    mocks.prisma.page.update.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        ...lockPage(Number(where.id.replace("page-", ""))),
        ...data
      })
    );

    await repairPagesFromFinalQa(
      baseOptions({
        input: {
          targetPages: 3,
          mediaSettings: { mobile: { import: { styleProfile: { sampleExcerpts: ["Imported voice."] } } } }
        },
        pages,
        quality: qualityGates("styleExcerpts"),
        finalQa: finalQa([1, 3])
      })
    );

    expect(mocks.loadStyleLockPages).toHaveBeenCalledWith("project-1", 3, [pages[1]]);
    expect(reviseStyleExcerpts()[1]).toEqual([pages[1]!.markdown, "Imported voice."]);
    expect(reviseStyleExcerpts()[1]!.join(" ")).not.toContain("Page 1 prose");
  });

  it("audits the repair against the very array the rewrite was anchored to", async () => {
    // The finding this closes: nothing checked that the auditor and the
    // rewrite's `styleExcerpts` come off the same pin. They are asserted
    // identical by reference, so re-deriving either one separately fails here
    // even if the two derivations happen to agree today.
    mocks.revisePageDraftWithRestart.mockResolvedValue(draftNamed("Repaired"));
    strategy.reviewPageDraft.mockResolvedValue(report(85, true));
    const pages = [lockPage(1), lockPage(2)];

    await repairPagesFromFinalQa(baseOptions({ pages, quality: qualityGates("styleExcerpts", "styleAuditor") }));

    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0]!.markdown).toBe("Repaired text.");
    expect(auditCalls()[0]!.styleExcerpts).toEqual([pages[0]!.markdown]);
    expect(auditCalls()[0]!.styleExcerpts).toBe(reviseStyleExcerpts()[0]);
    // A clean audit stamps zero rather than nothing, which is what tells the
    // draft comparison this report was seen by the auditor at all.
    expect(savedPageData()[0]).toMatchObject({ status: "COMPLETED", qualityReport: { stylePenalty: 0 } });
  });

  it("builds no auditor unless the gate is on and there is a lock to compare against", async () => {
    mocks.revisePageDraftWithRestart.mockResolvedValue(draftNamed("Repaired"));
    strategy.reviewPageDraft.mockResolvedValue(report(85, true));
    const pages = [lockPage(1), lockPage(2)];

    // Excerpts pinned, auditor gate off: the rewrite is still anchored, and
    // the saved report carries no penalty key, so nothing later can mistake it
    // for a report that passed the audit.
    await repairPagesFromFinalQa(baseOptions({ pages, quality: qualityGates("styleExcerpts") }));

    expect(mocks.auditPageStyle).not.toHaveBeenCalled();
    expect(reviseStyleExcerpts()).toEqual([[pages[0]!.markdown]]);
    expect(savedPageData()[0]!.qualityReport).not.toHaveProperty("stylePenalty");

    // Auditor gate on, nothing pinned: there is nothing to audit against.
    await repairPagesFromFinalQa(baseOptions({ pages, quality: qualityGates("styleAuditor") }));

    expect(mocks.auditPageStyle).not.toHaveBeenCalled();
  });

  it("carries a failed audit's penalty and issues into the report the repair saves", async () => {
    mocks.revisePageDraftWithRestart.mockResolvedValue(draftNamed("Repaired"));
    // The reviewer approves the repair and rejects every rewrite after it, so
    // the audited draft is the keeper and its report is what ships.
    strategy.reviewPageDraft.mockResolvedValueOnce(report(85, true)).mockResolvedValue(report(40));
    strategy.revisePageDraft.mockResolvedValue(draftNamed("Rewrite"));
    mocks.auditPageStyle.mockResolvedValue({
      styleOk: false,
      styleIssues: ["Register drifts into lecture mode.", "Rhythm ignores the opening."]
    });

    await repairPagesFromFinalQa(
      baseOptions({ pages: [lockPage(1), lockPage(2)], quality: qualityGates("styleExcerpts", "styleAuditor") })
    );

    const saved = savedPageData()[0]!;
    expect(saved.status).toBe("FAILED_QA");
    expect(saved.qualityReport).toMatchObject({ score: 85, stylePenalty: 30 });
    expect(saved.qualityReport.issues).toContain("Register drifts into lecture mode.");
    expect(saved.qualityReport.requiredRevisions).toContain("Revise style: Register drifts into lecture mode.");
  });

  it("spends at most two style audits per page, and gives the next page a fresh budget", async () => {
    // The reviewer approves every rewrite and the audit rejects every one, so
    // nothing but the counter can stop the two gates trading provider calls.
    mocks.revisePageDraftWithRestart.mockImplementation(
      async (options: { reviseOptions: { pageIndex: number } }) =>
        draftNamed(`Repair ${options.reviseOptions.pageIndex}`)
    );
    strategy.revisePageDraft.mockImplementation(async (options: { pageIndex: number }) =>
      draftNamed(`Rewrite ${options.pageIndex}`)
    );
    strategy.reviewPageDraft.mockResolvedValue(report(85, true));
    mocks.auditPageStyle.mockResolvedValue({ styleOk: false, styleIssues: ["Register drifts."] });
    mocks.prisma.page.update.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        ...lockPage(Number(where.id.replace("page-", ""))),
        ...data
      })
    );

    await repairPagesFromFinalQa(
      baseOptions({
        input: {
          targetPages: 2,
          mediaSettings: {
            mobile: { import: { styleProfile: { sampleExcerpts: ["Imported voice one.", "Imported voice two."] } } }
          }
        },
        pages: [lockPage(1), lockPage(2)],
        quality: qualityGates("styleExcerpts", "styleAuditor"),
        finalQa: finalQa([1, 2])
      })
    );

    // Two per page and no more — the closure is built inside the page loop, so
    // page 1 exhausting its budget must not spend page 2's.
    expect(auditCalls().map((call) => call.markdown)).toEqual([
      "Repair 1 text.",
      "Rewrite 1 text.",
      "Repair 2 text.",
      "Rewrite 2 text."
    ]);
    // The third approval on each page is the one the cap lets through, so both
    // pages ship on a report the auditor never saw.
    expect(savedPageData().map((data) => data.status)).toEqual(["COMPLETED", "COMPLETED"]);
    expect(savedPageData().map((data) => data.qualityReport.stylePenalty)).toEqual([undefined, undefined]);
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

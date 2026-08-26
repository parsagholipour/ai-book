import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHAPTER_CONTINUITY_FOCUS_LIMIT, type PageQualityReport } from "@book-maker/core";
import { pageQaQualityGates } from "../testing/qualityGateFixtures.js";

/**
 * Where a page loop's recovery lands, given its budget.
 *
 * Recovery throws the draft away — a brief-repair model call and an
 * instruction to write a complete replacement page — so its index is a
 * spending decision, and the budget it is fitted to is tier-scaled. The two
 * ends are what the tests below pin: a budget that would never reach the
 * requested index gets recovery pulled down onto its last candidate, and a
 * budget too small to hold an ordinary revision first gets no recovery at all.
 * The loop pinned to a reader's own edit opts out of both — and the progress
 * message reads the same index, because the loop hands it to `onRewrite`
 * instead of letting each caller derive one from the book's input.
 *
 * The brief repair recovery buys is here too: the planner call the latch spends
 * once, both asks of the ownership fence, and the two things that wait to see
 * whether the page keeps a draft that call briefed — *whether* the durable
 * `Chapter.productionBrief` write is taken, and the merged brief the loop hands
 * back for a caller that briefs the chapter's other pages from one copy. What
 * that write then claims of the row, and what it says when the claim misses,
 * moved to `pageReviewChapterBriefCas.test.ts` when this file reached its size
 * budget — the seam being memory on this side and the row on that one.
 *
 * Its own file rather than `pageReview.test.ts`'s: these drive the loop past
 * every rewrite it has and read only what the rewrites were *told* and what the
 * chapter row was left holding, so they need the same two mocks the
 * pure-decision suite needs — `runtime/dispatch.js` opens a Redis connection at
 * import time and the db client wants a database — plus the one row the repair
 * writes, and none of the page-save wiring.
 */

const mocks = vi.hoisted(() => ({
  chapter: { findUnique: vi.fn(), updateMany: vi.fn() }
}));

vi.mock("@book-maker/db", async () => ({
  prisma: { chapter: mocks.chapter },
  Prisma: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../runtime/dispatch.js", () => ({ enqueueWorkerJob: vi.fn() }));

import { runPageQualityLoop } from "./pageReview.js";
import { pageRevisionMessage, repairPageBriefForRecovery } from "./pageReviewRecovery.js";
import {
  PAGE_QA_RECOVERY_CANDIDATE,
  finalQaRevisionsFor,
  pageQaCandidatesFor,
  pageQaRecoveryRevision
} from "./tuning.js";

/** The tiers whose budgets the cases below turn on. */
const fastInput = { mediaSettings: { modelTier: "fast" } } as never;
const balancedInput = { mediaSettings: {} } as never;
const ultraInput = { mediaSettings: { modelTier: "ultra" } } as never;

const report = (score: number, overrides: Partial<PageQualityReport> = {}): PageQualityReport =>
  ({
    approved: false,
    score,
    issues: [],
    requiredRevisions: [],
    notes: "",
    checks: { repetitionOk: true, progressionOk: true },
    ...overrides
  }) as unknown as PageQualityReport;

const draftNamed = (name: string) => ({
  title: name,
  markdown: `${name} text.`,
  summary: `${name} summary.`,
  continuityNotes: [] as string[]
});

/** Page QA keeps its historical defaults while the style auditor remains off. */
const pageQaGates = pageQaQualityGates();

describe("pageQaRecoveryRevision", () => {
  it("pulls the requested index down to a budget that would never reach it", () => {
    // Fast tier's page loop: three candidates against a requested fourth.
    expect(pageQaRecoveryRevision(3)).toBe(3);
  });

  it("leaves a budget that comfortably holds it alone", () => {
    expect(pageQaRecoveryRevision(6)).toBe(PAGE_QA_RECOVERY_CANDIDATE);
    expect(pageQaRecoveryRevision(pageQaCandidatesFor({ mediaSettings: {} } as never))).toBe(
      PAGE_QA_RECOVERY_CANDIDATE
    );
  });

  it("refuses to land on a loop's first rewrite, however small the budget", () => {
    // A guard rather than a description of any live caller — see the docstring.
    // Landing recovery on a loop's single rewrite makes the cheapest tier the
    // one that escalates soonest and pays the extra planner call on every
    // flagged page.
    expect(pageQaRecoveryRevision(2, 3)).toBeGreaterThan(2);
    expect(pageQaRecoveryRevision(1)).toBeGreaterThan(1);
  });
});

describe("finalQaRevisionsFor", () => {
  /**
   * The repair loop's budget counts attempts from the first rewrite, one base
   * later than the page loops count candidates, so the tier's own number buys
   * it one move less. On fast that was the difference between reaching recovery
   * and never reaching it — and the repair pass runs on pages the page-level
   * loop already failed to rescue, which is exactly where recovery is the only
   * move left.
   */
  it("gives the cheapest tier room for an ordinary rewrite and a recovery", () => {
    const budget = finalQaRevisionsFor(fastInput);

    expect(budget).toBe(3);
    expect(pageQaRecoveryRevision(budget, PAGE_QA_RECOVERY_CANDIDATE - 1)).toBe(budget);
  });

  it("leaves every tier that already cleared the floor exactly where it was", () => {
    expect(finalQaRevisionsFor(balancedInput)).toBe(3);
    expect(finalQaRevisionsFor({ mediaSettings: { modelTier: "premium" } } as never)).toBe(5);
    expect(finalQaRevisionsFor({ mediaSettings: { modelTier: "ultra" } } as never)).toBe(10);
  });
});

describe("pageRevisionMessage", () => {
  it("names the recovery phase off the loop's own index, not the raw constant", () => {
    expect(pageRevisionMessage(7, 3, 2, 3)).toBe("Quality recovery rewrite page 7 (rewrite 2/2)");
    expect(pageRevisionMessage(7, 3, 5, 4)).toBe("Revising page 7 (rewrite 2/5)");
  });

  it("says nothing about recovery for a loop that has none, and prints no sentinel", () => {
    // The disabled case is `undefined` rather than an index no revision
    // reaches: an operator reading this line must never be told the loop
    // escalates at rewrite Infinity.
    const message = pageRevisionMessage(7, 99, 5, undefined);

    expect(message).toBe("Revising page 7 (rewrite 98/5)");
    expect(message).not.toMatch(/Infinity|undefined|NaN/);
  });
});

describe("runPageQualityLoop recovery point", () => {
  const alwaysRejecting = () => ({
    revisePageDraft: vi.fn(async (_options: { report: PageQualityReport }) => draftNamed("Rewrite")),
    reviewPageDraft: vi.fn(async () => report(40))
  });

  const recoveringLoop = (overrides: Record<string, unknown>) =>
    runPageQualityLoop({
      projectId: "project-1",
      input: {} as never,
      plan: {} as never,
      pageIndex: 4,
      draft: draftNamed("Initial"),
      report: report(50),
      previousPages: [],
      continuityNotes: [],
      textModel: {} as never,
      reviseContext: "Page 4",
      quality: pageQaGates,
      ...overrides
    } as never);

  /** Which rewrites were told to replace the page rather than edit it. */
  const replacementAttempts = (strategy: ReturnType<typeof alwaysRejecting>) =>
    strategy.revisePageDraft.mock.calls
      .map((call, index) => ({ attempt: index + 2, report: call[0]!.report }))
      .filter((call) => call.report.notes.includes("Quality recovery mode"))
      .map((call) => call.attempt);

  beforeEach(() => vi.clearAllMocks());

  it("pulls recovery down onto the last candidate of a budget that would never reach it", async () => {
    // Fast tier: three candidates, so the raw constant (4) never fires and the
    // whole budget goes on light edits of a draft the reviewer already rejected.
    const strategy = alwaysRejecting();

    await recoveringLoop({ strategy, maxCandidates: 3 });

    expect(replacementAttempts(strategy)).toEqual([3]);
  });

  it("buys no recovery at all for a budget too small to hold an ordinary revision first", async () => {
    const strategy = alwaysRejecting();

    await recoveringLoop({ strategy, maxCandidates: 2, recoveryRevision: 3 });

    expect(replacementAttempts(strategy)).toEqual([]);
  });

  it("reaches recovery on the cheapest tier's last final-QA attempt", async () => {
    // Fast-tier final QA, driven through the real budget and the real requested
    // index: one ordinary rewrite, then the move that changes the outcome. The
    // pass runs on a page the page loop already spent its whole budget failing
    // to rescue, so a repair that can only repeat light edits repairs nothing.
    const strategy = alwaysRejecting();
    const maxCandidates = finalQaRevisionsFor(fastInput);

    await recoveringLoop({ strategy, maxCandidates, recoveryRevision: PAGE_QA_RECOVERY_CANDIDATE - 1 });

    expect(strategy.revisePageDraft).toHaveBeenCalledTimes(maxCandidates - 1);
    expect(replacementAttempts(strategy)).toEqual([maxCandidates]);
  });

  it("never escalates a loop pinned to a reader's own edit", async () => {
    // The chat page rewrite: three candidates, no `recoveryRevision`, so the
    // clamp would otherwise land recovery on its last attempt. "Produce a
    // complete replacement page" is the one instruction that loop may not
    // carry — the reader paid for their edit to be repaired, not for the page
    // to be thrown away.
    const strategy = alwaysRejecting();

    await recoveringLoop({ strategy, maxCandidates: 3, userRequest: "Make the second paragraph funnier" });

    expect(replacementAttempts(strategy)).toEqual([]);
  });

  describe("what the operator is told", () => {
    /**
     * Rendered the way both progress callbacks render it — from the recovery
     * index the loop hands over, and from nothing else. Each used to derive its
     * own out of the book's input, which knows the tier and not the request, so
     * the message was right only for the callers that happen not to pass
     * `userRequest`.
     */
    const messagesFor = async (overrides: Record<string, unknown>, maxRewriteAttempts: number) => {
      const messages: string[] = [];
      await recoveringLoop({
        ...overrides,
        onRewrite: async (revision: number, recoveryRevision: number | undefined) => {
          messages.push(pageRevisionMessage(4, revision, maxRewriteAttempts, recoveryRevision));
        }
      });
      return messages;
    };

    it("announces recovery on the rewrite the loop actually escalates", async () => {
      expect(await messagesFor({ strategy: alwaysRejecting(), maxCandidates: 3 }, 2)).toEqual([
        "Revising page 4 (rewrite 1/2)",
        "Quality recovery rewrite page 4 (rewrite 2/2)"
      ]);
    });

    it("never says quality recovery for a loop pinned to a reader's own edit", async () => {
      // Four candidates, so a message written against the raw constant escalates
      // on the last rewrite. This loop never does: it is repairing a page around
      // an edit that was paid for, so no rewrite of it is ever briefed to throw
      // the page away, and saying otherwise describes work nobody is doing.
      const messages = await messagesFor(
        { strategy: alwaysRejecting(), maxCandidates: 4, userRequest: "Make the second paragraph funnier" },
        3
      );

      expect(messages).toEqual([
        "Revising page 4 (rewrite 1/3)",
        "Revising page 4 (rewrite 2/3)",
        "Revising page 4 (rewrite 3/3)"
      ]);
    });
  });

  describe("the brief repair it may spend once", () => {
    const originalBeat = { pageIndex: 4, goal: "Introduce the vault", requiredContinuity: [] as string[] };
    const repairedBeat = { pageIndex: 4, goal: "Open the vault", requiredContinuity: [] as string[] };

    /**
     * A reviewer that keeps blaming the brief, which is the whole reason a page
     * is in this loop: `shouldRepairPageBriefForRecovery` reads the report, and
     * a report like this one answers it the same way on every rewrite left.
     */
    const brieflyBlaming = () => ({
      revisePageDraft: vi.fn(async (_options: { pageBrief?: unknown }) => draftNamed("Rewrite")),
      reviewPageDraft: vi.fn(async () => ({
        ...report(40),
        checks: { repetitionOk: false, progressionOk: true }
      })),
      repairPageBrief: vi.fn(async () => repairedBeat)
    });

    it("repairs the brief once across a budget that keeps asking for it", async () => {
      // Ultra final QA: ten attempts, recovery fitted onto the third. Every one
      // of rewrites 3..10 satisfies the predicate, and unlatched every one of
      // them spent a planner call and (with a `chapterId`) a durable chapter
      // write, each landing a different beat — ~120 of each on a compile
      // repairing fifteen pages. One repair is the move; repeating it asks the
      // planner to disown the beat it wrote one rewrite ago.
      const strategy = brieflyBlaming();
      const maxCandidates = finalQaRevisionsFor(ultraInput);

      await recoveringLoop({
        strategy,
        maxCandidates,
        recoveryRevision: PAGE_QA_RECOVERY_CANDIDATE - 1,
        repairBrief: true,
        pageBrief: originalBeat
      });

      expect(maxCandidates).toBe(10);
      expect(strategy.revisePageDraft).toHaveBeenCalledTimes(maxCandidates - 1);
      expect(strategy.repairPageBrief).toHaveBeenCalledTimes(1);
    });

    it("still briefs every remaining rewrite against the repaired beat", async () => {
      // The latch spends the *call*, not the answer: the one repair has to keep
      // steering the rewrites after it, or a page pays for a fresh assignment
      // and then goes on being rewritten against the beat that failed.
      const strategy = brieflyBlaming();

      await recoveringLoop({
        strategy,
        maxCandidates: finalQaRevisionsFor(ultraInput),
        recoveryRevision: PAGE_QA_RECOVERY_CANDIDATE - 1,
        repairBrief: true,
        pageBrief: originalBeat
      });

      // Nine rewrites, the repair on the second of them (recovery lands on
      // attempt 3), so one rewrite is briefed against the beat that failed and
      // the other eight against its replacement.
      const briefs = strategy.revisePageDraft.mock.calls.map((call) => call[0]!.pageBrief);
      expect(briefs).toHaveLength(9);
      expect(briefs[0]).toBe(originalBeat);
      expect(briefs.slice(1)).toEqual(Array.from({ length: 8 }, () => repairedBeat));
    });

    it("spends nothing when the caller never asked for a repair", async () => {
      const strategy = brieflyBlaming();

      await recoveringLoop({
        strategy,
        maxCandidates: finalQaRevisionsFor(ultraInput),
        recoveryRevision: PAGE_QA_RECOVERY_CANDIDATE - 1,
        pageBrief: originalBeat
      });

      expect(strategy.repairPageBrief).not.toHaveBeenCalled();
    });
  });
  /**
   * The two halves of that repair the loop holds back — the write that outlives
   * the compile and the merged brief its caller may brief the chapter's other
   * pages from — and the one thing both of them wait for.
   */
  describe("the repair it holds back until the page keeps a draft it briefed", () => {
    const originalBeat = {
      pageIndex: 4,
      chapterIndex: 1,
      purpose: "Introduce the vault",
      beat: "Introduce the vault",
      requiredContinuity: [] as string[],
      endingPressure: ""
    };
    const repairedBeat = { ...originalBeat, purpose: "Open the vault", beat: "Open the vault" };
    const storedChapterBrief = () => ({
      chapterIndex: 1,
      title: "The vault",
      summary: "The crew reaches the vault.",
      continuityFocus: [] as string[],
      pages: [{ ...originalBeat }]
    });

    /** Blames the brief on the first rewrite, then answers with `verdict`. */
    const repairingStrategy = (verdict: PageQualityReport) => ({
      revisePageDraft: vi.fn(async (_options: { pageBrief?: unknown }) => draftNamed("Rewrite")),
      reviewPageDraft: vi
        .fn<() => Promise<PageQualityReport>>()
        .mockResolvedValueOnce({ ...report(40), checks: { repetitionOk: false, progressionOk: true } } as never)
        .mockResolvedValue(verdict),
      repairPageBrief: vi.fn(async () => repairedBeat)
    });

    /**
     * The shape the finding was found in: `finalQaRevisionsFor` is 3 on both
     * fast and balanced and `pageQaRecoveryRevision(3, 3)` is 3, so recovery
     * lands on the loop's **final** rewrite and exactly one candidate is ever
     * briefed against the repair.
     */
    const loopOnItsLastAttempt = (strategy: unknown, extra: Record<string, unknown> = {}) =>
      recoveringLoop({
        strategy,
        maxCandidates: 3,
        recoveryRevision: PAGE_QA_RECOVERY_CANDIDATE - 1,
        repairBrief: true,
        pageBrief: originalBeat,
        chapterBrief: storedChapterBrief(),
        chapterId: "chapter-a",
        ...extra
      });

    /** What the compare-and-swap staked, and what it wrote. */
    const chapterWrite = () =>
      mocks.chapter.updateMany.mock.calls[0]![0] as {
        where: { id: string; productionBrief: { equals: { pages: Array<{ beat: string }> } } };
        data: { productionBrief: { pages: Array<{ beat: string }> } };
      };

    beforeEach(() => {
      mocks.chapter.findUnique.mockResolvedValue({ productionBrief: storedChapterBrief() });
      mocks.chapter.updateMany.mockResolvedValue({ count: 1 });
    });

    it("leaves the chapter alone when the rewrite it briefed is rejected", async () => {
      // The finding. Committed at the repair, this page shipped its pre-repair
      // prose as FAILED_QA while `Chapter.productionBrief` permanently claimed
      // the fresh beat — so every later drafting job read that beat back as
      // `previousChapterPageBriefs` and steered away from material the book
      // still contains.
      const strategy = repairingStrategy(report(30));

      const outcome = await loopOnItsLastAttempt(strategy);

      expect(strategy.repairPageBrief).toHaveBeenCalledTimes(1);
      // The seed draft, from before the repair: nothing briefed against the new
      // beat survived the reviewer.
      expect(outcome.revision).toBe(1);
      expect(mocks.chapter.findUnique).not.toHaveBeenCalled();
      expect(mocks.chapter.updateMany).not.toHaveBeenCalled();
      // And the merged brief is held back by the same test, so a caller that
      // briefs the chapter's later pages from one copy — a book pass's
      // `ChapterSetup.brief`, a compile's per-chapter parse — cannot claim a
      // beat the row was right to refuse.
      expect(outcome.repairedChapterBrief).toBeUndefined();
    });

    it("writes the repaired beat once the page keeps the rewrite it briefed", async () => {
      const strategy = repairingStrategy(report(85, { approved: true }));

      const outcome = await loopOnItsLastAttempt(strategy);

      expect(outcome.approved).toBe(true);
      expect(outcome.revision).toBe(3);
      expect(mocks.chapter.updateMany).toHaveBeenCalledTimes(1);
      // Still a compare-and-swap: staked on the brief this loop read, holding
      // the beat it replaced.
      expect(chapterWrite().where.id).toBe("chapter-a");
      expect(chapterWrite().where.productionBrief.equals.pages.map((page) => page.beat)).toEqual([
        "Introduce the vault"
      ]);
      expect(chapterWrite().data.productionBrief.pages).toEqual([repairedBeat]);
      // The same take, so the caller's copy and the row cannot disagree about
      // whether the repair was earned.
      expect(outcome.repairedChapterBrief?.pages).toEqual([repairedBeat]);
    });

    it("writes it for a keeper the reviewer rejected too, because that is the page that ships", async () => {
      // Kept, not approved. A page the loop could not rescue is saved at its
      // best draft, so a chapter describing the assignment *that* draft was
      // written to is right for the same reason an approved one is.
      const strategy = repairingStrategy(report(70));

      const outcome = await loopOnItsLastAttempt(strategy);

      expect(outcome.approved).toBe(false);
      expect(outcome.revision).toBe(3);
      expect(chapterWrite().data.productionBrief.pages).toEqual([repairedBeat]);
    });

    it.each([
      {
        outcome: "no-stored-brief",
        arrange: () => mocks.chapter.findUnique.mockResolvedValue(null)
      },
      {
        outcome: "unclaimable",
        arrange: () => {
          mocks.chapter.findUnique.mockResolvedValue({ productionBrief: storedChapterBrief() });
          mocks.chapter.updateMany.mockResolvedValue({ count: 0 });
        }
      },
      {
        outcome: "lost-race",
        arrange: () => {
          mocks.chapter.findUnique
            .mockResolvedValueOnce({ productionBrief: storedChapterBrief() })
            .mockResolvedValueOnce({ productionBrief: { ...storedChapterBrief(), continuityFocus: ["Sibling A"] } })
            .mockResolvedValueOnce({ productionBrief: { ...storedChapterBrief(), continuityFocus: ["Sibling B"] } })
            .mockResolvedValueOnce({ productionBrief: { ...storedChapterBrief(), continuityFocus: ["Sibling C"] } });
          mocks.chapter.updateMany.mockResolvedValue({ count: 0 });
        }
      }
    ])("does not carry the repaired brief after a standalone $outcome outcome", async ({ arrange }) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      arrange();
      const strategy = repairingStrategy(report(85, { approved: true }));

      const outcome = await loopOnItsLastAttempt(strategy);

      expect(outcome.approved).toBe(true);
      expect(outcome.revision).toBe(3);
      // The repaired assignment still briefed the keeper. Only the chapter-wide
      // copy is withheld: it must wait on the same successful CAS as the row.
      expect(strategy.revisePageDraft.mock.calls.at(-1)?.[0].pageBrief).toBe(repairedBeat);
      expect(outcome.repairedChapterBrief).toBeUndefined();
      warn.mockRestore();
    });

    it("asks the ownership fence again at the write, a whole page's rewrites later", async () => {
      // The two asks are different questions: the first stands the delivery
      // down if it lost the book across the repair's own model call, and this
      // one is the write's, because everything between them is provider time.
      const superseded = new Error("superseded");
      const strategy = repairingStrategy(report(85, { approved: true }));
      let asked = 0;
      const assertOwnership = vi.fn(async () => {
        asked += 1;
        if (asked > 1) {
          throw superseded;
        }
      });

      // The throw is the whole carry story too: a loop that stands down at the
      // write returns no outcome, so the caller's copy of the chapter is left
      // exactly as it was for want of anything to replace it with.
      await expect(loopOnItsLastAttempt(strategy, { assertOwnership })).rejects.toBe(superseded);

      expect(assertOwnership).toHaveBeenCalledTimes(2);
      expect(mocks.chapter.updateMany).not.toHaveBeenCalled();
    });
  });
});

describe("repairPageBriefForRecovery", () => {
  const beat = (pageIndex: number, text: string) => ({
    pageIndex,
    chapterIndex: 1,
    purpose: text,
    beat: text,
    requiredContinuity: [] as string[],
    endingPressure: ""
  });

  const chapterBriefFixture = () => ({
    chapterIndex: 1,
    title: "The vault",
    summary: "The crew reaches the vault.",
    continuityFocus: [] as string[],
    pages: [beat(5, "Reach the vault"), beat(6, "Repeat the approach")]
  });

  const repairedBeat = () => ({ ...beat(6, "Open the vault"), requiredContinuity: ["fresh angle"] });

  const strategy = { repairPageBrief: vi.fn() };

  const callOptions = (overrides: Record<string, unknown> = {}) =>
    ({
      strategy,
      input: {},
      plan: {},
      chapterBrief: chapterBriefFixture(),
      chapterId: "chapter-1",
      pageBrief: beat(6, "Repeat the approach"),
      pageIndex: 6,
      draft: draftNamed("Six"),
      qualityReport: report(40),
      previousPages: [],
      continuityNotes: [],
      textModel: {},
      context: "Page 6",
      ...overrides
    }) as never;

  /** The write the loop takes once the page keeps a draft this beat briefed. */
  const takeDeferredWrite = async (options = callOptions()) => {
    const repair = await repairPageBriefForRecovery(options);
    await repair.persist?.();
    return repair;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    strategy.repairPageBrief.mockResolvedValue(repairedBeat());
  });

  /**
   * What the repair does to the chapter brief it is handed, which is nothing at
   * all: it answers with the merge and leaves every copy of that brief to the
   * loop, which rebinds its own immediately and hands the caller's out only
   * once the page has kept a draft the beat briefed.
   */
  describe("the chapter brief it is handed", () => {
    it("answers with the merge and writes into nothing it was given", async () => {
      // The finding, from the write side. The book passes hand in the single
      // `ChapterSetup.brief` every page of a chapter is briefed from, so an
      // `Object.assign` here promoted a page-local edit to a chapter-wide one
      // at the moment the planner call returned — pages after a page whose
      // post-repair rewrite is then rejected briefed against a beat that page
      // never wrote, and a memory of the chapter that no longer matched the
      // row. Fixed at one call site with a per-page copy, three others still
      // had it; fixed here, none of them can.
      const handed = chapterBriefFixture();

      const repair = await repairPageBriefForRecovery(callOptions({ chapterBrief: handed }));

      // The rewrites after this one are briefed off the answer, so the repair
      // has to be on it before they run.
      expect(repair.chapterBrief?.pages[1]).toEqual(repairedBeat());
      // And the caller's own brief is byte-for-byte what it handed in.
      expect(handed).toEqual(chapterBriefFixture());
      expect(repair.chapterBrief).not.toBe(handed);
    });

    it("answers with the merge for a page whose chapter it may not write either", async () => {
      // A compile that cannot honestly claim the book passes no `chapterId`, so
      // there is no durable write to offer — but the beat it just paid a
      // planner call for still has to steer this page's remaining rewrites, and
      // still has to be available to the chapter's later pages if this one
      // keeps it. Deferring that is the loop's job, not this function's.
      const repair = await repairPageBriefForRecovery(callOptions({ chapterId: null }));

      expect(repair.beat).toEqual(repairedBeat());
      expect(repair.chapterBrief?.pages[1]).toEqual(repairedBeat());
      expect(repair.persist).toBeNull();
      expect(mocks.chapter.findUnique).not.toHaveBeenCalled();
      expect(mocks.chapter.updateMany).not.toHaveBeenCalled();
    });

    it("carries the chapter's other beats across as copies of them", async () => {
      // The same rule as the continuity focus below, one level down. A merge
      // that hands back the caller's own beat objects has left every one of
      // their `requiredContinuity` lists shared between the brief the chapter
      // had before this repair and the brief its later pages are briefed from,
      // so a pass appending to one appends to both. Only `repaired` crosses by
      // identity, and it is this repair's own object rather than the caller's.
      const handed = chapterBriefFixture();

      const repair = await repairPageBriefForRecovery(callOptions({ chapterBrief: handed }));

      expect(repair.chapterBrief?.pages[0]).toEqual(handed.pages[0]);
      expect(repair.chapterBrief?.pages[0]).not.toBe(handed.pages[0]);
      repair.chapterBrief?.pages[0]?.requiredContinuity.push("Appended by a later pass.");
      expect(handed.pages[0]?.requiredContinuity).toEqual([]);
    });

    it("has no merge to answer with for a caller that briefs from no chapter", async () => {
      const repair = await repairPageBriefForRecovery(callOptions({ chapterBrief: undefined }));

      expect(repair.beat).toEqual(repairedBeat());
      expect(repair.chapterBrief).toBeUndefined();
    });
  });

  /**
   * The one field the merge *combines* rather than carries across, and so the
   * only one a budget can be spent on. `focusWithRepairedContinuity` holds why
   * the cap belongs to what a pass appends, and points at the sibling that
   * reached the same rule from the critic's side; these pin the two answers it
   * turns on.
   */
  describe("the chapter's continuity focus", () => {
    const constraints = (count: number) =>
      Array.from({ length: count }, (_, index) => `Map constraint ${index + 1}.`);

    /**
     * Past the budget, and carrying a repeat and an untrimmed entry the map's
     * own producers left in it. `uniqueStrings` collapses and trims both, so a
     * list that comes back holding them is visibly one nothing re-deduped
     * either — not merely one that happened to fit.
     */
    const overBudgetFocus = [
      ...constraints(CHAPTER_CONTINUITY_FOCUS_LIMIT + 3),
      "Map constraint 1.",
      " Map constraint 2. "
    ];

    const briefWithFocus = (focus: string[]) => ({ ...chapterBriefFixture(), continuityFocus: [...focus] });

    /** What the compare-and-swap left in the row every later job reads back. */
    const writtenFocus = () =>
      (
        mocks.chapter.updateMany.mock.calls[0]![0] as {
          data: { productionBrief: { continuityFocus: string[] } };
        }
      ).data.productionBrief.continuityFocus;

    beforeEach(() => {
      mocks.chapter.updateMany.mockResolvedValue({ count: 1 });
    });

    it("leaves a list this repair did not grow exactly as it found it", async () => {
      // The finding. A repaired beat that requires no continuity of its own
      // appends nothing, so there is nothing for the budget to be spent on —
      // and the entries past it are ones the map's own producers wrote, which
      // every page of this chapter has always been drafted against. Cut
      // unconditionally, five of them went the first time any one page of the
      // chapter bought a repair: out of this page's remaining rewrites, and out
      // of the row `previousChapterPageBriefs` is read from ever after.
      strategy.repairPageBrief.mockResolvedValue({ ...beat(6, "Open the vault"), requiredContinuity: [] });
      const handed = briefWithFocus(overBudgetFocus);
      mocks.chapter.findUnique.mockResolvedValue({ productionBrief: briefWithFocus(overBudgetFocus) });

      const repair = await takeDeferredWrite(callOptions({ chapterBrief: handed }));

      expect(overBudgetFocus).toHaveLength(25);
      expect(repair.chapterBrief?.continuityFocus).toEqual(overBudgetFocus);
      expect(writtenFocus()).toEqual(overBudgetFocus);
      // And the caller's own list is still the caller's, as everything else on
      // this brief is.
      expect(handed.continuityFocus).toEqual(overBudgetFocus);
    });

    it("hands that list back as a copy rather than the brief's own array", async () => {
      // The half of "writes into nothing it was given" that a *pure* merge can
      // still lose. The empty-append path returned `existing` itself, so the
      // merged brief's `continuityFocus` **was** the handed brief's array —
      // `runPageQualityLoop` rebinds to the merge and `adoptRepairedChapterBrief`
      // assigns it to the shared `ChapterSetup.brief`, so the pre-repair brief
      // and the post-repair one held one list between them and the next `push`
      // from either side wrote through to both. It is also the common path:
      // most repaired beats require no continuity of their own. The sibling
      // spender of this budget is pinned the same way in
      // `packages/core/src/generation/pageMapCritic.test.ts`.
      strategy.repairPageBrief.mockResolvedValue({ ...beat(6, "Open the vault"), requiredContinuity: [] });
      const handed = briefWithFocus(["Keep the ferryman's name."]);

      const repair = await repairPageBriefForRecovery(callOptions({ chapterBrief: handed }));

      expect(repair.chapterBrief?.continuityFocus).toEqual(["Keep the ferryman's name."]);
      expect(repair.chapterBrief?.continuityFocus).not.toBe(handed.continuityFocus);
      repair.chapterBrief?.continuityFocus.push("Appended by a later pass.");
      expect(handed.continuityFocus).toEqual(["Keep the ferryman's name."]);
    });

    it("stakes the compare-and-swap on a list the value it writes cannot reach", async () => {
      // The same aliasing inside the durable write, where it is a
      // compare-and-swap staking its `expected` on the very array the value it
      // is writing carries: the row state a CAS is claiming against must be a
      // reading of the row and nothing the write can touch.
      strategy.repairPageBrief.mockResolvedValue({ ...beat(6, "Open the vault"), requiredContinuity: [] });
      mocks.chapter.findUnique.mockResolvedValue({ productionBrief: briefWithFocus(["Keep the ferryman's name."]) });

      await takeDeferredWrite(callOptions({ chapterBrief: briefWithFocus(["Keep the ferryman's name."]) }));

      const write = mocks.chapter.updateMany.mock.calls[0]![0] as {
        where: { productionBrief: { equals: { continuityFocus: string[] } } };
        data: { productionBrief: { continuityFocus: string[] } };
      };
      expect(write.data.productionBrief.continuityFocus).toEqual(["Keep the ferryman's name."]);
      expect(write.data.productionBrief.continuityFocus).not.toBe(write.where.productionBrief.equals.continuityFocus);
    });

    it("caps a list this repair did grow at the budget its sibling spends", async () => {
      // The budget is over the whole list rather than over the appended tail —
      // the same cut `focusWithCriticNotes` makes, from the same constant — so
      // a chapter already past it pays for the repair's own entry by losing its
      // last. That is a pass spending a prompt budget it grew, which is the
      // case the cap is for.
      strategy.repairPageBrief.mockResolvedValue({
        ...beat(6, "Open the vault"),
        requiredContinuity: ["Fresh angle: the vault is already open."]
      });
      const handed = briefWithFocus(constraints(CHAPTER_CONTINUITY_FOCUS_LIMIT + 5));
      mocks.chapter.findUnique.mockResolvedValue({
        productionBrief: briefWithFocus(constraints(CHAPTER_CONTINUITY_FOCUS_LIMIT + 5))
      });

      const repair = await takeDeferredWrite(callOptions({ chapterBrief: handed }));

      expect(repair.chapterBrief?.continuityFocus).toEqual(constraints(CHAPTER_CONTINUITY_FOCUS_LIMIT));
      expect(writtenFocus()).toEqual(constraints(CHAPTER_CONTINUITY_FOCUS_LIMIT));
      expect(handed.continuityFocus).toHaveLength(CHAPTER_CONTINUITY_FOCUS_LIMIT + 5);
    });

    it("appends the repaired beat's own continuity when the budget has room for it", async () => {
      // The other side of the guard: skipping the merge for a list nothing grew
      // must not become skipping the merge.
      strategy.repairPageBrief.mockResolvedValue({
        ...beat(6, "Open the vault"),
        requiredContinuity: ["Fresh angle: the vault is already open."]
      });
      const handed = briefWithFocus(constraints(2));
      mocks.chapter.findUnique.mockResolvedValue({ productionBrief: briefWithFocus(constraints(2)) });

      const repair = await takeDeferredWrite(callOptions({ chapterBrief: handed }));

      expect(repair.chapterBrief?.continuityFocus).toEqual([
        ...constraints(2),
        "Fresh angle: the vault is already open."
      ]);
      expect(writtenFocus()).toEqual([...constraints(2), "Fresh angle: the vault is already open."]);
    });
  });

  describe("the page with nothing staged, which is still a page mid-loop", () => {
    /**
     * The stand-down is not about what there is to commit. A page in no
     * chapter whose caller keeps no copy of one has no `persist` at all, so
     * this ask is the only one it will ever get — and everything it is
     * protecting is still ahead: the recovery rewrite, its review, and every
     * attempt left in the budget.
     */
    it("asks the fence after the repair call even when there is nothing to stage", async () => {
      const assertOwnership = vi.fn(async () => undefined);

      const repair = await repairPageBriefForRecovery(
        callOptions({ chapterId: null, assertOwnership })
      );

      expect(assertOwnership).toHaveBeenCalledTimes(1);
      // Asked *after* the model call it exists to follow, not before it.
      expect(strategy.repairPageBrief).toHaveBeenCalledTimes(1);
      expect(assertOwnership.mock.invocationCallOrder[0]!).toBeGreaterThan(
        strategy.repairPageBrief.mock.invocationCallOrder[0]!
      );
      // And nothing about the answer changes for a fence that says yes.
      expect(repair.beat).toEqual(repairedBeat());
      expect(repair.persist).toBeNull();
    });

    it("stands such a page down rather than handing back a beat to keep rewriting", async () => {
      // The whole point of the ask: with no `persist` there is no second fence
      // behind it, so a beat returned here buys the delivery the rest of the
      // page's rewrite budget on a manuscript somebody else owns.
      const lost = new Error("lost its durable lease");
      const assertOwnership = vi.fn().mockRejectedValue(lost);

      await expect(
        repairPageBriefForRecovery(callOptions({ chapterId: null, assertOwnership }))
      ).rejects.toBe(lost);

      expect(assertOwnership).toHaveBeenCalledTimes(1);
      // Raised as the caller wrote it — a lost lease and a stop are both the
      // caller's to recognise, so this module neither wraps nor catches.
      expect(mocks.chapter.findUnique).not.toHaveBeenCalled();
      expect(mocks.chapter.updateMany).not.toHaveBeenCalled();
    });
  });

  it("stands the delivery down when ownership went during the repair call", async () => {
    // The first of the fence's two asks, and it stages nothing: the repair is a
    // model call, and a delivery that lost the book across it must not spend the
    // rest of the page's rewrite budget on a manuscript somebody else owns.
    const assertOwnership = vi.fn().mockRejectedValue(new Error("lost its durable lease"));

    await expect(repairPageBriefForRecovery(callOptions({ assertOwnership }))).rejects.toThrow(
      "lost its durable lease"
    );

    expect(strategy.repairPageBrief).toHaveBeenCalledTimes(1);
    expect(mocks.chapter.updateMany).not.toHaveBeenCalled();
  });
});

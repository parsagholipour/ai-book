import { describe, expect, it, vi } from "vitest";
import type { ChapterBrief, PageProductionBeat, PageQualityReport } from "@book-maker/core";

/**
 * The page review loop's pure decisions: which draft is kept, what a rewrite is
 * told, and when a brief is blamed. Two modules' worth — the keeper comparison
 * is `pageReview.ts`'s and the recovery half is `pageReviewRecovery.ts`'s —
 * because what they have in common is that they read nothing and write nothing,
 * so they need only the two mocks that make either module importable at all:
 * `runtime/dispatch.js` opens a Redis connection at import time, and the db
 * client wants a database. The loop itself, the page save and the style audit
 * live in `pageReview.test.ts`, and everything the recovery module *does*
 * (the brief repair's model call and its durable write) in
 * `pageReviewRecovery.test.ts`, which own the wiring they need.
 */

vi.mock("@book-maker/db", async () => ({
  prisma: {},
  Prisma: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../runtime/dispatch.js", () => ({ enqueueWorkerJob: vi.fn() }));

import { bestDraftCandidate } from "./pageReview.js";
import {
  pageRevisionMessage,
  pageRewriteReport,
  replacePageBriefInChapterBrief,
  shouldRepairPageBriefForRecovery
} from "./pageReviewRecovery.js";
import { PAGE_QA_RECOVERY_CANDIDATE } from "./tuning.js";

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

describe("bestDraftCandidate", () => {
  it("keeps the higher-scoring draft and keeps the incumbent on a tie", () => {
    const first = { draft: draftNamed("First"), revision: 1, report: report(60) };
    const second = { draft: draftNamed("Second"), revision: 2, report: report(70) };
    const tie = { draft: draftNamed("Tie"), revision: 3, report: report(70) };

    expect(bestDraftCandidate(first, second)).toBe(second);
    expect(bestDraftCandidate(second, first)).toBe(second);
    expect(bestDraftCandidate(second, tie)).toBe(second);
  });
});

describe("pageRevisionMessage", () => {
  it("announces plain revising before the recovery candidate and recovery after", () => {
    // The index is spelled out at every call, here included: these three take
    // it as a required parameter precisely so no caller can fall back to the
    // raw constant, which is right only for the tiers whose budget reaches it.
    const recovery = PAGE_QA_RECOVERY_CANDIDATE;

    expect(pageRevisionMessage(3, recovery - 1, 6, recovery)).toBe("Revising page 3 (rewrite 2/6)");
    expect(pageRevisionMessage(3, recovery, 6, recovery)).toBe(
      `Quality recovery rewrite page 3 (rewrite ${recovery - 1}/6)`
    );
  });
});

describe("pageRewriteReport", () => {
  it("passes the report through untouched below the recovery candidate", () => {
    const original = report(40);
    expect(pageRewriteReport(original, PAGE_QA_RECOVERY_CANDIDATE - 1, PAGE_QA_RECOVERY_CANDIDATE)).toBe(original);
  });

  it("escalates to a structural-replacement briefing at the recovery candidate", () => {
    const original = report(40, { issues: ["Too repetitive"], requiredRevisions: ["Vary it"], notes: "Meh." });
    const escalated = pageRewriteReport(original, PAGE_QA_RECOVERY_CANDIDATE, PAGE_QA_RECOVERY_CANDIDATE);

    expect(escalated).not.toBe(original);
    expect(escalated.issues).toContain("Too repetitive");
    expect(escalated.issues).toContain("Earlier generated replacements for this page were still rejected by QA.");
    expect(escalated.requiredRevisions.length).toBeGreaterThan(original.requiredRevisions.length);
    expect(escalated.notes).toContain("Quality recovery mode");
  });

  it("honors a caller-supplied recovery threshold", () => {
    // The final-QA loop counts attempts from the first rewrite, one later than
    // the page loops count candidates, so it passes the threshold minus one to
    // enter recovery at the same third rewrite.
    const original = report(40);
    expect(pageRewriteReport(original, PAGE_QA_RECOVERY_CANDIDATE - 1, PAGE_QA_RECOVERY_CANDIDATE - 1)).not.toBe(original);
    expect(pageRewriteReport(original, PAGE_QA_RECOVERY_CANDIDATE - 2, PAGE_QA_RECOVERY_CANDIDATE - 1)).toBe(original);
  });
});

describe("shouldRepairPageBriefForRecovery", () => {
  const brief = { pageIndex: 3, goal: "Introduce the robin" } as unknown as PageProductionBeat;

  it("requires a brief and the recovery candidate", () => {
    expect(
      shouldRepairPageBriefForRecovery(PAGE_QA_RECOVERY_CANDIDATE, report(40), undefined, PAGE_QA_RECOVERY_CANDIDATE)
    ).toBe(false);
    expect(
      shouldRepairPageBriefForRecovery(PAGE_QA_RECOVERY_CANDIDATE - 1, report(40), brief, PAGE_QA_RECOVERY_CANDIDATE)
    ).toBe(false);
  });

  it("repairs on failed repetition or progression checks", () => {
    expect(
      shouldRepairPageBriefForRecovery(
        PAGE_QA_RECOVERY_CANDIDATE,
        report(40, { checks: { repetitionOk: false, progressionOk: true } } as never),
        brief,
        PAGE_QA_RECOVERY_CANDIDATE
      )
    ).toBe(true);
    expect(
      shouldRepairPageBriefForRecovery(
        PAGE_QA_RECOVERY_CANDIDATE,
        report(40, { checks: { repetitionOk: true, progressionOk: false } } as never),
        brief,
        PAGE_QA_RECOVERY_CANDIDATE
      )
    ).toBe(true);
  });

  it("repairs when the feedback text blames the brief, and not otherwise", () => {
    expect(
      shouldRepairPageBriefForRecovery(
        PAGE_QA_RECOVERY_CANDIDATE,
        report(40, { issues: ["This page repeats the same argument as page 2."] }),
        brief,
        PAGE_QA_RECOVERY_CANDIDATE
      )
    ).toBe(true);
    expect(
      shouldRepairPageBriefForRecovery(
        PAGE_QA_RECOVERY_CANDIDATE,
        report(40, { issues: ["Weak verbs."] }),
        brief,
        PAGE_QA_RECOVERY_CANDIDATE
      )
    ).toBe(false);
  });
});

describe("replacePageBriefInChapterBrief", () => {
  const baseBrief = (): ChapterBrief =>
    ({
      chapterIndex: 1,
      pages: [
        { pageIndex: 1, requiredContinuity: [] },
        { pageIndex: 2, requiredContinuity: [] }
      ],
      continuityFocus: ["the robin's name"]
    }) as unknown as ChapterBrief;

  it("returns undefined without a chapter brief", () => {
    expect(replacePageBriefInChapterBrief(undefined, { pageIndex: 1 } as never)).toBeUndefined();
  });

  it("replaces a matching page brief and merges continuity focus, without touching the original", () => {
    const chapterBrief = baseBrief();
    const repaired = { pageIndex: 2, requiredContinuity: ["the storm", "the robin's name"] } as unknown as PageProductionBeat;

    const updated = replacePageBriefInChapterBrief(chapterBrief, repaired);

    expect(updated?.pages.map((page) => page.pageIndex)).toEqual([1, 2]);
    expect(updated?.pages[1]).toBe(repaired);
    expect(updated?.continuityFocus).toEqual(["the robin's name", "the storm"]);
    // It used to `Object.assign` the merge back onto its argument as well,
    // which is what let a book pass's per-chapter setup and a compile pass's
    // per-chapter parse take a repair no page had earned yet — a rejected
    // rewrite's beat briefing every later page of the chapter. Its callers take
    // the new brief and leave the old one standing now: the repair hands it
    // back, and the loop passes it on only once the page keeps the draft.
    expect(chapterBrief.pages[1]).not.toBe(repaired);
    expect(chapterBrief.continuityFocus).toEqual(["the robin's name"]);
  });

  it("inserts an unknown page brief in index order", () => {
    const chapterBrief = baseBrief();
    const inserted = { pageIndex: 0, requiredContinuity: [] } as unknown as PageProductionBeat;

    const updated = replacePageBriefInChapterBrief(chapterBrief, inserted);

    expect(updated?.pages.map((page) => page.pageIndex)).toEqual([0, 1, 2]);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { PageQualityReport } from "@book-maker/core";

/**
 * The page review loop's one pure decision: which draft is kept. It reads
 * nothing and writes nothing, so it needs only the two mocks that make the
 * module importable at all: `runtime/dispatch.js` opens a Redis connection at
 * import time, and the db client wants a database. The loop itself, the page
 * save and the style audit live in `pageReview.test.ts`. (The recovery half —
 * the rewrite escalation and the brief repair — went with the per-page review
 * chain on 2026-10-16.)
 */

vi.mock("@book-maker/db", async () => ({
  prisma: {},
  Prisma: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../runtime/dispatch.js", () => ({ enqueueWorkerJob: vi.fn() }));

import { bestDraftCandidate } from "./pageReview.js";

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

it("never ranks an unscored screened failure using its compatibility score", () => {
  const screened = { draft: draftNamed("Screened"), revision: 1, report: report(75, { scoreBasis: "screened_unscored", issues: ["Style audit rejected this candidate"], requiredRevisions: ["Repair drift"] }) };
  const scored = { draft: draftNamed("Scored"), revision: 2, report: report(99) };
  expect(bestDraftCandidate(screened, scored)).toBe(screened);
  expect(bestDraftCandidate(scored, screened)).toBe(scored);
  const repaired = { ...scored, report: report(80, { approved: true }) };
  expect(bestDraftCandidate(screened, repaired)).toBe(repaired);
  expect(screened.report.requiredRevisions).toEqual(["Repair drift"]);
});

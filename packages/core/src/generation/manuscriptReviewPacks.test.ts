import { describe, expect, it } from "vitest";
import { manuscriptFinding, type ManuscriptQualityIssue } from "./manuscriptQualityIssue.js";
import {
  DEFAULT_MANUSCRIPT_REVIEW_PACK_LIMITS,
  MANUSCRIPT_REVIEW_MAX_CALLS,
  MANUSCRIPT_REVIEW_MAX_OUTPUT_TOKENS,
  MANUSCRIPT_REVIEW_PACK_MAX_PAGES,
  MANUSCRIPT_REVIEW_PACK_MAX_PROSE_CHARS,
  MANUSCRIPT_REVIEW_PACKS_PER_CALL,
  MANUSCRIPT_REVIEW_TEMPERATURE,
  buildManuscriptReviewPacks,
  groupPacksForCalls,
  selectManuscriptReviewPacks,
  type ReviewablePage
} from "./manuscriptReviewPacks.js";

function page(index: number, markdown: string, extras: Partial<ReviewablePage> = {}): ReviewablePage {
  return {
    index,
    chapterIndex: 1,
    title: `Page ${index}`,
    markdown,
    summary: `Planning summary for page ${index}, not the prose.`,
    ...extras
  };
}

function candidate(
  pages: number[],
  extras: Partial<ManuscriptQualityIssue> = {}
): ManuscriptQualityIssue {
  return manuscriptFinding({
    code: "SAME_CHAPTER_TREATMENT_REPETITION",
    severity: "warning",
    message: `Pages ${pages.join(", ")} repeat a treatment.`,
    guidance: "Review the cluster.",
    affectedPageIndexes: pages,
    metrics: { occurrences: pages.length, clusterCount: 1, wouldBlock: false },
    evidence: pages.map((pageIndex) => ({
      pageIndex,
      excerpt: `Detector excerpt from page ${pageIndex}.`
    })),
    ...extras
  });
}

const CLUSTER_PROSE = [
  "Cubical chert weights recovered at Harappa follow a repeated ratio across the citadel workshop.",
  "Those standardized stones therefore show administrative control of Indus trade at the granary.",
  "The 13.63 gram unit recurs among the cubical chert stones kept beside matching balance pans."
];

describe("buildManuscriptReviewPacks", () => {
  it("turns a three-page cluster into one pack of actual prose", () => {
    const pages = [1, 2, 3, 4, 5].map((index) =>
      page(index, CLUSTER_PROSE[(index - 1) % CLUSTER_PROSE.length] ?? `Distinct page ${index}.`)
    );
    const packs = buildManuscriptReviewPacks(pages, [candidate([2, 3, 4])]);

    expect(packs).toHaveLength(1);
    expect(packs[0]?.pageIndexes).toEqual([2, 3, 4]);
    expect(packs[0]?.pages).toHaveLength(3);
    expect(packs[0]?.pages.every((entry) => entry.contentKind === "prose")).toBe(true);
    expect(packs[0]?.pages.map((entry) => entry.prose)).toEqual([
      pages[1]?.markdown,
      pages[2]?.markdown,
      pages[3]?.markdown
    ]);
    expect(packs[0]?.findingCodes).toEqual(["SAME_CHAPTER_TREATMENT_REPETITION"]);
    expect(packs[0]?.question).toMatch(/canonical/i);
  });

  it("merges overlapping pair findings into one pack", () => {
    const pages = [1, 2, 3, 4].map((index) => page(index, `Page ${index} ${CLUSTER_PROSE[0]}`));
    const packs = buildManuscriptReviewPacks(pages, [candidate([1, 2]), candidate([2, 3])]);

    expect(packs).toHaveLength(1);
    expect(packs[0]?.pageIndexes).toEqual([1, 2, 3]);
    expect(packs[0]?.pages.map((entry) => entry.pageIndex)).toEqual([1, 2, 3]);
  });

  it("labels neighboring summaries so they cannot be mistaken for prose", () => {
    const pages = [1, 2, 3, 4, 5].map((index) =>
      page(index, `Actual manuscript prose for page ${index} about the citadel workshop.`)
    );
    const packs = buildManuscriptReviewPacks(pages, [candidate([2, 3, 4])]);

    expect(packs[0]?.neighbors.map((entry) => entry.contentKind)).toEqual(["summary", "summary"]);
    expect(packs[0]?.neighbors.map((entry) => entry.pageIndex)).toEqual([1, 5]);
    expect(packs[0]?.neighbors.every((entry) => entry.summary.includes("Planning summary"))).toBe(true);
    expect(packs[0]?.neighbors.some((entry) => "prose" in entry)).toBe(false);
    expect(packs[0]?.detectorEvidence.every((entry) => entry.contentKind === "detector_evidence")).toBe(true);
  });

  it("produces no pack for clean findings", () => {
    const pages = [1, 2].map((index) => page(index, `A distinct useful page ${index}.`));
    expect(
      buildManuscriptReviewPacks(pages, [
        manuscriptFinding({
          code: "UNPAID_PROMISE",
          severity: "warning",
          message: "A promise is unpaid.",
          guidance: "Pay it off.",
          affectedPageIndexes: [1]
        })
      ])
    ).toEqual([]);
    expect(selectManuscriptReviewPacks(pages, []).packs).toEqual([]);
  });

  it("caps packs and calls deterministically and reports the leftover as unadjudicated", () => {
    const pages = Array.from({ length: 16 }, (_, offset) =>
      page(offset + 1, `Unique workshop page ${offset + 1} with its own evidence.`)
    );
    const findings = Array.from({ length: 7 }, (_, offset) => {
      const start = offset * 2 + 1;
      return candidate([start, start + 1], {
        metrics: { occurrences: 2, clusterCount: 1, wouldBlock: offset === 6 }
      });
    });

    const selection = selectManuscriptReviewPacks(pages, findings);
    expect(MANUSCRIPT_REVIEW_PACKS_PER_CALL * MANUSCRIPT_REVIEW_MAX_CALLS).toBe(6);
    expect(MANUSCRIPT_REVIEW_MAX_OUTPUT_TOKENS).toBe(1800);
    expect(MANUSCRIPT_REVIEW_TEMPERATURE).toBe(0);
    expect(selection.packs).toHaveLength(6);
    expect(selection.packs[0]?.wouldBlock).toBe(true);
    expect(selection.packs[0]?.pageIndexes).toEqual([13, 14]);
    expect(selection.unadjudicatedFindings).toHaveLength(1);
    expect(selection.unadjudicatedFindings[0]?.affectedPageIndexes).toEqual([11, 12]);

    const groups = groupPacksForCalls(selection.packs);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.length)).toEqual([3, 3]);
    expect(selection.packs.every((pack) => pack.pageIndexes.length <= MANUSCRIPT_REVIEW_PACK_MAX_PAGES)).toBe(
      true
    );
  });

  it("bounds long page prose and keeps the truncated page labeled as prose", () => {
    const long = `${"Cubical chert weights fill this page. ".repeat(200)}End of the workshop record.`;
    expect(long.length).toBeGreaterThan(MANUSCRIPT_REVIEW_PACK_MAX_PROSE_CHARS);
    const packs = buildManuscriptReviewPacks(
      [page(1, long), page(2, `${long} Second copy.`)],
      [candidate([1, 2])],
      DEFAULT_MANUSCRIPT_REVIEW_PACK_LIMITS
    );
    expect(packs[0]?.pages[0]).toMatchObject({ contentKind: "prose", truncated: true });
    expect(packs[0]?.pages[0]?.prose.includes("\n…\n")).toBe(true);
    expect(packs[0]?.pages[0]?.prose.length).toBeLessThanOrEqual(MANUSCRIPT_REVIEW_PACK_MAX_PROSE_CHARS);
  });
});

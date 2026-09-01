import { describe, expect, it } from "vitest";
import { manuscriptFinding, type ManuscriptQualityIssue } from "./manuscriptQualityIssue.js";
import type { ManuscriptReviewPack } from "./manuscriptReviewPacks.js";
import {
  CORROBORATED_STRUCTURAL_DUPLICATION,
  corroborateStructuralReview,
  structuralClusterFromIssue,
  StructuralReviewValidationError,
  tryValidateStructuralReviewResult,
  unresolvedStructuralClusters,
  validateStructuralReviewResult,
  type StructuralReviewCluster
} from "./manuscriptStructuralReview.js";

function reviewPack(
  pageIndexes: number[],
  findingCodes: string[],
  wouldBlock: boolean
): ManuscriptReviewPack {
  return {
    id: `structural:${findingCodes.join("+")}:${pageIndexes.join("-")}`,
    findingCodes,
    metrics: { occurrences: pageIndexes.length, clusterCount: 1, wouldBlock },
    pageIndexes,
    pages: pageIndexes.map((pageIndex) => ({
      contentKind: "prose",
      pageIndex,
      title: `Page ${pageIndex}`,
      prose: `Treatment on page ${pageIndex}.`,
      truncated: false
    })),
    neighbors: [],
    detectorEvidence: [],
    question: "Do these pages repeat the same treatment?",
    wouldBlock
  };
}

const pack = reviewPack([1, 2, 3], ["RECAP_BACKTRACKING"], true);
const otherPack = reviewPack([10, 11], ["CROSS_CHAPTER_CONCEPT_REPETITION"], false);

const candidate: ManuscriptQualityIssue = manuscriptFinding({
  code: "RECAP_BACKTRACKING",
  severity: "warning",
  message: "Pages 1-3 repeat a treatment.",
  guidance: "Review them.",
  affectedPageIndexes: [1, 2, 3],
  metrics: { occurrences: 3, clusterCount: 1, wouldBlock: true }
});

const otherCandidate: ManuscriptQualityIssue = manuscriptFinding({
  code: "CROSS_CHAPTER_CONCEPT_REPETITION",
  severity: "warning",
  message: "Pages 10-11 repeat a treatment.",
  guidance: "Review them.",
  affectedPageIndexes: [10, 11],
  metrics: { occurrences: 2, clusterCount: 1, wouldBlock: false }
});

function cluster(overrides: Partial<StructuralReviewCluster> = {}): StructuralReviewCluster {
  return {
    canonicalPageIndex: 1,
    duplicatePageIndexes: [2, 3],
    repeatedSubject: "Cubical chert weights as Indus administrative control of trade",
    repeatedEvidence: "The 13.63 gram unit and matching balance pans are reused without new finds",
    repeatedConclusion: "Each page closes on the same claim that officials constrained exchange",
    confidence: "high",
    recommendedAction: "review",
    ...overrides
  };
}

describe("validateStructuralReviewResult", () => {
  it("rejects returned indexes that are outside the pack", () => {
    const data = { clusters: [cluster({ canonicalPageIndex: 99, duplicatePageIndexes: [2] })] };
    expect(() => validateStructuralReviewResult(data, [pack])).toThrow(StructuralReviewValidationError);
    expect(tryValidateStructuralReviewResult(data, [pack])).toBeNull();
  });

  it("rejects a cluster that mixes page indexes from two packs in one call", () => {
    const mixed = cluster({ canonicalPageIndex: 1, duplicatePageIndexes: [10] });
    const data = { clusters: [mixed] };
    const packs = [pack, otherPack];
    expect(() => validateStructuralReviewResult(data, packs)).toThrow(StructuralReviewValidationError);
    expect(tryValidateStructuralReviewResult(data, packs)).toBeNull();
    expect(
      corroborateStructuralReview({
        result: { clusters: [mixed] },
        packs,
        candidateFindings: [candidate, otherCandidate]
      })
    ).toEqual([]);
  });

  it("rejects a canonical page that is also listed as a duplicate", () => {
    expect(
      tryValidateStructuralReviewResult(
        { clusters: [cluster({ canonicalPageIndex: 1, duplicatePageIndexes: [1, 2] })] },
        [pack]
      )
    ).toBeNull();
  });

  it("accepts an empty cluster list when the candidate is a legitimate recurring subject", () => {
    expect(validateStructuralReviewResult({ clusters: [] }, [pack])).toEqual({ clusters: [] });
    expect(validateStructuralReviewResult({}, [pack])).toEqual({ clusters: [] });
  });
});

describe("corroborateStructuralReview", () => {
  it("turns a high-confidence subject/evidence/conclusion duplicate into a blocking issue", () => {
    const issues = corroborateStructuralReview({
      result: { clusters: [cluster()] },
      packs: [pack],
      candidateFindings: [candidate]
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: CORROBORATED_STRUCTURAL_DUPLICATION,
      severity: "error",
      source: "model",
      affectedPageIndexes: [1, 2, 3]
    });
    expect(issues[0]?.metrics?.wouldBlock).toBe(true);
    expect(issues[0]?.metrics?.occurrences).toBe(3);
  });

  it("still blocks a high-confidence cluster contained in one pack of a multi-pack call", () => {
    const issues = corroborateStructuralReview({
      result: { clusters: [cluster()] },
      packs: [pack, otherPack],
      candidateFindings: [candidate, otherCandidate]
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: CORROBORATED_STRUCTURAL_DUPLICATION,
      severity: "error",
      source: "model",
      affectedPageIndexes: [1, 2, 3]
    });
  });

  it("keeps medium confidence advisory", () => {
    const issues = corroborateStructuralReview({
      result: { clusters: [cluster({ confidence: "medium" })] },
      packs: [pack],
      candidateFindings: [candidate]
    });
    expect(issues[0]).toMatchObject({
      code: CORROBORATED_STRUCTURAL_DUPLICATION,
      severity: "warning",
      source: "model"
    });
  });

  it("leaves low confidence diagnostic-only and emits no issue", () => {
    expect(
      corroborateStructuralReview({
        result: { clusters: [cluster({ confidence: "low" })] },
        packs: [pack],
        candidateFindings: [candidate]
      })
    ).toEqual([]);
  });

  it("clears a legitimate recurring topic without adding a corroborated issue", () => {
    expect(
      corroborateStructuralReview({
        result: { clusters: [cluster({ recommendedAction: "keep" })] },
        packs: [pack],
        candidateFindings: [candidate]
      })
    ).toEqual([]);
    expect(
      corroborateStructuralReview({
        result: { clusters: [] },
        packs: [pack],
        candidateFindings: [candidate]
      })
    ).toEqual([]);
  });

  it("rejects empty or generic overlap explanations", () => {
    expect(
      corroborateStructuralReview({
        result: {
          clusters: [
            cluster({
              repeatedSubject: "same",
              repeatedEvidence: "overlap",
              repeatedConclusion: "identical"
            })
          ]
        },
        packs: [pack],
        candidateFindings: [candidate]
      })
    ).toEqual([]);
  });

  it("does not corroborate a cluster that does not reference a deterministic candidate", () => {
    expect(
      corroborateStructuralReview({
        result: { clusters: [cluster()] },
        packs: [pack],
        candidateFindings: []
      })
    ).toEqual([]);
  });

  it("names canonical and duplicate pages on the corroborated issue", () => {
    const issues = corroborateStructuralReview({
      result: { clusters: [cluster()] },
      packs: [pack],
      candidateFindings: [candidate]
    });
    expect(issues[0]?.cluster).toEqual({ canonicalPageIndex: 1, duplicatePageIndexes: [2, 3] });
    expect(unresolvedStructuralClusters(issues)).toEqual([
      {
        code: CORROBORATED_STRUCTURAL_DUPLICATION,
        severity: "error",
        canonicalPageIndex: 1,
        duplicatePageIndexes: [2, 3]
      }
    ]);
  });
});

describe("structuralClusterFromIssue", () => {
  it("recovers canonical vs duplicates from a stored Phase 04 issue that only has evidence", () => {
    const issue = manuscriptFinding({
      code: CORROBORATED_STRUCTURAL_DUPLICATION,
      severity: "error",
      source: "model",
      message: "Page 1 is the strongest treatment; pages 2, 3 repeat its subject.",
      guidance: "Review the canonical page and the duplicates in Edit Mode.",
      affectedPageIndexes: [1, 2, 3],
      evidence: [
        { pageIndex: 1, excerpt: "Cubical chert weights" },
        { pageIndex: 2, excerpt: "The 13.63 gram unit" }
      ]
    });
    expect(structuralClusterFromIssue(issue)).toEqual({
      canonicalPageIndex: 1,
      duplicatePageIndexes: [2, 3]
    });
  });
});

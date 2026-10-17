import { describe, expect, it } from "vitest";
import { manuscriptFinding } from "./manuscriptQualityIssue.js";
import {
  CORROBORATED_STRUCTURAL_DUPLICATION,
  structuralClusterFromIssue
} from "./manuscriptStructuralReview.js";

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

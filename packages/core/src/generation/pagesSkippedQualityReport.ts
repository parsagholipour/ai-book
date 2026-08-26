import type { PageQualityReport } from "../schemas/book.js";

/** A fresh approved placeholder for a page whose configured review passes were skipped. */
export function skippedPageQualityReport(): PageQualityReport {
  return {
    approved: true,
    score: 100,
    issues: [],
    requiredRevisions: [],
    notes: "Page quality checks skipped.",
    groundedOk: true,
    unsupportedClaims: [],
    checks: {
      placeholderFree: true,
      promptLeakFree: true,
      titleClean: true,
      repetitionOk: true,
      progressionOk: true,
      styleNatural: true
    }
  };
}

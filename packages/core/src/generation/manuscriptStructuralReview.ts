import {
  parseManuscriptQualityIssueCluster,
  type ManuscriptQualityIssue,
  type ManuscriptQualityIssueCluster
} from "./manuscriptQualityIssue.js";

/**
 * What survives of the compile's structural adjudicator (`review-manuscript-structure`), removed on 2026-10-16:
 * its findings were console diagnostics no repair read, and the defect screen reads the book for duplication.
 * Stored reports still carry `CORROBORATED_STRUCTURAL_DUPLICATION` findings, which the API's quality card reads.
 */
export const CORROBORATED_STRUCTURAL_DUPLICATION = "CORROBORATED_STRUCTURAL_DUPLICATION";

/**
 * Canonical vs duplicate pages for an unresolved cluster. Prefers the
 * structured field written at corroboration; recovers the same split from
 * stored Phase 04 reports that only named the canonical page in evidence[0].
 */
export function structuralClusterFromIssue(
  issue: Pick<ManuscriptQualityIssue, "code" | "affectedPageIndexes" | "cluster" | "evidence">
): ManuscriptQualityIssueCluster | undefined {
  if (issue.cluster) {
    return parseManuscriptQualityIssueCluster(issue.cluster);
  }
  if (issue.code !== CORROBORATED_STRUCTURAL_DUPLICATION) {
    return undefined;
  }
  const canonicalPageIndex = issue.evidence?.[0]?.pageIndex;
  if (canonicalPageIndex === undefined || !Number.isInteger(canonicalPageIndex) || canonicalPageIndex <= 0) {
    return undefined;
  }
  const duplicatePageIndexes = [
    ...new Set(issue.affectedPageIndexes.filter((index) => index !== canonicalPageIndex))
  ].sort((left, right) => left - right);
  if (duplicatePageIndexes.length < 1) {
    return undefined;
  }
  return { canonicalPageIndex, duplicatePageIndexes };
}

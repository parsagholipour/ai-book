import {
  MANUSCRIPT_STRUCTURAL_AUDIT_DETECTOR_VERSION,
  type ManuscriptQualityDiagnostics,
  type ManuscriptQualityFindingDiagnostic,
  type ManuscriptQualityIssue,
  type ManuscriptQualityIssueMetrics
} from "./manuscriptQualityIssue.js";

/** Pages in one duplicate-treatment or recap cluster that make a blocking candidate. */
export const DUPLICATE_CLUSTER_BLOCKING_MIN_PAGES = 3;
/** Share of manuscript pages one structural family must cover to be a blocking candidate. */
export const STRUCTURAL_FAMILY_PAGE_RATIO_BLOCKING = 0.2;
/** Sentence-opening family count that can become a warning candidate. */
export const SENTENCE_OPENING_WARNING_MIN_OCCURRENCES = 12;
/** Sentence-opening families must also exceed this multiple of the clean-corpus baseline. */
export const SENTENCE_OPENING_WARNING_BASELINE_MULTIPLIER = 4;
/**
 * Typical clean-book count for one listed English opening family. Four times
 * this value is 12, so the two warning gates meet on the same number.
 */
export const SENTENCE_OPENING_CLEAN_CORPUS_BASELINE = 3;
/** Occurrence floor for the span-and-count blocking candidate. */
export const STRUCTURAL_OCCURRENCE_SPAN_BLOCKING_MIN_OCCURRENCES = 25;
/** Chapter-span floor that accompanies the occurrence blocking candidate. */
export const STRUCTURAL_OCCURRENCE_SPAN_BLOCKING_MIN_CHAPTERS = 5;

/**
 * Families that already feed `STRUCTURAL_SLOP_SATURATION` publication. New
 * Phase 03 detectors are evaluated for shadow `would_block` but do not enlarge
 * this set, so COMPLETE vs REVIEW_REQUIRED stays on the three-family rule.
 */
export const PUBLICATION_CORROBORATION_CODES = [
  "REPEATED_ANALYTICAL_GRID",
  "FRAMEWORK_SATURATION",
  "SYMMETRICAL_HEDGING",
  "GENERIC_HISTORICAL_PLACEHOLDERS",
  "RESEARCH_META_FRAMING",
  "CROSS_CHAPTER_CONCEPT_REPETITION"
] as const;

const PUBLICATION_CORROBORATION_CODE_SET = new Set<string>(PUBLICATION_CORROBORATION_CODES);

/**
 * Spec blocking candidate: a recap cluster of ≥3 pages. Original corroboration
 * families use page-share and occurrence-span instead.
 * `SAME_CHAPTER_TREATMENT_REPETITION` sat beside it until 2026-09-02; the
 * detector behind it was removed (see `manuscriptRecapAudit.ts`).
 */
const DUPLICATE_CLUSTER_CODES = new Set<string>(["RECAP_BACKTRACKING"]);

const SATURATION_FAMILY_CODES = new Set<string>([
  ...PUBLICATION_CORROBORATION_CODES,
  ...DUPLICATE_CLUSTER_CODES
]);

const CADENCE_CODES = new Set<string>(["SENTENCE_OPENING_CADENCE"]);

export type ManuscriptBlockingPolicy = {
  wouldBlock: boolean;
  corroboration: boolean;
  reasons: string[];
  findingWouldBlock: Map<string, boolean>;
};

function issueKey(issue: ManuscriptQualityIssue): string {
  return `${issue.code}:${issue.affectedPageIndexes.join(",")}`;
}

function pageRatio(issue: ManuscriptQualityIssue, pageCount: number): number {
  return issue.metrics?.affectedPageRatio ?? (pageCount <= 0 ? 0 : issue.affectedPageIndexes.length / pageCount);
}

function occurrencesOf(issue: ManuscriptQualityIssue): number {
  return issue.metrics?.occurrences ?? issue.affectedPageIndexes.length;
}

function chaptersSpanned(issue: ManuscriptQualityIssue): number {
  return issue.metrics?.chaptersSpanned ?? 0;
}

function clusterPages(issue: ManuscriptQualityIssue): number {
  return issue.affectedPageIndexes.length;
}

export function evaluateManuscriptBlockingPolicy(
  issues: readonly ManuscriptQualityIssue[],
  pageCount: number
): ManuscriptBlockingPolicy {
  const corroborationCodes = new Set(
    issues.filter((issue) => PUBLICATION_CORROBORATION_CODE_SET.has(issue.code)).map((issue) => issue.code)
  );
  const corroboration = corroborationCodes.size >= 3;
  const findingWouldBlock = new Map<string, boolean>();
  const reasons: string[] = [];
  if (corroboration) {
    reasons.push("corroboration");
  }

  for (const issue of issues) {
    const key = issueKey(issue);
    const ratio = pageRatio(issue, pageCount);
    const occurrences = occurrencesOf(issue);
    const chapters = chaptersSpanned(issue);
    const saturatedCluster =
      DUPLICATE_CLUSTER_CODES.has(issue.code) &&
      clusterPages(issue) >= DUPLICATE_CLUSTER_BLOCKING_MIN_PAGES;
    const saturatedShare =
      SATURATION_FAMILY_CODES.has(issue.code) && ratio >= STRUCTURAL_FAMILY_PAGE_RATIO_BLOCKING;
    const saturatedSpan =
      SATURATION_FAMILY_CODES.has(issue.code) &&
      occurrences >= STRUCTURAL_OCCURRENCE_SPAN_BLOCKING_MIN_OCCURRENCES &&
      chapters >= STRUCTURAL_OCCURRENCE_SPAN_BLOCKING_MIN_CHAPTERS;
    const cadenceWarning =
      CADENCE_CODES.has(issue.code) &&
      occurrences >= SENTENCE_OPENING_WARNING_MIN_OCCURRENCES &&
      occurrences >= SENTENCE_OPENING_CLEAN_CORPUS_BASELINE * SENTENCE_OPENING_WARNING_BASELINE_MULTIPLIER;
    const blocks =
      issue.code === "STRUCTURAL_SLOP_SATURATION" ||
      saturatedCluster ||
      saturatedShare ||
      saturatedSpan ||
      (corroboration && PUBLICATION_CORROBORATION_CODE_SET.has(issue.code));
    findingWouldBlock.set(key, blocks);
    if (saturatedCluster) {
      reasons.push("cluster");
    }
    if (saturatedShare) {
      reasons.push("page-ratio");
    }
    if (saturatedSpan) {
      reasons.push("occurrence-span");
    }
    if (cadenceWarning) {
      reasons.push("cadence-warning");
    }
  }

  const wouldBlock = corroboration || [...findingWouldBlock.values()].some(Boolean);
  return {
    wouldBlock,
    corroboration,
    reasons: [...new Set(reasons)],
    findingWouldBlock
  };
}

export function stampShadowWouldBlock(
  issues: readonly ManuscriptQualityIssue[],
  pageCount: number
): ManuscriptQualityIssue[] {
  const policy = evaluateManuscriptBlockingPolicy(issues, pageCount);
  return issues.map((issue) => {
    const wouldBlock = policy.findingWouldBlock.get(issueKey(issue)) ?? false;
    if (!issue.metrics && !wouldBlock) {
      return issue;
    }
    const metrics: ManuscriptQualityIssueMetrics = {
      ...issue.metrics,
      wouldBlock
    };
    return { ...issue, metrics };
  });
}

export function manuscriptQualityDiagnostics(
  issues: readonly ManuscriptQualityIssue[],
  pageCount: number
): ManuscriptQualityDiagnostics {
  const policy = evaluateManuscriptBlockingPolicy(issues, pageCount);
  const findings: ManuscriptQualityFindingDiagnostic[] = issues.map((issue) => {
    const diagnostic: ManuscriptQualityFindingDiagnostic = {
      code: issue.code,
      detectorVersion: MANUSCRIPT_STRUCTURAL_AUDIT_DETECTOR_VERSION,
      severity: issue.severity,
      affectedPageCount: issue.affectedPageIndexes.length,
      occurrences: occurrencesOf(issue),
      affectedPageRatio: pageRatio(issue, pageCount),
      wouldBlock: policy.findingWouldBlock.get(issueKey(issue)) ?? false
    };
    return {
      ...diagnostic,
      ...(issue.metrics?.clusterCount !== undefined ? { clusterCount: issue.metrics.clusterCount } : {}),
      ...(issue.metrics?.chaptersSpanned !== undefined ? { chaptersSpanned: issue.metrics.chaptersSpanned } : {})
    };
  });
  return {
    detectorVersion: MANUSCRIPT_STRUCTURAL_AUDIT_DETECTOR_VERSION,
    wouldBlock: policy.wouldBlock,
    findings
  };
}

export function publicationCorroborationError(
  warnings: readonly ManuscriptQualityIssue[]
): ManuscriptQualityIssue[] {
  const codes = new Set(
    warnings.filter((issue) => PUBLICATION_CORROBORATION_CODE_SET.has(issue.code)).map((issue) => issue.code)
  );
  if (codes.size < 3) {
    return [];
  }
  const affected = [...new Set(warnings.flatMap((issue) => issue.affectedPageIndexes))].sort((a, b) => a - b);
  return [
    {
      code: "STRUCTURAL_SLOP_SATURATION",
      severity: "error",
      source: "deterministic",
      message: `${warnings.length} independent structural repetition signals recur across the manuscript.`,
      guidance:
        "Review the book's framework, examples, caveats, evidence integration, and cross-chapter progression before marking it complete.",
      affectedPageIndexes: affected,
      metrics: {
        clusterCount: codes.size,
        occurrences: warnings.length,
        wouldBlock: true
      }
    }
  ];
}

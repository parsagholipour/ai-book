import { z } from "zod";
import {
  manuscriptFinding,
  parseManuscriptQualityIssueCluster,
  type ManuscriptQualityIssue,
  type ManuscriptQualityIssueCluster
} from "./manuscriptQualityIssue.js";
import type { ManuscriptReviewPack } from "./manuscriptReviewPacks.js";

export const MANUSCRIPT_STRUCTURAL_REVIEW_PURPOSE = "review-manuscript-structure";

export const STRUCTURAL_REVIEW_CONFIDENCE = ["low", "medium", "high"] as const;
export type StructuralReviewConfidence = (typeof STRUCTURAL_REVIEW_CONFIDENCE)[number];

export const STRUCTURAL_REVIEW_ACTIONS = ["keep", "review", "consolidate"] as const;
export type StructuralReviewAction = (typeof STRUCTURAL_REVIEW_ACTIONS)[number];

export const CORROBORATED_STRUCTURAL_DUPLICATION = "CORROBORATED_STRUCTURAL_DUPLICATION";
export const STRUCTURAL_REVIEW_BUDGET_EXCEEDED = "STRUCTURAL_REVIEW_BUDGET_EXCEEDED";

const GENERIC_EXPLANATION =
  /^(n\/?a|none|unknown|overlap|same|similar|repeated|duplicate|identical|see above|as above|-|\.)\.?$/i;
const GENERIC_ROLE_EXPLANATION =
  /^(the\s+)?(same|similar|overlapping|repeated|duplicate|identical)\s+(subject|evidence|conclusion|thing|content|text|prose|treatment)\.?$/i;

export type StructuralReviewCluster = {
  canonicalPageIndex: number;
  duplicatePageIndexes: number[];
  repeatedSubject: string;
  repeatedEvidence: string;
  repeatedConclusion: string;
  confidence: StructuralReviewConfidence;
  recommendedAction: StructuralReviewAction;
};

export type StructuralReviewResult = {
  clusters: StructuralReviewCluster[];
};

export const structuralReviewResultSchema = z
  .object({
    clusters: z
      .array(
        z
          .object({
            canonicalPageIndex: z.number().int().positive(),
            duplicatePageIndexes: z.array(z.number().int().positive()).max(8),
            repeatedSubject: z.string().trim().min(1).max(500),
            repeatedEvidence: z.string().trim().min(1).max(500),
            repeatedConclusion: z.string().trim().min(1).max(500),
            confidence: z.enum(STRUCTURAL_REVIEW_CONFIDENCE),
            recommendedAction: z.enum(STRUCTURAL_REVIEW_ACTIONS)
          })
          .strict()
      )
      .max(12)
      .default([])
  })
  .strict();

export class StructuralReviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuralReviewValidationError";
  }
}

export function validateStructuralReviewResult(
  data: unknown,
  packs: readonly ManuscriptReviewPack[]
): StructuralReviewResult {
  const parsed = structuralReviewResultSchema.parse(data);
  for (const cluster of parsed.clusters) {
    if (!isValidClusterShape(cluster, packs)) {
      throw new StructuralReviewValidationError(
        "Structural review named page indexes that were not in the supplied pack."
      );
    }
  }
  return { clusters: parsed.clusters };
}

export function tryValidateStructuralReviewResult(
  data: unknown,
  packs: readonly ManuscriptReviewPack[]
): StructuralReviewResult | null {
  try {
    return validateStructuralReviewResult(data, packs);
  } catch (error) {
    if (error instanceof StructuralReviewValidationError || error instanceof z.ZodError) {
      return null;
    }
    throw error;
  }
}

function clusterPageIndexes(cluster: StructuralReviewCluster): number[] {
  return [cluster.canonicalPageIndex, ...cluster.duplicatePageIndexes];
}

function packContainingEveryClusterPage(
  cluster: StructuralReviewCluster,
  packs: readonly ManuscriptReviewPack[]
): ManuscriptReviewPack | undefined {
  const clusterPages = clusterPageIndexes(cluster);
  return packs.find((pack) => {
    const allowed = new Set(pack.pageIndexes);
    return clusterPages.every((pageIndex) => allowed.has(pageIndex));
  });
}

function isValidClusterShape(
  cluster: StructuralReviewCluster,
  packs: readonly ManuscriptReviewPack[]
): boolean {
  const duplicates = new Set(cluster.duplicatePageIndexes);
  if (duplicates.has(cluster.canonicalPageIndex)) {
    return false;
  }
  return packContainingEveryClusterPage(cluster, packs) !== undefined;
}

function isSubstantiveOverlapExplanation(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 24) {
    return false;
  }
  if (GENERIC_EXPLANATION.test(trimmed) || GENERIC_ROLE_EXPLANATION.test(trimmed)) {
    return false;
  }
  return trimmed.split(/\s+/).filter(Boolean).length >= 4;
}

function overlapExplanationCount(cluster: StructuralReviewCluster): number {
  return [
    cluster.repeatedSubject,
    cluster.repeatedEvidence,
    cluster.repeatedConclusion
  ].filter(isSubstantiveOverlapExplanation).length;
}

function pagesOverlap(left: readonly number[], right: readonly number[]): boolean {
  const set = new Set(right);
  return left.some((pageIndex) => set.has(pageIndex));
}

function candidateForCluster(
  cluster: StructuralReviewCluster,
  packs: readonly ManuscriptReviewPack[],
  candidateFindings: readonly ManuscriptQualityIssue[]
): { pack: ManuscriptReviewPack; finding: ManuscriptQualityIssue } | undefined {
  const pack = packContainingEveryClusterPage(cluster, packs);
  if (!pack) {
    return undefined;
  }
  const finding = candidateFindings.find((entry) => pagesOverlap(entry.affectedPageIndexes, pack.pageIndexes));
  if (!finding) {
    return undefined;
  }
  return { pack, finding };
}

/**
 * Convert a validated model result into manuscript issues only when it
 * references a deterministic candidate, names pack pages, and explains at
 * least two of subject / evidence / conclusion overlap.
 *
 * High confidence becomes blocking (`error`). Medium stays advisory.
 * Low confidence is diagnostic only and emits no issue. `keep` clears the
 * candidate for corroboration without dropping the original deterministic finding.
 */
export function corroborateStructuralReview(options: {
  result: StructuralReviewResult;
  packs: readonly ManuscriptReviewPack[];
  candidateFindings: readonly ManuscriptQualityIssue[];
}): ManuscriptQualityIssue[] {
  const issues: ManuscriptQualityIssue[] = [];
  for (const cluster of options.result.clusters) {
    if (cluster.recommendedAction === "keep") {
      continue;
    }
    if (cluster.duplicatePageIndexes.length < 1) {
      continue;
    }
    if (overlapExplanationCount(cluster) < 2) {
      continue;
    }
    const matched = candidateForCluster(cluster, options.packs, options.candidateFindings);
    if (!matched) {
      continue;
    }
    const severity = cluster.confidence === "high" ? "error" : cluster.confidence === "medium" ? "warning" : null;
    if (severity === null) {
      continue;
    }
    const affected = [...new Set(clusterPageIndexes(cluster))].sort(
      (left, right) => left - right
    );
    const duplicates = [...new Set(cluster.duplicatePageIndexes)].sort((left, right) => left - right);
    issues.push(
      manuscriptFinding({
        code: CORROBORATED_STRUCTURAL_DUPLICATION,
        severity,
        source: "model",
        message:
          `Page ${cluster.canonicalPageIndex} is the strongest treatment; pages ${duplicates.join(", ")} ` +
          `repeat its subject (${cluster.repeatedSubject}) and overlap evidence or conclusion.`,
        guidance:
          "Review the canonical page and the duplicates in Edit Mode. Do not automatically consolidate the prose.",
        affectedPageIndexes: affected,
        metrics: {
          ...matched.finding.metrics,
          occurrences: affected.length,
          clusterCount: matched.finding.metrics?.clusterCount ?? 1,
          wouldBlock: severity === "error" || matched.finding.metrics?.wouldBlock === true
        },
        evidence: [
          { pageIndex: cluster.canonicalPageIndex, excerpt: cluster.repeatedSubject },
          { pageIndex: duplicates[0]!, excerpt: cluster.repeatedEvidence }
        ],
        cluster: {
          canonicalPageIndex: cluster.canonicalPageIndex,
          duplicatePageIndexes: duplicates
        }
      })
    );
  }
  return issues;
}

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

export function unresolvedStructuralClusters(
  issues: readonly ManuscriptQualityIssue[]
): Array<{
  code: string;
  severity: ManuscriptQualityIssue["severity"];
  canonicalPageIndex: number;
  duplicatePageIndexes: number[];
}> {
  return issues.flatMap((issue) => {
    const cluster = structuralClusterFromIssue(issue);
    if (!cluster) {
      return [];
    }
    return [
      {
        code: issue.code,
        severity: issue.severity,
        canonicalPageIndex: cluster.canonicalPageIndex,
        duplicatePageIndexes: cluster.duplicatePageIndexes
      }
    ];
  });
}

export function structuralReviewBudgetExceededIssue(
  unadjudicated: readonly ManuscriptQualityIssue[]
): ManuscriptQualityIssue | undefined {
  if (unadjudicated.length === 0) {
    return undefined;
  }
  const affected = [...new Set(unadjudicated.flatMap((finding) => finding.affectedPageIndexes))].sort(
    (left, right) => left - right
  );
  return manuscriptFinding({
    code: STRUCTURAL_REVIEW_BUDGET_EXCEEDED,
    severity: "warning",
    message: `${unadjudicated.length} additional structural cluster${unadjudicated.length === 1 ? "" : "s"} were not sent to model review because the review budget was exhausted.`,
    guidance: "The unreviewed clusters remain recorded as deterministic warnings; this review was not exhaustive.",
    affectedPageIndexes: affected,
    metrics: {
      clusterCount: unadjudicated.length,
      occurrences: affected.length,
      wouldBlock: unadjudicated.some((finding) => finding.metrics?.wouldBlock === true)
    }
  });
}

import { z } from "zod";
import type { ManuscriptQualityIssue, PictureBookPageReview } from "@book-maker/core";
import { isInheritedRepairFinding, type PictureBookRepairContext } from "@book-maker/core";
import { incompleteRepairReview, repairReviewFindingSchema, repairReviewValidationSchema, unverifiedRepairQualityIssues } from "./compileRepairReviewFailure.js";

const rejectionClass = z.enum(["no_candidate", "local_checks", "verification_failed", "target_unresolved", "semantic_regression"]);
export class RepairRejectedError extends Error {
  constructor(readonly failureClass: z.infer<typeof rejectionClass>, readonly affectedPageIndexes: number[], reason: string) {
    super(reason); this.name = "RepairRejectedError";
  }
}

export const repairFailureSchema = z.strictObject({
  pageId: z.string(), targetPageIndex: z.number().int().positive().optional(),
  failureClass: z.union([rejectionClass, z.literal("assessment_unavailable")]),
  affectedPageIndexes: z.array(z.number().int().positive()), reason: z.string().max(4000),
  repairOperationId: z.string().min(1).max(200).optional(),
  reviewFindings: repairReviewFindingSchema.array().max(320).optional(),
  reviewValidationIssues: repairReviewValidationSchema.array().max(40).optional()
});
export type RepairFailure = z.infer<typeof repairFailureSchema>;

export function repairFailure(pageId: string, targetPageIndex: number | undefined, error: unknown, repairOperationId?: string): RepairFailure {
  const incomplete = incompleteRepairReview(error);
  return { pageId, ...(targetPageIndex === undefined ? {} : { targetPageIndex }),
    ...(repairOperationId ? { repairOperationId } : {}),
    failureClass: error instanceof RepairRejectedError ? error.failureClass : "assessment_unavailable",
    affectedPageIndexes: error instanceof RepairRejectedError ? error.affectedPageIndexes : targetPageIndex === undefined ? [] : [targetPageIndex],
    reason: (error instanceof Error ? error.message : "Automatic repair assessment was unavailable.").slice(0, 4000),
    ...incomplete };
}

/** Residual findings remain failed QA; only verified improvements may publish alongside them. */
export function hasOnlyInheritedEditorialFindings(review: PictureBookPageReview, context: PictureBookRepairContext): boolean {
  const findings = review.findings?.filter((finding) => finding.domain === "prose");
  const unverified = review.unverifiedFindings ?? [];
  const count = (findings?.length ?? 0) + unverified.length;
  if (!count) return false;
  // A second diagnostic of the very same untouched passage must not erase
  // verified edits elsewhere. Preserve both diagnostics and FAILED_QA; only
  // waive rejection when every style issue is tied to an inherited local
  // prose finding by exact evidence and category, never fuzzy message text.
  const styleIssues = new Set(review.styleAudit?.styleIssues ?? []);
  const inheritedStyle = !review.styleAudit || (styleIssues.size === 0 ? review.styleAudit.styleOk :
    [...styleIssues].every(issue => review.styleAudit!.evidence?.some(evidence => evidence.issue === issue &&
      ["voice", "scaffold", "repetition"].includes(evidence.category) && evidence.quote.trim().length >= 12 &&
      review.draftMarkdown.includes(evidence.quote) && findings?.some(finding => finding.basis === "page_prose" &&
        finding.relatedEvidence.length === 0 && finding.quote === evidence.quote &&
        finding.category === (evidence.category === "repetition" ? "repetition" : "style") &&
        isInheritedRepairFinding(finding, review.pageIndex, context)))));
  const styleRevisions = new Set([...styleIssues].map(issue => `Revise style: ${issue}`));
  return (findings ?? []).every(finding => isInheritedRepairFinding(finding, review.pageIndex, context)) &&
    unverified.every(finding => isInheritedRepairFinding(finding, review.pageIndex, context, true)) &&
    inheritedStyle && review.report.issues.filter(issue => !styleIssues.has(issue)).length === count &&
    review.report.requiredRevisions.filter(issue => !styleRevisions.has(issue)).length === count &&
    review.report.groundedOk && review.report.unsupportedClaims.length === 0 &&
    review.report.checks.placeholderFree && review.report.checks.titleClean && review.report.checks.promptLeakFree &&
    !review.storyExtract?.contradictions.length;
}

/** Preserve failure class and actual rejection pages in the final quality card. */
export function finalRepairQualityIssues(state: {
  unavailableRepairPageIds?: string[]; repairFailures?: RepairFailure[];
} | undefined, pages: readonly { id: string; index: number }[]): ManuscriptQualityIssue[] {
  const failures = state?.repairFailures ?? [];
  const grouped = new Map<string, RepairFailure>();
  for (const failure of failures) {
    const key = JSON.stringify([failure.repairOperationId, failure.failureClass, failure.reason, [...failure.affectedPageIndexes].sort((a, b) => a - b)]);
    grouped.set(key, failure);
  }
  const issues: ManuscriptQualityIssue[] = [...grouped.values()].map((failure) => ({
    code: failure.failureClass === "assessment_unavailable" ? "FINAL_QA_REPAIR_UNAVAILABLE" : "FINAL_QA_REPAIR_REJECTED",
    source: "deterministic", severity: "warning",
    message: `${failure.failureClass === "assessment_unavailable" && failure.reviewFindings?.length &&
      failure.reviewFindings.every(finding => finding.validationFailure === "repair_metadata")
      ? "Editorial concerns were found, but repair metadata could not be verified"
      : `Automatic repair ${failure.failureClass === "assessment_unavailable" ? "could not be verified" : "was rejected"}`}: ${failure.reason} Saved prose was retained.` +
      (failure.reviewValidationIssues?.length && !failure.reviewFindings?.length
        ? ` ${failure.reviewValidationIssues.map(issue => `Page ${issue.pageIndex}: ${issue.message}`).join(" ")}` : ""),
    guidance: "Review the reported findings before requesting another repair.",
    affectedPageIndexes: failure.affectedPageIndexes.length ? failure.affectedPageIndexes : pages.filter((page) => page.id === failure.pageId).map((page) => page.index),
    provenance: { kind: "repair", ...(failure.repairOperationId ? { repairOperationId: failure.repairOperationId } : {}) }
  }));
  issues.push(...unverifiedRepairQualityIssues(failures));
  const legacyIds = state?.unavailableRepairPageIds?.filter((id) => !failures.some((failure) => failure.pageId === id)) ?? [];
  if (legacyIds.length) issues.push({ code: "FINAL_QA_REPAIR_UNAVAILABLE", source: "deterministic", severity: "warning",
    message: "Automatic repair could not complete after its bounded provider attempts; the saved pages were retained.",
    guidance: "Review these pages or request another repair.", affectedPageIndexes: pages.filter((page) => legacyIds.includes(page.id)).map((page) => page.index) });
  return issues;
}

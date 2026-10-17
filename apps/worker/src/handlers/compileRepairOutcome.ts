import { z } from "zod";
import type { ManuscriptQualityIssue } from "@book-maker/core";
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

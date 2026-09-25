import { z } from "zod";
import type { ManuscriptQualityIssue, PictureBookPageReview } from "@book-maker/core";

const rejectionClass = z.enum(["no_candidate", "local_checks", "verification_failed", "target_unresolved", "semantic_regression"]);
export class RepairRejectedError extends Error {
  constructor(readonly failureClass: z.infer<typeof rejectionClass>, readonly affectedPageIndexes: number[], reason: string) {
    super(reason); this.name = "RepairRejectedError";
  }
}

export const repairFailureSchema = z.strictObject({
  pageId: z.string(), targetPageIndex: z.number().int().positive().optional(),
  failureClass: z.union([rejectionClass, z.literal("assessment_unavailable")]),
  affectedPageIndexes: z.array(z.number().int().positive()), reason: z.string().max(4000)
});
export type RepairFailure = z.infer<typeof repairFailureSchema>;

export function repairFailure(pageId: string, targetPageIndex: number | undefined, error: unknown): RepairFailure {
  return { pageId, ...(targetPageIndex === undefined ? {} : { targetPageIndex }),
    failureClass: error instanceof RepairRejectedError ? error.failureClass : "assessment_unavailable",
    affectedPageIndexes: error instanceof RepairRejectedError ? error.affectedPageIndexes : targetPageIndex === undefined ? [] : [targetPageIndex],
    reason: (error instanceof Error ? error.message : "Automatic repair assessment was unavailable.").slice(0, 4000) };
}

/** Only scoped editorial evidence wholly outside the edit can be inherited.
 * Missing requirements, continuity and unstructured audit failures still block.
 */
export function hasOnlyInheritedEditorialFindings(review: PictureBookPageReview, changed: ReadonlySet<number>): boolean {
  const findings = review.findings?.filter((finding) => finding.domain === "prose");
  if (!findings?.length || changed.has(review.pageIndex)) return false;
  return findings.every((finding) =>
    ["repetition", "style"].includes(finding.category) && finding.basis !== "missing_requirement" &&
    finding.relatedEvidence.every((evidence) => !changed.has(evidence.pageIndex))) &&
    review.report.issues.length === findings.length && review.report.requiredRevisions.length === findings.length &&
    review.report.groundedOk && review.report.unsupportedClaims.length === 0 &&
    review.report.checks.placeholderFree && review.report.checks.titleClean && review.report.checks.promptLeakFree && review.report.checks.progressionOk &&
    !review.storyExtract?.contradictions.length && (!review.styleAudit || review.styleAudit.styleOk);
}

/** Preserve failure class and actual rejection pages in the final quality card. */
export function finalRepairQualityIssues(state: {
  unavailableRepairPageIds?: string[]; repairFailures?: RepairFailure[];
} | undefined, pages: readonly { id: string; index: number }[]): ManuscriptQualityIssue[] {
  const failures = state?.repairFailures ?? [];
  const grouped = new Map<string, RepairFailure>();
  for (const failure of failures) {
    const key = JSON.stringify([failure.failureClass, failure.reason, failure.affectedPageIndexes]);
    grouped.set(key, failure);
  }
  const issues: ManuscriptQualityIssue[] = [...grouped.values()].map((failure) => ({
    code: failure.failureClass === "assessment_unavailable" ? "FINAL_QA_REPAIR_UNAVAILABLE" : "FINAL_QA_REPAIR_REJECTED",
    source: "deterministic", severity: "warning",
    message: `Automatic repair ${failure.failureClass === "assessment_unavailable" ? "could not be verified" : "was rejected"}: ${failure.reason} Saved prose was retained.`,
    guidance: "Review the reported findings before requesting another repair.",
    affectedPageIndexes: failure.affectedPageIndexes.length ? failure.affectedPageIndexes : pages.filter((page) => page.id === failure.pageId).map((page) => page.index)
  }));
  const legacyIds = state?.unavailableRepairPageIds?.filter((id) => !failures.some((failure) => failure.pageId === id)) ?? [];
  if (legacyIds.length) issues.push({ code: "FINAL_QA_REPAIR_UNAVAILABLE", source: "deterministic", severity: "warning",
    message: "Automatic repair could not complete after its bounded provider attempts; the saved pages were retained.",
    guidance: "Review these pages or request another repair.", affectedPageIndexes: pages.filter((page) => legacyIds.includes(page.id)).map((page) => page.index) });
  return issues;
}

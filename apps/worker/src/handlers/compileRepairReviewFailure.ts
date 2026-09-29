import { z } from "zod";
import { PictureBookReviewIncompleteError, pageFindingProvenance, type ManuscriptQualityIssue } from "@book-maker/core";

export const repairReviewFindingSchema = z.strictObject({
  findingId: z.string().min(1).max(200), pageIndex: z.number().int().positive(),
  relatedPageIndexes: z.array(z.number().int().positive()).max(40),
  message: z.string().min(1).max(500), guidance: z.string().min(1).max(500),
  validationFailure: z.enum(["evidence", "auxiliary", "repair_metadata"]).optional()
});
export const repairReviewValidationSchema = z.strictObject({ pageIndex: z.number().int().positive(), message: z.string().max(2000) });
type ReviewFinding = z.infer<typeof repairReviewFindingSchema>;

/** Retain the original claim for diagnostics without granting editing authority. */
export function incompleteRepairReview(error: unknown): {
  affectedPageIndexes: number[]; reviewFindings: ReviewFinding[];
  reviewValidationIssues: z.infer<typeof repairReviewValidationSchema>[];
} | undefined {
  if (!(error instanceof PictureBookReviewIncompleteError)) return undefined;
  const unresolved = new Set(error.checkpoint.unresolvedPageIndexes);
  const rows = [
    ...(error.checkpoint.citationRows ?? []).map(row => ({ row, validationFailure: "evidence" as const })),
    ...(error.checkpoint.editorialRows ?? []).map(row => ({ row, validationFailure: "auxiliary" as const })),
    ...(error.checkpoint.metadataRows ?? []).map(row => ({ row, validationFailure: "repair_metadata" as const }))
  ];
  return {
    affectedPageIndexes: [...unresolved].sort((a, b) => a - b),
    reviewFindings: rows.filter(({ row }) => unresolved.has(row.pageIndex)).flatMap(({ row, validationFailure }) => row.findings.filter(finding => finding.domain === "prose").map(finding => ({
      findingId: pageFindingProvenance(row.pageIndex, JSON.stringify([finding.category, finding.message, finding.quote, finding.relatedEvidence])).findingId!,
      pageIndex: row.pageIndex, relatedPageIndexes: [...new Set(finding.relatedEvidence.map(evidence => evidence.pageIndex))],
      message: finding.message, guidance: finding.guidance, validationFailure
    }))),
    reviewValidationIssues: error.checkpoint.validationIssues.filter(issue => unresolved.has(issue.pageIndex))
      .map(issue => ({ pageIndex: issue.pageIndex, message: issue.message.slice(0, 2000) }))
  };
}

export function unverifiedRepairQualityIssues(failures: readonly {
  reviewFindings?: readonly ReviewFinding[] | undefined; repairOperationId?: string | undefined;
}[]): ManuscriptQualityIssue[] {
  const findings = new Map<string, ManuscriptQualityIssue>();
  for (const failure of failures) for (const finding of failure.reviewFindings ?? []) {
    const key = JSON.stringify([finding.findingId, finding.pageIndex]);
    if (findings.has(key)) continue;
    findings.set(key, {
      code: "MANUSCRIPT_FINDING_UNVERIFIED", severity: "warning", source: "model",
      message: `${finding.validationFailure === "repair_metadata" || finding.validationFailure === "auxiliary" ? "Editorial" : "Unverified editorial"} concern on candidate page ${finding.pageIndex}: ${finding.message}`,
      guidance: `${finding.guidance} ${finding.validationFailure === "repair_metadata"
        ? "The quoted concern was retained, but its repair scope could not be verified. Check the saved prose before editing."
        : finding.validationFailure === "auxiliary"
          ? "The quoted concern was retained, but auxiliary review checks are incomplete. Check the saved prose before editing."
          : "Verify this concern against the saved prose; its evidence or repair metadata could not be fully validated."}`,
      affectedPageIndexes: [finding.pageIndex, ...finding.relatedPageIndexes.filter(index => index !== finding.pageIndex)],
      provenance: { findingId: finding.findingId, primaryPageIndex: finding.pageIndex, relatedPageIndexes: finding.relatedPageIndexes,
        kind: "manuscript", verification: "unverified", ...(failure.repairOperationId ? { repairOperationId: failure.repairOperationId } : {}) }
    });
  }
  return [...findings.values()];
}

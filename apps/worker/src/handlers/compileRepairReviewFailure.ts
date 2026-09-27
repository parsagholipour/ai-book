import { z } from "zod";
import { PictureBookReviewIncompleteError, pageFindingProvenance, type ManuscriptQualityIssue } from "@book-maker/core";

export const repairReviewFindingSchema = z.strictObject({
  findingId: z.string().min(1).max(200), pageIndex: z.number().int().positive(),
  relatedPageIndexes: z.array(z.number().int().positive()).max(3),
  message: z.string().min(1).max(500), guidance: z.string().min(1).max(500)
});
export const repairReviewValidationSchema = z.strictObject({ pageIndex: z.number().int().positive(), message: z.string().max(2000) });
type ReviewFinding = z.infer<typeof repairReviewFindingSchema>;

/** Retain the original proposed claim, not its invalid quotation as evidence. */
export function incompleteRepairReview(error: unknown): {
  affectedPageIndexes: number[]; reviewFindings: ReviewFinding[];
  reviewValidationIssues: z.infer<typeof repairReviewValidationSchema>[];
} | undefined {
  if (!(error instanceof PictureBookReviewIncompleteError)) return undefined;
  const unresolved = new Set(error.checkpoint.unresolvedPageIndexes);
  const rows = [...(error.checkpoint.citationRows ?? []), ...(error.checkpoint.editorialRows ?? [])];
  return {
    affectedPageIndexes: [...unresolved].sort((a, b) => a - b),
    reviewFindings: rows.filter(row => unresolved.has(row.pageIndex)).flatMap(row => row.findings.filter(finding => finding.domain === "prose").map(finding => ({
      findingId: pageFindingProvenance(row.pageIndex, JSON.stringify([finding.category, finding.message, finding.quote, finding.relatedEvidence])).findingId!,
      pageIndex: row.pageIndex, relatedPageIndexes: [...new Set(finding.relatedEvidence.map(evidence => evidence.pageIndex))],
      message: finding.message, guidance: finding.guidance
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
      message: `Unverified editorial concern on page ${finding.pageIndex}: ${finding.message}`,
      guidance: `${finding.guidance} Verify this concern against the saved prose; its evidence could not be fully validated.`,
      affectedPageIndexes: [finding.pageIndex, ...finding.relatedPageIndexes.filter(index => index !== finding.pageIndex)],
      provenance: { findingId: finding.findingId, primaryPageIndex: finding.pageIndex, relatedPageIndexes: finding.relatedPageIndexes,
        kind: "manuscript", verification: "unverified", ...(failure.repairOperationId ? { repairOperationId: failure.repairOperationId } : {}) }
    });
  }
  return [...findings.values()];
}

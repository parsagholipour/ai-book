import { pageFindingProvenance, pageQualityReportSchema, type ManuscriptQualityIssue } from "@book-maker/core";
import { isUnavailablePageReview } from "./shortPictureBookReviewDelivery.js";

/** Carry rejected keepers into the final card without another review or repair. */
export function unresolvedPageQualityIssues(
  pages: readonly { index: number; status: string; qualityReport?: unknown }[]
): ManuscriptQualityIssue[] {
  return pages.flatMap((page) => {
    // Completed pages can retain historical QA after an exact edit. Their old
    // rejection must not be presented as a review of the new prose.
    if (page.status !== "FAILED_QA") return [];
    const parsed = pageQualityReportSchema.safeParse(page.qualityReport);
    // A prose-approved report can be waiting only for deferred illustrations.
    if (parsed.success && parsed.data.approved) return [];
    if (isUnavailablePageReview(page.qualityReport)) return [{ code: "FINAL_REVIEW_UNAVAILABLE", severity: "warning" as const,
      source: "model" as const, affectedPageIndexes: [page.index],
      message: "The manuscript review could not verify this page after its bounded attempts. The saved draft remains included in the exports.",
      guidance: "Review the saved page or request another review." }];
    const report = parsed.success ? parsed.data : undefined;
    const issues = cleanFeedback(report?.issues);
    const revisions = cleanFeedback(report?.requiredRevisions);
    return [{
      code: "PAGE_QA_UNRESOLVED",
      severity: "warning" as const,
      source: "model" as const,
      message: issues.length > 0
        ? `Page QA did not approve the saved draft: ${issues.join("\n")}`
        : "This saved page remains flagged by page QA, but no detailed rejection is available.",
      guidance: revisions.length > 0
        ? revisions.join("\n")
        : "Review this page before sharing the book. The best available draft remains included in the exports.",
      affectedPageIndexes: [page.index],
      ...(issues.length === 1 ? { provenance: pageFindingProvenance(page.index, issues[0]!) } : {})
    }];
  });
}

function cleanFeedback(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

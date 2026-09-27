import { pageFindingProvenance, pageQualityReportSchema, type FinalBookQa, type ManuscriptQualityIssue } from "@book-maker/core";
import { qualityIssuesFromFinalQa as formatFinalQa } from "./exportQualityReview.js";

/** Add trusted local identities above the dependency-free text formatter. */
export function qualityIssuesFromFinalQa(
  finalQa: Pick<FinalBookQa, "approved" | "issues" | "requiredFixes">,
  lastPage: number,
  pages: readonly { index: number; qualityReport?: unknown }[] = []
): ManuscriptQualityIssue[] {
  return formatFinalQa(finalQa, lastPage).map(issue => {
    const primary = Number(/^Page (\d+):/u.exec(issue.message)?.[1]);
    if (!issue.affectedPageIndexes.includes(primary)) return issue;
    const report = pageQualityReportSchema.safeParse(pages.find(page => page.index === primary)?.qualityReport);
    const unprefixed = issue.message.replace(/^Page \d+:\s*/u, "");
    // Only the saved diagnosis/revision pair establishes this relationship;
    // a primary page shared by unrelated final-QA messages does not.
    const diagnosis = finalQa.issues.includes(issue.message) ? unprefixed : report.success && report.data.issues.length === 1 &&
      report.data.requiredRevisions.length === 1 && report.data.requiredRevisions[0] === unprefixed &&
      finalQa.issues.includes(`Page ${primary}: ${report.data.issues[0]}`) ? report.data.issues[0] : undefined;
    return diagnosis ? { ...issue, provenance: pageFindingProvenance(primary, diagnosis, issue.affectedPageIndexes) } : issue;
  });
}

import type { ManuscriptQualityIssue, ManuscriptQualityReport } from "@book-maker/core";

/** Findings merged from the compile's integrity, review and companion passes. */
export function dedupeQualityIssues(issues: ManuscriptQualityIssue[]): ManuscriptQualityIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = JSON.stringify([issue.code, issue.message, issue.affectedPageIndexes, issue.severity,
      issue.provenance?.findingId, issue.provenance?.primaryPageIndex,
      issue.provenance?.kind === "repair" ? issue.provenance.repairOperationId : undefined]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function qualitySummaryMessage(report: ManuscriptQualityReport): string {
  const count = report.findings?.length ?? report.issues.length;
  if (report.state === "blocked") {
    return `Review required: ${count} integrity issue${count === 1 ? "" : "s"} must be fixed before export.`;
  }
  if (report.state === "review_recommended") {
    return `Export complete with ${count} review recommendation${count === 1 ? "" : "s"}.`;
  }
  return "Export complete. Quality checks passed.";
}

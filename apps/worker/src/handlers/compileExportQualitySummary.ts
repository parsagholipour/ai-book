import {
  appendQualityIssue,
  inferWritingMode,
  isNarrativeWritingMode,
  printedShortIssue,
  withoutRefutedFindings,
  type BookPlan,
  type CreateProjectInput,
  type ManuscriptQualityIssue,
  type ManuscriptQualityReport,
  type PrintedSheets
} from "@book-maker/core";

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

/**
 * The model findings a compile files, at every door it files them through:
 * deduplicated, and without a finding the pages it names refute
 * (`withoutRefutedFindings` — "this page has no dialogue" about a page that
 * prints “…,” Rabbit said). Dropped rather than demoted, because the console
 * and the stand-down read these too, and a refuted claim is not a diagnostic.
 */
export function settledModelIssues(
  issues: ManuscriptQualityIssue[],
  pages: readonly { index: number; markdown: string }[]
): ManuscriptQualityIssue[] {
  return withoutRefutedFindings(dedupeQualityIssues(issues), pages);
}

/** A story is spared the explanatory-module sweep (`runDeterministicManuscriptChecks`' `narrative`). */
export function isStoryBook(input: CreateProjectInput, plan: BookPlan): boolean {
  return isNarrativeWritingMode(inferWritingMode(input, plan));
}

/**
 * The verdict once the render has said how many paid pages it printed: the
 * one length finding a reader is shown, appended after the render because only
 * the render knows (`BOOK_PRINTED_SHORT`). A warning, so it never changes the
 * status the verdict already decided. Undefined when there is nothing to add.
 */
export function withPrintedShortfall(
  report: ManuscriptQualityReport,
  printedSheets: PrintedSheets | undefined
): ManuscriptQualityReport | undefined {
  const issue = printedSheets ? printedShortIssue(printedSheets) : undefined;
  return issue ? appendQualityIssue(report, issue) : undefined;
}

/**
 * The job's progress line for a verdict. It speaks of the reader's grade — the
 * findings a reader is shown — and counts the console's diagnostics apart.
 */
export function qualitySummaryMessage(report: ManuscriptQualityReport): string {
  const readerCount = report.readerFindings?.length ?? report.findings?.length ?? report.issues.length;
  const diagnostics = report.readerFindings ? report.issues.length - report.readerFindings.length : 0;
  const console = diagnostics > 0 ? ` ${diagnostics} diagnostic${diagnostics === 1 ? "" : "s"} for the console.` : "";
  if (report.state === "blocked") {
    return `Review required: ${readerCount} integrity issue${readerCount === 1 ? "" : "s"} must be fixed before export.${console}`;
  }
  if (report.state === "review_recommended") {
    return `Export complete with ${readerCount} review recommendation${readerCount === 1 ? "" : "s"}.${console}`;
  }
  return `Export complete. Quality checks passed.${console}`;
}

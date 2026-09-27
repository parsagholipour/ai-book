import type { PictureBookRepairContext } from "./pictureBookRepair.js";
import type { PictureBookReviewCheckpoint, PictureBookReviewOptions } from "./pictureBookReview.js";
import { pictureBookPageReview, validatedPictureBookReviewRow, PICTURE_BOOK_CITATION_ERROR,
  type PictureBookPageReview } from "./pictureBookReviewValidation.js";

type Finding = NonNullable<PictureBookPageReview["findings"]>[number];

/** A target cannot become an inherited residual. Continuity needs its entire
 * causal prefix unchanged; an unchanged page alone is insufficient. */
export function isInheritedRepairFinding(finding: Finding, pageIndex: number, context: PictureBookRepairContext, unverified = false): boolean {
  const changed = new Set(context.changes.map(change => change.pageIndex));
  if (!changed.size || changed.has(pageIndex) || context.issues.some(issue => issue.pageIndexes.includes(pageIndex)) ||
    context.requirementTargets?.some(target => target.pageIndex === pageIndex) || finding.domain !== "prose" ||
    finding.basis === "missing_requirement" || finding.requirementQuote !== null ||
    !["repetition", "style", "continuity"].includes(finding.category) ||
    finding.relatedEvidence.some(evidence => changed.has(evidence.pageIndex))) return false;
  const firstEdit = Math.min(...changed);
  return (!unverified && finding.category !== "continuity") ||
    (pageIndex < firstEdit && finding.relatedEvidence.every(evidence => evidence.pageIndex < firstEdit));
}

/** Only exhausted citation correction on an untouched prefix can be retained.
 * Missing rows, protocol/schema failures and unresolved targets still fail.
 * No quoted text is promoted to evidence and no page becomes approved. */
export function retainUnverifiedRepairPrefix(options: PictureBookReviewOptions, checkpoint: PictureBookReviewCheckpoint): PictureBookPageReview[] | undefined {
  const context = options.repairContext;
  if (!context?.changes.length || checkpoint.protocolIssues.length || checkpoint.editorialRows?.length ||
    !checkpoint.unresolvedPageIndexes.length || checkpoint.roundsStarted < 2) return undefined;
  const pages = new Map(options.pages.map(page => [page.index, page]));
  const reviews = new Map(checkpoint.reviews.map(review => [review.pageIndex, review]));
  const pending = checkpoint.citationRows ?? [];
  if (reviews.size !== checkpoint.reviews.length || checkpoint.unresolvedPageIndexes.length !== pending.length || new Set(checkpoint.unresolvedPageIndexes).size !== pending.length ||
    new Set(pending.map(row => row.pageIndex)).size !== pending.length || reviews.size + pending.length !== pages.size) return undefined;
  for (const review of reviews.values()) {
    if (pages.get(review.pageIndex)?.markdown !== review.draftMarkdown || Object.entries(options.checks)
      .some(([key, enabled]) => review.completedChecks[key as keyof typeof options.checks] !== enabled)) return undefined;
  }
  const schema = validatedPictureBookReviewRow({ ...options, pages });
  for (const row of pending) {
    const page = pages.get(row.pageIndex), parsed = schema.safeParse(row);
    if (!page || reviews.has(row.pageIndex) || !checkpoint.unresolvedPageIndexes.includes(row.pageIndex) ||
      parsed.success || parsed.error.issues.some(issue => issue.code !== "custom" || issue.message !== PICTURE_BOOK_CITATION_ERROR) ||
      !row.findings.length || !row.findings.every(finding => finding.relatedEvidence.every(evidence => pages.has(evidence.pageIndex)) &&
        isInheritedRepairFinding(finding, row.pageIndex, context, true))) return undefined;
    const review = pictureBookPageReview(row, page, options.checks, options.input.prompt, options.reusableStoryExtracts?.get(row.pageIndex));
    reviews.set(row.pageIndex, { ...review, findings: [], unverifiedFindings: row.findings,
      report: { ...review.report, approved: false,
        issues: row.findings.map(finding => `Unverified existing concern: ${finding.message} Its evidence quotation could not be verified; the complete preceding prose is unchanged by this repair.`),
        notes: "Retained unverified findings from an unchanged pre-edit prefix; this page is not approved." } });
  }
  return [...reviews.values()].sort((a, b) => a.pageIndex - b.pageIndex);
}

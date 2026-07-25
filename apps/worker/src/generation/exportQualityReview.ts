import type { FinalBookQa, ManuscriptQualityIssue } from "@book-maker/core";

const REVIEW_ELLIPSIS = "\n…\n";

/**
 * Bounds review payloads while preserving the real page ending.
 * Head-only truncation previously made mid-page clips look like incomplete prose.
 */
export function clipQualityText(value: string, maxLength: number): string {
  const compact = value.trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  const budget = maxLength - REVIEW_ELLIPSIS.length;
  if (budget < 2) {
    return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  }
  const headLen = Math.ceil(budget / 2);
  const tailLen = Math.floor(budget / 2);
  const head = compact.slice(0, headLen).trimEnd();
  const tail = compact.slice(compact.length - tailLen).trimStart();
  return `${head}${REVIEW_ELLIPSIS}${tail}`;
}

/** First N characters of manuscript text (for chapter openings). */
export function clipQualityTextPrefix(value: string, maxLength: number): string {
  const compact = value.trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** Last N characters of manuscript text (for chapter endings). */
export function clipQualityTextSuffix(value: string, maxLength: number): string {
  const compact = value.trim();
  return compact.length <= maxLength
    ? compact
    : `…${compact.slice(Math.max(0, compact.length - (maxLength - 1))).trimStart()}`;
}

/**
 * Maps final whole-book QA into manuscript quality warnings.
 * When the book is approved, only requiredFixes become review recommendations —
 * advisory issues (e.g. pageMap ellipsis notes) must not bump the export state.
 */
export function qualityIssuesFromFinalQa(
  finalQa: Pick<FinalBookQa, "approved" | "issues" | "requiredFixes">,
  affectedPageIndexes: number[]
): ManuscriptQualityIssue[] {
  const source = finalQa.approved ? finalQa.requiredFixes : [...finalQa.issues, ...finalQa.requiredFixes];
  const messages = [...new Set(source.map((value) => value.trim()).filter(Boolean))];
  if (messages.length === 0) {
    return [];
  }
  return messages.slice(0, 24).map((message) => ({
    code: "WHOLE_BOOK_REVIEW",
    severity: "warning" as const,
    source: "model" as const,
    message,
    guidance: "Review the affected prose in Edit Mode or request a targeted regeneration.",
    affectedPageIndexes
  }));
}

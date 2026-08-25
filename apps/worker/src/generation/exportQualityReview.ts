import { extractRepairPageIndexesFromText } from "./finalQaPageTargets.js";
import { uniqueStrings } from "@book-maker/core/collections";
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
 *
 * **Each message carries the pages it names, and no others.** One
 * `affectedPageIndexes` array was computed over the whole verdict and stamped
 * onto every message alike, so a verdict making two unrelated complaints
 * shipped both with the union of their pages: "Chapter 4 restates the same
 * argument twice" reached the reader's card as "Pages 1 · Open Edit Mode"
 * because a *different* message named page 1, and the opening complaint pointed
 * at chapter 4's page in the same breath. The card's whole promise is "Review
 * the affected prose in Edit Mode", which is a wrong answer the moment it opens
 * a page that message never complained about. The caller cannot get that right
 * with one array, so it no longer passes one — it passes the book's page count
 * and the mapping happens per message, here.
 *
 * A message naming no page gets an empty array, and both consumers read that as
 * "no page link": the card drops the tap target and the "Pages …" line
 * (`book_screen_body.dart`), and `normalizeProjectQuality` keeps the report-level
 * union it always built out of the issues, so the card's own Open Edit Mode
 * button still reaches every page the verdict *did* name. Falling back to the
 * verdict's other pages would be the union bug again, one message at a time —
 * and "the pacing sags throughout" is honestly about no page in particular.
 *
 * `extractRepairPageIndexesFromText`, not `extractRepairPageIndexes`: the prose
 * edge heuristics answer a different question than this one, and the shared
 * module (`finalQaPageTargets.ts`) is what makes the two look like one. They
 * fire exactly when `edgeComplaintSpeaksForTheBook` decides a complaint is about
 * the *book's* opening or ending rather than about a part of it — the repair
 * pass wants them, because it has to redraft something and the first or last
 * page is the only candidate a page-less complaint offers, and a redraft nobody
 * needed costs one model call. This is the other question: where a human should
 * look. A guess that misses ("The chapters hold together, but page 12 repeats
 * the opening" still reaches page 1, because the government tests read a unit
 * that *opens* the message and this one has a clause in front of it) spends the
 * reader's trust on a page nobody complained about, while a message with no link
 * still says "the opening" in its own words. Which pages get *rewritten* stays
 * `compileExportRepair.ts`'s question.
 */
export function qualityIssuesFromFinalQa(
  finalQa: Pick<FinalBookQa, "approved" | "issues" | "requiredFixes">,
  lastPage: number
): ManuscriptQualityIssue[] {
  const source = finalQa.approved ? finalQa.requiredFixes : [...finalQa.issues, ...finalQa.requiredFixes];
  const messages = uniqueStrings(source);
  if (messages.length === 0) {
    return [];
  }
  return messages.slice(0, 24).map((message) => ({
    code: "WHOLE_BOOK_REVIEW",
    severity: "warning" as const,
    source: "model" as const,
    message,
    guidance: "Review the affected prose in Edit Mode or request a targeted regeneration.",
    // Bounded to 1..lastPage by the extractor itself, so a verdict naming
    // "page 40" of a 20-page book links nowhere rather than to a page the
    // reader cannot open.
    affectedPageIndexes: extractRepairPageIndexesFromText(message, lastPage)
  }));
}

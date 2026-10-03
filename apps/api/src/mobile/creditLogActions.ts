import { jsonRecord } from "./support.js";

/**
 * What a charge bought, in the reader's words, read from what the charge
 * recorded about itself.
 *
 * A ledger `operation` names the *rate* a charge was billed at, and several
 * actions share one: a page rewrite, a chapter rewrite, a structural insert, a
 * continuation and the Studio's chapter draft are all `PAGE_REGENERATION`,
 * because they are priced per page written. Titled by the operation, a reader
 * who added a page or continued their book was shown "Page rewrite" — and a
 * refunded insert "Page rewrite refunded" — for something they never asked
 * for. Every charge site already writes what it was for into `metadata`
 * (`intent.kind`, `writingAssist`, or for a retry the `operationId` it re-ran),
 * so the label comes from there and the rate stays what it is. A refund is
 * titled from the charge it reverses (`reversesEntryId`), whose record it does
 * not repeat.
 *
 * Only structured fields are read. `description` is never one of them: it holds
 * refund reasons that are often raw provider errors (`creditLog.ts`).
 */

const STUDIO_ASSIST_TITLES: Record<string, string> = {
  draft_chapter: "Chapter draft",
  chapter_feedback: "Chapter notes",
  consistency: "Consistency check",
  outline: "Book outline"
};

/** The edit operation a retry-lane charge re-ran, when the charge names no intent of its own. */
export function retriedOperationId(metadata: unknown): string | null {
  const record = jsonRecord(metadata);
  if (jsonRecord(record.intent).kind !== undefined || typeof record.writingAssist === "string") {
    return null;
  }
  return typeof record.operationId === "string" ? record.operationId : null;
}

/**
 * The action a charge paid for, or null when its rate's own name already says
 * it. `operationKinds` maps a retried edit operation's id to its
 * `BookEditOperationKind`.
 */
export function chargeActionTitle(metadata: unknown, operationKinds: ReadonlyMap<string, string>): string | null {
  const record = jsonRecord(metadata);
  if (typeof record.writingAssist === "string") {
    return STUDIO_ASSIST_TITLES[record.writingAssist] ?? null;
  }
  const intentKind = jsonRecord(record.intent).kind;
  const retried = retriedOperationId(metadata);
  const kind =
    typeof intentKind === "string" ? intentKind : retried ? operationKinds.get(retried)?.toLowerCase() : undefined;
  switch (kind) {
    case "restructure_pages":
      // Only an insert is ever charged: deleting and moving pages are free.
      return record.pagesBilled === 1 ? "New page" : "New pages";
    case "continue_book":
      return typeof record.chapterCount === "number"
        ? record.chapterCount === 1
          ? "New chapter"
          : "New chapters"
        : "Book continuation";
    case "chapter_regenerate":
      return "Chapter rewrite";
    default:
      return null;
  }
}

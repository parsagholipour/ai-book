import { MODEL_PAGE_NUMBERING, type ReaderPageNumbering } from "../bookPageNumbering.js";
import { type MobileBookEditOperationRecord } from "./dto.js";
import { jsonRecord } from "./support.js";

/**
 * What an edit-operation card says: which pages, what was applied, what is
 * happening now. Split out of `projectSerializers.ts` along the same seam as
 * `bookEditCopy.ts` — this is what the user reads about an operation, that file
 * is what the wire carries. Page numbers go through a
 * {@link ReaderPageNumbering}, so the card speaks the printed PDF pages the
 * reader can see whenever the book's current page map is known.
 */

/**
 * Which pages an edit is about, said the way the reader would say it.
 *
 * "Selected pages" was true of every rewrite and told no one anything; the
 * indexes are on the row, and they are the same numbers the live progress card
 * counts down, so the two never describe the same job differently.
 */
function describeEditPages(indexes: number[], numbering: ReaderPageNumbering = MODEL_PAGE_NUMBERING): string {
  const pages = numbering
    .displayPages(indexes.filter((index) => Number.isInteger(index) && index > 0))
    .sort((left, right) => left - right);
  if (pages.length === 0) {
    return "the selected pages";
  }
  if (pages.length === 1) {
    return `page ${pages[0]}`;
  }
  if (pages.length === 2) {
    return `pages ${pages[0]} and ${pages[1]}`;
  }
  return `${pages.length} pages`;
}

function capitalizeFirst(text: string): string {
  return text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/**
 * What the finished card says an edit did. The queued reply above it already
 * named the work in the reader's own terms, so a flat "Edit applied." for every
 * kind made the card the least informative line of the turn — and for an
 * illustration swap it did not even say a picture had changed.
 *
 * The page phrase is dropped rather than faked when no page was recorded:
 * `describeEditPages([])` answers "the selected pages", which is a fine
 * fallback mid-sentence and nonsense in a summary of what just happened.
 */
function appliedEditSummary(
  operation: MobileBookEditOperationRecord,
  numbering: ReaderPageNumbering = MODEL_PAGE_NUMBERING
): string {
  const pages = operation.affectedPageIndexes;
  const on = pages.length > 0 ? ` on ${describeEditPages(pages, numbering)}` : "";
  switch (operation.kind) {
    case "ADD_IMAGE":
      // The worker records what it swapped out, which is the only thing that
      // separates a replacement from a picture the book did not have before.
      return jsonRecord(jsonRecord(operation.classifier).previousAsset).id !== undefined
        ? `Illustration replaced${on}.`
        : `New illustration${on}.`;
    case "MOVE_IMAGE":
      return `Illustration moved${on}.`;
    case "REMOVE_IMAGE":
      return pages.length > 0
        ? `Illustration removed from ${describeEditPages(pages, numbering)}.`
        : "Illustration removed.";
    case "PAGE_REWRITE":
      return pages.length > 0
        ? `${capitalizeFirst(describeEditPages(pages, numbering))} rewritten.`
        : "Pages rewritten.";
    case "CHAPTER_REGENERATE":
      return "Chapter rewritten.";
    case "CONTINUE_BOOK":
      return "New chapters added.";
    case "BOOK_REPLAN":
      return "The new copy is ready.";
    case "PLAN_REVISION":
      return "Plan revised.";
    case "MANUAL_EDIT":
      return "Your edits are saved.";
    default:
      return "Edit applied.";
  }
}

/**
 * What a move or remove says when it found nothing to do.
 *
 * The queued reply already promised the reader "I'll remove the illustration on
 * page 3", so a layout edit that reaches the worker to find the picture gone —
 * or already exactly where it was asked to go — has to say so somewhere, and the
 * worker cannot: it never writes a chat message and cannot reach the API to. The
 * card is the one surface that can, which is the same reason
 * `skippedPageIndexes` is read just above.
 *
 * Null for every other operation, so the ordinary applied summary stands.
 */
function layoutSkipSummary(operation: MobileBookEditOperationRecord): string | null {
  const classifier = jsonRecord(operation.classifier);
  if (classifier.layoutMissing !== true) {
    return null;
  }
  return classifier.layoutSkippedReason === "already_positioned"
    ? "Nothing was changed: that picture is already where you asked for it."
    : operation.kind === "MOVE_IMAGE"
      ? "Nothing was changed: that illustration isn’t in the book any more."
      : "Nothing was changed: that illustration had already gone.";
}

export function currentActionForEditOperation(
  operation: MobileBookEditOperationRecord,
  numbering: ReaderPageNumbering = MODEL_PAGE_NUMBERING
): string {
  if (operation.status === "FAILED") {
    if (operation.kind === "PLAN_REVISION") {
      return "Plan revision failed.";
    }
    return "Edit failed.";
  }
  if (operation.status === "APPLIED") {
    // The worker records pages it skipped because their text had changed
    // between the quote and the apply; the card is where that has to be said,
    // because the queued chat reply already promised those pages.
    const skipped = jsonRecord(operation.classifier)
      .skippedPageIndexes as unknown;
    const skippedPages = Array.isArray(skipped)
      ? skipped.filter((index): index is number => Number.isInteger(index) && (index as number) > 0)
      : [];
    if (skippedPages.length > 0) {
      return operation.affectedPageIndexes.length === 0
        ? `Nothing was changed: ${describeEditPages(skippedPages, numbering)} no longer contained that text.`
        : `${appliedEditSummary(operation, numbering)} ${capitalizeFirst(describeEditPages(skippedPages, numbering))} no longer contained that text and ${skippedPages.length === 1 ? "was" : "were"} left unchanged.`;
    }
    const layoutSkip = layoutSkipSummary(operation);
    if (layoutSkip) {
      return layoutSkip;
    }
    return appliedEditSummary(operation, numbering);
  }
  if (operation.kind === "BOOK_REPLAN") {
    return "Rebuilding a new copy.";
  }
  if (operation.kind === "PAGE_REWRITE") {
    return `Rewriting ${describeEditPages(operation.affectedPageIndexes, numbering)}.`;
  }
  if (operation.kind === "CHAPTER_REGENERATE") {
    return "Rewriting the chapter.";
  }
  if (operation.kind === "CONTINUE_BOOK") {
    return "Writing new chapters.";
  }
  if (operation.kind === "ADD_IMAGE") {
    return "Creating your illustration.";
  }
  if (operation.kind === "MOVE_IMAGE") {
    return "Moving the illustration.";
  }
  if (operation.kind === "REMOVE_IMAGE") {
    return "Removing the illustration.";
  }
  if (operation.kind === "PLAN_REVISION") {
    return "Revising the plan.";
  }
  if (operation.kind === "MANUAL_EDIT") {
    return "Saving your manual edits.";
  }
  return "Applying text edits.";
}

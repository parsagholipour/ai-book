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
    case "RESTRUCTURE_PAGES":
      return structuralEditSummary(operation, pages, numbering);
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

/**
 * What a structural edit says when the book had moved on before it ran.
 *
 * `restructurePages` answers a resolver refusal — the book changed between the
 * card and the Apply — by refunding the charge and marking the operation
 * APPLIED with nothing done: no shift, no drafting, an empty
 * `affectedPageIndexes`. {@link structuralEditSummary} then fell back to the
 * *requested* action and confirmed "Pages removed." for a book that still holds
 * every one of them. The worker cannot correct the queued reply itself, which is
 * the same reason `layoutSkipSummary` exists just above; this is the structural
 * half of it, keyed on the marker the worker writes in place of the
 * `structuralApplication` stamp — which is why the row is refused an Undo too,
 * by `canUndoBookEdit` asking for that stamp rather than for this marker.
 *
 * It names no page: the pages a refusal is about are pages the book no longer
 * holds, so the map has no span for them and `describeEditPages` would hand the
 * reader a raw model index. It names no price either — the refund amount travels
 * separately in the DTO and the operation card renders the exact settlement.
 *
 * `structuralRefusalMessage` is deliberately not reused: those sentences are a
 * *reply*, and they end by asking for the next instruction, which a record of
 * what already happened may not do.
 *
 * Null for every other operation, so the ordinary applied summary stands.
 */
function structuralSkipSummary(operation: MobileBookEditOperationRecord): string | null {
  const reason = jsonRecord(operation.classifier).structuralSkipped;
  if (typeof reason !== "string") {
    return null;
  }
  switch (reason) {
    case "unknown_pages":
      return "Nothing was changed: those pages aren’t in the book any more.";
    case "anchor_out_of_range":
      return "Nothing was changed: the page they were meant to follow isn’t in the book any more.";
    case "nothing_to_do":
      return "Nothing was changed: those pages are already where you asked for them.";
    case "would_empty_book":
      return "Nothing was changed: that would have taken out every page of the book.";
    case "would_empty_chapter":
      return "Nothing was changed: that would have left one of the chapters with no pages.";
    case "missing_request":
      // Not a refusal the resolver can return: the worker settles here when the
      // job arrived with no structural request on either the payload or this
      // classifier, so there was nothing to resolve. It gets a sentence of its
      // own because the default below blames the book for moving on, which is
      // the one thing that did not happen.
      return "Nothing was changed: that edit couldn’t be read back when it ran.";
    case "undo_history_too_large":
      return "Nothing was changed: those pages carry more Undo history than can be moved safely.";
    default:
      // `no_pages`, `too_many_pages`, `anchor_inside_selection` — all of them a
      // book that stopped matching the card, and none of them worth a sentence
      // the reader would have to hold the old book in mind to read.
      return "Nothing was changed: the book had moved on before that edit ran.";
  }
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
    const structuralSkip = structuralSkipSummary(operation);
    if (structuralSkip) {
      return structuralSkip;
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
  if (operation.kind === "RESTRUCTURE_PAGES") {
    const action = structuralActionOf(operation);
    return action === "delete"
      ? "Removing those pages."
      : action === "move"
        ? "Moving those pages."
        : "Writing the new pages.";
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

/** Which of the three a structural operation was, off its own classifier. */
function structuralActionOf(operation: { classifier?: unknown }): string {
  const classifier = jsonRecord(operation.classifier);
  const applied = jsonRecord(classifier.structuralApplication).action;
  if (typeof applied === "string") {
    return applied;
  }
  const requested = jsonRecord(classifier.structuralEdit).action;
  return typeof requested === "string" ? requested : "insert";
}

/**
 * What an applied structural edit says it did.
 *
 * A delete or a move reports what happened to pages the reader already had. An
 * insert cannot name its own pages, and that is not a gap to paper over: the map
 * in force was measured from the PDF *before* they existed, and the apply only
 * re-points it over the shift, so a page that was just written has no printed
 * number until the recompile publishes and re-measures. `describeEditPages`
 * answered that with the raw model index — the one number that may never reach a
 * reader, and here a number that names a *different* printed page. So an insert
 * says how many pages it wrote and which printed page they follow, both of which
 * are true in the window before the recompile and after it.
 */
function structuralEditSummary(
  operation: { classifier?: unknown },
  pages: number[],
  numbering: ReaderPageNumbering
): string {
  const action = structuralActionOf(operation);
  if (action === "delete") {
    return "Pages removed.";
  }
  if (action === "move") {
    return "Pages moved.";
  }
  // `affectedPageIndexes` is the pages the worker actually wrote, so an empty
  // list is an insert that settled having written none. A refusal is answered
  // by `structuralSkipSummary` before this runs, so what is left here is a row
  // whose marker is missing; the requested `pageCount` is still not read as a
  // fallback, because it would report pages the book never got.
  if (pages.length === 0) {
    return "New pages added.";
  }
  const count = pages.length === 1 ? "1 new page" : `${pages.length} new pages`;
  return `${count} added${insertedPagesLocation(operation, pages, numbering)}.`;
}

/**
 * Where an insert put its pages, in the numbering the reader can see.
 *
 * `anchorPageIndex` is the request's own three cases: `0` is the front of the
 * book, `null` is "no place named", which appends — the same distinction the
 * proposal card spoke before Apply. It decides *which* of the three phrases
 * this is, and an anchor the classifier does not carry still gets none rather
 * than a guessed one. Two of the three are the request's to answer outright:
 * `resolveStructuralPageEdit` clamps `null` to the last page and leaves `0`
 * alone, so "the end" and "the front" are true of every book the apply could
 * have landed on, whatever it went on to write.
 *
 * The **number** in the third is not its to give. That same clamp takes an
 * anchor past the end of the book to the last page while the request keeps the
 * number the reader typed, so "add a page after page 100" to a twenty-page book
 * landed after page 20 and this card confirmed page 100 — the same page the
 * proposal bubble had already got wrong. An insert opens one contiguous gap and
 * shifts only what follows it, so the first page it wrote, less one, *is* the
 * resolver's `insertAfterIndex` — read off what the apply actually produced
 * rather than re-clamped here, and true of every row already written, which is
 * why the resolved anchor needed no new field of its own.
 *
 * **True of every row that wrote the whole insert**, which is what
 * {@link wroteEveryRecordedPage} is now asked. `affectedPageIndexes` is the
 * pages the worker actually *drafted*, and a resumed delivery drafts only the
 * recorded ids the book still holds (`stampDescribesBook` resumes on a partial
 * survival on purpose, and `refundUnwrittenEditPages` hands back the
 * difference) — so on those rows the lowest page written is somewhere inside
 * the run rather than at its head, and one less than it is a page of the run
 * itself or a gap where one was. Neither is the anchor, and neither is
 * translatable: the map in force was measured before any of them existed. The
 * count is still true, so the card keeps it and says no place at all.
 *
 * The anchor of a whole insert is a page which already existed, so unlike the
 * new pages it is still translatable: an insert shifts only the pages after it,
 * and the apply re-points the stored map over that shift in the same
 * transaction. It is translated through `printedPageEnd` — the same end of the
 * span the proposal card names before Apply, because the new prose follows the
 * anchor's *last* printed sheet and a model page spanning two of them was
 * confirmed one sheet early — and through the end that answers `undefined`
 * rather than the model index, because a map in force that cannot place the
 * anchor (a page some earlier edit added to a book whose recompile has not
 * published) would otherwise print a model index at a reader who reads it as a
 * printed page. A place this card cannot name is left out of the sentence.
 */
function insertedPagesLocation(
  operation: { classifier?: unknown },
  insertedPageIndexes: number[],
  numbering: ReaderPageNumbering
): string {
  const classifier = jsonRecord(operation.classifier);
  const anchor = jsonRecord(classifier.structuralEdit).anchorPageIndex;
  if (anchor === null) {
    return " at the end of the book";
  }
  if (typeof anchor !== "number" || !Number.isInteger(anchor) || anchor < 0) {
    return "";
  }
  if (anchor === 0) {
    return " at the front of the book";
  }
  const written = insertedPageIndexes.filter((index) => Number.isInteger(index) && index > 0);
  if (!wroteEveryRecordedPage(classifier, written.length)) {
    return "";
  }
  const firstNewPage = Math.min(...written);
  // A whole insert after a real page starts at that page plus one; anything
  // lower is a book that moved under the row, and there is no page to name.
  if (!Number.isFinite(firstNewPage) || firstNewPage < 2) {
    return "";
  }
  const printedAnchor = numbering.printedPageEnd(firstNewPage - 1);
  return printedAnchor === undefined ? "" : ` after page ${printedAnchor}`;
}

/**
 * Whether the pages the card can see are the whole insert the worker created.
 *
 * The stamp records the page *ids* the shift created, and the settlement writes
 * the indexes of the ones drafting actually wrote — equal on every ordinary
 * delivery, and deliberately not on a resumed one whose book had lost some of
 * them. The two counts are the only thing that separates the two, so the
 * comparison is any disagreement rather than "fewer": a row whose numbers do
 * not add up is a row this sentence may not be derived from either way.
 *
 * `true` when nothing is recorded to compare against — a stamp that predates
 * the ids, or a row whose marker is missing. That is the answer the card gave
 * before this existed, and it degrades the same way one page further on: an
 * anchor the map cannot place is left out of the sentence.
 */
function wroteEveryRecordedPage(classifier: Record<string, unknown>, writtenPages: number): boolean {
  const recorded = jsonRecord(classifier.structuralApplication).insertedPageIds;
  if (!Array.isArray(recorded) || recorded.length === 0) {
    return true;
  }
  return recorded.length === writtenPages;
}

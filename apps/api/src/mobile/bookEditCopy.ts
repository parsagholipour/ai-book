import { type BookEditIntent, type BookEditIntentKind, type BookEditPageInstruction } from "../bookEditIntent.js";
import { clippedImageSubject, imageLayoutProposalSummary, imageLayoutQueuedMessage } from "../bookEditImage.js";
import { MODEL_PAGE_NUMBERING, type ReaderPageNumbering } from "../bookPageNumbering.js";
import { type StructuralCardPlan } from "./pendingEditState.js";
import { structuralPlacementOf } from "./structuralPageEdits.js";
import { languageDisplayName } from "./support.js";

/**
 * The proposal-card and queued-reply prose, split out of `bookEditIntents.ts`
 * along the seam it grew on: this module is what the user *reads*, that one is
 * what the system *does*.
 *
 * Every page number printed here goes through a {@link ReaderPageNumbering}:
 * with a current PDF page map the sentences speak the printed page numbers the
 * reader can actually see — the same numbers the pdfrx indicator and the
 * printed footer show — while the intent's own `affectedPageIndexes` stay model
 * indexes, because they are what Apply re-resolves and what the deep links use.
 * Without a map the copy is byte-for-byte what it always was.
 */

export function editProposalSummary(
  kind: BookEditIntentKind,
  affectedPageIndexes: number[],
  intent: BookEditIntent,
  numbering: ReaderPageNumbering = MODEL_PAGE_NUMBERING,
  /**
   * A restructure's resolved card numbers, when the caller holds them. The
   * sentence and the chip beside it are drawn from the same plan, so they
   * cannot name different pages — see {@link structuralProposalSummary}.
   */
  structuralPlan?: StructuralCardPlan | undefined
): string {
  if (kind === "plan_revision") {
    // Only ever carded by a credits-blocked revision's resume proposal; the
    // ordinary plan revision path charges without a card.
    return "Revise the book plan";
  }
  if (kind === "continue_book") {
    const chapterCount = intent.continuation?.chapterCount ?? 1;
    return chapterCount > 1
      ? `Write ${chapterCount} new chapters continuing your book`
      : "Write the next chapter of your book";
  }
  if (kind === "restructure_pages") {
    return structuralProposalSummary(intent, numbering, structuralPlan);
  }
  if (kind === "book_replan") {
    return replanProposalSummary(intent);
  }
  if (kind === "add_image") {
    const subject = clippedImageSubject(intent.imageEdit?.subject ?? "a scene from this book");
    const replace = intent.imageEdit?.replace;
    if (replace) {
      // The card is the "shall I replace it?" ask — its summary names both
      // pictures so Apply confirms exactly the swap.
      return replace.oldSubject
        ? `Replace the illustration of “${clippedImageSubject(replace.oldSubject)}” with “${subject}”`
        : `Replace the latest illustration with one of “${subject}”`;
    }
    const onPage =
      intent.imageEdit?.placement === "end_of_book"
        ? undefined
        : intent.imageEdit?.placement === "page"
          ? intent.imageEdit.pageIndex ?? affectedPageIndexes[0]
          : affectedPageIndexes[0];
    return onPage !== undefined
      ? `Add an illustration of “${subject}” on page ${numbering.displayPage(onPage)}`
      : `Add an illustration of “${subject}” at the end of the book`;
  }
  if (kind === "remove_image" || kind === "move_image") {
    return imageLayoutProposalSummary(kind, affectedPageIndexes, intent.imageLayout, numbering);
  }
  if (kind === "chapter_regenerate") {
    return intent.affectedChapterIndex
      ? `Rewrite chapter ${intent.affectedChapterIndex}`
      : "Rewrite that chapter";
  }
  if (intent.scope === "all_pages") {
    return kind === "page_rewrite" ? "Rewrite the whole book" : "Edit the whole book";
  }
  const shown = numbering.displayPages(affectedPageIndexes);
  if (shown.length === 1) {
    return kind === "page_rewrite" ? `Rewrite page ${shown[0]}` : `Edit page ${shown[0]}`;
  }
  if (shown.length > 1) {
    return kind === "page_rewrite" ? `Rewrite pages ${shown.join(", ")}` : `Edit pages ${shown.join(", ")}`;
  }
  return kind === "page_rewrite" ? "Rewrite matching pages" : "Edit matching pages";
}

/**
 * Names the settings the rebuild will use, because the card is the last thing
 * shown before the charge. "Rebuild the plan and regenerate the book" reads the
 * same whether the request was understood or dropped — and when it was dropped,
 * the copy arrives at the old length with no sign anything was missed.
 */
function replanProposalSummary(intent: BookEditIntent): string {
  const language = intent.targetLanguage ? ` ${languageDisplayName(intent.targetLanguage)}` : "";
  const targetPages = intent.replanSettings?.targetPages;
  const length = targetPages === undefined ? "" : ` ${targetPages}-page`;
  const illustrations =
    intent.replanSettings?.fullIllustrations === false
      ? " without illustrations"
      : intent.replanSettings?.fullIllustrations === true
        ? " with illustrations"
        : "";
  // The cover moves the quote too (a designed cover replaces the AI one for
  // free), so a request that dropped it must say so here for the same reason
  // the other settings do.
  const cover = intent.replanSettings?.includeCover === false ? " with a designed cover" : "";
  if (!language && !length && !illustrations && !cover) {
    return "Rebuild the plan and regenerate the book as a new copy";
  }
  return `Rebuild as a new${language}${length} copy${illustrations}${cover}`;
}

/**
 * The confirmation prose. It deliberately never names a price: the credits live
 * in `editProposal.credits`, which the app renders as a tappable badge on the
 * proposal card, so the number is one glance away instead of buried in a
 * sentence the reader has to parse on every edit.
 */
export function editProposalMessage(
  kind: BookEditIntentKind,
  affectedPageIndexes: number[],
  intent: BookEditIntent,
  numbering: ReaderPageNumbering = MODEL_PAGE_NUMBERING,
  /** Passed straight through: the bubble and the card say the same sentence. */
  structuralPlan?: StructuralCardPlan | undefined
): string {
  const summary = editProposalSummary(kind, affectedPageIndexes, intent, numbering, structuralPlan);
  return `${summary}. Tap Apply to confirm, or Cancel to drop it.`;
}

/**
 * The "work is queued" reply. Like {@link editProposalMessage} it stays silent
 * about the price — the charge is on the message as `metadata.creditsCharged`
 * and renders as the badge in the bubble's corner.
 */
export function operationQueuedMessage(
  kind: BookEditIntentKind,
  affectedPageIndexes: number[],
  intent: BookEditIntent,
  numbering: ReaderPageNumbering = MODEL_PAGE_NUMBERING
): string {
  if (kind === "continue_book") {
    const chapterCount = intent.continuation?.chapterCount ?? 1;
    const chapterText = chapterCount > 1 ? `${chapterCount} new chapters` : "the next chapter";
    return `I’ll write ${chapterText} in your book’s voice and refresh the exports.`;
  }
  if (kind === "restructure_pages") {
    const edit = intent.structuralEdit;
    if (edit?.action === "delete") {
      const pages = edit.pageIndexes.length === 1 ? "that page" : "those pages";
      return `I’ll take ${pages} out, renumber the rest of the book and refresh the exports.`;
    }
    if (edit?.action === "move") {
      const pages = edit.pageIndexes.length === 1 ? "that page" : "those pages";
      return `I’ll move ${pages}, renumber the rest of the book and refresh the exports.`;
    }
    // Defaulted once, then *printed from the default*. A missing
    // `structuralEdit` is an insert of one page — the same reading
    // `structuralEditForProposal` applies before anything is charged — and
    // interpolating `edit?.pageCount` again would promise "undefined new pages"
    // the moment the defaulting and the printing disagree.
    const pageCount = edit?.pageCount ?? 1;
    const pages = pageCount === 1 ? "a new page" : `${pageCount} new pages`;
    return `I’ll write ${pages} in your book’s voice, renumber the rest of the book and refresh the exports.`;
  }
  if (kind === "book_replan") {
    return "I’ll rebuild the plan and regenerate the book.";
  }
  if (kind === "add_image") {
    const targetPage = affectedPageIndexes[0];
    const shownPage = targetPage === undefined ? undefined : numbering.displayPage(targetPage);
    if (intent.imageEdit?.replace) {
      const where = shownPage === undefined ? "" : ` on page ${shownPage}`;
      return `I’m creating that illustration now and replacing the one${where}, then I’ll refresh the exports.`;
    }
    // The card said "at the end of the book" for an end placement, so the
    // queued reply says the same — the resolved target page is still a page
    // number, which read as a place the user never named.
    const destination =
      intent.imageEdit?.placement === "end_of_book" || shownPage === undefined
        ? "at the end of the book"
        : `to page ${shownPage}`;
    return `I’m creating that illustration now and adding it ${destination}, then I’ll refresh the exports.`;
  }
  if (kind === "remove_image" || kind === "move_image") {
    return imageLayoutQueuedMessage(kind, affectedPageIndexes, intent.imageLayout, numbering);
  }
  if (kind === "chapter_regenerate") {
    const chapterText = intent.affectedChapterIndex ? `chapter ${intent.affectedChapterIndex}` : "that chapter";
    // With a map the honest parenthetical is the printed span; a page COUNT
    // must stay the model-page count, because that is the priced unit.
    const shown = numbering.displayPages(affectedPageIndexes);
    const span =
      numbering.pdfPageMap && shown.length > 0
        ? shown.length === 1
          ? `page ${shown[0]}`
          : `pages ${shown[0]}–${shown[shown.length - 1]}`
        : `${affectedPageIndexes.length} page${affectedPageIndexes.length === 1 ? "" : "s"}`;
    return `I’ll rewrite ${chapterText} (${span}) with that direction and refresh the exports.`;
  }
  const shown = numbering.displayPages(affectedPageIndexes);
  const pageText =
    intent.scope === "all_pages"
      ? "the whole book"
      : intent.scope === "matching_pages"
        ? shown.length === 1
          ? `the matching text on page ${shown[0]}`
          : `matching text on pages ${shown.join(", ")}`
        : shown.length === 1
          ? `page ${shown[0]}`
          : `pages ${shown.join(", ")}`;
  return kind === "page_rewrite"
    ? `I’ll rewrite ${pageText} and refresh the exports.`
    : `I’ll edit ${pageText} and refresh the exports.`;
}

/**
 * The request as the worker's prompts should see it: the reader's own words
 * plus the mentioned characters' sheets. Only ever applied where the string is
 * handed to a model — job payloads and the plan-revision message — because the
 * bare `message` is what page targeting and exact-replacement parsing read.
 */
export function requestWithCharacterContext(message: string, characterContext: string | undefined): string {
  return characterContext ? `${message}\n\n${characterContext}` : message;
}

/**
 * The same, for the per-page instructions riding the same payload. The worker
 * *substitutes* a page's instruction for the whole request rather than adding to
 * it (`applyBookEdit.ts`), so appending the sheets to `request` alone left every
 * page the reader named — "make page 3 funnier and page 7 shorter" — rewritten
 * with no idea who the mentioned character is, while the unnamed pages in the
 * same edit had the sheet. Only the payload copy is composed: the entries on the
 * intent stay bare, because that is what the card shows and what the resumable
 * pending state rebuilds from.
 */
export function pageInstructionsWithCharacterContext(
  instructions: BookEditPageInstruction[],
  characterContext: string | undefined
): BookEditPageInstruction[] {
  if (!characterContext) {
    return instructions;
  }
  return instructions.map((entry) => ({
    pageIndex: entry.pageIndex,
    instruction: requestWithCharacterContext(entry.instruction, characterContext)
  }));
}

/**
 * The card's own words for a structural edit — how many pages, and where, in
 * the numbering the reader can see.
 *
 * Deliberately unlike the `continue_book` card, which says "Write 8 new
 * chapters" while carrying a quote of `8 × medianChapterSize × perPage`: a
 * reader looking at a four-figure number has no way to tell what it counted.
 *
 * **Where the pages land is {@link structuralPlacementOf}'s answer, and this
 * sentence only chooses the words for it.** The chip drawn beside it is that
 * same answer (`structuralCardBlock`), which is what keeps the two halves of one
 * card from naming different places: the prose used to resolve the anchor
 * itself, so it printed the request's unclamped "after page 100" beside a chip
 * that said page 20, and it named a move's destination on a card whose chip
 * named none. The three placements — and what a `null` anchor means, and what an
 * anchor the page map cannot place means — now have one place to live, and each
 * action keeps only its own preposition here.
 */
function structuralProposalSummary(
  intent: BookEditIntent,
  numbering: ReaderPageNumbering,
  plan?: StructuralCardPlan | undefined
): string {
  const edit = intent.structuralEdit;
  if (!edit) {
    return "Change which pages the book has";
  }
  if (edit.action === "delete") {
    return structuralPagesPhrase("Remove", edit.pageIndexes, numbering);
  }
  const placement = structuralPlacementOf(edit, plan, numbering);
  if (edit.action === "move") {
    const moved = structuralPagesPhrase("Move", edit.pageIndexes, numbering);
    switch (placement.at) {
      case "front":
        return `${moved} to the front of the book`;
      case "end":
        return `${moved} to the end of the book`;
      case "after":
        return `${moved} after page ${placement.readerPage}`;
      case "unnamed":
        // A move the resolver would refuse (it has no destination), or one whose
        // destination the map cannot place. Saying only what is true beats
        // naming the front of the book, which is where this sentence used to
        // send both of them.
        return moved;
    }
  }
  const pages = edit.pageCount === 1 ? "1 new page" : `${edit.pageCount} new pages`;
  switch (placement.at) {
    case "front":
      return `Add ${pages} at the front of the book`;
    case "end":
      return `Add ${pages} at the end of the book`;
    case "after":
      return `Add ${pages} after page ${placement.readerPage}`;
    case "unnamed":
      return `Add ${pages}`;
  }
}

function structuralPagesPhrase(
  verb: "Remove" | "Move",
  pageIndexes: readonly number[],
  numbering: ReaderPageNumbering
): string {
  const shown = numbering.displayPages(pageIndexes);
  if (shown.length === 1) {
    return `${verb} page ${shown[0]}`;
  }
  if (shown.length > 1) {
    return `${verb} pages ${shown.join(", ")}`;
  }
  // A map in force can still name nothing: a version-2 cover sheet has a PDF
  // span and no printed number, so displayPages returns []. Do not interpolate
  // that into "Remove pages " / "Move pages ".
  const pages = pageIndexes.length === 1 ? "that page" : "those pages";
  return `${verb} ${pages}`;
}

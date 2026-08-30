import { type BookEditIntent, type BookEditIntentKind } from "../bookEditIntent.js";
import { clippedImageSubject, imageLayoutProposalSummary, imageLayoutQueuedMessage } from "../bookEditImage.js";
import { MODEL_PAGE_NUMBERING, type ReaderPageNumbering } from "../bookPageNumbering.js";
import { type StructuralCardPlan } from "./pendingEditState.js";
import { structuralActionInstruction } from "./structuralPageEdits.js";
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
  const durableInstruction = intent.editInstruction?.trim();
  if (
    durableInstruction &&
    (kind === "local_patch" ||
      kind === "page_rewrite" ||
      kind === "chapter_regenerate" ||
      kind === "restructure_pages")
  ) {
    // This is the execution contract the reader approves, not preview copy.
    // The router accepts up to 1,200 characters because multi-requirement
    // edits need that space; clipping the card hid requirements that the
    // worker would still execute after Apply.
    return durableInstruction;
  }
  if (kind === "plan_revision") {
    // Only ever carded by a credits-blocked revision's resume proposal; the
    // ordinary plan revision path charges without a card.
    return "Revise the book plan";
  }
  if (kind === "continue_book") {
    const chapterCount = intent.continuation?.chapterCount ?? 1;
    const action = chapterCount > 1
      ? `Write ${chapterCount} new chapters continuing your book`
      : "Write the next chapter of your book";
    // Keep the priced unit visible, but make the reader approve the same
    // standalone content contract Apply persists and the worker executes. A
    // contextual request such as "yes, do that for two chapters" is not a safe
    // substitute once the router has resolved what "that" means.
    return durableInstruction ? `${action}: ${durableInstruction}` : action;
  }
  if (kind === "restructure_pages") {
    return structuralActionInstruction(intent, numbering, structuralPlan);
  }
  if (kind === "book_replan") {
    const action = replanProposalSummary(intent);
    // The settings phrase explains the kind and price of the operation; the
    // durable instruction says what the rebuilt copy must actually become.
    // Both belong on the final confirmation instead of replacing the resolved
    // instruction with generic "rebuild" prose.
    return durableInstruction ? `${action}: ${durableInstruction}` : action;
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
 * Compatibility copy for the few legacy consumers whose model-facing schema
 * still accepts one request string. The durable payload also carries the bare
 * edit instruction and `characterContext` separately; this derived string is
 * never an adherence contract or an input to targeting.
 */
export function requestWithCharacterContext(message: string, characterContext: string | undefined): string {
  return characterContext ? `${message}\n\n${characterContext}` : message;
}

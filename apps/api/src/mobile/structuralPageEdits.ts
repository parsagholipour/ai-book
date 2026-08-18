import { type BookEditIntent } from "../bookEditIntent.js";
import { type ReaderPageNumbering } from "../bookPageNumbering.js";
import { type StructuralCardPlan } from "./pendingEditState.js";
import { type ProjectForChat } from "./projectChat.js";
import {
  MAX_DELETED_PAGES,
  MAX_INSERTED_PAGES,
  MAX_MOVED_PAGES,
  type ExistingPage,
  type StructuralPageEdit,
  type StructuralPagePlan,
  type StructuralPageRefusal
} from "@book-maker/core";

/**
 * The proposal side of insert / delete / move: what the card says, what it
 * refuses, and how the request is squared against the book before it is priced.
 *
 * Split out of `bookEditIntents.ts` because that file is at its size budget and
 * because this is a seam of its own — every other proposal branch there resolves
 * pages that already exist, and this one is the exception that cannot.
 */

/** The pages the resolver needs, assembled from what the chat already loaded. */
export function structuralPagesOf(project: Pick<ProjectForChat, "pages" | "chapters">): ExistingPage[] {
  // `loadProjectForChat` selects the chapter's *index*, not its id, so the id
  // is recovered here — the resolver keys chapter membership by id because that
  // is what the worker writes back to `Chapter.targetPages`.
  const chapterIdByIndex = new Map(project.chapters.map((chapter) => [chapter.index, chapter.id]));
  return project.pages.map((page) => ({
    id: page.id,
    index: page.index,
    chapterId: page.chapter ? (chapterIdByIndex.get(page.chapter.index) ?? null) : null
  }));
}

/**
 * The edit as it will be resolved, **on the proposal side only**.
 *
 * The default when the intent carries none at all is a one-page append, which
 * is what "add a page" means with nothing else said. Everything sharper than
 * that — including the difference between "at the front" (anchor 0) and "no
 * place named" (anchor null) — is already settled on the intent.
 *
 * Guessing is safe here and nowhere else: a proposal reserves nothing, and the
 * card says what the guess was before anything is charged. The Apply reads
 * `intent.structuralEdit` itself and settles for free when it is missing
 * (`queueChatRestructurePages`) — a confirmed intent comes back through
 * `structuralEditFromMetadata`, which drops a stored edit it cannot parse, and
 * defaulting *that* to an append executes an edit the reader never approved.
 */
export function structuralEditForProposal(intent: BookEditIntent): StructuralPageEdit {
  return intent.structuralEdit ?? { action: "insert", anchorPageIndex: null, pageIndexes: [], pageCount: 1 };
}

/**
 * How many pages the card says the edit covers.
 *
 * Each action names its pages in a different field, and a **move names none of
 * them**: reordering creates nothing and removes nothing, so `newPageIndexes`
 * and `removedPageIds` are both empty and `order` is the whole book rather than
 * the part that travels. Reading either of the first two for a move reported
 * "0 pages", so the count comes from the selection the resolver accepted —
 * deduplicated exactly the way `resolveStructuralPageEdit` deduplicates it, and
 * safe to trust because a plan only exists once that resolver has refused every
 * page it could not find.
 */
function structuralPageCount(plan: StructuralPagePlan, edit: StructuralPageEdit): number {
  switch (plan.action) {
    case "insert":
      return plan.newPageIndexes.length;
    case "delete":
      return plan.removedPageIds.length;
    case "move":
      return new Set(edit.pageIndexes).size;
  }
}

/**
 * The card's numbers, before they are put into the reader's numbering.
 *
 * Only the resolver can work these out, and it needs the book: how long it ends
 * up, and where an insert really lands once an anchor past the end has been
 * clamped. So they are stored on the pending edit rather than recomputed — the
 * card rebuilt from that state has an intent and a quote in hand, never the
 * pages — while the printed numbers are left to be rendered at that moment,
 * through whichever numbering is in force then.
 */
export function structuralCardPlanOf(intent: BookEditIntent, plan: StructuralPagePlan): StructuralCardPlan {
  return {
    action: plan.action,
    pageCount: structuralPageCount(plan, structuralEditForProposal(intent)),
    totalPages: plan.totalPages,
    insertAfterIndex: plan.insertAfterIndex
  };
}

/**
 * Where a structural edit puts its pages — the one answer every surface that
 * says it is drawn from.
 *
 * The placements were written out twice, once as prose in
 * `structuralProposalSummary` (`bookEditCopy.ts`) and once as the wire fields
 * below, and the two had already drifted: the sentence named a move's
 * destination while both fields were gated on `action === "insert"`, so the chip
 * beside "Move page 3 after page 5" named no destination at all. One resolved
 * answer is what stops the next placement — or the next reading of a null
 * anchor — landing in one half of a card only.
 *
 * **An insert's landing place is the resolver's answer; a move's is the
 * request's.** `resolveStructuralPageEdit` reads an anchor past the end of the
 * book as an append and clamps it, so an insert names
 * {@link StructuralCardPlan.insertAfterIndex} rather than what was typed — while
 * a plan that is *not* an insert carries no anchor at all (`insertAfterIndex` is
 * `0` on every one of them), so reading it for a move would put every moved page
 * at the front of the book. A move's own anchor needs no clamping: the resolver
 * refuses a move whose destination the book does not hold.
 *
 * The head of the book is the one placement with **no page to name**: model page
 * 0 is not a page, so it is marked rather than numbered.
 *
 * The number is the **end** of the anchor's printed span: a model page can print
 * across two sheets, and what follows it starts after the last of them.
 * `anchorPageIndexFromDecision` takes `Math.max` over a widened "after" anchor on
 * the way in for the same reason. It is read through `printedPageEnd` rather
 * than `displayPageEnd`, which answers a page the map cannot place with the raw
 * model index — the right degradation inside a *list* of pages and the wrong one
 * for a place, because "after page 8" is read as a printed number and would name
 * a sheet holding something else. A page an earlier, not-yet-recompiled edit
 * added is exactly such a page, so a destination this card cannot name is left
 * out of the sentence and off the wire instead, the same way the applied
 * insert's card drops its clause (`insertedPagesLocation`, `editOperationCopy.ts`).
 */
export type StructuralPlacement =
  /** Model anchor `0`: the pages open the book, and no printed number names that. */
  | { at: "front" }
  /** The request named no place at all, which an insert appends. */
  | { at: "end" }
  /** After a page the reader can see, in printed numbering. */
  | { at: "after"; readerPage: number }
  /**
   * Nothing this surface may name: a delete moves nothing, and an anchor the
   * map cannot place is left out rather than approximated.
   */
  | { at: "unnamed" };

export function structuralPlacementOf(
  edit: StructuralPageEdit,
  plan: StructuralCardPlan | undefined,
  numbering: ReaderPageNumbering
): StructuralPlacement {
  if (edit.action === "delete") {
    return { at: "unnamed" };
  }
  if (edit.action === "insert" && edit.anchorPageIndex === null) {
    // Only the request can say this. The resolver clamps a null anchor to the
    // last page, so its plan is indistinguishable from an explicit "after the
    // last page" — while a move with no anchor is refused outright and has no
    // destination to name at all.
    return { at: "end" };
  }
  // No plan is a card rebuilt from a pending state stored before those numbers
  // were kept: the request's own anchor is all such a row has, which is exactly
  // the copy it has always produced.
  const anchor =
    edit.action === "insert" && plan?.action === "insert" ? plan.insertAfterIndex : edit.anchorPageIndex;
  if (anchor === null || !Number.isInteger(anchor) || anchor < 0) {
    return { at: "unnamed" };
  }
  if (anchor === 0) {
    return { at: "front" };
  }
  const readerPage = numbering.printedPageEnd(anchor);
  return readerPage === undefined ? { at: "unnamed" } : { at: "after", readerPage };
}

/**
 * The placement as the app reads it.
 *
 * `placement` is the answer; `atFrontOfBook` and `afterReaderPage` are the same
 * answer in the encoding shipped builds already read, and they keep their exact
 * meaning — such a build still draws the front marker and the anchor number, and
 * still reads a card carrying neither as the append that `end` is. The stored
 * transcripts are why both survive: a card written before this existed carries
 * no `placement`, and the app infers one from those two fields rather than
 * losing the place on every proposal ever made.
 */
function structuralPlacementFields(placement: StructuralPlacement): Record<string, unknown> {
  switch (placement.at) {
    case "front":
      return { placement: "front", atFrontOfBook: true };
    case "after":
      return { placement: "after", afterReaderPage: placement.readerPage };
    case "end":
      return { placement: "end" };
    case "unnamed":
      return { placement: "unnamed" };
  }
}

/**
 * The block the app draws on the card: how many pages, and where.
 *
 * The "where" is {@link structuralPlacementOf}'s answer and nothing else, so the
 * chip and the sentence above it cannot name different places — or, as they once
 * did for a move, one place and none.
 */
export function structuralCardBlock(
  intent: BookEditIntent,
  card: StructuralCardPlan,
  numbering: ReaderPageNumbering
): Record<string, unknown> {
  return {
    action: card.action,
    pageCount: card.pageCount,
    totalPages: card.totalPages,
    ...structuralPlacementFields(structuralPlacementOf(structuralEditForProposal(intent), card, numbering)),
    ...(intent.structuralEdit && intent.structuralEdit.pageIndexes.length > 0
      ? { readerPageNumbers: numbering.displayPages(intent.structuralEdit.pageIndexes) }
      : {})
  };
}

/**
 * What the chat says when the book cannot take the change.
 *
 * Every one of these is a free settlement rather than a failure: nothing was
 * reserved, and the reader gets a sentence naming what is in the way instead of
 * a card they would have to cancel.
 */
export function structuralRefusalMessage(
  reason: StructuralPageRefusal,
  intent: BookEditIntent,
  numbering: ReaderPageNumbering
): string {
  const spoken = intent.structuralEdit?.pageIndexes ?? [];
  const named = spoken.length > 0 ? numbering.displayPages(spoken).join(", ") : "";
  switch (reason) {
    case "no_pages":
      return "This book has no pages yet, so there is nothing to add to or remove.";
    case "unknown_pages":
      return named
        ? `I couldn’t find page ${named} in this book any more, so nothing was changed or charged.`
        : "I couldn’t find the pages that edit named any more, so nothing was changed or charged.";
    case "anchor_out_of_range":
      return "I couldn’t tell where in the book those pages should go. Tell me the page they should follow.";
    case "too_many_pages":
      return structuralTooManyPagesMessage(structuralEditForProposal(intent));
    case "would_empty_book":
      return "That would remove every page of the book. Tell me which pages to keep and I’ll take out the rest.";
    case "would_empty_chapter":
      return "That would leave one of the chapters with no pages at all. Ask me to rewrite or replan the chapter instead.";
    case "anchor_inside_selection":
      return "Those pages can’t move to a place inside themselves. Tell me a page they should follow that isn’t one of them.";
    case "undo_history_too_large":
      return "I couldn’t remove those pages without losing older Undo history, so nothing was changed or charged.";
    case "nothing_to_do":
      return structuralNothingToDoMessage(structuralEditForProposal(intent));
  }
}

/**
 * The one refusal the resolver returns for three different requests.
 *
 * `resolveStructuralPageEdit` answers `nothing_to_do` to an **insert of fewer
 * than one page**, to a **delete or move that named no page at all** — the model
 * wrote the instruction and left the list empty, which is what "delete the
 * boring pages" comes back as — and to a **move already in the order it asked
 * for**. Only the last of those is "already where you asked me to put them", so
 * the other two were answered with a sentence about a different edit, and a
 * reader whose deletion named no page was told nothing they could act on.
 *
 * Naming no page is the same miss `forcedStructuralDecision` (`bookEditIntent.ts`)
 * answers once the clarification budget is spent, and these sentences match its
 * wording deliberately: the two paths answer the same request, and a reader who
 * reaches one after the other must not be told two different things. Asking for
 * the page in prose spends nothing of that budget — a refusal reply carries
 * `pendingEditCancelled` and no `pendingEdit`, so `findPendingScopeClarification`
 * never sees it and it cannot become the second question.
 */
function structuralNothingToDoMessage(edit: StructuralPageEdit): string {
  if (edit.action === "insert") {
    return "I couldn’t tell how many pages to add. Tell me how many, and the page they should follow.";
  }
  if (edit.pageIndexes.length === 0) {
    return edit.action === "delete"
      ? "I couldn’t tell which page to remove. Tell me the page number and I’ll take it out."
      : "I couldn’t tell which page to move. Tell me the page number and where it should go.";
  }
  return "Those pages are already where you asked me to put them, so there’s nothing to change.";
}

/**
 * The cap that was reached, named for the action that reached it.
 *
 * Three caps come back as this one refusal — `MAX_INSERTED_PAGES`,
 * `MAX_DELETED_PAGES` and `MAX_MOVED_PAGES` — and only the delete had an arm, so
 * "move pages 1 to 12 to after page 30" was answered "I can add up to 10 pages
 * at a time": the right number by coincidence, since the insert and move caps
 * happen to be equal, and an instruction about an edit the reader never asked
 * for. The numbers are read from the constants for the same reason the resolver
 * reads them from there — a literal in the copy keeps promising ten after a cap
 * has moved.
 *
 * **The advice differs because the retry does.** Added and removed pages
 * *accumulate*: ten new pages stay in the book, twenty removed ones stay gone,
 * so the same request asked a second time finishes what the first started. A
 * move accumulates nothing — carrying ten of twelve pages across leaves the
 * other two somewhere the reader has to find again, and repeating "move pages
 * 1 to 12" would name a different twelve — so the honest ask is a smaller
 * selection, or moves the reader splits and aims themselves.
 */
function structuralTooManyPagesMessage(edit: StructuralPageEdit): string {
  switch (edit.action) {
    case "insert":
      return `I can add up to ${MAX_INSERTED_PAGES} pages at a time. Ask again for more once these are in.`;
    case "delete":
      return `I can remove up to ${MAX_DELETED_PAGES} pages at a time. Try it in smaller batches.`;
    case "move":
      return `I can move up to ${MAX_MOVED_PAGES} pages at a time. Name fewer pages, or split it into separate moves that each say where those pages go.`;
  }
}

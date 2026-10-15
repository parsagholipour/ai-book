/**
 * What a book edit costs, and which ledger operation it lands under.
 *
 * Split out of `bookEditIntents.ts` so the pricing rules sit next to each other
 * rather than buried among the intent classifiers: these three functions are the
 * complete mapping from "what the user asked for" to "what we charge and how it
 * is recorded", and they are called from both the proposal path (which quotes a
 * price) and the execute path (which charges one).
 */

import {
  createProjectSchema,
  creditPricing,
  estimateBookReplanCreditCost,
  inputWithReplanSettings,
  modelTierFromMediaSettings,
  tierPrice,
  type CreditPricing,
  type ModelTier,
  type ReplanSettings
} from "@book-maker/core";
import { type BookEditIntentKind } from "../bookEditIntent.js";
import { type ProjectForChat } from "./projectChat.js";
import { inputSnapshotFromProject } from "./projectSummarySerializers.js";

/**
 * What pages a finished book *gains* cost: a chat continuation's new chapters
 * and a structural insert's new pages are priced like the book they join — the
 * flat `addedPagesBase`, then the tier's own `fullBookPerPage` for each page —
 * rather than at the rewrite rate, which billed ten more pages above a new
 * ten-page book (launch review, 2026-10-13). No page added is no charge at all,
 * base included: a delete or a move writes nothing.
 *
 * Neither edit draws a picture (`continueBook` and the insert both draft with
 * `illustrate: false`), so there is no image line; one that starts drawing
 * would add `tierPrice(pricing, "imageGeneration", tier)` per picture here.
 * The dashboard buckets the same two keys (`admin/pricingDrivers.ts`).
 */
export function addedPagesCreditCost(pages: number, tier: ModelTier, pricing: CreditPricing = creditPricing()): number {
  const added = Math.max(0, Math.floor(pages));
  return added === 0 ? 0 : pricing.addedPagesBase + added * tierPrice(pricing, "fullBookPerPage", tier);
}

export function bookEditCreditCost(
  kind: BookEditIntentKind,
  affectedPageCount: number,
  project: ProjectForChat,
  options: {
    /**
     * Set when every page in scope was verified to contain the literal text, so
     * the whole edit is a string replacement the worker performs without a
     * single provider call. There is nothing to bill for, and charging anyway is
     * what made a rename feel like a regeneration.
     */
    deterministic?: boolean;
    /**
     * The generation settings a `book_replan` request named. A replan is priced
     * as a whole book, so "make it 3 pages without illustrations" has to be
     * quoted against the book being asked for — read off the project row alone
     * it was billed at the old book's length and image count, both of which the
     * rebuilt book then did not have.
     */
    replanSettings?: ReplanSettings | null | undefined;
  } = {}
): number {
  // One snapshot for the whole quote. Reading the live prices twice could
  // straddle an operator's save and produce a total that no price list explains.
  if (kind === "undo_last_edit" || kind === "redo_last_edit") {
    return 0;
  }
  const pricing = creditPricing();
  // Rewriting a page of a premium book runs the premium prose model, so the
  // per-page rates follow the book's own tier exactly as its generation did.
  // The flat halves (`bookTextEditBase`) do not: they are request overhead, not
  // model spend.
  const tier = modelTierFromMediaSettings(project.mediaSettings);
  if (kind === "local_patch") {
    return options.deterministic
      ? 0
      : pricing.bookTextEditBase + Math.max(1, affectedPageCount) * tierPrice(pricing, "bookTextEditPerPage", tier);
  }
  // Chapter regeneration is priced like a multi-page rewrite of that chapter.
  if (kind === "page_rewrite" || kind === "chapter_regenerate") {
    return Math.max(1, affectedPageCount) * tierPrice(pricing, "pageRegenerationPerPage", tier);
  }
  // A continuation adds the pages it appends — at least one — like a book does.
  if (kind === "continue_book") {
    return addedPagesCreditCost(Math.max(1, affectedPageCount), tier, pricing);
  }
  if (kind === "add_image") {
    // One generated illustration at the book's own tier. No base fee: the
    // request overhead the flat halves cover elsewhere is dwarfed by the image.
    return tierPrice(pricing, "imageGeneration", tier);
  }
  if (kind === "move_image" || kind === "remove_image") {
    return 0;
  }
  if (kind === "book_title") {
    // The title itself is free. An AI cover drawn with the old one in it is
    // redrawn at `coverRegeneration`, which `bookTitleEdits.ts` prices from the
    // cover it finds — something this function has no way to see.
    return 0;
  }
  if (kind === "restructure_pages") {
    // Only the pages a model has to *write*. Deleting and reordering pages
    // calls no provider at all — the same reasoning that prices move_image and
    // remove_image at zero — so `affectedPageCount` here is the resolved plan's
    // `pagesBilled`, which is 0 for those two, and they cost nothing. A page
    // costs the same whether it lands in the middle of the book or, as a
    // continuation, at the end.
    return addedPagesCreditCost(affectedPageCount, tier, pricing);
  }
  if (kind === "book_replan") {
    // The one function the charge's stored quote comes from too
    // (`replanCopyOperations.ts`), so the card and the stop settlement agree.
    const current = createProjectSchema.parse(inputSnapshotFromProject(project));
    const requested = inputWithReplanSettings(current, options.replanSettings);
    return estimateBookReplanCreditCost(requested, pricing).totalCredits;
  }
  // A plan revision runs the planner the first plan ran, so it follows the
  // book's tier exactly as the charge in `queueChargedPlanRevision` does.
  return tierPrice(pricing, "planRevision", tier);
}

export function operationKindForIntent(
  kind: BookEditIntentKind
):
  | "LOCAL_PATCH"
  | "PAGE_REWRITE"
  | "CHAPTER_REGENERATE"
  | "BOOK_REPLAN"
  | "CONTINUE_BOOK"
  | "PLAN_REVISION"
  | "ADD_IMAGE"
  | "MOVE_IMAGE"
  | "REMOVE_IMAGE"
  | "RESTRUCTURE_PAGES"
  | "BOOK_TITLE" {
  if (kind === "book_title") {
    // Only an AI cover's redraw makes a title change a card, and only that card
    // can be cancelled or applied through a claim row.
    return "BOOK_TITLE";
  }
  if (kind === "restructure_pages") {
    // One kind for insert, delete and move: which one it was rides the
    // operation's classifier, so every list that switches on the kind gains a
    // single arm rather than three.
    return "RESTRUCTURE_PAGES";
  }
  if (kind === "page_rewrite") {
    return "PAGE_REWRITE";
  }
  if (kind === "add_image") {
    return "ADD_IMAGE";
  }
  if (kind === "move_image") {
    return "MOVE_IMAGE";
  }
  if (kind === "remove_image") {
    return "REMOVE_IMAGE";
  }
  if (kind === "chapter_regenerate") {
    return "CHAPTER_REGENERATE";
  }
  if (kind === "book_replan") {
    return "BOOK_REPLAN";
  }
  if (kind === "continue_book") {
    return "CONTINUE_BOOK";
  }
  if (kind === "plan_revision") {
    // Reached only from the proposal Cancel path: a plan revision is normally
    // charged without a card, but a credits-blocked one resumes as a proposal,
    // and cancelling that must not be recorded as a text edit.
    return "PLAN_REVISION";
  }
  return "LOCAL_PATCH";
}

export function billingOperationForIntent(
  kind: BookEditIntentKind
): "BOOK_TEXT_EDIT" | "PAGE_REGENERATION" | "BOOK_REPLAN" | "IMAGE_GENERATION" {
  if (kind === "page_rewrite" || kind === "chapter_regenerate" || kind === "continue_book") {
    return "PAGE_REGENERATION";
  }
  // A structural edit that writes pages is priced and recorded as page
  // regeneration; a free delete or move writes no ledger entry at all, so the
  // operation it names never reaches the ledger either way.
  if (kind === "restructure_pages") {
    return "PAGE_REGENERATION";
  }
  if (kind === "book_replan") {
    return "BOOK_REPLAN";
  }
  if (kind === "add_image") {
    return "IMAGE_GENERATION";
  }
  return "BOOK_TEXT_EDIT";
}

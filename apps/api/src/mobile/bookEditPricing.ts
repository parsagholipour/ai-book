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
  creditCostForOperation,
  creditPricing,
  estimateFullBookCreditCost,
  inputWithReplanSettings,
  type ReplanSettings
} from "@book-maker/core";
import { type BookEditIntentKind } from "../bookEditIntent.js";
import { type ProjectForChat } from "./projectChat.js";
import { inputSnapshotFromProject } from "./projectSerializers.js";

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
  const pricing = creditPricing();
  if (kind === "local_patch") {
    return options.deterministic
      ? 0
      : pricing.bookTextEditBase + Math.max(1, affectedPageCount) * pricing.bookTextEditPerPage;
  }
  // Chapter regeneration is priced like a multi-page rewrite of that chapter;
  // continuation is priced like regenerating the pages it will append.
  if (kind === "page_rewrite" || kind === "chapter_regenerate" || kind === "continue_book") {
    return Math.max(1, affectedPageCount) * pricing.pageRegenerationPerPage;
  }
  if (kind === "book_replan") {
    const current = createProjectSchema.parse(inputSnapshotFromProject(project));
    const requested = inputWithReplanSettings(current, options.replanSettings);
    return pricing.bookReplanBase + estimateFullBookCreditCost(requested, pricing).totalCredits;
  }
  return creditCostForOperation("PLAN_REVISION", pricing);
}

export function operationKindForIntent(
  kind: BookEditIntentKind
): "LOCAL_PATCH" | "PAGE_REWRITE" | "CHAPTER_REGENERATE" | "BOOK_REPLAN" | "CONTINUE_BOOK" | "PLAN_REVISION" {
  if (kind === "page_rewrite") {
    return "PAGE_REWRITE";
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

export function billingOperationForIntent(kind: BookEditIntentKind): "BOOK_TEXT_EDIT" | "PAGE_REGENERATION" | "BOOK_REPLAN" {
  if (kind === "page_rewrite" || kind === "chapter_regenerate" || kind === "continue_book") {
    return "PAGE_REGENERATION";
  }
  if (kind === "book_replan") {
    return "BOOK_REPLAN";
  }
  return "BOOK_TEXT_EDIT";
}

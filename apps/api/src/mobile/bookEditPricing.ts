/**
 * What a book edit costs, and which ledger operation it lands under.
 *
 * Split out of `bookEditIntents.ts` so the pricing rules sit next to each other
 * rather than buried among the intent classifiers: these three functions are the
 * complete mapping from "what the user asked for" to "what we charge and how it
 * is recorded", and they are called from both the proposal path (which quotes a
 * price) and the execute path (which charges one).
 */

import { createProjectSchema, creditCostForOperation, creditPricing, estimateFullBookCreditCost } from "@book-maker/core";
import { type BookEditIntentKind } from "../bookEditIntent.js";
import { type ProjectForChat } from "./projectChat.js";
import { inputSnapshotFromProject } from "./projectSerializers.js";

export function bookEditCreditCost(kind: BookEditIntentKind, affectedPageCount: number, project: ProjectForChat): number {
  // One snapshot for the whole quote. Reading the live prices twice could
  // straddle an operator's save and produce a total that no price list explains.
  const pricing = creditPricing();
  if (kind === "local_patch") {
    return pricing.bookTextEditBase + Math.max(1, affectedPageCount) * pricing.bookTextEditPerPage;
  }
  // Chapter regeneration is priced like a multi-page rewrite of that chapter;
  // continuation is priced like regenerating the pages it will append.
  if (kind === "page_rewrite" || kind === "chapter_regenerate" || kind === "continue_book") {
    return Math.max(1, affectedPageCount) * pricing.pageRegenerationPerPage;
  }
  if (kind === "book_replan") {
    const input = createProjectSchema.parse(inputSnapshotFromProject(project));
    return pricing.bookReplanBase + estimateFullBookCreditCost(input, pricing).totalCredits;
  }
  return creditCostForOperation("PLAN_REVISION", pricing);
}

export function operationKindForIntent(
  kind: BookEditIntentKind
): "LOCAL_PATCH" | "PAGE_REWRITE" | "CHAPTER_REGENERATE" | "BOOK_REPLAN" | "CONTINUE_BOOK" {
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

import { backMatterIntent } from "./bookEditBackMatter.js";
import { chapterHeadingEditFromDecision, chapterHeadingIntent } from "./bookEditChapterHeading.js";
import { imageInsertionIntentFromDecision, imageLayoutIntentFromDecision } from "./bookEditImage.js";
import {
  anchorModelPageIndex,
  chapterRegenerateFromMessage,
  continuationRequestFromMessage,
  replanSettingsFromEditMessage,
  showContentTargetFromMessage,
  targetLanguageFromLanguageVersionRequest
} from "./bookEditMessage.js";
import type {
  BookEditChapterContext,
  BookEditIntent,
  BookEditScope
} from "./bookEditIntent.js";
import type { DecideActionPayload } from "./bookEditRouterPrompt.js";
import { structuralPageEditFromMessage } from "./bookEditStructure.js";
import { exactReplacementInstructionMatches, type ExactReplacement } from "@book-maker/core";
import {
  MODEL_PAGE_NUMBERING,
  modelPagesForCopiedPrintedPages,
  type ReaderPageNumbering
} from "./bookPageNumbering.js";

/**
 * Reading the router model's structured answer.
 *
 * The counterpart to `bookEditRouterPrompt.ts`, which holds everything the
 * model is *told*: this file holds how what it says is read back. It imports
 * only types from `bookEditIntent.ts`, so the router keeps its control flow and
 * this keeps the mapping, with no runtime cycle between them.
 */

/**
 * Maps the model's decide/propose_edit payload onto an internal BookEditIntent.
 * Pricing tiers (local_patch vs page_rewrite vs book_replan) are derived here
 * from editTarget + editStyle, never guessed as free-form kind labels.
 */
/** Extra routing context; every field optional so tests and old callers stand. */
export type IntentDecisionContext = {
  clarifyExhausted?: boolean | undefined;
  pageNumbering?: ReaderPageNumbering | undefined;
  /** The model page a reader-selection message was sent from; see classifyProjectChatMessage. */
  readerSelectionPageIndex?: number | undefined;
};

/** One router page channel, re-read as model pages when it holds printed numbers. */
function routedModelPages(
  channel: number[] | null | undefined,
  message: string,
  context: IntentDecisionContext
): number[] {
  const numbering = context.pageNumbering ?? MODEL_PAGE_NUMBERING;
  return modelPagesForCopiedPrintedPages(message, numbering, [channel])?.[0] ?? channel ?? [];
}

/** One page channel read as a set: deduplicated, in the reader's own order. */
function sortedPageIndexes(indexes: readonly number[]): number[] {
  return [...new Set(indexes)].sort((a, b) => a - b);
}

export function intentFromDecideAction(
  decision: DecideActionPayload,
  message: string,
  chapters: BookEditChapterContext[] = [],
  context: IntentDecisionContext = {}
): BookEditIntent {
  if (decision.action === "propose_edit") {
    return intentFromProposeEdit(decision, message, chapters, context);
  }
  if (decision.action === "show_content") {
    return {
      kind: "show_content",
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      affectedPageIndexes: [],
      assistantMessage: decision.assistantMessage,
      scope: "none",
      impact: "small_text",
      clarification: "none",
      contentTarget:
        showContentTargetFromMessage(message, { pdfPageMap: context.pageNumbering?.pdfPageMap }) ?? {
          type: "outline"
        }
    };
  }
  if (decision.action === "undo_last_edit") {
    return {
      kind: "undo_last_edit",
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      affectedPageIndexes: [],
      assistantMessage: decision.assistantMessage,
      scope: "none",
      impact: "small_text",
      clarification: "none"
    };
  }
  if (decision.action === "plan_revision") {
    return {
      kind: "plan_revision",
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      affectedPageIndexes: [],
      assistantMessage: decision.assistantMessage,
      scope: "none",
      impact: "small_text",
      clarification: "none",
      ...(decision.targetLanguage ? { targetLanguage: decision.targetLanguage } : {})
    };
  }
  if (decision.action === "clarify") {
    return {
      kind: "clarify",
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      // The same printed-number guard the propose path applies: forcedDecision
      // turns a clarify that carries pages into an explicit-pages rewrite, so a
      // copied number picks the wrong page here too.
      affectedPageIndexes: routedModelPages(decision.pageIndexes, message, context),
      assistantMessage: decision.assistantMessage,
      scope: "none",
      impact: "small_text",
      // Always "scope", including when the model reports "none": it is what
      // makes handleProjectChatIntent store resumable pendingEdit state. Honour
      // the model's value here and the next turn has nothing to recover, so a
      // fragment like "just add" gets routed on its own.
      clarification: "scope"
    };
  }
  return {
    kind: "answer",
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    affectedPageIndexes: [],
    assistantMessage: decision.assistantMessage,
    scope: "none",
    impact: "small_text",
    clarification: "none"
  };
}

export function intentFromProposeEdit(
  decision: DecideActionPayload,
  message: string,
  chapters: BookEditChapterContext[] = [],
  context: IntentDecisionContext = {}
): BookEditIntent {
  const intent = intentFromProposeEditBase(decision, message, chapters, context);
  return {
    ...intent,
    editInstruction: decision.editInstruction?.trim() || message.trim()
  };
}

function intentFromProposeEditBase(
  decision: DecideActionPayload,
  message: string,
  chapters: BookEditChapterContext[] = [],
  context: IntentDecisionContext = {}
): BookEditIntent {
  const target = decision.editTarget ?? "pages";
  const style = decision.editStyle ?? (decision.replacementFrom ? "exact_replace" : "rewrite");
  // Every page channel re-reads as model pages when the model copied the printed
  // numbers the message speaks. Everything below — including the image targets,
  // whose pageIndexes win over the map-aware message fallbacks — reads them
  // from here rather than off the decision. Each per-page instruction rides its
  // own single-page channel rather than one shared list, because a printed page
  // can hold two model pages and the mapping would otherwise lose which
  // instruction belonged to which page.
  const instructions = decision.perPageInstructions ?? [];
  // The structural anchor rides this call rather than one of its own. The guard
  // fires only when the numbers the router named are exactly the numbers the
  // message speaks, and a move says its source in `pageIndexes` and its
  // destination in the anchor: read in isolation neither channel can ever hold
  // the whole spoken set, so both declined and both stayed printed numbers on
  // the one request that always names two pages.
  const anchorChannel = decision.structuralAnchorPageIndex != null ? [decision.structuralAnchorPageIndex] : [];
  const copied = modelPagesForCopiedPrintedPages(message, context.pageNumbering ?? MODEL_PAGE_NUMBERING, [
    decision.pageIndexes,
    decision.imageDestPageIndexes,
    anchorChannel,
    ...instructions.map((entry) => [entry.pageIndex])
  ]);
  const routed = copied?.[0] ?? decision.pageIndexes ?? [];
  const imageDecision = copied
    ? { ...decision, pageIndexes: routed, imageDestPageIndexes: copied[1] ?? decision.imageDestPageIndexes }
    : decision;
  const routedAnchorPageIndex = anchorPageIndexFromDecision(decision, copied?.[2]);
  const perPageInstructions = instructions.flatMap((entry, offset) =>
    (copied?.[offset + 3] ?? [entry.pageIndex]).map((pageIndex) => ({ pageIndex, instruction: entry.instruction }))
  );
  // The pages the router actually *named*. For a text edit that is only half
  // the set (see below); for a structural one it is the whole of it, which is
  // why the two are kept apart rather than derived from each other.
  const namedPageIndexes = sortedPageIndexes(routed);
  // A page the router wrote an instruction for is a page it asked to edit, so
  // it belongs in the priced set even when the model left it out of
  // pageIndexes. A reader selection still wins: it is a locator, and widening
  // it would charge for pages the reader never pointed at.
  //
  // That widening is a *rewrite* reading and must never reach a delete or a
  // move, where the routed set is the reader's selection rather than a set a
  // charge is spread over: one decision answering "delete page 7 and make
  // page 3 funnier" with `pageIndexes` [7] and an instruction for 3 would take
  // page 3 out of the book. The structural call site below is handed
  // `namedPageIndexes` for exactly that reason.
  const routedPageIndexes = sortedPageIndexes([...routed, ...perPageInstructions.map((entry) => entry.pageIndex)]);
  // The locator's model page is authoritative over parsing the bubble: a
  // copied "page 12" maps to every model page that printed page holds, and
  // adjacent pages routinely share one. Preferring the selection keeps a
  // one-passage rewrite on the page the reader acted on (the quote still
  // narrows via affectedPagesForIntent). A pageless page edit from a
  // selection still targets that page rather than the "which page?" flows.
  const pageIndexes =
    context.readerSelectionPageIndex !== undefined && target === "pages"
      ? [context.readerSelectionPageIndex]
      : routedPageIndexes;
  const chapterIndex = decision.chapterIndex ?? chapterRegenerateFromMessage(message);
  const targetLanguage =
    decision.targetLanguage ?? (target === "language_copy" ? targetLanguageFromLanguageVersionRequest(message) : null);

  if (target === "continuation") {
    const chapterCount = Math.min(
      8,
      Math.max(1, decision.newChapterCount ?? continuationRequestFromMessage(message)?.chapterCount ?? 1)
    );
    return {
      kind: "continue_book",
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      affectedPageIndexes: [],
      assistantMessage: decision.assistantMessage,
      scope: "none",
      impact: "style_rewrite",
      clarification: "none",
      continuation: { chapterCount }
    };
  }

  if (target === "insert_pages" || target === "delete_pages" || target === "move_pages") {
    return structuralIntentFromDecision(target, decision, message, namedPageIndexes, routedAnchorPageIndex, context);
  }

  if (target === "back_matter") {
    // Defaults to removal: the section only exists to be dropped, so a model
    // that picks this target without saying which way meant "take it out".
    return backMatterIntent({ includeSources: decision.backMatterSources ?? false }, decision);
  }

  if (target === "chapter_heading") {
    return chapterHeadingIntent(
      chapterHeadingEditFromDecision(decision.chapterHeadingStyle, decision.chapterHeadingLabel),
      decision
    );
  }

  if (target === "insert_image") {
    return imageInsertionIntentFromDecision(imageDecision, message, context);
  }

  if (target === "move_image" || target === "remove_image") {
    return imageLayoutIntentFromDecision(target === "move_image" ? "move" : "remove", imageDecision, message, context);
  }

  if (target === "language_copy" || target === "structural") {
    const replanSettings = replanSettingsFromEditMessage(message, {
      targetPages: decision.newTargetPages,
      illustrations: decision.illustrationsEnabled
    });
    return {
      kind: "book_replan",
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      affectedPageIndexes: [],
      assistantMessage: decision.assistantMessage,
      scope: "all_pages",
      impact: "structural_replan",
      clarification: "none",
      ...(targetLanguage ? { targetLanguage } : {}),
      ...(replanSettings ? { replanSettings } : {})
    };
  }

  if (target === "chapter") {
    const chapter = chapterIndex ? chapters.find((candidate) => candidate.index === chapterIndex) : undefined;
    return {
      kind: "chapter_regenerate",
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      affectedPageIndexes: chapter?.pageIndexes ?? pageIndexes,
      assistantMessage: decision.assistantMessage,
      scope: "explicit_pages",
      impact: "style_rewrite",
      clarification: chapterIndex ? "none" : "scope",
      affectedChapterIndex: chapterIndex
    };
  }

  const scope: BookEditScope =
    target === "whole_book"
      ? "all_pages"
      : target === "matching"
        ? "matching_pages"
        : pageIndexes.length > 0
          ? "explicit_pages"
          : "none";

  // A pageless "pages" target keeps its edit kind rather than becoming a
  // clarify: the model committed to an edit and wrote assistantMessage as a
  // confirmation of it, so surfacing that text as a clarify reply promises an
  // edit while proposing nothing. proposeBookEdit resolves the target from the
  // message (quoted text) or asks the one real "which page?" question itself.
  // Per-page instructions only ride the two text kinds, and only for pages the
  // edit actually covers: an entry for a page outside the set would be paid for
  // by nobody and applied by nothing.
  const scopedInstructions = perPageInstructions.filter((entry) => pageIndexes.includes(entry.pageIndex));

  if (style === "exact_replace") {
    const editInstruction = decision.editInstruction?.trim() || message.trim();
    const routerReplacement = exactReplacementFromDecision(decision, editInstruction);
    return {
      kind: "local_patch",
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      affectedPageIndexes: pageIndexes,
      assistantMessage: decision.assistantMessage,
      scope,
      impact: "small_text",
      clarification: "none",
      ...(routerReplacement !== undefined ? { exactReplacement: routerReplacement } : {}),
      ...(scopedInstructions.length > 0 ? { perPageInstructions: scopedInstructions } : {})
    };
  }

  return {
    kind: "page_rewrite",
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    affectedPageIndexes: pageIndexes,
    assistantMessage: decision.assistantMessage,
    scope,
    impact: "style_rewrite",
    clarification: "none",
    ...(scopedInstructions.length > 0 ? { perPageInstructions: scopedInstructions } : {})
  };
}

/**
 * `undefined` means the router made no structured claim and the conservative
 * durable-instruction parser may decide later. `null` means it did make a
 * claim, but the pair was incomplete or disagreed with the approved contract;
 * that negative proof must survive proposal reconstruction and redelivery.
 */
function exactReplacementFromDecision(
  decision: DecideActionPayload,
  editInstruction: string
): ExactReplacement | null | undefined {
  const hasFrom = typeof decision.replacementFrom === "string";
  const hasTo = typeof decision.replacementTo === "string";
  if (!hasFrom && !hasTo) return undefined;
  if (!hasFrom || !hasTo) return null;
  const replacement = {
    from: decision.replacementFrom!.trim(),
    to: decision.replacementTo!.trim()
  };
  return exactReplacementInstructionMatches(editInstruction, replacement) ? replacement : null;
}

/**
 * The anchor in model pages, with "before" resolved here rather than by the
 * router.
 *
 * The router used to be told to send one less than the page the reader named
 * whenever they said "before", and that quietly disarmed the copy guard above:
 * a stepped-back number is no longer one the message speaks, so the copy
 * signature never matched, the channel was left exactly as written, and
 * "add a page before page 10" opened the gap after *model* page 9 — a
 * different place entirely on any book with a page map. The router now names
 * the page itself, under the same channel discipline as `pageIndexes`, and the
 * step happens down here, after the translation, where one page back is one
 * page back.
 *
 * Which end of the anchor matters once the translation can widen it, and that
 * rule is `anchorModelPageIndex`'s rather than this function's: the model-free
 * recogniser reads the same "after page 10" off the same map, and
 * `structuralIntentFromDecision` below borrows its anchor whenever the router
 * named none, so a second copy of the rule here is a second answer to one
 * question.
 *
 * Nullish, not falsy, on the way in: 0 is the head of the book, and it is
 * already a model index — the guard filters it out of the copy check and hands
 * it back as is.
 */
function anchorPageIndexFromDecision(
  decision: DecideActionPayload,
  mappedAnchorPages: number[] | undefined
): number | null {
  const pages =
    mappedAnchorPages ?? (decision.structuralAnchorPageIndex != null ? [decision.structuralAnchorPageIndex] : []);
  return anchorModelPageIndex(decision.structuralAnchorPosition === "before" ? "before" : "after", pages);
}

/**
 * A structural page edit, with its anchor read as a printed page number.
 *
 * The anchor is a page channel like any other, so it goes through the same
 * copy guard as `pageIndexes` — in the *same* call, because the guard weighs
 * every channel against the whole message at once. A router that echoed the
 * printed "10" the reader typed would otherwise open the gap after model page
 * 10, which on any book with a page map is a different place entirely.
 *
 * `namedPageIndexes` is the pages the router named and only those: here the
 * routed set is the reader's *selection* — the pages that are removed from the
 * book or relocated inside it — rather than a set a per-page charge is spread
 * over, so the per-page-instruction widening the rewrite path applies has no
 * business in it. A page nobody named would be lost or moved.
 *
 * `affectedPageIndexes` stays empty on purpose — see `BookEditIntent.structuralEdit`.
 */
function structuralIntentFromDecision(
  target: "insert_pages" | "delete_pages" | "move_pages",
  decision: DecideActionPayload,
  message: string,
  namedPageIndexes: number[],
  routedAnchorPageIndex: number | null,
  context: IntentDecisionContext
): BookEditIntent {
  const action = target === "insert_pages" ? "insert" : target === "delete_pages" ? "delete" : "move";
  const map = context.pageNumbering?.pdfPageMap;
  const recognized = structuralPageEditFromMessage(message, [], map ? { pdfPageMap: map } : {});
  // **A recognised anchor belongs to the reading that recognised it**, so it is
  // borrowed only when that reading is the same edit the router routed. The
  // recogniser reads the raw message on its own, and a line carrying two
  // requests resolves to whichever one it reads first: "put a new page after
  // page 5 and shuffle page 2 somewhere sensible" is an insert to it and a move
  // to the router. Taken verbatim, its anchor is one reading's destination
  // wearing the other reading's action — a page reordered to a place named only
  // as where a *new* page would go — and `resolveStructuralPageEdit` performs
  // that placement, with the card showing and charging for it. The fork below
  // already fences `pageIndexes` and `pageCount` by action; the anchor was the
  // one channel left open.
  //
  // Only an insert can be borrowed from here today, and that is a property of
  // this call rather than of the grammar: it passes no pages, and
  // `pageIndexesFromMessage` filters its numbers against the pages it is handed,
  // so the delete and move readings resolve none and never come back anchored.
  // The gate names the action anyway, so handing this call a page list later
  // cannot quietly reopen it in the other direction.
  //
  // `pageCount` needs no gate of its own: only an insert reads it, and a
  // recognition that is not an insert carries 0, which the floor below already
  // reads as "no count named".
  const recognizedAnchorPageIndex =
    recognized?.anchored && recognized.edit.action === action ? recognized.edit.anchorPageIndex : null;
  // Null all the way through when nobody named a place: an insert appends and
  // says so on the card, a move refuses — free, with a sentence asking for the
  // page it should follow. Both are the answer to a request that did not say
  // where, which is exactly what a disagreement leaves behind. Zero is reserved
  // for "the front of the book", which is a different request.
  const anchorPageIndex = routedAnchorPageIndex ?? recognizedAnchorPageIndex;
  // **Floored here, never capped here.** `MAX_INSERTED_PAGES` belongs to
  // `resolveStructuralPageEdit`, which both the proposal and the Apply run, and
  // clamping to it on the way in is the difference between two answers to one
  // request: silently narrowed to ten, "add 12 pages after page 10" resolves as
  // an accepted ten-page insert and the reader is charged for ten with nothing
  // on the card, in the bubble or in the transcript saying two were dropped —
  // while the identical message on the router-outage path keeps its twelve,
  // reaches `too_many_pages` and is answered for free with "I can add up to 10
  // pages at a time. Ask again for more once these are in." The refusal is what
  // both paths owe, so the count travels as asked and the resolver is the only
  // thing that reads the cap. (`structuralPageCount`'s own schema bound is well
  // above the cap for the same reason — a number the router cannot say is a
  // refusal the reader cannot reach.)
  //
  // The floor stays, and it is not the same rule: it turns "no count named"
  // into the one page "add a page" means — the router leaving the field out, and
  // a borrowed recognition that is not an insert, which carries 0.
  const pageCount = Math.max(1, decision.structuralPageCount ?? recognized?.edit.pageCount ?? 1);
  return {
    kind: "restructure_pages",
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    affectedPageIndexes: [],
    assistantMessage: decision.assistantMessage,
    scope: "none",
    impact: "style_rewrite",
    clarification: "none",
    structuralEdit: {
      action,
      anchorPageIndex,
      pageIndexes: action === "insert" ? [] : namedPageIndexes,
      pageCount: action === "insert" ? pageCount : 0
    }
  };
}

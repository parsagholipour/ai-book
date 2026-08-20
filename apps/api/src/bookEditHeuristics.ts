import {
  chapterRegenerateFromMessage,
  continuationRequestFromMessage,
  dislikePreferenceFromMessage,
  hasAllPagesScope,
  hasEditVerbBeyondShow,
  isBookEditScopeOnlyMessage,
  isIdentityChangeSubject,
  isUndoRequestMessage,
  languageDisplayName,
  looksLikeChangeRequest,
  pageIndexesFromMessage,
  pageIndexesMatchingSubject,
  pageIndexesMatchingText,
  replacementTermsFromMessage,
  replanSettingsFromEditMessage,
  showContentTargetFromMessage,
  spokenPageNumbersFromMessage,
  targetLanguageFromLanguageVersionRequest
} from "./bookEditMessage.js";
import type {
  BookEditChapterContext,
  BookEditIntent,
  BookEditPageContext,
  BookEditProjectStage,
  BookEditScope,
  ShowContentTarget
} from "./bookEditIntent.js";
import { MODEL_PAGE_NUMBERING, type ReaderPageNumbering } from "./bookPageNumbering.js";
import { structuralPageEditFromMessage, structuralPageIntent } from "./bookEditStructure.js";
import { totalPrintedPages, type ReplanSettings, type StructuralPageEdit } from "@book-maker/core";

/**
 * How this classification run reads and speaks page numbers, plus the model
 * page a reader-selection message was sent from. Both default to the old
 * model-index behaviour, so no caller and no book without a map moves.
 */
export type HeuristicReaderContext = {
  numbering?: ReaderPageNumbering | undefined;
  selectionPageIndex?: number | undefined;
};

/**
 * The model-free classifier: an English regex tree that routes a chat message
 * without calling a provider.
 *
 * Two callers, two very different jobs. classifyWithHeuristics runs on every
 * turn — it short-circuits the ultra-high-precision read and undo cases and
 * otherwise becomes the hint the router sees. classifyWithDegradedHeuristics
 * only runs when there is no router model, or it timed out or failed, and it
 * deliberately never invents a charged edit kind from regexes alone.
 */

/**
 * High-precision shortcuts only. Charged edit routing belongs to the tool agent;
 * this path is for show/undo short-circuits and degraded fallbacks when the model
 * is unavailable.
 */
export function classifyWithHeuristics(
  message: string,
  stage: BookEditProjectStage,
  pages: BookEditPageContext[],
  planSummary?: string | undefined,
  _chapters: BookEditChapterContext[] = [],
  reader: HeuristicReaderContext = {}
): BookEditIntent {
  const numbering = reader.numbering ?? MODEL_PAGE_NUMBERING;
  const isPlanStage = stage === "plan_ready" || stage === "approved_plan";
  const asksQuestion = /\?$|^(what|why|how|can you explain|tell me|summari[sz]e|where|when)\b/i.test(message.trim());
  const contentTarget = showContentTargetFromMessage(message, { pdfPageMap: numbering.pdfPageMap });

  if (contentTarget && !hasEditVerbBeyondShow(message)) {
    return {
      kind: "show_content",
      confidence: 0.9,
      reasoning: "The user wants to read book content, not change it.",
      affectedPageIndexes: contentTarget.type === "page" ? [contentTarget.index] : [],
      assistantMessage: showContentAcknowledgement(contentTarget, numbering),
      scope: "none",
      impact: "small_text",
      clarification: "none",
      contentTarget
    };
  }

  if (isUndoRequestMessage(message)) {
    return {
      kind: "undo_last_edit",
      confidence: 0.9,
      reasoning: "The user asked to undo the most recent edit.",
      affectedPageIndexes: [],
      assistantMessage: "I’ll undo the last edit and restore the previous version of those pages.",
      scope: "none",
      impact: "small_text",
      clarification: "none"
    };
  }

  if (asksQuestion || !looksLikeChangeRequest(message)) {
    return {
      kind: "answer",
      confidence: 0.78,
      reasoning: "The message reads as a question or general chat, not a change request.",
      affectedPageIndexes: [],
      assistantMessage: isPlanStage ? answerPlanQuestion(message, planSummary) : answerMessage(message, pages, numbering),
      scope: "none",
      impact: "small_text",
      clarification: "none"
    };
  }

  // Degraded fallback: never invent a charged edit kind from English regex trees.
  return {
    kind: "clarify",
    confidence: 0.45,
    reasoning: "Heuristic fallback cannot safely price or target this change without the router.",
    affectedPageIndexes: [],
    assistantMessage: isPlanStage
      ? "I can revise the plan — tell me what to change."
      : "Should I edit a specific page, matching phrase, or the whole book?",
    scope: "none",
    impact: "small_text",
    clarification: "scope"
  };
}

/**
 * The settings a replan may adopt from a message, with the media half dropped
 * when the request named a page.
 *
 * Dropped rather than merely un-counted: these settings ride the intent into the
 * replan, so leaving them on a request that became structural for some other
 * reason would still turn a book's illustrations off because one sentence asked
 * about one page's picture. A length is not scoped that way — "make it 3 pages"
 * is about the book however many pages it names.
 */
function bookWideReplanSettings(
  settings: ReplanSettings | undefined,
  bookWide: boolean
): ReplanSettings | undefined {
  if (!settings || bookWide) {
    return settings;
  }
  const { targetPages } = settings;
  return targetPages === undefined ? undefined : { targetPages };
}

/** What the assistant says it is about to do, before the card names the price. */
function structuralAcknowledgement(edit: StructuralPageEdit): string {
  if (edit.action === "delete") {
    return edit.pageIndexes.length === 1
      ? "I\u2019ll remove that page and renumber the rest of the book."
      : "I\u2019ll remove those pages and renumber the rest of the book.";
  }
  if (edit.action === "move") {
    return "I\u2019ll move those pages and renumber the rest of the book.";
  }
  return edit.pageCount === 1
    ? "I\u2019ll write a new page there and renumber the rest of the book."
    : `I\u2019ll write ${edit.pageCount} new pages there and renumber the rest of the book.`;
}

function continuationAcknowledgement(chapterCount: number): string {
  return chapterCount > 1
    ? `I’ll write ${chapterCount} new chapters that continue your book in its own voice.`
    : "I’ll write the next chapter of your book in its own voice.";
}

export function classifyWithDegradedHeuristics(
  message: string,
  stage: BookEditProjectStage,
  pages: BookEditPageContext[],
  planSummary?: string | undefined,
  chapters: BookEditChapterContext[] = [],
  reader: HeuristicReaderContext = {}
): BookEditIntent {
  const numbering = reader.numbering ?? MODEL_PAGE_NUMBERING;
  const lower = message.toLowerCase();
  const isPlanStage = stage === "plan_ready" || stage === "approved_plan";
  // The selection the reader acted on is authoritative over re-parsing its own
  // composed message; a typed message has no selection and parses as before.
  const explicitPages =
    reader.selectionPageIndex !== undefined && pages.some((page) => page.index === reader.selectionPageIndex)
      ? [reader.selectionPageIndex]
      : pageIndexesFromMessage(message, pages, { pdfPageMap: numbering.pdfPageMap });
  const broadScope = hasAllPagesScope(message);
  const explicitScope: BookEditScope = explicitPages.length > 0 ? "explicit_pages" : broadScope ? "all_pages" : "none";
  const replacement = replacementTermsFromMessage(message);
  const matchedReplacementPages = replacement ? pageIndexesMatchingText(replacement.from, pages) : [];
  const targetLanguage = targetLanguageFromLanguageVersionRequest(message);
  const languageVersionRequest = targetLanguage !== null;
  const hasEditVerb =
    /\b(change|edit|rewrite|revise|fix|replace|rename|swap|switch|remove|delete|add|insert|update|make|turn|shorten|expand|polish|regenerate|move|reorder|restructure|redo|rework)\b/i.test(
      message
    ) || languageVersionRequest;
  const dislike = dislikePreferenceFromMessage(message);
  const hasChangeIntent = hasEditVerb || dislike !== null;
  const asksQuestion = /\?$|^(what|why|how|can you explain|tell me|summari[sz]e|where|when)\b/i.test(message.trim());
  const scopeOnly = isBookEditScopeOnlyMessage(message);
  const contentTarget = showContentTargetFromMessage(message, { pdfPageMap: numbering.pdfPageMap });
  const undoRequest = isUndoRequestMessage(message);
  const chapterRegen = chapterRegenerateFromMessage(message);
  // A new length or a decision about pictures can only be honoured by replanning
  // — a page rewrite cannot change how many pages there are — so naming either
  // one is structural on its own, whatever verb the request used.
  // …but the decision about pictures has to be about the *book*.
  // `negativeMediaPreference` reads "remove … picture" wherever it appears, so a
  // page-scoped picture request — the free `remove_image` the router would have
  // routed — arrived here as a whole-book rebuild that also switched
  // illustrations off for good. Naming a page is what tells the two apart;
  // "remove all the pictures" names none and still replans.
  const bookWide = explicitPages.length === 0 && spokenPageNumbersFromMessage(message).length === 0;
  const replanSettings = bookWideReplanSettings(replanSettingsFromEditMessage(message), bookWide);
  const structural =
    replanSettings?.targetPages !== undefined ||
    replanSettings?.fullIllustrations !== undefined ||
    // "page" deliberately absent: adding or removing particular pages is a
    // structural *page* edit now, and routing it here forked a whole new
    // project and regenerated the book to add three pages to it.
    /\b(add|remove|delete|new)\s+(a\s+)?(chapter|section)\b/i.test(message) ||
    /\b(change|switch|replace|swap|turn|make|move|reorder|restructure)\b.{0,80}\b(audience|premise|book type|length|structure|outline|plan|ending|title|cover|visual identity|illustration style)\b/i.test(
      message
    ) ||
    /\b(change|switch|replace|swap|turn|make)\b.{0,80}\b(main character|character|protagonist|hero|species|animal)\b/i.test(
      message
    ) ||
    /\b(main character|protagonist|hero|species|animal)\b.{0,80}\b(to|with|into)\b/i.test(message) ||
    /\b(move|reorder)\b.{0,60}\b(chapters?|ending|beginning|scenes?|sections?)\b/i.test(message) ||
    /\bmake\s+it\s+(twice|half|much)\b/i.test(lower);

  if (contentTarget && !hasEditVerbBeyondShow(message)) {
    return {
      kind: "show_content",
      confidence: 0.9,
      reasoning: "The user wants to read book content, not change it.",
      affectedPageIndexes: contentTarget.type === "page" ? [contentTarget.index] : [],
      assistantMessage: showContentAcknowledgement(contentTarget, numbering),
      scope: "none",
      impact: "small_text",
      clarification: "none",
      contentTarget
    };
  }

  if (undoRequest) {
    return {
      kind: "undo_last_edit",
      confidence: 0.9,
      reasoning: "The user asked to undo the most recent edit.",
      affectedPageIndexes: [],
      assistantMessage: "I’ll undo the last edit and restore the previous version of those pages.",
      scope: "none",
      impact: "small_text",
      clarification: "none"
    };
  }

  // Before the continuation and before the structural battery: this is the
  // model-free half of insert/delete/move, and without it a router outage turns
  // "add two pages after page 10" into a whole-book quote.
  const structuralPages =
    stage === "complete"
      ? structuralPageEditFromMessage(message, pages, numbering.pdfPageMap ? { pdfPageMap: numbering.pdfPageMap } : {})
      : null;
  if (structuralPages && (structuralPages.anchored || structuralPages.edit.action === "insert")) {
    return structuralPageIntent(structuralPages, {
      confidence: 0.86,
      reasoning: "The user asked to change which pages the book has.",
      assistantMessage: structuralAcknowledgement(structuralPages.edit)
    });
  }

  const continuation = stage === "complete" ? continuationRequestFromMessage(message) : null;
  if (continuation) {
    return {
      kind: "continue_book",
      confidence: 0.86,
      reasoning: "The user asked to continue the book with new chapters.",
      affectedPageIndexes: [],
      assistantMessage: continuationAcknowledgement(continuation.chapterCount),
      scope: "none",
      impact: "style_rewrite",
      clarification: "none",
      continuation
    };
  }

  if (chapterRegen !== null && !isPlanStage) {
    const chapter = chapters.find((candidate) => candidate.index === chapterRegen);
    return {
      kind: "chapter_regenerate",
      confidence: 0.88,
      reasoning: "The user asked to regenerate a specific chapter.",
      affectedPageIndexes: chapter?.pageIndexes ?? [],
      assistantMessage: chapter?.title.trim()
        ? `I’ll rewrite chapter ${chapterRegen} (“${chapter.title}”) with that direction.`
        : `I’ll rewrite chapter ${chapterRegen} with that direction.`,
      scope: "explicit_pages",
      impact: "style_rewrite",
      clarification: "none",
      affectedChapterIndex: chapterRegen
    };
  }
  const patch =
    replacement !== null ||
    /\b(typo|spelling|grammar|punctuation|capitali[sz]ation|rename)\b/i.test(message) ||
    /["“][^"”]{1,160}["”]\s+(to|with|into)\s+["“][^"”]{1,160}["”]/i.test(message);
  const rewrite =
    /\b(rewrite|revise|shorten|expand|polish|regenerate)\b/i.test(message) ||
    /\b(make|change|adjust)\b.{0,80}\b(tone|style|voice|mood|feel|warmer|clearer|simpler|funnier|scarier|softer|gentler|more exciting|more practical|more detailed)\b/i.test(
      message
    );
  const mediaPreference =
    /\b(?:i\s+(?:do\s+not|don't|dont)\s+want|no|without|skip|remove|disable|turn\s+off)\b.{0,80}\b(?:images?|covers?|visuals?|illustrations?|artwork|pictures?)\b/i.test(
      message
    );
  const softPlanChange =
    mediaPreference ||
    /^i\s+(?:want|would like|need|prefer)\b(?!\s+(?:to\s+)?(?:know|understand|ask|see|review|learn|hear)\b)(?=.{0,140}\b(?:audience|reader|readers|tone|style|title|premise|outline|chapters?|examples?|images?|covers?|visuals?|illustrations?|pages?|length|ending|parents|children|kids)\b)/i.test(
      message.trim()
    ) ||
    /\b(?:could|can)\s+(?:it|the\s+(?:book|story|plan|audience|tone|style|title|chapters?|outline))\s+(?:be|have|use|include|focus)\b/i.test(
      message
    ) ||
    /\b(?:audience|reader|readers|tone|style|title|premise|outline|chapters?|examples?|visuals?|illustrations?)\s+should\b/i.test(
      message
    ) ||
    /\bmake\s+it\s+more\b/i.test(message);

  if (scopeOnly) {
    return {
      kind: "clarify",
      confidence: 0.82,
      reasoning: "The message only supplies edit scope and needs a pending edit request to apply it.",
      affectedPageIndexes: [],
      assistantMessage: "What change should I apply to the whole book?",
      scope: broadScope ? "all_pages" : "none",
      impact: "small_text",
      clarification: "scope"
    };
  }

  if (isPlanStage && (hasChangeIntent || softPlanChange)) {
    return {
      kind: "plan_revision",
      confidence: 0.88,
      reasoning: "The project is in a plan stage and the message requests a change.",
      affectedPageIndexes: [],
      assistantMessage:
        stage === "approved_plan"
          ? "I’ll revise the approved plan with that direction so you can review it again."
          : "I’ll revise the book plan with that direction.",
      scope: explicitScope,
      impact: structural ? "structural_replan" : rewrite ? "style_rewrite" : "small_text",
      clarification: "none",
      ...(targetLanguage ? { targetLanguage } : {})
    };
  }

  if (isPlanStage) {
    return {
      kind: "answer",
      confidence: asksQuestion || !hasEditVerb ? 0.84 : 0.76,
      reasoning: "The project is in plan review and the user is asking about the plan rather than generated book text.",
      affectedPageIndexes: [],
      assistantMessage: answerPlanQuestion(message, planSummary),
      scope: "none",
      impact: "small_text",
      clarification: "none"
    };
  }

  if (stage !== "complete") {
    return {
      kind: asksQuestion || !hasChangeIntent ? "answer" : "clarify",
      confidence: asksQuestion || !hasChangeIntent ? 0.82 : 0.7,
      reasoning: "The project is not ready for generated-book edits.",
      affectedPageIndexes: [],
      assistantMessage:
        asksQuestion || !hasChangeIntent
          ? "I can answer questions about this project, but book text edits are available after the book is generated."
          : "I can help with that after the current book work is finished.",
      scope: explicitScope,
      impact: structural ? "structural_replan" : rewrite ? "style_rewrite" : "small_text",
      clarification: hasChangeIntent ? "scope" : "none"
    };
  }

  if (!hasChangeIntent && asksQuestion) {
    return {
      kind: "answer",
      confidence: 0.86,
      reasoning: "The user is asking a general question.",
      affectedPageIndexes: [],
      assistantMessage: answerMessage(message, pages, numbering),
      scope: "none",
      impact: "small_text",
      clarification: "none"
    };
  }

  if (!hasChangeIntent) {
    return {
      kind: "answer",
      confidence: 0.74,
      reasoning: "No edit intent was detected.",
      affectedPageIndexes: [],
      assistantMessage: "I can help with questions about the book or make edits if you tell me what to change.",
      scope: "none",
      impact: "small_text",
      clarification: "none"
    };
  }

  if (languageVersionRequest) {
    return {
      kind: "book_replan",
      confidence: 0.91,
      reasoning: "The user asked to create a generated language version of the completed book.",
      affectedPageIndexes: [],
      assistantMessage: `I’ll create a new ${languageDisplayName(targetLanguage)} copy and regenerate the book there. This book stays unchanged.`,
      scope: "all_pages",
      impact: "structural_replan",
      clarification: "none",
      targetLanguage,
      ...(replanSettings ? { replanSettings } : {})
    };
  }

  if (structural) {
    return {
      kind: "book_replan",
      confidence: 0.9,
      reasoning: "The request changes the book identity, structure, or planning assumptions.",
      affectedPageIndexes: [],
      assistantMessage: "I’ll rebuild the plan and regenerate the book around that change.",
      scope: broadScope ? "all_pages" : explicitScope,
      impact: "structural_replan",
      clarification: "none",
      ...(replanSettings ? { replanSettings } : {})
    };
  }

  if (patch) {
    const scope: BookEditScope =
      explicitScope === "explicit_pages"
        ? "explicit_pages"
        : replacement
          ? "matching_pages"
          : broadScope
            ? "all_pages"
            : "none";
    const affectedPageIndexes = scope === "matching_pages" ? matchedReplacementPages : explicitPages;
    const confident = scope !== "none" || affectedPageIndexes.length > 0 || replacement !== null;
    return {
      kind: confident ? "local_patch" : "clarify",
      confidence: confident ? 0.86 : 0.68,
      reasoning: replacement
        ? "The request is an exact replacement or rename."
        : "The request looks like a small text edit.",
      affectedPageIndexes,
      assistantMessage:
        scope === "explicit_pages"
          ? `I’ll apply that text edit to page ${formatPageList(numbering.displayPages(explicitPages))}.`
          : scope === "matching_pages" || scope === "all_pages"
            ? "I’ll apply that text edit throughout the book where it matches."
            : "Should I change a specific page, matching phrase, or the whole book?",
      scope,
      impact: "small_text",
      clarification: scope === "none" ? "scope" : "none"
    };
  }

  if (rewrite) {
    const canRewrite = explicitScope === "explicit_pages" || broadScope;
    return {
      kind: canRewrite ? "page_rewrite" : "clarify",
      confidence: canRewrite ? 0.86 : 0.68,
      reasoning: "The request is a same-structure rewrite or style edit.",
      affectedPageIndexes: explicitPages,
      assistantMessage:
        explicitScope === "explicit_pages"
          ? `I’ll rewrite page ${formatPageList(numbering.displayPages(explicitPages))} with that direction.`
          : broadScope
            ? "I’ll rewrite the book with that direction while keeping the same structure."
            : "Should I rewrite a specific page or the whole book?",
      scope: explicitScope,
      impact: "style_rewrite",
      clarification: canRewrite ? "none" : "scope"
    };
  }

  if (dislike) {
    if (dislike.subject && isIdentityChangeSubject(dislike.subject)) {
      return {
        kind: "book_replan",
        confidence: 0.85,
        reasoning: "The user dislikes an identity-level part of the book, which needs a replan.",
        affectedPageIndexes: [],
        assistantMessage: "I’ll rebuild the plan and regenerate the book around that change.",
        scope: broadScope ? "all_pages" : explicitScope,
        impact: "structural_replan",
        clarification: "none",
        ...(replanSettings ? { replanSettings } : {})
      };
    }
    if (broadScope) {
      return {
        kind: "page_rewrite",
        confidence: 0.84,
        reasoning: "The user wants existing content changed across the whole book.",
        affectedPageIndexes: [],
        assistantMessage: "I’ll rewrite the book with that direction while keeping the same structure.",
        scope: "all_pages",
        impact: "style_rewrite",
        clarification: "none"
      };
    }
    const matchedPages = dislike.subject ? pageIndexesMatchingSubject(dislike.subject, pages) : [];
    const affectedPageIndexes = explicitPages.length > 0 ? explicitPages : matchedPages;
    if (affectedPageIndexes.length > 0) {
      return {
        kind: "page_rewrite",
        confidence: 0.84,
        reasoning: "The user expressed a preference change about existing content.",
        affectedPageIndexes,
        assistantMessage: `I’ll revise page ${formatPageList(numbering.displayPages(affectedPageIndexes))} with that direction.`,
        scope: explicitPages.length > 0 ? "explicit_pages" : "matching_pages",
        impact: "style_rewrite",
        clarification: "none"
      };
    }
    return {
      kind: "clarify",
      confidence: 0.8,
      reasoning: "The user wants existing content changed but no target pages could be inferred.",
      affectedPageIndexes: [],
      assistantMessage:
        "I can change that. Should I revise the scenes where it appears, specific pages, or the whole book?",
      scope: "none",
      impact: "style_rewrite",
      clarification: "scope"
    };
  }

  return {
    kind: "clarify",
    confidence: 0.62,
    reasoning: "The message appears edit-like but the target is unclear.",
    affectedPageIndexes: explicitPages,
    assistantMessage: "Should I edit a specific page, matching phrase, or the whole book?",
    scope: explicitScope,
    impact: "small_text",
    clarification: "scope"
  };
}

function formatPageList(indexes: number[]): string {
  return indexes.length === 1 ? String(indexes[0]) : indexes.join(", ");
}

function showContentAcknowledgement(target: ShowContentTarget, numbering: ReaderPageNumbering): string {
  if (target.type === "page") {
    return `Here’s page ${numbering.displayPage(target.index)}.`;
  }
  if (target.type === "chapter") {
    return `Here’s chapter ${target.index}.`;
  }
  return "Here’s the current outline.";
}

function answerPlanQuestion(message: string, planSummary?: string | undefined): string {
  const summary = planSummary?.trim();
  if (summary) {
    const firstLines = summary
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join("\n");
    if (/\bsummar/i.test(message) || /\bwhat\b.{0,40}\b(?:plan|about)\b/i.test(message)) {
      return `Here’s the current plan:\n${firstLines}`;
    }
  }
  return "I can answer questions about this plan. If you want something changed, tell me what to adjust and I’ll revise the plan for review.";
}

function answerMessage(message: string, pages: BookEditPageContext[], numbering: ReaderPageNumbering): string {
  const lower = message.toLowerCase();
  if (/\bhow many pages\b/.test(lower)) {
    // The printed count when it is known — the number on the reader's screen —
    // and the manuscript count otherwise.
    return numbering.pdfPageMap
      ? `This book is ${totalPrintedPages(numbering.pdfPageMap)} pages long as compiled, from ${pages.length} generated pages.`
      : `This book currently has ${pages.length} generated pages.`;
  }
  if (/\bsummar/i.test(message)) {
    const pageLines = pages
      .slice(0, 6)
      .map((page) => `Page ${numbering.displayPage(page.index)}: ${page.summary || page.title}`)
      .join("\n");
    return pageLines || "There are no generated pages to summarize yet.";
  }
  return "I can answer questions about the latest book or edit it if you ask for a specific change.";
}

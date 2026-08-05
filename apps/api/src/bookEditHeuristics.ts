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
  quotedTexts,
  replacementTermsFromMessage,
  replanSettingsFromEditMessage,
  showContentTargetFromMessage,
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
  _chapters: BookEditChapterContext[] = []
): BookEditIntent {
  const isPlanStage = stage === "plan_ready" || stage === "approved_plan";
  const asksQuestion = /\?$|^(what|why|how|can you explain|tell me|summari[sz]e|where|when)\b/i.test(message.trim());
  const contentTarget = showContentTargetFromMessage(message);

  if (contentTarget && !hasEditVerbBeyondShow(message)) {
    return {
      kind: "show_content",
      confidence: 0.9,
      reasoning: "The user wants to read book content, not change it.",
      affectedPageIndexes: contentTarget.type === "page" ? [contentTarget.index] : [],
      assistantMessage: showContentAcknowledgement(contentTarget),
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
      assistantMessage: isPlanStage ? answerPlanQuestion(message, planSummary) : answerMessage(message, pages),
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
  chapters: BookEditChapterContext[] = []
): BookEditIntent {
  const lower = message.toLowerCase();
  const isPlanStage = stage === "plan_ready" || stage === "approved_plan";
  const explicitPages = pageIndexesFromMessage(message, pages);
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
  const contentTarget = showContentTargetFromMessage(message);
  const undoRequest = isUndoRequestMessage(message);
  const chapterRegen = chapterRegenerateFromMessage(message);
  // A new length or a decision about pictures can only be honoured by replanning
  // — a page rewrite cannot change how many pages there are — so naming either
  // one is structural on its own, whatever verb the request used.
  const replanSettings = replanSettingsFromEditMessage(message);
  const structural =
    replanSettings?.targetPages !== undefined ||
    replanSettings?.fullIllustrations !== undefined ||
    /\b(add|remove|delete|new)\s+(a\s+)?(chapter|section|page)\b/i.test(message) ||
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
      assistantMessage: showContentAcknowledgement(contentTarget),
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
      assistantMessage: chapter
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
      assistantMessage: answerMessage(message, pages),
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
          ? `I’ll apply that text edit to page ${formatPageList(explicitPages)}.`
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
          ? `I’ll rewrite page ${formatPageList(explicitPages)} with that direction.`
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
        assistantMessage: `I’ll revise page ${formatPageList(affectedPageIndexes)} with that direction.`,
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

function showContentAcknowledgement(target: ShowContentTarget): string {
  if (target.type === "page") {
    return `Here’s page ${target.index}.`;
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

function answerMessage(message: string, pages: BookEditPageContext[]): string {
  const lower = message.toLowerCase();
  if (/\bhow many pages\b/.test(lower)) {
    return `This book currently has ${pages.length} generated pages.`;
  }
  if (/\bsummar/i.test(message)) {
    const pageLines = pages
      .slice(0, 6)
      .map((page) => `Page ${page.index}: ${page.summary || page.title}`)
      .join("\n");
    return pageLines || "There are no generated pages to summarize yet.";
  }
  return "I can answer questions about the latest book or edit it if you ask for a specific change.";
}

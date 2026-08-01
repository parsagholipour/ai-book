import { type BookEditIntent } from "./bookEditIntent.js";

/**
 * "Remove the sources at the end" is not a page edit.
 *
 * The reader-facing Sources list is back matter that `compileBookMarkdown`
 * builds from the project's ResearchSource rows at export time, so it appears
 * in no page's markdown. Routed as a normal edit it would charge for rewriting
 * pages that never contained it and then hand back a recompiled book with the
 * section still there. These requests become a project preference plus a free
 * recompile instead, which is what this module recognises and describes.
 */

export type BackMatterEdit = {
  /** Whether the Sources list should be printed at the end of the book. */
  includeSources: boolean;
};

const SOURCES_SECTION =
  /\b(?:sources?|references?|bibliograph(?:y|ies)|citations?|works\s+cited|further\s+reading)\b/i;
/** "source material", "source code" and friends are about something else entirely. */
const SOURCES_FALSE_FRIEND = /\b(?:open[-\s]source|source\s+(?:material|materials|notes|code|file|files|text))\b/i;
const REMOVE_CUE =
  /\b(?:remove|delete|drop|omit|exclude|hide|cut|erase|strip|get\s+rid\s+of|take\s+(?:it\s+)?out|no\s+more|without|don'?t\s+(?:want|include|show|need|print)|do\s+not\s+(?:want|include|show|need|print))\b/i;
const RESTORE_CUE =
  /\b(?:add|include|show|print|list|keep|restore|i\s+want)\b|\b(?:put|bring)\b[^.!?]{0,40}\bback\b/i;
/** A named page or chapter means the user is pointing at prose, not the back matter. */
const NAMED_LOCATION = /\b(?:pages?|chapters?)\s+\d+/i;
const QUESTION = /^(?:what|why|how|where|when|which|who|can|could|do|does|did|is|are)\b/i;

/**
 * Detects a request to drop or restore the Sources list. High precision by
 * design: anything ambiguous returns null and takes the normal routing path,
 * where the model can still choose the `back_matter` edit target.
 */
export function backMatterEditFromMessage(message: string): BackMatterEdit | null {
  const text = message.replace(/\s+/g, " ").trim();
  if (!SOURCES_SECTION.test(text) || SOURCES_FALSE_FRIEND.test(text) || NAMED_LOCATION.test(text)) {
    return null;
  }
  if (QUESTION.test(text) || text.endsWith("?")) {
    return null;
  }
  if (REMOVE_CUE.test(text)) {
    return { includeSources: false };
  }
  return RESTORE_CUE.test(text) ? { includeSources: true } : null;
}

/** The intent a recognised back-matter request routes to. Always free. */
export function backMatterIntent(
  edit: BackMatterEdit,
  decision: { confidence: number; reasoning: string; assistantMessage: string }
): BookEditIntent {
  return {
    kind: "back_matter",
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    affectedPageIndexes: [],
    assistantMessage: decision.assistantMessage,
    scope: "none",
    impact: "small_text",
    clarification: "none",
    backMatter: edit
  };
}

export function backMatterIntentFromMessage(message: string): BookEditIntent | null {
  const edit = backMatterEditFromMessage(message);
  if (!edit) {
    return null;
  }
  return backMatterIntent(edit, {
    confidence: 0.95,
    reasoning: "The sources list is compiled back matter, not page text.",
    assistantMessage: backMatterAcknowledgement(edit)
  });
}

export function backMatterAcknowledgement(edit: BackMatterEdit): string {
  return edit.includeSources
    ? "I’ll print the sources list at the end of your book again and refresh the exports."
    : "I’ll drop the sources list from the end of your book and refresh the exports.";
}

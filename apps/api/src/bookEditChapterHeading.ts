import { type BookEditIntent } from "./bookEditIntent.js";
import { CHAPTER_HEADING_STYLES, sanitizeChapterHeadingLabel, type ChapterHeadingStyle } from "@book-maker/core";

/**
 * "Don't say Chapter, just show the title" is not a page edit.
 *
 * The word in a chapter heading is never stored anywhere. `compileBookMarkdown`
 * synthesizes `Chapter N: Title` at export time from a label table, and
 * `cleanChapterTitle` actively strips that prefix back off a stored title so it
 * cannot be doubled — so the word appears in no page's markdown and not even in
 * `Chapter.title`. Routed as a normal edit it charges for rewriting every page
 * in the book and then recompiles the exact same heading straight back, which
 * is what happened before this module existed. These requests become a project
 * preference plus a free recompile instead.
 *
 * Same shape and the same precision policy as `bookEditBackMatter.ts`: anything
 * ambiguous returns null and takes the normal routing path, where the model can
 * still choose the `chapter_heading` edit target.
 */

export type ChapterHeadingEdit = {
  style: ChapterHeadingStyle;
  /** Replaces the word "Chapter". Absent means the localized default. */
  label?: string;
};

/** A reference to the chapter label itself — the word, or a "Chapter 3"/"Chapter x" form. */
const CHAPTER_WORD = /\bchapters?\b/i;
/**
 * The request has to be about how a heading *reads*. Without this, "rewrite
 * chapter 3" and "add a chapter" would match on CHAPTER_WORD alone.
 */
const PRESENTATION_CUE =
  /\b(?:heading|headings|header|headers|title|titles|titled|label|labels|labelled|labeled|caption|captions|numbering|numbered|numbers?|name|named|call(?:ed)?|say(?:s|ing)?|word|wording)\b/i;
/** Asking to take the label out. Mirrors bookEditBackMatter's REMOVE_CUE. */
const REMOVE_CUE =
  /\b(?:remove|delete|drop|omit|exclude|hide|cut|erase|strip|skip|get\s+rid\s+of|take\s+(?:it\s+)?out|no\s+more|without|stop|don'?t\s+(?:want|include|show|need|print|say|use|write)|do\s+not\s+(?:want|include|show|need|print|say|use|write)|dislike|don'?t\s+like|hate)\b/i;
/** Asking for a different word, or for the default back. */
const RENAME_CUE = /\b(?:call|rename|replace|change|swap|switch|use|instead|say)\b/i;
/** "just the title", "simply the name", "only show titles". */
const TITLE_ONLY_CUE =
  /\b(?:just|simply|only|merely)\b[^.!?]{0,40}\b(?:titles?|names?|headings?)\b|\b(?:titles?|names?|headings?)\b[^.!?]{0,20}\bonly\b/i;
/** "keep the numbers", "still number them", "1, 2, 3". */
const KEEP_NUMBER_CUE =
  /\b(?:keep|still|but)\b[^.!?]{0,30}\b(?:numbers?|numbering|numbered)\b|\b(?:number|numbered)\s+(?:them|the\s+chapters?)\b/i;
/** Restoring the default wording. */
const RESTORE_CUE = /\b(?:back|restore|again|default|like\s+(?:it\s+)?(?:was|before))\b/i;
/**
 * A numbered page or chapter means the user is pointing at one piece of the
 * book, not at how every heading reads. Same guard, same reason, as
 * `NAMED_LOCATION` in `bookEditBackMatter.ts`.
 */
const NAMED_LOCATION = /\b(?:pages?|chapters?)\s+\d+/i;
/**
 * The label being talked about *as a word* — quoted, called "the word chapter",
 * or written as the pattern "Chapter x".
 *
 * This is what separates "I don't like that we have \"Chapter x\"" from "I don't
 * like the chapter titles, make them shorter": the first is about the label, the
 * second is a real content edit that must keep its normal routing.
 */
const LABEL_AS_WORD =
  /["“”'‘’]\s*chapters?\b|\bthe\s+word\s+["“”'‘’]?chapters?\b|\bchapters?\s+(?:x|n|#)\b/i;
const QUESTION = /^(?:what|why|how|where|when|which|who|can|could|do|does|did|is|are)\b/i;

/**
 * Pulls the replacement word out of "call them Parts", "use Episode instead of
 * Chapter", "say Part instead". Returns undefined when no clean single word is
 * on offer, which downgrades the request to a plain style change.
 */
function customLabelFromMessage(text: string): string | undefined {
  const patterns = [
    /\b(?:call|rename)\s+(?:them|it|the\s+chapters?|each\s+one)?\s*(?:as\s+)?["“']?([\p{L}][\p{L} '’-]{0,22}?)["”']?\s*(?:instead|rather|,|\.|$)/iu,
    /\b(?:use|say|write|prefer|want)\s+(?:the\s+word\s+)?["“']?([\p{L}][\p{L} '’-]{0,22}?)["”']?\s+instead(?:\s+of\s+["“']?chapters?["”']?)?/iu,
    /\b["“']?([\p{L}][\p{L} '’-]{0,22}?)["”']?\s+instead\s+of\s+["“']?chapters?["”']?/iu
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = match?.[1]?.trim();
    // Singularize a plural request ("call them Parts") so the heading reads
    // "Part 1", which is how a label is used in a heading.
    const singular = candidate && /s$/i.test(candidate) && !/ss$/i.test(candidate)
      ? candidate.replace(/s$/i, "")
      : candidate;
    const label = sanitizeChapterHeadingLabel(singular);
    if (label && !/^chapters?$/i.test(label)) {
      return label;
    }
  }
  return undefined;
}

/**
 * Detects a request to restyle chapter headings. Requires both a reference to
 * the chapter label and a presentation cue, so requests about a chapter's
 * *content* can never reach this path.
 */
export function chapterHeadingEditFromMessage(message: string): ChapterHeadingEdit | null {
  const text = message.replace(/\s+/g, " ").trim();
  if (!CHAPTER_WORD.test(text) || !PRESENTATION_CUE.test(text) || NAMED_LOCATION.test(text)) {
    return null;
  }
  if (QUESTION.test(text) || text.endsWith("?")) {
    return null;
  }

  const label = customLabelFromMessage(text);
  if (label) {
    return { style: "label_number_title", label };
  }
  // A restore only counts when it is not also asking to take something out —
  // "put the chapter numbers back" is a restore, "remove it, back to titles" is not.
  if (RESTORE_CUE.test(text) && !REMOVE_CUE.test(text)) {
    return { style: "label_number_title" };
  }
  if (!REMOVE_CUE.test(text) && !RENAME_CUE.test(text)) {
    return null;
  }
  if (TITLE_ONLY_CUE.test(text)) {
    return { style: "title_only" };
  }
  if (KEEP_NUMBER_CUE.test(text)) {
    return { style: "number_title" };
  }
  // Nothing said about what to keep. Only act when the message named the label
  // *as a word*: "I don't like the chapter titles" is a request to rewrite those
  // titles and has to keep its normal routing, while "I don't like the word
  // \"Chapter\"" is this. Drop the label, keep the numbering they never mentioned.
  return REMOVE_CUE.test(text) && LABEL_AS_WORD.test(text) ? { style: "number_title" } : null;
}

/** The intent a recognised chapter-heading request routes to. Always free. */
export function chapterHeadingIntent(
  edit: ChapterHeadingEdit,
  decision: { confidence: number; reasoning: string; assistantMessage: string }
): BookEditIntent {
  return {
    kind: "chapter_heading",
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    affectedPageIndexes: [],
    assistantMessage: decision.assistantMessage,
    scope: "none",
    impact: "small_text",
    clarification: "none",
    chapterHeading: edit
  };
}

export function chapterHeadingIntentFromMessage(message: string): BookEditIntent | null {
  const edit = chapterHeadingEditFromMessage(message);
  if (!edit) {
    return null;
  }
  return chapterHeadingIntent(edit, {
    confidence: 0.95,
    reasoning: "Chapter headings are built at export time, not stored in page text.",
    assistantMessage: chapterHeadingAcknowledgement(edit)
  });
}

/** Normalizes whatever the router model returned into a usable edit. */
export function chapterHeadingEditFromDecision(
  style: string | null | undefined,
  label: string | null | undefined
): ChapterHeadingEdit {
  const resolved = CHAPTER_HEADING_STYLES.find((candidate) => candidate === style) ?? "title_only";
  const clean = sanitizeChapterHeadingLabel(label);
  // A label only means anything alongside the label style; asking for
  // "1. Title" and supplying a word at the same time is a contradiction, and
  // the style the user named is the one they can see.
  return resolved === "label_number_title" && clean ? { style: resolved, label: clean } : { style: resolved };
}

export function chapterHeadingAcknowledgement(edit: ChapterHeadingEdit): string {
  if (edit.label) {
    return `I’ll head each chapter with “${edit.label} 1”, “${edit.label} 2” and so on, then refresh the exports.`;
  }
  if (edit.style === "title_only") {
    return "I’ll drop the “Chapter” label and the numbering so each chapter opens with just its title, then refresh the exports.";
  }
  if (edit.style === "number_title") {
    return "I’ll drop the word “Chapter” and head each one with just its number and title, then refresh the exports.";
  }
  return "I’ll put the “Chapter” heading back and refresh the exports.";
}

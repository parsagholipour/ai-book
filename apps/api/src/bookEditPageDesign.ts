import { type BookEditIntent } from "./bookEditIntent.js";
import {
  allStoryPageDesigns,
  isStoryPageDesignId,
  requestedStoryPageDesign,
  storyPageDesign,
  type StoryPageDesignId
} from "@book-maker/core";

/**
 * "Make the pages look like the night sky" is not a page edit.
 *
 * A picture book printed without illustrations wears a page design — a card,
 * its colours, a few drawn shapes, a face (`storyPageDesigns.ts` in core) — and
 * the design is a project preference the compile reads, never page text. So
 * changing it is the same free recompile as the Sources list and the chapter
 * headings: one `mediaSettings` field, no model, no charge.
 *
 * Same precision policy as `bookEditChapterHeading.ts`: anything ambiguous
 * returns null and takes the normal routing path, where the router can still
 * choose the `page_design` edit target. What must never land here is a request
 * about what the book *says* — "rewrite page 3 to be about the sea", "make the
 * story darker", "change the writing style" — because a free reprint would
 * answer a real edit with nothing.
 */

export type PageDesignEdit = {
  /** The design asked for; null asks for "something different". */
  design: StoryPageDesignId | null;
  /** Set when the message asks which designs there are: a reply, no change. */
  list?: true;
};

/** A word about how the pages look. */
const LOOK_WORD =
  /\b(?:designs?|layouts?|looks?|style[sd]?|themes?|themed|colou?rs?|colou?r scheme|backgrounds?|decorations?)\b/i;
/**
 * The page design itself, for a change that names no design: "change the
 * design", "a different layout", "I don't like how the pages look". A look-word
 * alone is not enough there — "change the theme to friendship" is the story's
 * theme and "I don't like the colours" may be anything's — so those go to the
 * router, which knows the `page_design` target and the rest of the book.
 */
const PAGE_LOOK =
  /\b(?:designs?|layouts?|colou?r ?schemes?)\b|\b(?:pages?|sheets?)\b[^.!?]{0,25}\b(?:looks?|style|styles|colou?rs?|backgrounds?|themes?)\b|\b(?:looks?|style|colou?rs?|backgrounds?|theme)s?\s+of\s+(?:the\s+)?(?:pages?|sheets?)\b/i;
/** Asking for a different one. */
const CHANGE_CUE =
  /\b(?:change|switch|swap|another|different|new|other|try|update|replace|redo)\b|\b(?:don'?t|do not)\s+(?:like|love|want)\b|\b(?:dislike|hate|boring|ugly)\b/i;
/** Disliking the design that follows, in the same clause. */
const NEGATION = /\b(?:don'?t|do not|didn'?t|not|no more|dislike|hate|instead of|rather than|get rid of|tired of)\b/i;
/** "What designs can I choose?" */
const LIST_QUESTION =
  /\b(?:what|which)\b[^.!?]{0,40}\b(?:designs?|layouts?|styles?|themes?|looks?)\b[^.!?]{0,40}\b(?:are there|available|can i|could i|do you have|to choose|to pick|options?|offer)\b|\b(?:list|show me)\b[^.!?]{0,20}\b(?:designs?|layouts?|page styles?|themes?)\b|\b(?:designs?|layouts?|themes?)\b[^.!?]{0,20}\b(?:options|choices|are available)\b/i;
/** One numbered place in the book: an edit of that place, not of every page's look. */
const NAMED_LOCATION = /\b(?:pages?|chapters?|scenes?)\s+\d+/i;
/**
 * The look of something other than the page sheets, or "style" and "theme"
 * meaning the writing: each of these is a different edit with its own route.
 */
const NOT_THE_PAGES =
  /\b(?:cover|illustrations?|pictures?|images?|drawings?|art(?:work)?|photos?|font|typeface)\b|\b(?:writing|prose|narrative|text|story|language|voice|tone)\s+(?:style|design|look|theme)s?\b|\b(?:style|tone|voice|theme)s?\s+(?:of|in)\s+(?:the\s+)?(?:writing|text|prose|story|book|language|words)\b|\b(?:story|book)'?s?\s+(?:theme|style)s?\b|\btheme\s+(?:is|about|of)\b/i;

/**
 * Detects a request to change, name or list the page design. Requires a word
 * about how the pages look, so a request about their content can never reach
 * this path.
 */
export function pageDesignEditFromMessage(message: string): PageDesignEdit | null {
  const text = message.replace(/\s+/g, " ").trim();
  if (!LOOK_WORD.test(text) || NAMED_LOCATION.test(text) || NOT_THE_PAGES.test(text)) {
    return null;
  }
  if (LIST_QUESTION.test(text)) {
    return { design: null, list: true };
  }
  const named = requestedStoryPageDesign(text);
  if (named && !namedOnlyToRefuse(text, named)) {
    return { design: named };
  }
  if (named || (CHANGE_CUE.test(text) && PAGE_LOOK.test(text))) {
    return { design: null };
  }
  return null;
}

/**
 * "I don't like the night sky design": a design named in the clause that
 * refuses it is a request for any other one. Only the clause the name sits in
 * is read, so "instead of the night sky, use the ocean" still names the ocean.
 */
function namedOnlyToRefuse(text: string, design: StoryPageDesignId): boolean {
  const match = storyPageDesign(design).names.exec(text);
  if (!match) {
    return false;
  }
  const before = text.slice(0, match.index);
  const clause = before.slice(Math.max(before.lastIndexOf(","), before.lastIndexOf(";"), before.lastIndexOf(".")) + 1);
  return NEGATION.test(clause);
}

/** The intent a recognised page-design request routes to. Always free. */
export function pageDesignIntent(
  edit: PageDesignEdit,
  decision: { confidence: number; reasoning: string; assistantMessage: string }
): BookEditIntent {
  return {
    kind: "page_design",
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    affectedPageIndexes: [],
    assistantMessage: decision.assistantMessage,
    scope: "none",
    impact: "small_text",
    clarification: "none",
    pageDesign: edit
  };
}

export function pageDesignIntentFromMessage(message: string): BookEditIntent | null {
  const edit = pageDesignEditFromMessage(message);
  if (!edit) {
    return null;
  }
  return pageDesignIntent(edit, {
    confidence: 0.95,
    reasoning: "A page design is a compile preference, not page text.",
    assistantMessage: pageDesignAcknowledgement(edit)
  });
}

/** Normalizes whatever the router model returned into a usable edit. */
export function pageDesignEditFromDecision(design: string | null | undefined): PageDesignEdit {
  return { design: isStoryPageDesignId(design) ? design : null };
}

export function pageDesignAcknowledgement(edit: PageDesignEdit): string {
  if (edit.list) {
    return "Here are the designs your pages can be printed in.";
  }
  return edit.design
    ? `I’ll print your pages in the ${storyPageDesign(edit.design).label} design and refresh the exports.`
    : "I’ll give your pages a different design and refresh the exports.";
}

/** One line per design, the one in use marked, for the chat's light markdown. */
export function pageDesignCatalogLines(current: StoryPageDesignId | undefined): string {
  return allStoryPageDesigns()
    .map((design) => `- **${design.label}**${design.id === current ? " (now)" : ""} — ${design.summary}`)
    .join("\n");
}

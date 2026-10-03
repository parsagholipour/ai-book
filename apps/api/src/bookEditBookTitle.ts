import { type BookEditIntent } from "./bookEditIntent.js";

/**
 * "Change the book title to Dinner Made Simple" is not a page edit, and it was
 * quoted as a 550-credit whole-book rebuild (2026-10-02): nothing recognised it,
 * the router prompt had no place for it, and a title reads like "the book's
 * identity", which the prompt sends to `structural`. The title is printed from
 * the project row and the plan — the cover, the title page, the file names and
 * the EPUB and Word metadata — and no page holds it.
 *
 * Same precision policy as `bookEditChapterHeading.ts`: only a title the reader
 * spelled out is read here. A request to *invent* one ("make the title
 * catchier"), a question, or a title request with a second edit attached
 * returns null and takes the normal routing path, where the router can still
 * choose the `book_title` edit target.
 */

/** The longest title the chat will set; past this it is a paragraph, not a title. */
export const MAX_BOOK_TITLE_LENGTH = 160;

const BOOK_WORD = String.raw`(?:the|this|my|our)\s+(?:book|story|novel|guide|manuscript)`;
const COURTESY = String.raw`(?:(?:please|pls|kindly|just|(?:can|could|would|will)\s+you|i\s+(?:want|need|would\s+like|['’]d\s+like)\s+(?:you\s+)?to|let['’]?s|go\s+ahead\s+and)\s+)*`;

/** The shapes a reader names a new title in; the capture is the title itself. */
const TITLE_REQUESTS: readonly RegExp[] = [
  // "change the title to X", "set the book's title to X", "update the title of the book to X"
  new RegExp(
    String.raw`^${COURTESY}(?:change|set|update|switch|make|edit)\s+(?:(?:the|my|this)\s+)?(?:book(?:['’]s)?\s+)?title(?:\s+of\s+${BOOK_WORD})?\s+(?:to|into|as|be)\s+(.+)$`,
    "i"
  ),
  // "rename the book to X", "retitle my book X"
  new RegExp(String.raw`^${COURTESY}(?:rename|retitle)\s+${BOOK_WORD}(?:\s+(?:to|as))?\s+(.+)$`, "i"),
  // "call the book X", "title the book X", "name my story X"
  new RegExp(String.raw`^${COURTESY}(?:call|title|name)\s+${BOOK_WORD}\s+(.+)$`, "i"),
  // "the new title should be X", "the title should be X", "new title: X"
  new RegExp(String.raw`^(?:the\s+)?(?:new\s+)?(?:book(?:['’]s)?\s+)?title\s+(?:should\s+be|will\s+be|is\s+now)\s*:?\s+(.+)$`, "i"),
  new RegExp(String.raw`^new\s+(?:book\s+)?title\s*[:\-–—]\s*(.+)$`, "i")
];

/** Words that ask for a title to be invented, never spelled out. */
const INVENT_CUE =
  /\b(?:something|anything|better|catchier|funnier|shorter|longer|snappier|punchier|more|less|different|else|suggest|ideas?|options?)\b/i;
/** A second request riding after the title. */
const SECOND_REQUEST =
  /\b(?:and|then|also|plus)\s+(?:make|rewrite|write|change|add|delete|remove|fix|turn|keep|move|update|redraw|replace)\b/i;

/**
 * A title the reader spelled out, cleaned for printing, or undefined.
 *
 * Quotes are a boundary the reader drew, so a quoted title is taken whole
 * whatever it says; what follows the closing quote may only be punctuation or
 * courtesy. Unquoted, the rest of the message is the title, which is why it
 * may neither ask for one to be invented nor carry a second request.
 */
export function spokenBookTitle(captured: string, options: { askedAsQuestion?: boolean } = {}): string | undefined {
  const raw = captured.trim();
  const quoted = /^["“”'‘’«](.+?)["“”'‘’»]\s*(.*)$/u.exec(raw);
  if (quoted) {
    const tail = quoted[2]?.trim() ?? "";
    if (tail && !/^(?:[.!?,]\s*)?(?:(?:please|thanks|thank\s+you)\s*[.!?]?)?$/i.test(tail)) {
      return undefined;
    }
    return sanitizeBookTitle(quoted[1], { keepFinalStop: true });
  }
  if (INVENT_CUE.test(raw) || SECOND_REQUEST.test(raw)) {
    return undefined;
  }
  const unquoted = raw.replace(/\s*,?\s*(?:please|thanks|thank\s+you)\s*[.!?]?$/i, "");
  // "Can you change the title to Supper Club?" asks; the mark is the request's.
  return sanitizeBookTitle(options.askedAsQuestion ? unquoted.replace(/\?+$/, "") : unquoted);
}

/** One line of printable title, or undefined when nothing printable is left. */
export function sanitizeBookTitle(
  value: string | null | undefined,
  options: { keepFinalStop?: boolean } = {}
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const unwrapped = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["“”'‘’«]+|["“”'‘’»]+$/gu, "")
    .trim();
  // A sentence's full stop is not part of the title, and "?" and "!" can be;
  // inside quotes the reader drew the edges, so even the stop is theirs.
  const title = options.keepFinalStop ? unwrapped : unwrapped.replace(/\.+$/, "").trim();
  if (!title || title.length > MAX_BOOK_TITLE_LENGTH || !/[\p{L}\p{N}]/u.test(title)) {
    return undefined;
  }
  return title;
}

/** The title a message asks the book to have, or null. */
export function bookTitleFromMessage(message: string): string | null {
  const text = message.replace(/\s+/g, " ").trim();
  if (!text) {
    return null;
  }
  // Every shape below opens on a request, so a question about the title
  // ("what is the title?") matches none of them; one that asks for the change
  // ("can you change the title to X?") has its own mark read off the title.
  const askedAsQuestion = /^(?:can|could|would|will)\s+you\b/i.test(text) && text.endsWith("?");
  for (const pattern of TITLE_REQUESTS) {
    const captured = pattern.exec(text)?.[1];
    if (captured) {
      return spokenBookTitle(captured, { askedAsQuestion }) ?? null;
    }
  }
  return null;
}

/** The intent a title change routes to. Free unless the cover is AI artwork. */
export function bookTitleIntent(
  title: string,
  decision: { confidence: number; reasoning: string; assistantMessage: string }
): BookEditIntent {
  return {
    kind: "book_title",
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    affectedPageIndexes: [],
    assistantMessage: decision.assistantMessage,
    scope: "none",
    impact: "small_text",
    clarification: "none",
    bookTitle: title
  };
}

export function bookTitleIntentFromMessage(message: string): BookEditIntent | null {
  const title = bookTitleFromMessage(message);
  if (!title) {
    return null;
  }
  return bookTitleIntent(title, {
    confidence: 0.95,
    reasoning: "The book's title is printed from the project and its plan, not from any page.",
    assistantMessage: `I’ll retitle the book “${title}”.`
  });
}

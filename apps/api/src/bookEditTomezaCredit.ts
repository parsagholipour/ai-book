import { BOOK_WORD, COURTESY } from "./bookEditBookTitle.js";
import { type BookEditIntent } from "./bookEditIntent.js";

/**
 * "Remove the Made with Tomeza line" is not a page edit. The line is the free
 * tier's credit, printed on the matter sheet or at the title page's foot by
 * the compile, from the owner's plan — no page holds it, so routed as a rewrite
 * it was priced for pages that cannot hold it, and forcedDecision's whole-book
 * widening would have quoted every page of the book. It is a free
 * `tomeza_credit` intent applied by `removeTomezaCredit`
 * (`mobile/tomezaCreditEdits.ts`): a subscriber's book is reprinted without it,
 * a free account is told it comes with a plan.
 *
 * Same precision policy as `bookEditBookTitle.ts`: only a message that is, in
 * full, a request to take the line off is read here — it names Tomeza with a
 * credit word ("credit", "branding", "watermark", "line"…) or the label's own
 * words, and asks to remove or hide it. A question about the line ("what is
 * the Made with Tomeza line?", "can I remove it?") or a request with a second
 * edit attached returns null and takes the normal routing path, where the
 * router answers it or chooses the `tomeza_credit` target.
 */

/** The label's own words, quoted or not: "Made with Tomeza". */
const MADE_WITH_TOMEZA = String.raw`["“”'‘’«]?made\s+with\s+tomeza[.!]?["“”'‘’»]?`;
/** What a reader calls the line. */
const CREDIT_WORD = String.raw`(?:credit|branding|brand|watermark|line|text|logo|mark|label|tag|footer|imprint|attribution|signature|name|note|stamp|bit|words?|message)s?`;
const DETERMINER = String.raw`(?:(?:the|that|this|its|my|your|any|a)\s+)?`;
/** "the Made with Tomeza line", "Tomeza branding", "the text that says Made with Tomeza". */
const TOMEZA_LINE = String.raw`${DETERMINER}(?:${MADE_WITH_TOMEZA}(?:\s+${CREDIT_WORD}){0,2}|tomeza(?:['’]s)?(?:\s+${CREDIT_WORD}){1,2}|${CREDIT_WORD}\s+(?:that\s+)?(?:says|reads|saying|reading)\s+${MADE_WITH_TOMEZA})`;
/** Where in this book the reader says it sits. Another book, or every book, is not this request. */
const PLACE = String.raw`(?:\s+(?:from|in|on|off|out\s+of|of|at)\s+(?:it|${BOOK_WORD}|(?:the|my|this|its)\s+(?:(?:title|copyright|credits?|front|first|last|matter)\s+)?(?:page|sheet)|the\s+(?:bottom|foot|end|front|start|beginning)(?:\s+of\s+(?:the\s+)?(?:title\s+page|first\s+page|page|book|story))?|(?:the|my|this)\s+(?:pdf|epub|exports?|files?|downloads?)))?`;
/** What may follow a request that is already whole. */
const TAIL = String.raw`\s*,?\s*(?:please|thanks|thank\s+you)?\s*[.!]*\s*`;
const REMOVE_VERB = String.raw`(?:remove|delete|drop|hide|erase|strip|clear|cut|lose|ditch|get\s+rid\s+of|take\s+(?:out|away|off|down))`;

/** Every shape a reader asks for the line to go in, whole-message. */
const SHAPES: readonly RegExp[] = [
  // "remove the Made with Tomeza line", "hide the Tomeza watermark from my book"
  new RegExp(String.raw`^${COURTESY}${REMOVE_VERB}\s+${TOMEZA_LINE}${PLACE}${TAIL}$`, "i"),
  // "take the Tomeza credit off", "get the made with tomeza line out of the book"
  new RegExp(String.raw`^${COURTESY}(?:take|get)\s+${TOMEZA_LINE}\s+(?:out|away|off|down)${PLACE}${TAIL}$`, "i"),
  // "I don't want the Tomeza branding", "no Made with Tomeza line please"
  new RegExp(
    String.raw`^(?:(?:i\s+)?(?:don['’]?t|do\s+not)\s+want\s+|no\s+(?:more\s+)?)${TOMEZA_LINE}${PLACE}(?:\s+(?:anymore|any\s+more))?${TAIL}$`,
    "i"
  ),
  // "print it without the Made with Tomeza line"
  new RegExp(
    String.raw`^${COURTESY}(?:print|export|make|publish|save|give\s+me)\s+(?:it|${BOOK_WORD})\s+without\s+${TOMEZA_LINE}${TAIL}$`,
    "i"
  ),
  // "I want the Tomeza watermark removed", "I'd like the made with tomeza line gone"
  new RegExp(
    String.raw`^i(?:\s+(?:want|would\s+like)|['’]d\s+like)\s+${TOMEZA_LINE}${PLACE}\s+(?:removed|gone|deleted|hidden|taken\s+(?:off|out))${TAIL}$`,
    "i"
  )
];

/** Whether the whole message asks for the line to come off this book. */
export function isTomezaCreditRemoval(message: string): boolean {
  let text = message.replace(/[^\S\n]+/g, " ").trim();
  // A clarification's merged follow-up is the router's to read.
  if (!text || text.includes("\n") || /Follow-up from the user:/.test(message)) {
    return false;
  }
  // "Can you remove the Tomeza credit?" asks; the mark is the request's.
  if (/^(?:can|could|would|will)\s+you\b/i.test(text) && text.endsWith("?")) {
    text = text.replace(/\?+$/, "").trim();
  }
  return SHAPES.some((shape) => shape.test(text));
}

const LOOSE_CREDIT =
  /\bmade\s+with\s+tomeza\b|\btomeza(?:['’]s)?\s+(?:credit|brand|branding|watermark|line|text|logo|mark|label|tag|footer|imprint|attribution|signature|name|note|stamp)s?\b/i;
const REMOVAL_CUE =
  /\b(?:remove|removed|delete|deleted|drop|hide|hidden|erase|strip|clear|cut|lose|ditch|get\s+rid\s+of|take\s+(?:\S+\s+){0,5}(?:out|away|off|down)|without|gone|(?:don['’]?t|do\s+not)\s+want|no\s+(?:more\s+)?(?:made|tomeza))\b/i;
const SECOND_REQUEST =
  /\b(?:and|then|also|plus)\s+(?:make|rewrite|write|change|add|delete|remove|fix|turn|keep|move|update|redraw|replace)\b/i;
const QUESTION_OPENING =
  /^(?:who|what|why|how|where|when|which|is|are|does|did|has|have|can\s+i|could\s+i|should\s+i|do\s+i|do\s+you|will\s+it|would\s+it)\b/i;

/**
 * A model-free reading of "take the Tomeza line off" — loose, for the degraded
 * path only, where the alternative is a clarify and then a whole-book rewrite
 * card. A question about the line, or the line with a second edit, is not it.
 */
export function mentionsTomezaCreditRemoval(message: string): boolean {
  const text = message.replace(/\s+/g, " ").trim();
  if (!LOOSE_CREDIT.test(text) || !REMOVAL_CUE.test(text) || SECOND_REQUEST.test(text)) {
    return false;
  }
  const request = /^(?:can|could|would|will)\s+you\b/i.test(text);
  return request || !(text.endsWith("?") || QUESTION_OPENING.test(text));
}

/** The intent a request to take the line off routes to. Free on any plan; a free account is answered. */
export function tomezaCreditIntent(decision: {
  confidence: number;
  reasoning: string;
  assistantMessage: string;
}): BookEditIntent {
  return {
    kind: "tomeza_credit",
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    affectedPageIndexes: [],
    assistantMessage: decision.assistantMessage,
    scope: "none",
    impact: "small_text",
    clarification: "none"
  };
}

export function tomezaCreditIntentFromMessage(message: string): BookEditIntent | null {
  if (!isTomezaCreditRemoval(message)) {
    return null;
  }
  return tomezaCreditIntent({
    confidence: 0.95,
    reasoning: "The “Made with Tomeza” line is printed from the owner's plan, never from a page.",
    assistantMessage: "I’ll take the “Made with Tomeza” line off this book."
  });
}

import { normalizeNumerals, type StructuralPageEdit } from "@book-maker/core";
import type { BookEditIntent, BookEditPageContext } from "./bookEditIntent.js";
import {
  anchorModelPageIndex,
  DIGIT_PAGE_ELEMENT_SOURCE,
  NAMED_PAGE_LIST_SOURCE,
  ORDINAL_PAGE_SOURCE,
  PAGE_LIST_SEPARATOR_SOURCE,
  pageAnchorFromMessage,
  pageIndexesFromMessage,
  type ReaderPageNumberContext
} from "./bookEditMessage.js";

/**
 * Recognising "add three pages after page 10", "delete page 7", "move page 12
 * to after page 4" without asking a model.
 *
 * The model-free path is not a nicety here. Before this existed, "add a page"
 * matched the structural battery in `classifyWithDegradedHeuristics` and became
 * a `book_replan`, which forks a **whole new project** and regenerates the book
 * from scratch — priced as a whole book. A router outage turning "add two pages
 * after page 10" into that is the same shape as the 960-credit heading
 * incident, and the fix is the same: recognise it deterministically.
 *
 * Its sibling on the model path is the `insert_pages` / `delete_pages` /
 * `move_pages` targets in `bookEditRouterPrompt.ts`.
 */

const COUNT_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  another: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10
};

const COUNT_WORD_SOURCE = Object.keys(COUNT_WORDS).join("|");

/**
 * "Add N pages", in the shapes readers actually type. The page word has to
 * follow the count, which is what keeps it away from "add a picture to page 3":
 * that names a page, it does not ask for one.
 *
 * "Put" begins both readings — "put a page after page 3" asks for a new one,
 * "put page 3 after page 1" moves the one that exists — and with the count
 * optional this pattern matches either. That is why the move is read first: see
 * `structuralPageEditFromMessage`.
 *
 * The optional count is also why this one needs `PAGE_ATTRIBUTE_VETO` as much as
 * the other two: with nothing required between the verb and the page word,
 * "add page numbers to the book" and "write a page turner" both asked for a new
 * page, and an insert is the reading that costs credits.
 *
 * The page word is captured so `NUMBERED_PAGE_OBJECT_VETO` can be asked about
 * it, for the same reason.
 */
const INSERT_PATTERN = new RegExp(
  String.raw`\b(?:add|insert|append|write|put)\s+(?:in\s+)?(\d{1,2}|${COUNT_WORD_SOURCE})?\s*(?:more\s+|new\s+|extra\s+|additional\s+|blank\s+|empty\s+)*(pages?)\b`,
  "i"
);
/**
 * A page that does not exist yet cannot be numbered, so an insert's page word
 * may never be the head of a page the message *names*.
 *
 * This is the last thing standing between a free reorder and a charged new
 * page. "Put" begins both readings and the move reading only claims a request
 * whose destination it can resolve, so every phrasing whose destination this
 * file cannot read — "put page 3 last", "put page 3's picture at the end" —
 * fell through to the insert reading, where `put\s*page` matches and
 * `PAGE_ATTRIBUTE_VETO` sees " 3 last" and stands down. Each one became a card
 * offering to *write* a page, at `pageRegenerationPerPage`, on the router
 * outage path this recogniser exists to make safe. Declining is the right
 * answer rather than a lesser one: an unrecognised request falls through to
 * the rest of the heuristic tree and is answered with the one clarifying
 * question, which is free.
 *
 * It is the same grammar `pageIndexesFromMessage` reads, anchored at the page
 * word, so the two cannot disagree about whether the message named a page.
 */
const NUMBERED_PAGE_OBJECT_VETO = new RegExp(`^${NAMED_PAGE_LIST_SOURCE}`, "i");
/**
 * What may stand between a delete or a move verb and the page it acts on.
 *
 * A closed list, and that is the whole point. These two patterns used to allow
 * twenty arbitrary characters there, which does not say "the page" — it says
 * "a page word somewhere nearby", and nearby is where a reader writes what the
 * page *holds*: "remove the picture on page 3" was read as a whole-page delete,
 * as were the title, the last line and the photo on a page, and "move the
 * picture on page 3 to after page 5" moved the page. Nothing ahead of this
 * recogniser catches those — the model-free path has no image recogniser and no
 * patch recogniser by design (see `classifyProjectChatMessage`) — so whatever
 * these patterns claim is what the request becomes: a card offering to renumber
 * the book, for two edits that are free and touch no page at all.
 */
/** Whitespace, but never a line break: the object has to be in the same line as its verb. */
const PAGE_OBJECT_GAP = String.raw`[^\S\r\n]+`;
const PAGE_OBJECT_DETERMINER = String.raw`(?:(?:the|this|that|these|those)\s+)?`;
const PAGE_OBJECT_QUALIFIER = String.raw`(?:(?:whole|entire|complete|blank|empty|duplicate|extra|other|next|previous)\s+)*`;
/**
 * The rest of a list the object opened: "delete page 2 and page 4" is one
 * request, while "delete page 3, it repeats page 7" is one page and a reason.
 * A separator must be followed by a number, which is what separates them.
 */
const PAGE_OBJECT_TAIL = `(?:${PAGE_LIST_SEPARATOR_SOURCE}(?:pages?\\s+)?${DIGIT_PAGE_ELEMENT_SOURCE})*`;
/**
 * The object has to be a page the message actually *names* — "page 3", "pages
 * 2-4", "the 3rd page". A bare page word is not enough: "delete the page after
 * page 4" named no page to remove and used to remove page 4, which is not even
 * the page it asked about.
 */
const PAGE_OBJECT_SOURCE = `${PAGE_OBJECT_DETERMINER}${PAGE_OBJECT_QUALIFIER}(?:${NAMED_PAGE_LIST_SOURCE}|${ORDINAL_PAGE_SOURCE})${PAGE_OBJECT_TAIL}`;

const DELETE_PATTERN = new RegExp(
  String.raw`\b(?:delete|remove|drop|cut|get\s+rid\s+of|take\s+out)${PAGE_OBJECT_GAP}${PAGE_OBJECT_SOURCE}`,
  "i"
);
const MOVE_PATTERN = new RegExp(
  String.raw`\b(?:move|reorder|relocate|shift|put)${PAGE_OBJECT_GAP}${PAGE_OBJECT_SOURCE}`,
  "i"
);

/**
 * The exceptions, stated rather than approximated.
 *
 * A page word can be a locator instead of an object even when it stands right
 * where the object goes, and the tell is the word after it: "add page numbers",
 * "delete page 3's picture", "remove the page numbers", "write a page turner".
 * Every one of those matched, and the first two matched a *charged* reading.
 */
const PAGE_ATTRIBUTE_VETO =
  /^(?:['’]s|s['’])?\s*(?:number|numbering|break|count|size|margin|header|footer|title|heading|layout|border|background|colou?r|turner|picture|image|photo|illustration|drawing|artwork|caption|text|line|sentence|paragraph|word)s?\b/i;
/** "Cut page 3 down to half" asks for a shorter page, not for one page fewer. */
const SHORTENING_VETO = /^\s*(?:down\b|in\s+half\b|by\s+half\b|shorter\b|to\s+\d{1,4}\s+(?:words?|lines?|sentences?)\b)/i;
/** A refusal is not a request: "please don't delete page 3" removes nothing. */
const NEGATED_REQUEST = /\b(?:do\s+not|don['’]?t|never)\s+$/i;

/**
 * A verb whose object really is the page, with the exceptions applied.
 *
 * Returns the match so the caller can read the object clause back out of it:
 * the pages a structural edit targets come from *that span*, never from the
 * whole message, or "delete page 3, it repeats page 7" deletes both.
 */
function pageObjectMatch(text: string, pattern: RegExp): RegExpExecArray | null {
  const match = pattern.exec(text);
  if (!match) {
    return null;
  }
  if (NEGATED_REQUEST.test(text.slice(0, match.index))) {
    return null;
  }
  return PAGE_ATTRIBUTE_VETO.test(text.slice(match.index + match[0].length)) ? null : match;
}

/**
 * Whether an insert match's page word is really an existing page's, read from
 * the page word itself rather than from what follows the whole clause — the
 * count sits *before* the page word ("add 3 pages"), so a number after it is
 * never the count and always the page's own.
 */
function insertObjectIsANamedPage(text: string, insert: RegExpExecArray): boolean {
  const pageWord = insert[2];
  if (pageWord === undefined) {
    return false;
  }
  return NUMBERED_PAGE_OBJECT_VETO.test(text.slice(insert.index + insert[0].length - pageWord.length));
}

export type StructuralRecognition = {
  edit: StructuralPageEdit;
  /** True when the message named a place; false means the caller must ask or default. */
  anchored: boolean;
};

/**
 * Reads a structural page request out of a message, or null.
 *
 * Deliberately conservative about the *anchor*: an unanchored insert is still a
 * real request ("add two pages"), and the proposal path asks the one "after
 * which page?" question for it, so returning it unanchored is better than
 * refusing to recognise it at all. An unanchored **delete** is not — there is
 * no safe default page to remove — so it comes back with no pages and the
 * caller declines.
 *
 * Just as deliberately unconservative about *what was asked*: every reading
 * here needs the verb's own object to be a page the message names, and a
 * request that is only about something printed on a page falls through to the
 * rest of the heuristic tree rather than being answered with a page delete.
 *
 * The three readings are tried delete, move, insert, and that order is the one
 * thing here that is load-bearing. "Put" is both an insert verb and a move verb,
 * and the insert pattern's count is optional, so "put page 3 after page 1"
 * matches the insert pattern as well: read insert-first it became one new page
 * after page 1 and the page the reader pointed at never moved. The move reading
 * is the narrower one — it needs a destination *and* some other page named as
 * the thing to move — so trying it first costs the insert nothing: "put a page
 * after page 3" names no page to move and falls straight through.
 *
 * Order alone is not enough, though, because the move reading also stands down
 * over a destination it cannot resolve, and what it falls through to is the
 * charged reading. `NUMBERED_PAGE_OBJECT_VETO` is the other half: an insert's
 * page word may not be one the message numbered.
 */
export function structuralPageEditFromMessage(
  message: string,
  pages: BookEditPageContext[],
  context: ReaderPageNumberContext = {}
): StructuralRecognition | null {
  const text = normalizeNumerals(message);
  if (/\?\s*$/.test(text.trim())) {
    return null;
  }
  const anchor = pageAnchorFromMessage(message, context);
  // Null, not 0, when the caller passed no pages: `reduce`'s seed makes an
  // empty book and a one-page book the same number, and "at the end" resolved
  // against that lands an insert at the *front*. `intentFromDecideAction` calls
  // in with no page context on purpose, so this is the ordinary case, not an
  // edge one.
  const lastIndex = pages.length > 0 ? pages.reduce((highest, page) => Math.max(highest, page.index), 0) : null;

  const deleted = pageObjectMatch(text, DELETE_PATTERN);
  if (deleted && !SHORTENING_VETO.test(text.slice(deleted.index + deleted[0].length))) {
    // Read out of the object clause alone. A delete has no anchor — the pages
    // it names are the pages it removes — so anything the message says after
    // them is a reason, a second request or a place, and none of those is a
    // page to delete.
    const pageIndexes = pageIndexesFromMessage(deleted[0], pages, context);
    return {
      edit: { action: "delete", anchorPageIndex: null, pageIndexes, pageCount: 0 },
      anchored: pageIndexes.length > 0
    };
  }

  const moved = pageObjectMatch(text, MOVE_PATTERN);
  // The sources come from the object clause, the destination from the anchor
  // clause the whole message carries ("after page 1", "at the end").
  const move = moved ? movePageEdit(anchor, pageIndexesFromMessage(moved[0], pages, context), lastIndex) : null;
  if (move) {
    return move;
  }

  const insert = pageObjectMatch(text, INSERT_PATTERN);
  if (insert && !insertObjectIsANamedPage(text, insert)) {
    const token = insert[1]?.toLowerCase();
    const parsed = token ? (COUNT_WORDS[token] ?? Number.parseInt(token, 10)) : 1;
    const pageCount = Number.isFinite(parsed) ? Math.max(1, parsed) : 1;
    const anchorPageIndex = insertAnchorIndex(anchor, lastIndex);
    return {
      edit: { action: "insert", anchorPageIndex, pageIndexes: [], pageCount },
      anchored: anchorPageIndex !== null
    };
  }

  return null;
}

/**
 * A move names two places: the destination is the one the anchor clause
 * resolved, and the sources are the pages its own object clause named.
 *
 * Null rather than a refusal when either half is missing, because the caller
 * still has the insert reading to try — "put a page after page 3" names a
 * destination and nothing to move, and it is an insert.
 *
 * **"At the end" is a destination a move can express**, and it used to be the
 * one it turned down: the last page's own index is what "after which page?"
 * means there, and `resolveStructuralPageEdit` reads it like any other anchor.
 * Refusing it sent "put page 3 at the end" — a free reorder — down to the
 * insert reading, which offered to write a new page instead. With no pages to
 * measure there is still no end to name, and the request comes back null, the
 * same thing `insertAnchorIndex` says for the same reason.
 *
 * The destination is a *sheet*, so it is a set of model pages, and none of them
 * is a page to move: "put page 10 at the end" when printed page 10 is already
 * the last sheet asks for nothing at all.
 */
function movePageEdit(
  anchor: ReturnType<typeof pageAnchorFromMessage>,
  namedPages: number[],
  lastIndex: number | null
): StructuralRecognition | null {
  if (!anchor) {
    return null;
  }
  const destination = anchor.position === "end" ? (lastIndex === null ? [] : [lastIndex]) : anchor.pageIndexes;
  const anchorPageIndex = anchorModelPageIndex(anchor.position === "before" ? "before" : "after", destination);
  if (anchorPageIndex === null) {
    return null;
  }
  const sources = namedPages.filter((index) => !destination.includes(index));
  if (sources.length === 0) {
    return null;
  }
  return {
    edit: { action: "move", anchorPageIndex, pageIndexes: sources, pageCount: 0 },
    anchored: true
  };
}

/**
 * Where an insert lands, in "after this page" terms.
 *
 * "Before page 5" is "after page 4", and "before page 1" is the head of the
 * book, which is index 0 rather than a refusal — a reader asking for a new
 * opening page is asking for something real. Both readings are
 * `anchorModelPageIndex`'s, shared with the router path: a printed sheet
 * holding several model pages puts "after" past the last of them and "before"
 * ahead of the first, and stepping back the wrong end of that set is a gap
 * opened mid-sheet.
 *
 * "At the end" needs a book to be the end *of*: with no pages to measure it
 * comes back null, which the callers already read as "append", i.e. the place
 * the reader named. Returning a number there would be index 0 — the front.
 */
function insertAnchorIndex(
  anchor: ReturnType<typeof pageAnchorFromMessage>,
  lastIndex: number | null
): number | null {
  if (!anchor) {
    return null;
  }
  if (anchor.position === "end") {
    return lastIndex;
  }
  return anchorModelPageIndex(anchor.position, anchor.pageIndexes);
}

/** The intent a recognised structural request becomes. */
export function structuralPageIntent(
  recognition: StructuralRecognition,
  decision: { confidence: number; reasoning: string; assistantMessage: string }
): BookEditIntent {
  return {
    kind: "restructure_pages",
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    // The pages a structural edit touches are decided by the worker against the
    // book as it is then, so this stays empty: filling it would send the
    // request through `affectedPagesForIntent`, whose "which page?" question
    // and obsolete-proposal settlement both assume pages that already exist.
    affectedPageIndexes: [],
    assistantMessage: decision.assistantMessage,
    scope: "none",
    impact: "style_rewrite",
    clarification: "none",
    structuralEdit: recognition.edit
  };
}

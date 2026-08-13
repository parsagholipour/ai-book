import {
  explicitTargetPagesFromText,
  LANGUAGE_CLAUSE_END_GUARD,
  LANGUAGE_NAME_CODES,
  languageNamePattern,
  normalizeNumerals,
  normalizeProjectLanguage,
  replanSettingsFromMessage,
  type ReplanSettings
} from "@book-maker/core";
import type {
  BookEditPageContext,
  BookEditReplacement,
  BookEditScope,
  ShowContentTarget
} from "./bookEditIntent.js";

/**
 * Reading a user's chat message: page and chapter references, quoted text,
 * replacement terms, scope words, target languages, read-vs-edit intent and
 * dissatisfaction phrasing.
 *
 * Pure text in, plain values out — no model, no intent objects, no reply copy.
 * Both the router mapping in bookEditIntent.ts and the model-free classifier in
 * bookEditHeuristics.ts read messages through here, which is why it is a leaf.
 */

export type BookEditDislikePreference = {
  /** What the user objects to, when the message names it. */
  subject: string | null;
};

/**
 * Detects dissatisfaction or preference statements about existing content
 * ("I don't like X", "X should be Y", "too much Z"). These carry edit intent
 * even without an imperative edit verb, so they must never route to answer.
 */
export function dislikePreferenceFromMessage(message: string): BookEditDislikePreference | null {
  const text = message.trim();
  if (/\?\s*$/.test(text) || /^(?:what|why|how|where|when|who|which|can you explain|tell me)\b/i.test(text)) {
    return null;
  }
  const subjectPatterns = [
    /\bi\s+(?:really\s+|just\s+)?(?:do\s+not|don'?t|didn'?t|did\s+not)\s+(?:like|love|enjoy|want)\s+(.{2,120}?)(?=[.,;:!\n]|$)/i,
    /\bi\s+(?:really\s+)?(?:hate|dislike)\s+(.{2,120}?)(?=[.,;:!\n]|$)/i,
    /\bi(?:'m|\s+am)\s+not\s+(?:a\s+fan\s+of|happy\s+with|comfortable\s+with|okay\s+with|ok\s+with)\s+(.{2,120}?)(?=[.,;:!\n]|$)/i,
    /\b(?:there(?:'s|\s+is)\s+)?(?:way\s+|far\s+)?too\s+(?:much|many)\s+(.{2,80}?)(?=[.,;:!\n]|$)/i
  ];
  for (const pattern of subjectPatterns) {
    const match = text.match(pattern);
    const subject = match?.[1]
      ?.trim()
      .replace(/^(?:a|an|the)\s+/i, "")
      .replace(/\s+/g, " ");
    if (subject) {
      return { subject };
    }
  }
  const directive =
    /\b(?:this|that|it|they|she|he)\s+(?:really\s+)?should(?:n'?t|\s+not)?\s+(?:be|feel|stay|remain|happen|sound|read|have|include)\b/i.test(
      text
    ) ||
    (/\bshould\s+(?:be|feel|stay|remain|happen)\b/i.test(text) && !/\bshould\s+(?:i|we|you)\b/i.test(text)) ||
    /\bi\s+(?:would\s+)?prefer\b/i.test(text) ||
    /\bi'?d\s+rather\b/i.test(text);
  return directive ? { subject: null } : null;
}

const dislikeSubjectStopTerms = new Set([
  "the", "and", "that", "this", "these", "those", "with", "without", "from", "into", "onto", "over", "under",
  "part", "parts", "scene", "scenes", "chapter", "chapters", "page", "pages", "book", "story", "bit", "bits",
  "thing", "things", "stuff", "whole", "entire", "very", "really", "much", "many", "more", "less", "some", "all",
  "being", "having", "just", "then", "than", "when", "where", "how", "his", "her", "its", "their"
]);

/** Pages whose title, summary, or preview mention a significant word of the disliked subject. */
export function pageIndexesMatchingSubject(subject: string, pages: BookEditPageContext[]): number[] {
  const terms = [
    ...new Set(
      (subject.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((term) => !dislikeSubjectStopTerms.has(term))
    )
  ];
  if (terms.length === 0) {
    return [];
  }
  return pages
    .filter((page) => {
      const haystack = `${page.title} ${page.summary} ${page.previewText}`.toLowerCase();
      return terms.some(
        (term) => haystack.includes(term) || (term.endsWith("s") && haystack.includes(term.slice(0, -1)))
      );
    })
    .map((page) => page.index)
    .sort((a, b) => a - b);
}

const continuationNumberWords: Record<string, number> = {
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
  eight: 8
};

/**
 * Detects "continue my book" requests: keep writing, write the next chapter,
 * add N more chapters, finish the story. Returns the requested chapter count
 * (default 1) or null when the message is not a continuation request.
 */
export function continuationRequestFromMessage(message: string): { chapterCount: number } | null {
  const text = message.trim();
  if (/\?\s*$/.test(text)) {
    return null;
  }
  const addChapters = text.match(
    /\b(?:add|write|create|generate|give\s+me)\s+(?:(\d{1,2}|a|an|another|one|two|three|four|five|six|seven|eight)\s+)?(?:more\s+|new\s+|additional\s+|extra\s+)*chapters?\b/i
  );
  const nextChapter = text.match(
    /\b(?:write|start|draft|do)\s+(?:the\s+)?next\s+(?:(\d{1,2}|two|three|four|five)\s+)?chapters?\b/i
  );
  const continueBook =
    /\b(?:continue|keep\s+going\s+with|keep\s+writing|carry\s+on\s+with|pick\s+up)\b.{0,60}\b(?:book|story|novel|manuscript|writing|where\s+(?:i|it|we)\s+left\s+off)\b/i.test(
      text
    ) || /^(?:continue|keep\s+going|keep\s+writing)[.!\s]*$/i.test(text);
  const finishBook = /\b(?:finish|complete)\s+(?:writing\s+)?(?:the\s+|my\s+)?(?:book|story|novel|manuscript)\b/i.test(text);
  if (!addChapters && !nextChapter && !continueBook && !finishBook) {
    return null;
  }
  const countToken = (addChapters?.[1] ?? nextChapter?.[1])?.toLowerCase();
  const parsed = countToken ? continuationNumberWords[countToken] ?? Number.parseInt(countToken, 10) : 1;
  const chapterCount = Number.isFinite(parsed) ? Math.min(8, Math.max(1, parsed)) : 1;
  return { chapterCount };
}

export function looksLikeChangeRequest(message: string): boolean {
  return (
    dislikePreferenceFromMessage(message) !== null ||
    targetLanguageFromLanguageVersionRequest(message) !== null ||
    continuationRequestFromMessage(message) !== null ||
    /\b(change|edit|rewrite|revise|fix|replace|rename|swap|switch|remove|delete|add|insert|update|make|turn|shorten|expand|polish|regenerate|move|reorder|restructure|redo|rework|want|prefer)\b/i.test(
      message
    ) ||
    /\b(?:no|without|skip)\s+(?:images?|covers?|illustrations?|visuals?)\b/i.test(message)
  );
}

export function isIdentityChangeSubject(subject: string): boolean {
  return /\b(?:main\s+characters?|protagonists?|hero(?:es)?|species|titles?|premise|audience|endings?|structure|outline|covers?|visual\s+identity|illustration\s+style)\b/i.test(
    subject
  );
}

export function pageIndexesMatchingText(text: string, pages: BookEditPageContext[]): number[] {
  const needle = text.toLowerCase();
  if (!needle) {
    return [];
  }
  return pages
    .filter((page) =>
      [page.title, page.summary, page.previewText].some((value) => value.toLowerCase().includes(needle))
    )
    .map((page) => page.index)
    .sort((a, b) => a - b);
}

const targetLanguageNamePattern = languageNamePattern();

export function targetLanguageFromLanguageVersionRequest(message: string): string | null {
  // Patterns that end on a bare "<verb> ... in <Lang>" carry the clause-end
  // guard, or they read a topic as a language: "make chapter 2 about how aliens
  // are portrayed in Chinese media" would otherwise replan the book in Chinese.
  // The others already require "version/copy/edition/translation" or the literal
  // word "language", so they are precise on their own.
  const patterns = [
    new RegExp(
      `\\b(?:generate|create|make|regenerate|rewrite|translate|convert|build|produce)\\b.{0,100}\\b(${targetLanguageNamePattern})\\s+(?:version|copy|edition|translation)\\b`,
      "iu"
    ),
    new RegExp(
      `\\b(?:generate|create|make|regenerate|rewrite|translate|convert|build|produce)\\b.{0,100}\\b(?:in|to|into)\\s+(${targetLanguageNamePattern})${LANGUAGE_CLAUSE_END_GUARD}`,
      "iu"
    ),
    new RegExp(
      `\\b(?:translate|convert|rewrite|regenerate)\\b.{0,100}\\b(?:to|into|in)\\s+(${targetLanguageNamePattern})${LANGUAGE_CLAUSE_END_GUARD}`,
      "iu"
    ),
    new RegExp(
      `\\b(?:change|switch|set|make|turn|translate|convert)\\b.{0,80}\\blanguage\\b.{0,20}\\b(?:to|into|as|in|should\\s+be|:)\\s+(${targetLanguageNamePattern})\\b`,
      "iu"
    ),
    new RegExp(
      `\\blanguage\\s+(?:to|into|as|in|should\\s+be|:)\\s+(${targetLanguageNamePattern})\\b`,
      "iu"
    )
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    const rawLanguage = match?.[1]?.toLowerCase();
    const alias = rawLanguage ? LANGUAGE_NAME_CODES[rawLanguage] : undefined;
    if (alias) {
      return normalizeProjectLanguage(alias);
    }
  }
  return null;
}

export function languageDisplayName(language: string | null): string {
  return language === "en" ? "English" : language ?? "translated";
}

/**
 * Detects requests to read (not change) the outline, a chapter, or a page.
 * Returns null when the message does not look like a read request.
 */
export function showContentTargetFromMessage(message: string): ShowContentTarget | null {
  const text = message.trim();
  // "Why …" asks for an explanation, never a content read, even when it
  // contains a read-verb homograph like "display".
  if (/^why\b/i.test(text)) {
    return null;
  }
  const readVerb = /\b(?:show|read|see|view|display|open|give)\s+(?:me\s+)?/i;
  const wantsRead =
    readVerb.test(text) ||
    // "what's in chapter 2", "what does page 3 say" - but not broad questions
    // like "what is this plan about?", which deserve a summarized answer.
    /^what(?:'s|\s+is)\s+(?:in|on)\b/i.test(text) ||
    /\bwhat\s+does\s+(?:chapter|page)\s+\d+\s+say\b/i.test(text) ||
    /^let me (?:see|read)\b/i.test(text) ||
    /\bread\s+(?:it|that)\s+(?:back|to me)\b/i.test(text);
  if (!wantsRead) {
    return null;
  }
  const pageMatch = text.match(/\bpage\s+(\d{1,3})\b/i);
  if (pageMatch && !/\b(?:outline|plan|chapters?|table of contents|toc)\b/i.test(text)) {
    return { type: "page", index: Number(pageMatch[1]) };
  }
  const chapterMatch = text.match(/\bchapter\s+(\d{1,2})\b/i);
  if (chapterMatch) {
    return { type: "chapter", index: Number(chapterMatch[1]) };
  }
  if (/\b(?:outline|plan|table of contents|toc|chapters|chapter list|structure)\b/i.test(text)) {
    return { type: "outline" };
  }
  return null;
}

/** True when the message combines a read phrase with an actual edit request. */
export function hasEditVerbBeyondShow(message: string): boolean {
  return /\b(change|edit|rewrite|revise|fix|replace|rename|swap|remove|delete|insert|update|shorten|expand|polish|regenerate|redo|rework|make\s+it)\b/i.test(
    message
  );
}

export function isUndoRequestMessage(message: string): boolean {
  const normalized = message.toLowerCase().replace(/[.!?]+$/g, "").trim();
  return (
    /^(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?(?:undo|revert|roll\s*back)\b/.test(normalized) ||
    /\b(?:undo|revert|roll\s*back)\s+(?:the\s+|that\s+|my\s+)?(?:last|latest|previous|recent)?\s*(?:edit|change|revision|rewrite)?$/.test(
      normalized
    )
  );
}

/** Extracts the chapter index from "rewrite chapter 3, make it funnier"-style requests. */
export function chapterRegenerateFromMessage(message: string): number | null {
  const match = message.match(
    /\b(?:rewrite|regenerate|redo|rework|revise|refresh|improve)\s+(?:the\s+)?chapter\s+(\d{1,2})\b/i
  ) ??
    message.match(/\bchapter\s+(\d{1,2})\b.{0,40}\b(?:rewrite|regenerate|redo|rework|from scratch|again)\b/i);
  if (!match?.[1]) {
    return null;
  }
  const index = Number(match[1]);
  return Number.isInteger(index) && index > 0 ? index : null;
}

/**
 * The book length a replan request asks for.
 *
 * Guarded against page *references*: "rewrite pages 3-5" and "make it 3 pages"
 * overlap on the bare form `pages 3`, and reading a reference as a length would
 * resize the whole book to the page someone wanted edited. A reference puts the
 * word before the number, a length puts it after, so a message containing the
 * former names no length at all.
 */
export function replanTargetPagesFromMessage(message: string): number | undefined {
  if (/\bpages?\s+\d{1,3}\b/i.test(message)) {
    return undefined;
  }
  return explicitTargetPagesFromText(message);
}

/**
 * The generation settings a replan request named, from the router's structured
 * answer where it gave one and from the message otherwise.
 *
 * Both classifiers read it through here so a router timeout resolves the same
 * settings the model would have, and so the quote the user approves and the
 * charge that follows can never be computed from different readings.
 *
 * The message can only turn pictures *off* — there is no positive regex — but an
 * explicit `illustrations` from the model carries either direction, which is
 * safe because the resolved settings are what gets priced on the proposal card
 * before anything is reserved.
 */
export function replanSettingsFromEditMessage(
  message: string,
  reported: { targetPages?: number | null | undefined; illustrations?: boolean | null | undefined } = {}
): ReplanSettings | undefined {
  const targetPages = reported.targetPages ?? replanTargetPagesFromMessage(message);
  const settings: ReplanSettings = {
    ...replanSettingsFromMessage(message),
    ...(reported.illustrations === undefined || reported.illustrations === null
      ? {}
      : { fullIllustrations: reported.illustrations }),
    ...(targetPages === undefined || targetPages === null ? {} : { targetPages })
  };
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/** Where an image request asked to go, before validation against real pages. */
export type BookEditImagePlacement =
  | { placement: "end_of_book" }
  | { placement: "page"; pageIndex: number };

/**
 * Readers name pages three ways — "page 3", "page three", "the 3rd page" — and
 * all three have to read as the same page. Word forms stop at twenty: past
 * that, people write digits.
 */
const CARDINAL_WORDS = [
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen", "twenty"
];
const ORDINAL_WORDS = [
  "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth",
  "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth",
  "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth",
  "twentieth"
];

function numberWordValue(word: string): number | null {
  const lower = word.toLowerCase();
  const cardinal = CARDINAL_WORDS.indexOf(lower);
  if (cardinal !== -1) {
    return cardinal + 1;
  }
  const ordinal = ORDINAL_WORDS.indexOf(lower);
  return ordinal === -1 ? null : ordinal + 1;
}

/**
 * Pattern sources (no flags, no capture groups) shared with the image
 * recognizer's subject-excision clauses, so "on the 3rd page" is cut from the
 * subject by exactly the grammar that will then read it as a placement.
 */
export const NAMED_PAGE_SOURCE = `pages?\\s+(?:\\d{1,3}|${CARDINAL_WORDS.join("|")})(?!\\d)`;
export const ORDINAL_PAGE_SOURCE = `(?:the\\s+)?(?:\\d{1,3}(?:st|nd|rd|th)|${ORDINAL_WORDS.join("|")})\\s+page`;

const NAMED_PAGE = new RegExp(`\\b${NAMED_PAGE_SOURCE}\\b`, "i");
const ORDINAL_PAGE = new RegExp(`\\b${ORDINAL_PAGE_SOURCE}\\b`, "i");

function namedPageIndex(match: string): number | null {
  // The suffix strip must not touch word ordinals: "third" is not "thi" + "rd".
  const token = match
    .replace(/^pages?\s+|^the\s+|\s+page$/gi, "")
    .replace(/(?<=\d)(?:st|nd|rd|th)$/i, "");
  const value = /^\d{1,3}$/.test(token) ? Number(token) : numberWordValue(token);
  return value !== null && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * "At the end of the book", "on the last page", "as the final page". English
 * only, like every message reader here — non-English placement travels through
 * the router's `pageIndexes`, which is why that channel wins over this one.
 *
 * "The end" has to be the book's: either named ("of the book/story", "the
 * last page", "the back of the book") or a bare "at the end" closing the
 * sentence. "At the end of chapter 2" and "the light at the end of the
 * tunnel" name an end that is not the book's and place nothing here.
 */
export function endOfBookPlacementFromMessage(message: string): boolean {
  return (
    /\b(?:at|to|near)\s+the\s+(?:very\s+)?end\s+of\s+the\s+(?:book|story|manuscript)\b/i.test(message) ||
    /\b(?:at|to|near)\s+the\s+(?:very\s+)?end\s*(?:[.!?;\n]|$)/i.test(message) ||
    /\bat\s+the\s+back\s+of\s+the\s+book\b/i.test(message) ||
    /\b(?:the\s+)?(?:last|final|closing)\s+page\b/i.test(message) ||
    /\bas\s+the\s+(?:last|final)\s+(?:page|image|picture|illustration)\b/i.test(message)
  );
}

/**
 * A place *inside* a page: "to the top", "above the text", "below the text",
 * "at the bottom of the page". Field backstop, not a classifier — the router
 * has already chosen move_image by the time this is asked, and this only fills
 * the `imagePosition` it may have left off.
 *
 * Consulted **before** {@link endOfBookPlacementFromMessage}, whose "the last
 * page" rule would otherwise swallow "at the bottom of the last page" and send
 * the picture to a different page than the one the reader named.
 */
export function imagePositionFromMessage(message: string): "top" | "bottom" | null {
  if (/\b(?:to|at|near|on)\s+the\s+(?:very\s+)?top\b/i.test(message) || /\babove\s+the\s+(?:text|prose|words|story)\b/i.test(message)) {
    return "top";
  }
  if (
    /\b(?:to|at|near|on)\s+the\s+(?:very\s+)?bottom\b/i.test(message) ||
    /\bbelow\s+the\s+(?:text|prose|words|story)\b/i.test(message) ||
    /\b(?:under|underneath)\s+the\s+(?:text|prose|words|story)\b/i.test(message) ||
    /\b(?:at|to)\s+the\s+end\s+of\s+the\s+page\b/i.test(message)
  ) {
    return "bottom";
  }
  return null;
}

/**
 * "All the pictures", "every illustration", "any images". The same field
 * backstop rule: the router has already chosen remove_image, and this only
 * fills the `imageSelection` it may have left off. Without it a model that
 * forgets the field removes exactly one picture from a "remove all" request,
 * which is the headline case for the whole feature.
 */
export function bulkImageSelectionFromMessage(message: string): "all" | null {
  return /\b(?:all|every|any)\s+(?:of\s+)?(?:the\s+|my\s+)?(?:images?|pictures?|photos?|illustrations?|drawings?|artwork)\b/i.test(
    message
  ) ||
    /\b(?:images?|pictures?|photos?|illustrations?|drawings?)\s+(?:from|in|out\s+of)\s+the\s+(?:whole\s+)?book\b/i.test(message)
    ? "all"
    : null;
}

/**
 * The placement an image request names, read without the book's page list: a
 * named page ("page 3", "page three", "the 3rd page") is returned as-is and
 * validated against real pages by the proposal path. Numerals are normalized
 * so "page ۵" reads as page 5.
 */
export function imagePlacementFromMessage(message: string): BookEditImagePlacement | null {
  const normalized = normalizeNumerals(message);
  const named = NAMED_PAGE.exec(normalized) ?? ORDINAL_PAGE.exec(normalized);
  if (named) {
    const pageIndex = namedPageIndex(named[0]);
    if (pageIndex !== null) {
      return { placement: "page", pageIndex };
    }
  }
  return endOfBookPlacementFromMessage(message) ? { placement: "end_of_book" } : null;
}

export function pageIndexesFromMessage(message: string, pages: BookEditPageContext[]): number[] {
  const indexes = new Set<number>();
  // Numerals are normalized but the word "page" is not translated: the reader
  // writes its own references in English ("On page 4") whatever the book's
  // language, so this only has to survive a reader typing their own digits.
  const normalized = normalizeNumerals(message);
  for (const match of normalized.matchAll(/\bpages?\s+(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?/gi)) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    for (let index = Math.min(start, end); index <= Math.max(start, end); index += 1) {
      indexes.add(index);
    }
  }
  // "page three" and "the 3rd page" name single pages; ranges stay digits-only.
  for (const source of [NAMED_PAGE_SOURCE, ORDINAL_PAGE_SOURCE]) {
    for (const match of normalized.matchAll(new RegExp(`\\b${source}\\b`, "gi"))) {
      const index = namedPageIndex(match[0]);
      if (index !== null) {
        indexes.add(index);
      }
    }
  }
  for (const page of pages) {
    const title = page.title.trim().toLowerCase();
    if (title.length >= 4 && message.toLowerCase().includes(title)) {
      indexes.add(page.index);
    }
  }
  return [...indexes].filter((index) => pages.some((page) => page.index === index)).sort((a, b) => a - b);
}

export function quotedTexts(message: string): string[] {
  return [...message.matchAll(/["“]([^"”]{1,500})["”]/g)].map((match) => match[1]!.trim()).filter(Boolean);
}

export function replacementTermsFromMessage(message: string): BookEditReplacement | null {
  const quotes = quotedTexts(message);
  if (quotes.length >= 2) {
    return cleanReplacement({ from: quotes[0]!, to: quotes[1]! });
  }

  const match = message.match(
    /\b(?:replace|change|rename|swap|switch|turn)\s+(?:the\s+)?(.{1,160}?)\s+(?:with|to|into|as)\s+(.{1,220})$/i
  );
  if (!match) {
    return null;
  }
  return cleanReplacement({ from: match[1]!, to: match[2]! });
}

function cleanReplacement(replacement: BookEditReplacement): BookEditReplacement | null {
  const from = cleanReplacementTerm(replacement.from);
  const to = cleanReplacementTerm(replacement.to);
  if (!from || !to || editAttributeTerms.has(from.toLowerCase())) {
    return null;
  }
  return { from, to };
}

export function bookEditScopeFromMessage(message: string): BookEditScope {
  return hasAllPagesScope(message) ? "all_pages" : "none";
}

export function isBookEditScopeOnlyMessage(message: string): boolean {
  const normalized = normalizeScopeOnlyText(message);
  if (!hasAllPagesScope(normalized)) {
    return false;
  }
  const withoutScope = normalized
    .replace(/\b(?:the\s+)?(?:whole|entire|full)\s+(?:book|story|manuscript)\b/g, "")
    .replace(/\b(?:all|every)\s+(?:pages?|chapters?|book|story)\b/g, "")
    .replace(/\b(?:everywhere|throughout|globally)\b/g, "")
    .trim();
  return withoutScope.length === 0;
}

export function messageWithScope(message: string, scope: BookEditScope): string {
  if (scope === "all_pages") {
    return `${message.trim().replace(/[.?!]+$/g, "")} throughout the whole book.`;
  }
  return message.trim();
}

/**
 * Re-attaches the request a clarification was asked about to the reply that did
 * not answer it, so the router, the heuristic hint, the resolved page targets
 * and the queued operation all see the real request rather than a fragment like
 * "just add" whose meaning lives entirely in the previous turn.
 */
export function messageWithFollowUp(request: string, followUp: string): string {
  const original = request.trim();
  const reply = followUp.trim();
  if (!original || original.toLowerCase() === reply.toLowerCase()) {
    return reply;
  }
  return `${original}\n\nFollow-up from the user: ${reply}`;
}

export function hasAllPagesScope(message: string): boolean {
  return /\b(?:whole|entire|full)\s+(?:book|story|manuscript)\b/i.test(message) ||
    /\b(?:all|every)\s+(?:pages?|chapters?)\b/i.test(message) ||
    /\b(?:everywhere|throughout|globally)\b/i.test(message) ||
    /\bacross\s+(?:the\s+)?(?:book|story|all pages)\b/i.test(message);
}

function normalizeScopeOnlyText(message: string): string {
  return message
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/^(?:i\s+(?:said|mean|meant|told\s+you)\s+|just\s+|please\s+|do\s+|make\s+it\s+|the\s+)/i, "")
    .replace(/\s+please$/i, "")
    .trim();
}

function cleanReplacementTerm(value: string): string {
  return value
    .trim()
    .replace(/\b(?:in|throughout|across|over|for)\s+(?:the\s+)?(?:whole|entire|full|all|every)\s+(?:book|story|pages?|chapters?).*$/i, "")
    .replace(/\b(?:everywhere|throughout|globally)\b.*$/i, "")
    .replace(/^(?:a|an|the)\s+/i, "")
    .replace(/[.?!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const editAttributeTerms = new Set(["tone", "style", "voice", "mood", "feel", "vibe", "language", "length"]);

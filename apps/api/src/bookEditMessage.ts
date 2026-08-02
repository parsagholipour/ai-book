import { normalizeProjectLanguage } from "@book-maker/core";
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

const targetLanguageAliases: Record<string, string> = {
  english: "en",
  spanish: "es",
  french: "fr",
  german: "de",
  italian: "it",
  portuguese: "pt",
  dutch: "nl",
  turkish: "tr",
  russian: "ru",
  arabic: "ar",
  farsi: "fa",
  persian: "fa",
  hindi: "hi",
  chinese: "zh",
  mandarin: "zh",
  japanese: "ja",
  korean: "ko",
  hebrew: "he",
  greek: "el",
  thai: "th",
  swedish: "sv",
  norwegian: "no",
  danish: "da",
  polish: "pl",
  ukrainian: "uk"
};

const targetLanguageNamePattern = Object.keys(targetLanguageAliases)
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join("|");

export function targetLanguageFromLanguageVersionRequest(message: string): string | null {
  const patterns = [
    new RegExp(
      `\\b(?:generate|create|make|regenerate|rewrite|translate|convert|build|produce)\\b.{0,100}\\b(${targetLanguageNamePattern})\\s+(?:version|copy|edition|translation)\\b`,
      "iu"
    ),
    new RegExp(
      `\\b(?:generate|create|make|regenerate|rewrite|translate|convert|build|produce)\\b.{0,100}\\b(?:in|to|into)\\s+(${targetLanguageNamePattern})\\b`,
      "iu"
    ),
    new RegExp(
      `\\b(?:translate|convert|rewrite|regenerate)\\b.{0,100}\\b(?:to|into|in)\\s+(${targetLanguageNamePattern})\\b`,
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
    const alias = rawLanguage ? targetLanguageAliases[rawLanguage] : undefined;
    if (alias) {
      return normalizeProjectLanguage(alias);
    }
  }
  return null;
}

export function languageDisplayName(language: string | null): string {
  return language === "en" ? "English" : language ?? "translated";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

export function pageIndexesFromMessage(message: string, pages: BookEditPageContext[]): number[] {
  const indexes = new Set<number>();
  for (const match of message.matchAll(/\bpages?\s+(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?/gi)) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    for (let index = Math.min(start, end); index <= Math.max(start, end); index += 1) {
      indexes.add(index);
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

import { z } from "zod";

import { AUTHOR_ASSIST_LIMITS, type AuthorNote } from "./authorAssistTypes.js";

/**
 * What the Writing Studio's models are asked to return, and the deterministic
 * clean-up every reply goes through before the author sees it.
 *
 * The response schemas are deliberately loose — a bound on a string is an
 * output budget, not a signal (packages/core/src/generation/CLAUDE.md, "every
 * bound is stated the same way, then enforced by cutting rather than
 * refusing") — so a reply that is a little long, or that spells a severity
 * oddly, is clipped or normalized here instead of spending the repair attempt.
 * Each `…_CONTRACT` is the `outputContract` the prompt shows, and
 * `authorAssistPrompts.test.ts` holds each one to its schema's key set.
 */

// ---------------------------------------------------------------------------
// Response schemas and the contracts the prompts show

export const assistTextResponseSchema = z.object({ text: z.string() });
export type AssistTextResponse = z.infer<typeof assistTextResponseSchema>;

export const proofreadResponseSchema = z.object({
  corrections: z.array(z.object({ find: z.string(), replace: z.string(), reason: z.string().default("") }))
});
export type ProofreadResponse = z.infer<typeof proofreadResponseSchema>;

export const brainstormResponseSchema = z.object({
  ideas: z.array(z.object({ title: z.string().default(""), text: z.string().default("") }))
});
export type BrainstormResponse = z.infer<typeof brainstormResponseSchema>;

export const askResponseSchema = z.object({ answer: z.string() });
export type AskResponse = z.infer<typeof askResponseSchema>;

export const draftChapterResponseSchema = z.object({ markdown: z.string() });
export type DraftChapterResponse = z.infer<typeof draftChapterResponseSchema>;

const severitySchema = z.enum(["suggestion", "issue"]).catch("suggestion");
const nullableQuoteSchema = z.string().nullable().optional();

export const chapterFeedbackResponseSchema = z.object({
  notes: z.array(z.object({ quote: nullableQuoteSchema, note: z.string().default(""), severity: severitySchema }))
});
export type ChapterFeedbackResponse = z.infer<typeof chapterFeedbackResponseSchema>;

export const consistencyResponseSchema = z.object({
  notes: z.array(
    z.object({
      chapterNumber: z.union([z.number(), z.string()]).nullable().optional(),
      quote: nullableQuoteSchema,
      note: z.string().default(""),
      severity: severitySchema
    })
  )
});
export type ConsistencyResponse = z.infer<typeof consistencyResponseSchema>;

export const outlineResponseSchema = z.object({
  chapters: z.array(z.object({ title: z.string().default(""), notes: z.string().default("") }))
});
export type OutlineResponse = z.infer<typeof outlineResponseSchema>;

export const REWRITE_CONTRACT = { text: "<the complete replacement for selection, and nothing else>" } as const;
export const DESCRIBE_CONTRACT = { text: "<the complete, more vivid replacement for selection>" } as const;
export const CONTINUE_CONTRACT = { text: "<80-220 words that carry on exactly where before ends>" } as const;
export const PROOFREAD_CONTRACT = {
  corrections: [
    {
      find: "<text copied verbatim from selection, occurring there exactly once>",
      replace: "<the corrected text>",
      reason: "<a short phrase naming the error>"
    }
  ]
} as const;
export const BRAINSTORM_CONTRACT = {
  ideas: [{ title: "<a few words, at most 60 characters>", text: "<one to three sentences>" }]
} as const;
export const ASK_CONTRACT = { answer: "<at most 180 words>" } as const;
export const DRAFT_CHAPTER_CONTRACT = { markdown: "<the chapter's markdown prose, with no title heading>" } as const;
export const CHAPTER_FEEDBACK_CONTRACT = {
  notes: [
    {
      quote: "<at most 200 characters copied verbatim from chapter.markdown, or null>",
      note: "<one to three sentences for the author>",
      severity: "issue"
    }
  ]
} as const;
export const CONSISTENCY_CONTRACT = {
  notes: [
    {
      chapterNumber: 1,
      quote: "<at most 200 characters copied verbatim from that chapter, or null>",
      note: "<one or two sentences naming both sides of the contradiction>",
      severity: "issue"
    }
  ]
} as const;
export const OUTLINE_CONTRACT = {
  chapters: [{ title: "<a short chapter title>", notes: "<2-4 sentences>" }]
} as const;

// ---------------------------------------------------------------------------
// Output hygiene

const PREAMBLE_LINE =
  /^(?:(?:sure|certainly|of course|okay|ok|absolutely|great)[,!.]?\s+)?(?:here(?:'s|’s| is| are)|below is|this is)\b[^\n]{0,160}:\s*$/i;
const LABEL_LINE =
  /^(?:\*\*)?(?:rewritten|revised|improved|edited|expanded|corrected|proofread|new|suggested)?\s*(?:text|version|passage|paragraph|continuation|rewrite|revision|draft|answer)s?(?:\*\*)?\s*:\s*$/i;
const SIGN_OFF_PARAGRAPH = /^(?:let me know\b|i hope (?:this|that)\b|hope this helps\b|feel free to\b)/i;
const WRAPPING_FENCE = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/;
const HEADING_LINE = /^\s{0,3}#{1,6}\s/;
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["“", "”"],
  ["«", "»"],
  ["„", "“"],
  ["'", "'"],
  ["‘", "’"],
  ["「", "」"]
];

/**
 * Strips what a model wraps around an answer and the author never wrote: a
 * "Here is the rewrite:" line, a label line, a closing "Let me know…"
 * paragraph, a code fence around the whole reply, quotation marks around the
 * whole reply, and — when `source` has no heading — heading lines at the top.
 * Each strip is skipped when `source` itself starts that way, so a selection
 * that *is* a quotation, a fenced block or a line such as "This is how it
 * ended:" keeps it.
 */
export function cleanAssistText(raw: string, source = ""): string {
  let text = raw.replace(/\r\n?/g, "\n").trim();
  const sourceText = source.trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const before = text;
    if (!isPreambleLine(sourceText.split("\n", 1)[0] ?? "")) text = stripPreamble(text);
    text = stripSignOff(text);
    text = stripWrappingFence(text, sourceText);
    text = stripWrappingQuotes(text, sourceText);
    if (!sourceText.split("\n").some((line) => HEADING_LINE.test(line))) text = stripLeadingHeadings(text);
    if (text === before) break;
  }
  return text;
}

function isPreambleLine(line: string): boolean {
  const trimmed = line.trim();
  return PREAMBLE_LINE.test(trimmed) || LABEL_LINE.test(trimmed);
}

function stripPreamble(text: string): string {
  const newline = text.indexOf("\n");
  if (newline < 0) return text;
  if (!isPreambleLine(text.slice(0, newline))) return text;
  const rest = text.slice(newline + 1).trim();
  return rest.length > 0 ? rest : text;
}

function stripSignOff(text: string): string {
  const paragraphs = text.split(/\n\s*\n/);
  if (paragraphs.length < 2) return text;
  const last = paragraphs[paragraphs.length - 1]!.trim();
  return SIGN_OFF_PARAGRAPH.test(last) ? paragraphs.slice(0, -1).join("\n\n").trim() : text;
}

function stripWrappingFence(text: string, source: string): string {
  if (/^(`{3,}|~{3,})/.test(source)) return text;
  const match = text.match(WRAPPING_FENCE);
  return match ? match[2]!.trim() : text;
}

function stripWrappingQuotes(text: string, source: string): string {
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length < 2 || !text.startsWith(open) || !text.endsWith(close)) continue;
    if (source.startsWith(open)) return text;
    const inner = text.slice(open.length, text.length - close.length);
    // Only a pair that wraps the whole reply: dialogue that merely starts and
    // ends the passage ("Go," she said. "Now.") has more marks inside.
    if (inner.includes(open) || inner.includes(close)) return text;
    return inner.trim();
  }
  return text;
}

function stripLeadingHeadings(text: string): string {
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length && (HEADING_LINE.test(lines[index]!) || (index > 0 && lines[index]!.trim() === ""))) {
    index += 1;
  }
  const rest = lines.slice(index).join("\n").trim();
  return index > 0 && rest.length > 0 ? rest : text;
}

const SENTENCE_END = /([.!?…؟。！？]+["'”’»)\]]*)$/u;
const ENDS_IN_WORD = /[\p{L}\p{N}]$/u;

/**
 * Keeps the sentence the selection closed closed. Models rewriting "…went out
 * at ten." regularly answer "…guttered out at ten" — and Replace would then
 * silently delete the author's full stop, gluing the next sentence on. Only a
 * replacement that ends mid-word gets the selection's closing punctuation back;
 * one that ends in any punctuation of its own is the model's choice and kept.
 */
export function withSelectionEndPunctuation(selection: string, replacement: string): string {
  const ending = selection.trimEnd().match(SENTENCE_END)?.[1];
  const trimmed = replacement.trimEnd();
  if (!ending || !ENDS_IN_WORD.test(trimmed)) return replacement;
  return `${trimmed}${ending}${replacement.slice(trimmed.length)}`;
}

/** Re-attaches the selection's own leading and trailing whitespace, so a replacement keeps its paragraph breaks. */
export function withSelectionWhitespace(selection: string, replacement: string): string {
  const leading = selection.match(/^\s*/)?.[0] ?? "";
  const trailing = selection.match(/\s*$/)?.[0] ?? "";
  return `${leading}${replacement}${trailing}`;
}

// ---------------------------------------------------------------------------
// Continue: echo stripping and the join at the cursor

const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const MIN_ECHO_CHARS = 12;
/** A character of Han or kana carries a word's worth; twelve of them is a sentence. */
const MIN_ECHO_CHARS_NO_SPACE = 6;
const MIN_ECHO_WORDS = 3;

/**
 * Removes a leading copy of the end of `before` from a continuation. Models
 * asked to "continue from here" often restate the last words (or the whole last
 * sentence) before carrying on, which would print them twice at the cursor.
 *
 * Word-wise first, over the last 60 words: the longest run of at least three
 * words (and twelve characters) that `before` ends with and `text` starts with.
 * Then character-wise, for scripts written without spaces and for a cursor
 * inside a word: the longest suffix of `before` of at least twelve characters
 * (six in a script written without spaces) that `text` starts with.
 * `continuesWord` says the cut fell inside a word — the cursor was mid-word
 * and the rest completes it — so no separator may be put between them.
 * Returns `text` unchanged when nothing would be left.
 */
export function stripEchoedLead(before: string, text: string): { text: string; continuesWord: boolean } {
  const unchanged = { text, continuesWord: false };
  const tail = before.trimEnd();
  if (!tail || !text) return unchanged;
  const tailWords = tail.split(/\s+/).filter(Boolean).slice(-60);
  const words = [...text.matchAll(/\S+/g)];
  for (let count = Math.min(tailWords.length, words.length - 1); count >= MIN_ECHO_WORDS; count -= 1) {
    const expected = tailWords.slice(-count);
    if (!expected.every((word, index) => words[index]![0] === word)) continue;
    const last = words[count - 1]!;
    const end = last.index + last[0].length;
    if (end < MIN_ECHO_CHARS) break;
    const rest = text.slice(end).trimStart();
    return rest.length > 0 ? { text: rest, continuesWord: false } : unchanged;
  }
  for (let length = Math.min(tail.length, text.length - 1, 600); length >= MIN_ECHO_CHARS_NO_SPACE; length -= 1) {
    const suffix = tail.slice(-length);
    if (length < MIN_ECHO_CHARS && !NO_SPACE_SCRIPT.test(suffix)) break;
    if (!text.startsWith(suffix)) continue;
    const remainder = text.slice(length);
    const rest = remainder.trimStart();
    if (rest.length === 0) return unchanged;
    const continuesWord = before === tail && remainder === rest && WORD_CHAR.test(suffix.slice(-1)) && WORD_CHAR.test(rest.charAt(0));
    return { text: rest, continuesWord };
  }
  return unchanged;
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

/**
 * Makes a continuation ready to insert at the cursor: it carries its own
 * leading separator when `before` does not end in whitespace — a paragraph
 * break when the model opened one, otherwise a space, and nothing when the
 * text completes a word the cursor sat inside — and a trailing space
 * when `after` starts a word right at the cursor. Scripts written without
 * spaces (Han, kana, Thai, …) get no space either side.
 */
export function joinContinuationAtCursor(
  input: { before: string; after: string },
  text: string,
  lead: { openedParagraph: boolean; continuesWord: boolean }
): string {
  let result = text;
  const lastChar = input.before.slice(-1);
  if (lastChar && !/\s/.test(lastChar) && !lead.continuesWord) {
    if (lead.openedParagraph) result = `\n\n${result}`;
    else if (!NO_SPACE_SCRIPT.test(lastChar) && !NO_SPACE_SCRIPT.test(result.charAt(0)) && !/^[,.;:!?)\]}…»”’،؛؟]/.test(result)) {
      result = ` ${result}`;
    }
  }
  const firstAfter = input.after.charAt(0);
  const lastText = result.slice(-1);
  if (firstAfter && /[\p{L}\p{N}"“«'‘(]/u.test(firstAfter) && lastText && !/\s/.test(lastText)) {
    if (!NO_SPACE_SCRIPT.test(firstAfter) && !NO_SPACE_SCRIPT.test(lastText)) result = `${result} `;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Proofread

export type ProofreadCorrection = { find: string; replace: string; reason: string };

/**
 * Keeps only corrections the client can apply exactly, in the order they
 * occur in `selection`. Dropped: an empty `find`; a `find` equal to its
 * `replace`; a `find` not in `selection` verbatim; a `find` that occurs more
 * than once (the client could not tell which occurrence is meant — the prompt
 * asks for a neighbouring word in that case); and one whose span overlaps a
 * correction kept before it in the model's order. At most
 * `AUTHOR_ASSIST_LIMITS.proofreadCorrections` survive.
 */
export function filterProofreadCorrections(
  selection: string,
  corrections: ReadonlyArray<{ find: string; replace: string; reason?: string | undefined }>
): ProofreadCorrection[] {
  const kept: Array<ProofreadCorrection & { start: number; end: number }> = [];
  for (const correction of corrections) {
    if (kept.length >= AUTHOR_ASSIST_LIMITS.proofreadCorrections) break;
    const { find, replace } = correction;
    if (!find || find === replace) continue;
    const start = selection.indexOf(find);
    if (start < 0 || selection.indexOf(find, start + 1) >= 0) continue;
    const end = start + find.length;
    if (kept.some((other) => start < other.end && other.start < end)) continue;
    kept.push({ find, replace, reason: clipAtWord((correction.reason ?? "").trim(), 160), start, end });
  }
  return kept.sort((a, b) => a.start - b.start).map(({ find, replace, reason }) => ({ find, replace, reason }));
}

// ---------------------------------------------------------------------------
// Brainstorm

/** Up to three ideas, each trimmed and clipped, duplicates and empties dropped. */
export function cleanBrainstormIdeas(ideas: BrainstormResponse["ideas"]): Array<{ title: string; text: string }> {
  const seen = new Set<string>();
  const out: Array<{ title: string; text: string }> = [];
  for (const idea of ideas) {
    const text = clipAtSentence(cleanAssistText(idea.text), 480);
    const rawTitle = cleanAssistText(idea.title).replace(/^[#*\s]+|[*\s]+$/g, "");
    const title = clipAtWord(rawTitle || text, AUTHOR_ASSIST_LIMITS.ideaTitleChars);
    if (!title || !text) continue;
    const key = title.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, text });
    if (out.length === 3) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quotes and notes

const QUOTE_EDGE = /^[\s"'“”„«»‘’`]+|[\s"'“”„«»‘’`]+$/g;
const QUOTE_ELLIPSIS_EDGE = /^(?:…|\.\.\.)\s*|\s*(?:…|\.\.\.)$/g;

/**
 * Finds a model's quote in the text it claims to quote and returns the text's
 * *own* span — clipped to `maxChars` at a word boundary — or null. Exact first;
 * then a loose match that forgives what models mis-copy without changing the
 * words: runs of whitespace, straight versus curly quotes, hyphen versus
 * dashes, and `...` versus `…`. Wrapping quotation marks and ellipses the model
 * put around the quote are ignored.
 */
export function locateQuote(haystack: string, quote: string | null | undefined, maxChars: number = AUTHOR_ASSIST_LIMITS.noteQuoteChars): string | null {
  if (!quote) return null;
  const raw = quote.trim();
  const bare = raw.replace(QUOTE_ELLIPSIS_EDGE, "").replace(QUOTE_EDGE, "").trim();
  // The model's own marks first — they may be the text's opening quote — then without them.
  const needles = [...new Set([raw, bare])].filter((needle) => needle.length >= 2);
  for (const needle of needles) {
    const exact = haystack.indexOf(needle);
    if (exact >= 0) return clipAtWord(haystack.slice(exact, exact + needle.length), maxChars, false);
  }
  for (const needle of needles) {
    const match = looseQuotePattern(needle)?.exec(haystack);
    if (match) return clipAtWord(match[0], maxChars, false);
  }
  return null;
}

function looseQuotePattern(needle: string): RegExp | null {
  const tokens = needle.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 120) return null;
  const source = tokens
    .map((token) =>
      [...token]
        .map((char) => {
          if (/["“”„«»]/.test(char)) return "[\"“”„«»]";
          if (/['‘’`]/.test(char)) return "['‘’`]";
          if (/[-–—]/.test(char)) return "[-–—]";
          if (char === "…") return "(?:…|\\.\\.\\.)";
          return char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
        })
        .join("")
    )
    .join("\\s+");
  try {
    return new RegExp(source, "u");
  } catch {
    return null;
  }
}

/** A note's prose, cleaned and clipped; the empty string when there is none. */
export function cleanNoteText(note: string): string {
  return clipAtSentence(cleanAssistText(note).replace(/\s*\n\s*/g, " "), 700);
}

/** Notes sorted by where their quote sits in `text` (stable; notes without a quote last), duplicates dropped. */
export function orderNotesByQuote<N extends AuthorNote>(text: string, notes: readonly N[]): N[] {
  const seen = new Set<string>();
  const unique = notes.filter((note) => {
    const key = `${note.quote ?? ""}\u0000${note.note.toLocaleLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const position = (note: N) => (note.quote ? text.indexOf(note.quote) : -1);
  return unique
    .map((note, index) => ({ note, index, at: position(note) }))
    .sort((a, b) => (a.at < 0 ? Infinity : a.at) - (b.at < 0 ? Infinity : b.at) || a.index - b.index)
    .map(({ note }) => note);
}

// ---------------------------------------------------------------------------
// Clipping

/** Cuts at the last sentence end inside `maxChars` (past half of it), else at a word, with an ellipsis. */
export function clipAtSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  let best = -1;
  for (const match of cut.matchAll(/[.!?…。！？؟](?:["'”’»)\]]*)(?=\s|$)/gu)) {
    best = match.index + match[0].length;
  }
  if (best >= maxChars * 0.5) return cut.slice(0, best).trimEnd();
  return clipAtWord(text, maxChars);
}

/** Cuts at the last whitespace inside `maxChars` (past 60% of it), optionally marking the cut with `…`. */
export function clipAtWord(text: string, maxChars: number, ellipsis = true): string {
  if (text.length <= maxChars) return text;
  const room = ellipsis ? maxChars - 1 : maxChars;
  const cut = text.slice(0, room);
  const space = cut.search(/\s\S*$/);
  const base = (space > room * 0.6 ? cut.slice(0, space) : cut).trimEnd();
  return ellipsis ? `${base}…` : base;
}

export const CLIPPED_MIDDLE_MARKER = "[… the middle of this chapter is not shown …]";

/**
 * The head and tail of `text` within `maxChars` (60% head, 40% tail, each cut
 * at a paragraph or word boundary), joined by `CLIPPED_MIDDLE_MARKER`.
 */
export function clipHeadTail(text: string, maxChars: number): { text: string; clipped: boolean } {
  if (text.length <= maxChars) return { text, clipped: false };
  const room = Math.max(0, maxChars - CLIPPED_MIDDLE_MARKER.length - 4);
  const headRoom = Math.floor(room * 0.6);
  const tailRoom = room - headRoom;
  const headCut = text.slice(0, headRoom);
  const headBreak = Math.max(headCut.lastIndexOf("\n\n"), headCut.search(/\s\S*$/));
  const head = (headBreak > headRoom * 0.5 ? headCut.slice(0, headBreak) : headCut).trimEnd();
  const tailCut = text.slice(text.length - tailRoom);
  const tailBreak = tailCut.search(/\s/);
  const tail = (tailBreak >= 0 && tailBreak < tailRoom * 0.5 ? tailCut.slice(tailBreak) : tailCut).trimStart();
  return { text: `${head}\n\n${CLIPPED_MIDDLE_MARKER}\n\n${tail}`, clipped: true };
}

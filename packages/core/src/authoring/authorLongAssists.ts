import type { TextModelAdapter } from "../adapters/types.js";
import { figureAndStandInFreeProse, figureStandInMarkdown } from "../generation/figures/figureBlocks.js";
import { runAuthorAssistCall } from "./authorAssist.js";
import { chapterFeedbackCall, consistencyCall, draftChapterCall, outlineCall } from "./authorAssistPrompts.js";
import {
  cleanAssistText,
  cleanNoteText,
  clipAtWord,
  clipHeadTail,
  locateQuote,
  orderNotesByQuote
} from "./authorAssistSchemas.js";
import {
  AUTHOR_ASSIST_LIMITS,
  AuthorAssistInputError,
  AuthorAssistUnavailableError,
  type AuthorAssistBook,
  type AuthorNote
} from "./authorAssistTypes.js";
import { manuscriptProse, manuscriptWordCount, normalizeManuscriptMarkdown } from "./manuscriptText.js";

/**
 * The Writing Studio's long assists, run by the worker's `WRITING_ASSIST` job:
 * draft a chapter from its notes, developmental notes on a chapter, a
 * whole-book consistency check, and an outline. Each is one model call with
 * one repair, and each returns a suggestion — nothing here writes a chapter.
 *
 * Failures are `AuthorAssistInputError` (nothing to work on — the worker
 * should refund without retrying) or `AuthorAssistUnavailableError` (the model
 * failed or said nothing usable; a network failure stays readable through its
 * `cause`).
 */

export const DRAFT_TARGET_WORDS = { min: 300, max: 4000 } as const;
/** How much of one chapter the feedback read sees; longer chapters are shown head and tail. */
export const FEEDBACK_CHAPTER_CHARS = 60_000;
/** Per chapter and in total, for the consistency read. */
export const CONSISTENCY_CHAPTER_CHARS = 8_000;
export const CONSISTENCY_TOTAL_CHARS = 120_000;
const CONSISTENCY_MIN_CHAPTER_CHARS = 400;
const PREVIOUS_ENDING_CHARS = 1_500;
const MAX_FEEDBACK_NOTES = 12;
const MAX_CONSISTENCY_NOTES = 15;
const MAX_OUTLINE_CHAPTERS = 20;
const OUTLINE_TITLE_CHARS = 120;
const OUTLINE_NOTES_CHARS = 2_000;

// ---------------------------------------------------------------------------
// Draft a chapter

/**
 * Drafts a chapter from the author's notes, in the author's voice, continuing
 * from the end of the previous chapter. `targetWords` is clamped to 300–4000;
 * only the last 1,500 characters of `previousChapterEnding` are shown.
 *
 * The reply is markdown prose with no title heading (a leading heading or a
 * first line that repeats the chapter title is removed), normalized the way
 * the Studio stores chapters — for a picture layout, pages separated by
 * `<!-- page -->` lines. A reply the provider cut off at its output budget is
 * asked for once more at a wider budget (`generateJsonWithRetry`).
 */
export async function draftChapterFromNotes(
  input: {
    book: AuthorAssistBook;
    chapter: { title: string; notes: string };
    previousChapterEnding?: string;
    targetWords: number;
  },
  deps: { textModel: TextModelAdapter }
): Promise<{ markdown: string }> {
  const title = input.chapter.title.trim();
  if (!title && !input.chapter.notes.trim()) {
    throw new AuthorAssistInputError("NOTHING_TO_READ", "Give the chapter a title or some notes to draft from.");
  }
  const layout = input.book.layout ?? (input.book.kind === "picture" ? "picture" : "flow");
  const targetWords = clampTargetWords(input.targetWords);
  // A figure is a composed chapter's alone (a taken-over book can hold one): the
  // draft never sees one in the ending it continues from, and never keeps one it
  // invented — "every per-page path stores no figure of its own".
  const previousChapterEnding = tailOf(figureAndStandInFreeProse(input.previousChapterEnding ?? ""), PREVIOUS_ENDING_CHARS);
  const call = draftChapterCall({ book: input.book, chapter: input.chapter, previousChapterEnding, targetWords, layout });
  const reply = await runAuthorAssistCall(deps.textModel, call);
  const drafted = figureAndStandInFreeProse(cleanAssistText(reply.markdown));
  const markdown = normalizeManuscriptMarkdown(stripTitleLine(drafted, title), layout);
  if (manuscriptWordCount(markdown) === 0) {
    throw new AuthorAssistUnavailableError("The chapter draft came back empty.");
  }
  return { markdown };
}

export function clampTargetWords(targetWords: number): number {
  if (!Number.isFinite(targetWords)) return 1500;
  return Math.min(DRAFT_TARGET_WORDS.max, Math.max(DRAFT_TARGET_WORDS.min, Math.round(targetWords)));
}

function tailOf(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(trimmed.length - maxChars);
  const space = cut.search(/\s/);
  return (space >= 0 && space < maxChars * 0.3 ? cut.slice(space) : cut).trim();
}

/** Removes leading heading lines, and leading lines that are only the chapter title (plain or bold). */
function stripTitleLine(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  let index = 0;
  const plainTitle = title.toLocaleLowerCase();
  while (index < lines.length) {
    const line = lines[index]!.trim();
    const bare = line.replace(/^#{1,6}\s+/, "").replace(/^\*\*(.*)\*\*$/, "$1").replace(/^__(.*)__$/, "$1").trim();
    const isHeading = /^#{1,6}\s/.test(line);
    const isTitle = plainTitle.length > 0 && bare.toLocaleLowerCase() === plainTitle;
    if (line === "" && index > 0) {
      index += 1;
      continue;
    }
    if (!isHeading && !isTitle) break;
    index += 1;
  }
  // A reply that was only its title is no draft; the empty result says so.
  return lines.slice(index).join("\n").trim();
}

// ---------------------------------------------------------------------------
// Chapter feedback

/**
 * Developmental notes on one chapter: 3–12 asked for, at most 12 kept. Each
 * note's quote is verified against the chapter's markdown and replaced by the
 * chapter's own span (≤ 200 characters), or nulled when it is not there. Notes
 * come back in the order their quotes occur, notes about the whole chapter
 * last. A chapter longer than 60,000 characters is shown head and tail.
 */
export async function reviewChapterForAuthor(
  input: { book: AuthorAssistBook; chapter: { title: string; markdown: string } },
  deps: { textModel: TextModelAdapter }
): Promise<{ notes: AuthorNote[] }> {
  const markdown = input.chapter.markdown;
  if (manuscriptWordCount(markdown) === 0) {
    throw new AuthorAssistInputError("NOTHING_TO_READ", "This chapter has no text to read yet.");
  }
  // Read-only: a figure is shown as its stand-in line, never its JSON. Quotes are
  // still located in the chapter as stored, and a stand-in quote locates nowhere.
  const shown = clipHeadTail(figureStandInMarkdown(markdown.trim()), FEEDBACK_CHAPTER_CHARS);
  const call = chapterFeedbackCall({
    book: input.book,
    chapter: { title: input.chapter.title, markdown: shown.text, clipped: shown.clipped }
  });
  const reply = await runAuthorAssistCall(deps.textModel, call);
  const notes: AuthorNote[] = [];
  for (const raw of reply.notes) {
    const note = cleanNoteText(raw.note);
    if (!note) continue;
    notes.push({ quote: locateQuote(markdown, raw.quote), note, severity: raw.severity });
  }
  const ordered = orderNotesByQuote(markdown, notes).slice(0, MAX_FEEDBACK_NOTES);
  if (ordered.length === 0) {
    throw new AuthorAssistUnavailableError("The chapter feedback came back without a usable note.");
  }
  return { notes: ordered };
}

// ---------------------------------------------------------------------------
// Consistency

export type ConsistencyNote = AuthorNote & { chapterId: string | null };

/**
 * Contradictions of fact across the book's chapters. An empty list is a
 * valid answer — the chapters agree.
 *
 * **What the model sees is clipped.** Each chapter's prose (image lines and
 * fenced blocks removed) is shown whole up to 8,000 characters, and as its
 * head and tail beyond that; when the chapters together pass 120,000
 * characters, the per-chapter allowance shrinks to fit (never below 400). The
 * prompt says which chapters are clipped. Chapters with no prose are left out
 * but keep their numbers, which are positions in `input.chapters`.
 *
 * Each quote is verified against the full markdown of the chapter the model
 * named, then of every chapter in order; the note's `chapterId` is the chapter
 * the quote was found in. A quote found nowhere is nulled, and the note keeps
 * the named chapter's id when the number was a real chapter, else null.
 */
export async function checkBookConsistency(
  input: { book: AuthorAssistBook; chapters: Array<{ id: string; title: string; markdown: string }> },
  deps: { textModel: TextModelAdapter }
): Promise<{ notes: ConsistencyNote[] }> {
  const shown = consistencyChapters(input.chapters);
  if (shown.length === 0) {
    throw new AuthorAssistInputError("NOTHING_TO_READ", "The book has no text to check yet.");
  }
  const reply = await runAuthorAssistCall(deps.textModel, consistencyCall({ book: input.book, chapters: shown }));
  const notes: Array<ConsistencyNote & { order: number; at: number }> = [];
  const seen = new Set<string>();
  for (const raw of reply.notes) {
    const note = cleanNoteText(raw.note);
    if (!note) continue;
    const named = chapterAt(input.chapters, raw.chapterNumber);
    const located = locateInChapters(input.chapters, named, raw.quote);
    const chapterIndex = located ? located.index : named ? input.chapters.indexOf(named) : -1;
    const key = `${located?.quote ?? ""}\u0000${note.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push({
      quote: located?.quote ?? null,
      note,
      severity: raw.severity,
      chapterId: chapterIndex >= 0 ? input.chapters[chapterIndex]!.id : null,
      order: chapterIndex >= 0 ? chapterIndex : Infinity,
      at: located ? input.chapters[located.index]!.markdown.indexOf(located.quote) : Infinity
    });
    if (notes.length >= MAX_CONSISTENCY_NOTES) break;
  }
  notes.sort((a, b) => compareRank(a.order, b.order) || compareRank(a.at, b.at));
  return { notes: notes.map(({ order: _order, at: _at, ...note }) => note) };
}

function compareRank(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** The chapters the consistency read is shown, numbered by their position in the input (1-based). */
export function consistencyChapters(
  chapters: ReadonlyArray<{ title: string; markdown: string }>
): Array<{ number: number; title: string; text: string; clipped: boolean }> {
  const prose = chapters
    .map((chapter, index) => ({ number: index + 1, title: chapter.title.trim(), text: manuscriptProse(chapter.markdown).trim() }))
    .filter((chapter) => manuscriptWordCount(chapter.text) > 0);
  if (prose.length === 0) return [];
  const perChapter = Math.max(
    CONSISTENCY_MIN_CHAPTER_CHARS,
    Math.min(CONSISTENCY_CHAPTER_CHARS, Math.floor(CONSISTENCY_TOTAL_CHARS / prose.length))
  );
  return prose.map((chapter) => {
    const clipped = clipHeadTail(chapter.text, perChapter);
    return { number: chapter.number, title: chapter.title, text: clipped.text, clipped: clipped.clipped };
  });
}

function chapterAt<C>(chapters: readonly C[], value: number | string | null | undefined): C | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value.replace(/\D+/g, ""), 10) : NaN;
  return Number.isInteger(number) && number >= 1 ? chapters[number - 1] : undefined;
}

function locateInChapters(
  chapters: ReadonlyArray<{ markdown: string }>,
  named: { markdown: string } | undefined,
  quote: string | null | undefined
): { index: number; quote: string } | null {
  if (!quote) return null;
  const order = named ? [named, ...chapters.filter((chapter) => chapter !== named)] : chapters;
  for (const chapter of order) {
    const found = locateQuote(chapter.markdown, quote);
    if (found) return { index: chapters.indexOf(chapter), quote: found };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Outline

const DEFAULT_CHAPTER_TITLE = /^(?:chapter\s*\d+|your story|untitled(?:\s+chapter)?)$/i;

/**
 * An outline of 6–20 chapters (at most 20 kept), or for a picture book a
 * single chapter whose notes list its page beats one per line — several
 * chapters returned for a picture book are folded into one. Existing chapters
 * the author has written titles or notes for are passed through for the model
 * to keep; an untouched default ("Chapter 1" with no notes) is not.
 */
export async function outlineAuthorBook(
  input: { book: AuthorAssistBook; premise?: string; existingChapters?: Array<{ title: string; notes: string }> },
  deps: { textModel: TextModelAdapter }
): Promise<{ chapters: Array<{ title: string; notes: string }> }> {
  const existingChapters = (input.existingChapters ?? [])
    .map((chapter) => ({
      title: clipAtWord(chapter.title.trim(), OUTLINE_TITLE_CHARS),
      notes: clipAtWord(chapter.notes.trim(), OUTLINE_NOTES_CHARS)
    }))
    .filter((chapter) => chapter.notes.length > 0 || (chapter.title.length > 0 && !DEFAULT_CHAPTER_TITLE.test(chapter.title)))
    .slice(0, MAX_OUTLINE_CHAPTERS);
  const premise = clipAtWord((input.premise ?? input.book.styleProfile?.premise ?? "").trim(), AUTHOR_ASSIST_LIMITS.premiseChars);
  const reply = await runAuthorAssistCall(deps.textModel, outlineCall({ book: input.book, premise, existingChapters }));
  const chapters = reply.chapters
    .map((chapter) => {
      const notes = clipAtWord(cleanAssistText(chapter.notes), OUTLINE_NOTES_CHARS);
      const title = clipAtWord(cleanAssistText(chapter.title).replace(/^[#*\s]+|[*\s]+$/g, ""), OUTLINE_TITLE_CHARS);
      return { title: title || clipAtWord(notes, 60), notes };
    })
    .filter((chapter) => chapter.title.length > 0)
    .slice(0, MAX_OUTLINE_CHAPTERS);
  if (chapters.length === 0) {
    throw new AuthorAssistUnavailableError("The outline came back without a usable chapter.");
  }
  if (input.book.kind === "picture" && chapters.length > 1) {
    const beats = chapters.flatMap((chapter) => chapter.notes.split("\n").map((line) => line.trim()).filter(Boolean));
    return { chapters: [{ title: input.book.title.trim() || chapters[0]!.title, notes: beats.join("\n") }] };
  }
  return { chapters };
}

import {
  checkBookConsistency,
  draftChapterFromNotes,
  jsonRecord,
  outlineAuthorBook,
  reviewChapterForAuthor,
  type AuthorAssistBook,
  type AuthorNote,
  type TextModelAdapter
} from "@book-maker/core";
import { chapterEnding, previousChapter, type AssistChapter } from "./writingAssistContext.js";
import { WritingAssistFailure } from "../runtime/writingAssistSettlement.js";

/**
 * The four text assists of the Writing Studio, each one call into a core
 * runner (`packages/core/src/authoring/authorLongAssists.ts`) on the book's own
 * tier. Everything here is a *suggestion*: the result goes onto the
 * `ManuscriptAssist` row and the author applies it by hand, so nothing in this
 * module writes a chapter or a page.
 *
 * Refusals that the author can act on are raised before any model is called —
 * as `WritingAssistFailure` here (an empty chapter has no notes to give), or as
 * the runner's own `AuthorAssistInputError` — so a paid assist never spends a
 * provider call on nothing, and its charge comes back through the failure
 * path with a sentence that says what to do.
 */

/** The spec's default when the app names no length; core clamps whatever arrives. */
export const DRAFT_DEFAULT_WORDS = 1500;

/** The titles the Studio gives a chapter nobody has named yet. */
const PLACEHOLDER_TITLE = /^(?:chapter\s+\d+|your story)?$/i;

export type WritingAssistTextResult =
  | { type: "draft"; markdown: string }
  | { type: "notes"; notes: Array<AuthorNote & { chapterId?: string | null }> }
  | { type: "outline"; chapters: Array<{ title: string; notes: string }> };

type TextAssistContext = {
  book: AuthorAssistBook;
  chapters: readonly AssistChapter[];
  chapterId: string | null;
  input: unknown;
  textModel: TextModelAdapter;
};

function chapterFor(context: TextAssistContext): AssistChapter {
  const chapter = context.chapterId
    ? context.chapters.find((candidate) => candidate.id === context.chapterId)
    : undefined;
  if (!chapter) {
    throw new WritingAssistFailure("That chapter is no longer in your manuscript.");
  }
  return chapter;
}

function inputText(input: unknown, key: string, maxChars: number): string {
  const value = jsonRecord(input)[key];
  return typeof value === "string" ? value.trim().slice(0, maxChars) : "";
}

/**
 * The requested length. `draftChapterFromNotes` clamps it (`clampTargetWords`),
 * which only ever narrows what the price was quoted for.
 */
export function draftTargetWords(input: unknown): number {
  const raw = jsonRecord(input).targetWords;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DRAFT_DEFAULT_WORDS;
}

export async function draftChapterAssist(context: TextAssistContext): Promise<WritingAssistTextResult> {
  const chapter = chapterFor(context);
  // A chapter with neither notes nor a title is refused by the runner itself,
  // before any call, with a sentence the failure path passes through.
  const notes = inputText(context.input, "notes", 6000) || chapter.notes.trim();
  const previous = previousChapter(context.chapters, chapter.id);
  const previousEnding = previous ? chapterEnding(previous.markdown) : "";
  const { markdown } = await draftChapterFromNotes(
    {
      book: context.book,
      chapter: { title: chapter.title, notes },
      ...(previousEnding ? { previousChapterEnding: previousEnding } : {}),
      targetWords: draftTargetWords(context.input)
    },
    { textModel: context.textModel }
  );
  return { type: "draft", markdown };
}

export async function chapterFeedbackAssist(context: TextAssistContext): Promise<WritingAssistTextResult> {
  const chapter = chapterFor(context);
  if (!chapter.markdown.trim()) {
    throw new WritingAssistFailure("This chapter has no text yet to give notes on.");
  }
  const { notes } = await reviewChapterForAuthor(
    { book: context.book, chapter: { title: chapter.title, markdown: chapter.markdown } },
    { textModel: context.textModel }
  );
  return { type: "notes", notes };
}

export async function consistencyAssist(context: TextAssistContext): Promise<WritingAssistTextResult> {
  const chapters = context.chapters
    .filter((chapter) => chapter.markdown.trim())
    .map((chapter) => ({ id: chapter.id, title: chapter.title, markdown: chapter.markdown }));
  if (chapters.length === 0) {
    throw new WritingAssistFailure("Your book has no text yet to check.");
  }
  const { notes } = await checkBookConsistency({ book: context.book, chapters }, { textModel: context.textModel });
  return { type: "notes", notes };
}

export async function outlineAssist(context: TextAssistContext): Promise<WritingAssistTextResult> {
  // The app sends the author's premise as `notes` (or `prompt`); either will do.
  const premise = inputText(context.input, "notes", 6000) || inputText(context.input, "prompt", 1200);
  // A blank book's "Chapter 1" is the Studio's placeholder, not a plan the
  // outline has to keep; a chapter the author has named, noted or written is.
  const existingChapters = context.chapters
    .filter(
      (chapter) => chapter.notes.trim() || chapter.markdown.trim() || !PLACEHOLDER_TITLE.test(chapter.title.trim())
    )
    .map((chapter) => ({ title: chapter.title, notes: chapter.notes }));
  const { chapters } = await outlineAuthorBook(
    {
      book: context.book,
      ...(premise ? { premise } : {}),
      ...(existingChapters.length > 0 ? { existingChapters } : {})
    },
    { textModel: context.textModel }
  );
  return { type: "outline", chapters };
}

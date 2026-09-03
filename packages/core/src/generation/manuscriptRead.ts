import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { isStopOrAbortError } from "../adapters/retry.js";
import { targetLanguageGenerationGuidance } from "../prompting/language.js";
import type { AuthorStance, BookPlan, CreateProjectInput } from "../schemas/book.js";
import { isRecord } from "../schemas/jsonCoercion.js";
import { isNarrativeWritingMode } from "./authorStance.js";
import type { BookArc } from "./bookArc.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import { countReadableWords } from "./proseShape.js";
import { inferWritingMode } from "./styleContract.js";

/**
 * The whole-manuscript read of the composed-chapters pass: one call over
 * every chapter after the line edits, returning notes (never prose) — which
 * chapters to cut, what recurs across the book, where the argument stops
 * developing, and under an arc where the answer was stated early. Split out
 * of `composedChapter.ts` on 2026-09-03 for the file-size budget; the
 * barrel still reaches it through that module's re-export.
 */
export const READ_MANUSCRIPT_PURPOSE = "read-manuscript";

export const MANUSCRIPT_READ_MAX_WORDS = 110_000;

export type ManuscriptChapterForRead = {
  index: number;
  title: string;
  markdown: string;
  /** What the plan said this chapter establishes; the read checks the chapter against it, the writer never sees it. */
  expectedClaim?: string | undefined;
  /** Deterministic measurements of this chapter with the sentences behind them (`measurementNotes`). */
  measurements?: string[] | undefined;
};

export type ManuscriptReadResult = {
  chapters: Array<{ chapterIndex: number; edit: boolean; notes: string[] }>;
  bookNotes: string[];
  /** The chapter at which the argument stops developing, by the reader\'s count. */
  stopsDevelopingAt?: number | undefined;
  /** Two chapters that could swap places without loss, if any. */
  swappable?: number[] | undefined;
  /** Chapters before the resolution whose prose states the arc's answer, per the read. */
  answerStatedIn?: number[] | undefined;
  skipped?: string;
};

/** A note the model wrote as an object — `{paragraph, change}`, `{note}` — is its string fields joined; the first live read failed validation on exactly that. */
const readNoteSchema = z.preprocess((value) => {
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    return Object.values(value)
      .filter((field): field is string => typeof field === "string" && field.trim().length > 0)
      .join(": ");
  }
  return value;
}, z.string());

const manuscriptReadSchema = z.object({
  chapters: z
    .array(
      z.object({
        chapterIndex: z.number().int().positive(),
        edit: z.boolean().default(false),
        notes: z.array(readNoteSchema).default([])
      })
    )
    .default([]),
  bookNotes: z.array(readNoteSchema).default([]),
  stopsDevelopingAt: z.number().int().positive().optional(),
  swappable: z.array(z.number().int().positive()).max(2).optional(),
  answerStatedIn: z.array(z.number().int().positive()).default([])
});

export function manuscriptReadEditCap(chapterCount: number): number {
  return Math.max(1, Math.min(12, chapterCount));
}

/**
 * One read of the whole book. It returns notes, never prose: the chapters it
 * flags go back through `editChapter` with the notes, capped so a read that
 * dislikes everything cannot rewrite the book.
 */
export async function readManuscript(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  stance: AuthorStance;
  /** The arc, when the book has one: the read then reports where the answer was stated early. */
  arc?: BookArc | undefined;
  chapters: ManuscriptChapterForRead[];
  textModel: TextModelAdapter;
}): Promise<ManuscriptReadResult> {
  const totalWords = options.chapters.reduce((sum, chapter) => sum + countReadableWords(chapter.markdown), 0);
  if (totalWords > MANUSCRIPT_READ_MAX_WORDS) {
    return { chapters: [], bookNotes: [], skipped: `manuscript is ${totalWords} words; the read is capped at ${MANUSCRIPT_READ_MAX_WORDS}` };
  }
  const mode = inferWritingMode(options.input, options.plan);
  const cap = manuscriptReadEditCap(options.chapters.length);
  // The read returns notes, never prose, so a provider failure here is a
  // skipped read and not a failed book: composed-17 composed every chapter and
  // then failed at 70% on "OpenAI response was incomplete: max_output_tokens",
  // because at effort high the reasoning shares this output budget. The
  // budget is sized for that now; a cancellation still propagates.
  let result: { data: z.infer<typeof manuscriptReadSchema> };
  try {
    result = await generateJsonWithRetry(options.textModel, {
    purpose: READ_MANUSCRIPT_PURPOSE,
    temperature: 0.3,
    maxTokens: 16000,
    schema: manuscriptReadSchema,
    messages: [
      {
        role: "system",
        content: [
          "You are the acquiring editor reading the complete manuscript once, as a reader would, after every chapter has already had a line edit.",
          "Return one JSON object with chapters (one entry per chapter: chapterIndex, edit, notes) and bookNotes.",
          `Set edit to true for at most ${cap} chapters, the ones a reader would notice most, and only where deleting sentences or whole paragraphs would help: a case, scene, or conclusion another chapter already delivered (name both chapters); a claim of the book's restated in this chapter after an earlier chapter made it; a caveat about what the evidence cannot show, repeated after the chapter already made it; a closing paragraph that re-lists the chapter's cases or restates what the chapter showed; a one-sentence paragraph placed for effect. What follows the edit is deletion only, so do not flag what needs rewriting.`,
          "Each chapter carries measurements: deterministic counts with the sentences behind them, for orientation. Where a chapter carries expectedClaim, the plan's own statement of what it should establish, say in a note if the chapter does not establish it.",
          "notes are plain strings, one cut each, never objects.",
          "Each note quotes the first six to ten words of the sentence or paragraph to delete and says why in a few words. A chapter with edit false still gets an empty notes array.",
          "bookNotes: up to five sentences of the book's that recur across chapters in different words, each quoted once with the chapters that repeat it, for the cuts to act on. Also return stopsDevelopingAt: the chapter at which the book's argument stops developing and starts re-demonstrating, and swappable: two chapter indexes that could change places without loss, or an empty array.",
          `The author's stance, which the chapters should honour: ${options.stance.thesis} Positions: ${options.stance.positions.join(" | ")}`,
          ...(options.arc
            ? [
                `The book's answer, which only its resolution chapter (chapter ${Math.max(...options.arc.chapters.map((chapter) => chapter.index))}) may state: ${options.arc.answer} Return answerStatedIn: every chapter index before it whose prose states that answer in its own words, or an empty array.`
              ]
            : []),
          ...(isNarrativeWritingMode(mode) ? ["This is fiction: judge scenes, not arguments."] : []),
          ...targetLanguageGenerationGuidance(options.input.language)
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            book: { title: options.plan.title, premise: options.plan.premise, audience: options.plan.audience },
            chapters: options.chapters.map((chapter) => ({
              chapterIndex: chapter.index,
              title: chapter.title,
              ...(chapter.expectedClaim ? { expectedClaim: chapter.expectedClaim } : {}),
              ...(chapter.measurements && chapter.measurements.length > 0 ? { measurements: chapter.measurements } : {}),
              text: chapter.markdown
            })),
            outputContract: {
              chapters: [{ chapterIndex: 1, edit: false, notes: ["Paragraph beginning '…': cut the closing sentence."] }],
              bookNotes: ["One observation about the whole book."],
              stopsDevelopingAt: 1,
              swappable: [],
              answerStatedIn: []
            }
          },
          null,
          2
        )
      }
    ]
  });
  } catch (error) {
    if (isStopOrAbortError(error)) {
      throw error;
    }
    return { chapters: [], bookNotes: [], skipped: `read failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const known = new Set(options.chapters.map((chapter) => chapter.index));
  let edits = 0;
  const chapters = result.data.chapters
    .filter((entry) => known.has(entry.chapterIndex))
    .map((entry) => {
      const edit = entry.edit && entry.notes.length > 0 && edits < cap;
      if (edit) edits += 1;
      return { chapterIndex: entry.chapterIndex, edit, notes: entry.notes.map((note) => note.trim()).filter(Boolean) };
    });
  return {
    chapters,
    bookNotes: result.data.bookNotes,
    ...(result.data.stopsDevelopingAt !== undefined ? { stopsDevelopingAt: result.data.stopsDevelopingAt } : {}),
    ...(result.data.swappable !== undefined ? { swappable: result.data.swappable } : {}),
    ...(result.data.answerStatedIn.length > 0 ? { answerStatedIn: result.data.answerStatedIn } : {})
  };
}

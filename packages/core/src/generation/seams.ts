import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { isStopOrAbortError } from "../adapters/retry.js";
import { LATIN_SCRIPT_LANGUAGES } from "./chapterIntegrity.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import type { BookArc } from "./bookArc.js";
import { countReadableWords } from "./proseShape.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";

/**
 * The seams: every chapter's first and last paragraph, rewritten together in
 * one call under a no-two-alike contract, then accepted paragraph by
 * paragraph by rules the model cannot argue with. Openings and closings are
 * where the readers' three most-named tics cluster — the paired-antithesis
 * closer, the recap tail, the verdict — because each chapter's writer wrote
 * its seams without seeing any other chapter's. Proposed as experiment 4 of
 * research-improvements.md on 2026-09-02; first run in arm 1 of the arc.
 */
export const REWRITE_SEAMS_PURPOSE = "rewrite-seams";

export type SeamChapter = { index: number; title: string; kind?: string | undefined; opening: string; closing: string };
export type SeamReplacement = { index: number; opening?: string | undefined; closing?: string | undefined };

const seamsSchema = z.object({
  chapters: z.array(z.object({ index: z.number().int().positive(), opening: z.string().default(""), closing: z.string().default("") })).default([])
});

function properNouns(text: string): Set<string> {
  const nouns = new Set<string>();
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const words = sentence.split(/\s+/);
    for (const [index, raw] of words.entries()) {
      const word = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
      if (index === 0 || word.length < 4) continue;
      if (/^[A-Z][a-z]/.test(word)) nouns.add(word);
    }
  }
  return nouns;
}

function numbers(text: string): Set<string> {
  return new Set((text.match(/\b\d[\d,.]*\b/g) ?? []).map((n) => n.replace(/[,.]$/, "")));
}

function contentWords(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z]{4,}/g) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** A replacement is accepted only if it keeps the original's length band, every proper noun and every number. */
export function acceptSeam(original: string, candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed === original.trim()) return false;
  const originalWords = countReadableWords(original);
  const candidateWords = countReadableWords(trimmed);
  if (candidateWords < originalWords * 0.6 || candidateWords > originalWords * 1.4) return false;
  for (const noun of properNouns(original)) if (!trimmed.includes(noun)) return false;
  for (const number of numbers(original)) if (!trimmed.includes(number)) return false;
  return true;
}

export const SEAM_SIMILARITY_CEILING = 0.5;

/** The acceptance reads Latin proper nouns and words, so only a Latin-script book gets seams rewritten. */
export function seamsSupported(language: string): boolean {
  return LATIN_SCRIPT_LANGUAGES.has(language);
}

export async function rewriteSeams(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  arc?: BookArc | undefined;
  chapters: readonly SeamChapter[];
  bookNotes: readonly string[];
  textModel: TextModelAdapter;
}): Promise<{ replacements: SeamReplacement[]; accepted: number; rejected: number; skipped?: string }> {
  if (options.chapters.length === 0) {
    return { replacements: [], accepted: 0, rejected: 0 };
  }
  const arcByIndex = new Map(options.arc?.chapters.map((chapter) => [chapter.index, chapter]) ?? []);
  // The seams are a revision, never prose the book cannot ship without: a
  // provider failure here is a skipped revision, not a failed book, the same
  // rule the manuscript read follows. A cancellation still propagates.
  let result: { data: z.infer<typeof seamsSchema> };
  try {
    result = await generateJsonWithRetry(options.textModel, {
    purpose: REWRITE_SEAMS_PURPOSE,
    temperature: Math.min(0.5, options.input.temperature),
    maxTokens: 12000,
    schema: seamsSchema,
    messages: [
      {
        role: "system",
        content: [
          `You are the author of "${options.plan.title}" revising, together, the first and last paragraph of every chapter, which were written one chapter at a time.`,
          "Return one JSON object with chapters: one entry per chapter with index, opening and closing — the full replacement paragraphs, or the original paragraph unchanged where it already serves.",
          "No two closings may share a shape; no closing may state the book's answer, weigh two sides against each other, re-list the chapter's cases, or end on an aphorism that inverts a clause. A case chapter closes on its last event; a document chapter on its document's words; a complication chapter on the problem, unrepaired; a resolution on the answer, once. No two openings may open on the same construction, and no opening may announce what the chapter will do.",
          "Keep every fact, name, date, number and quotation of the paragraph you replace, and keep its length within a third either way. The paragraph must still join the sentences before or after it.",
          ...(options.bookNotes.length > 0 ? [`A reader of the whole manuscript noted: ${options.bookNotes.join(" | ")}`] : []),
          ...targetLanguageGenerationGuidance(options.input.language)
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            language: targetLanguagePayload(options.input.language),
            chapters: options.chapters.map((chapter) => ({
              index: chapter.index,
              title: chapter.title,
              ...(chapter.kind ? { kind: chapter.kind } : {}),
              ...(arcByIndex.get(chapter.index)?.job.does ? { job: arcByIndex.get(chapter.index)!.job.does } : {}),
              opening: chapter.opening,
              closing: chapter.closing
            })),
            outputContract: { chapters: [{ index: 1, opening: "…", closing: "…" }] }
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
    return { replacements: [], accepted: 0, rejected: 0, skipped: `seams failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const replacements: SeamReplacement[] = [];
  const acceptedClosings: Set<string>[] = [];
  let accepted = 0;
  let rejected = 0;
  for (const chapter of options.chapters) {
    const answer = result.data.chapters.find((entry) => entry.index === chapter.index);
    if (!answer) continue;
    const replacement: SeamReplacement = { index: chapter.index };
    if (acceptSeam(chapter.opening, answer.opening)) {
      replacement.opening = answer.opening.trim();
      accepted += 1;
    } else if (answer.opening.trim() && answer.opening.trim() !== chapter.opening.trim()) {
      rejected += 1;
    }
    if (acceptSeam(chapter.closing, answer.closing)) {
      const words = contentWords(answer.closing);
      if (acceptedClosings.every((other) => jaccard(words, other) < SEAM_SIMILARITY_CEILING)) {
        replacement.closing = answer.closing.trim();
        acceptedClosings.push(words);
        accepted += 1;
      } else {
        rejected += 1;
      }
    } else if (answer.closing.trim() && answer.closing.trim() !== chapter.closing.trim()) {
      rejected += 1;
    }
    if (replacement.opening !== undefined || replacement.closing !== undefined) {
      replacements.push(replacement);
    }
  }
  return { replacements, accepted, rejected };
}

/** The chapter with its first and/or last paragraph replaced. */
export function applySeam(markdown: string, replacement: SeamReplacement): string {
  const paragraphs = markdown.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  if (paragraphs.length === 0) return markdown;
  if (replacement.opening !== undefined) paragraphs[0] = replacement.opening;
  if (replacement.closing !== undefined) paragraphs[paragraphs.length - 1] = replacement.closing;
  return paragraphs.join("\n\n");
}

/** The first and last paragraph of a chapter, for the seams call. */
export function chapterSeams(markdown: string): { opening: string; closing: string } {
  const paragraphs = markdown.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  return { opening: paragraphs[0] ?? "", closing: paragraphs[paragraphs.length - 1] ?? "" };
}

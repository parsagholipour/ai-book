import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";
import type { AuthorStance, BookPlan, ChapterPlan, CreateProjectInput } from "../schemas/book.js";
import type { BookEpisodes } from "../schemas/episodes.js";
import { isRecord } from "../schemas/jsonCoercion.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import { FIGURE_FORM_PLAN_CONTRACT, FIGURE_FORM_PLAN_RULE } from "./figures/figurePrompt.js";
import { figurePlanSchema } from "./figures/figureSpec.js";
import { assignedSectionCount, sectionCountForPages, sustainedSectionShare } from "./chapterSectionCount.js";
import { EXAMPLE_CAST_RULE, FIXED_EXAMPLE_CAST_RULE, exampleCastFrom, type ExampleCastMember } from "./exampleCast.js";
import { ANALYTICAL_FORMS, PINNED_FORMS, formPaletteFor, type SectionForm } from "./chapterFormPalette.js";
import type { InstructionalSetting, InstructionalToolkit } from "../schemas/instructional.js";
import { inferWritingMode } from "./styleContract.js";
export { formPaletteFor, type SectionForm } from "./chapterFormPalette.js";
export {
  assignedSectionCount,
  MAX_CHAPTER_SECTIONS,
  SECTION_ASK_WORDS,
  sectionCountForPages,
  SUSTAINED_SECTION_WORDS,
  sustainedSectionShare
} from "./chapterSectionCount.js";

/**
 * The chapter form plan: what replaces the per-page production map for the
 * composed-chapters strategy.
 *
 * A page brief assigned every page the same job — a purpose, one bounded
 * claim, its evidence anchors and a landing sentence — so 120 pages came out
 * as 120 argumentative units of one shape. A form plan assigns each stretch of
 * a chapter a *shape* from a palette (a scene narrated in time, a close reading
 * of one source, a catalogue that is allowed to read as a list, a question left
 * open, a quiet passage with no thesis), and gives the whole chapter exactly
 * one landing. Variety is a property of the plan, which is where a
 * deterministic check is cheap and precise; it is not a property any prose
 * detector could recover after the fact.
 */

export const PLAN_CHAPTER_FORMS_PURPOSE = "plan-chapter-forms";

export const chapterSectionSchema = z.object({
  form: z.string().min(1),
  subject: z.string().min(1),
  /**
   * Any positive number: models answer in fractions or percentages, and shares
   * are renormalised to sum to one. A zero, negative or non-finite share is no
   * share: refused, it cost the section's whole chapter its planned sections
   * (the q2 workbook's last chapter went to the keyBeat fallback over one `0.0`).
   */
  share: z.preprocess((value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined), z.number().positive().optional()),
  owns: z.array(z.string()).default([]),
  note: z.string().optional(),
  /** The question or unfinished business this section hands to the next: the seam the writer carries across. */
  handoff: z.string().optional(),
  /** A chart or flow diagram this section carries, assigned here for an eligible book and drawn at compile; see `figures/`. */
  figure: figurePlanSchema.optional(),
  /** A toolkit section's subheading, printed as `###` (`instructionalBook.ts`); dropped from every other plan. */
  heading: z.string().trim().min(1).max(120).optional(),
  /** The brief requirement ids a toolkit section delivers (`requirementCoverageIssues`). */
  covers: z.array(z.string()).optional()
});

export const chapterCompositionSchema = z.object({
  chapterIndex: z.number().int().positive(),
  throughLine: z.string(),
  sections: z.array(chapterSectionSchema).min(1),
  landing: z.string(),
  avoid: z.array(z.string()).default([])
});

export type ChapterSection = z.infer<typeof chapterSectionSchema>;
export type ChapterComposition = z.infer<typeof chapterCompositionSchema>;

/** Tolerant root: `{chapters:[…]}`, `{compositions:[…]}`, or a bare array. */
const chapterCompositionsResponseSchema = z.preprocess(
  (value) => {
    if (Array.isArray(value)) {
      return { chapters: value };
    }
    if (isRecord(value)) {
      for (const key of ["chapters", "compositions", "plan", "chapterPlans"]) {
        if (Array.isArray(value[key])) {
          return { chapters: value[key] };
        }
      }
    }
    return value;
  },
  z.object({ chapters: z.array(z.unknown()) })
);

export type ChapterFormRange = { chapter: ChapterPlan; startPage: number; endPage: number
  /** The arc's kind for this chapter, when the book has an arc. */
  kind?: string | undefined;
  /** The arc's job for this chapter (`job.does`), which stands in for the plan's summary. */
  job?: string | undefined;
  /**
   * The chapter's word target (`chapterWordBudget(...).target`, before figures).
   * With it the section count is sized so no section is asked for more prose
   * than the writer returns for one; without it, by pages alone.
   */
  words?: number | undefined;
};


const MAX_BOOK_FORM_SHARE = 0.4;

/**
 * The variety contract, as messages. Empty means the plan passes. Each string
 * is written so the repair call can act on it.
 */
const LANDING_NEGATION_CONTRAST = /\b(?:did|does|do|was|were|is|are|could|would|had|has|have)\s+not\s+(?:simply|merely|only|just)\b|\b(?:was|were|is|are)\s+never\s+(?:only|simply|merely)\b|\bless\s+(?:on|about|a|an)\b.{3,80}\bthan\b|\bneither\b.{3,60}\bnor\b|\brather than\b|\bnot\b.{2,60}\bbut\b/i;
const LANDING_STOP_WORDS = new Set([
  "the", "a", "an", "of", "and", "or", "in", "to", "that", "this", "it", "its", "is", "was", "were", "are", "for", "on",
  "as", "by", "with", "at", "from", "but", "not", "into", "than", "their", "they", "them", "which", "who", "whose",
  "when", "where", "what", "how", "could", "would", "did", "does", "do", "had", "has", "have", "be", "been", "also",
  "only", "simply", "more", "less", "both", "each", "every", "one", "made", "make", "became", "become", "remained"
]);

function contentWords(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}'’-]+/gu) ?? []).filter((word) => word.length > 3 && !LANDING_STOP_WORDS.has(word))
  );
}

function overlap(left: Set<string>, right: Set<string>): number {
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared;
}

/**
 * The landings are where the first composed book's template lived: ten
 * chapters, ten closing sentences shaped "X did not simply A; it B, C and D",
 * each a restatement of the thesis, each pasted verbatim as the chapter's
 * last line. A landing is a particular the final section arrives at, and no
 * two may share a shape or a subject.
 */
export function landingIssues(
  compositions: readonly ChapterComposition[],
  options: { thesis?: string | undefined } = {}
): string[] {
  const issues: string[] = [];
  const thesisWords = options.thesis ? contentWords(options.thesis) : new Set<string>();
  const seen: Array<{ chapterIndex: number; words: Set<string> }> = [];
  for (const composition of compositions) {
    const landing = composition.landing.trim();
    if (!landing) continue;
    if (LANDING_NEGATION_CONTRAST.test(landing)) {
      issues.push(`Chapter ${composition.chapterIndex}'s landing is built as a negation and its correction ("${landing}"); make it a particular the final section arrives at.`);
    }
    const words = contentWords(landing);
    if (thesisWords.size > 0 && overlap(words, thesisWords) >= 4) {
      issues.push(`Chapter ${composition.chapterIndex}'s landing restates the book's thesis ("${landing}").`);
    }
    for (const earlier of seen) {
      if (overlap(words, earlier.words) >= 4) {
        issues.push(`Chapter ${composition.chapterIndex}'s landing repeats chapter ${earlier.chapterIndex}'s landing.`);
        break;
      }
    }
    seen.push({ chapterIndex: composition.chapterIndex, words });
  }
  return issues;
}

/**
 * Shape issues the repair call is asked to fix and the deterministic settle
 * cannot: fifteen chapters of exactly four sections at exactly a quarter each
 * was the best-scoring balanced book's form plan (composed-19a), and the
 * readers called every chapter the same silhouette. Kept apart from
 * `compositionVarietyIssues`, whose contract is that `settleFormVariety`
 * clears every one of them.
 */
export function compositionShapeIssues(compositions: readonly ChapterComposition[]): string[] {
  const issues: string[] = [];
  for (const composition of compositions) {
    const shares = composition.sections.map((section) => section.share ?? 1 / composition.sections.length);
    if (shares.length >= 3 && Math.max(...shares) - Math.min(...shares) < 0.08) {
      issues.push(`Chapter ${composition.chapterIndex} splits its length evenly across sections; give it one section of at least its sustainedShare and one under 15%.`);
    }
  }
  if (compositions.length >= 6) {
    const counts = new Set(compositions.map((composition) => composition.sections.length));
    if (counts.size === 1) {
      issues.push(`Every chapter has ${[...counts][0]} sections; vary the count across the book within each chapter's sectionCount range.`);
    }
  }
  return issues;
}

export function compositionVarietyIssues(
  compositions: readonly ChapterComposition[],
  palette: readonly SectionForm[],
  options: { thesis?: string | undefined } = {}
): string[] {
  const issues: string[] = [];
  const ids = new Set(palette.map((form) => form.id));
  const bookCounts = new Map<string, number>();
  let totalSections = 0;
  const sequences = new Map<string, number>();
  let previousOpening: string | undefined;

  for (const composition of compositions) {
    const forms = composition.sections.map((section) => section.form);
    const unknown = forms.filter((form) => !ids.has(form));
    if (unknown.length > 0) {
      issues.push(`Chapter ${composition.chapterIndex} uses forms outside the palette: ${[...new Set(unknown)].join(", ")}.`);
    }
    const counts = new Map<string, number>();
    for (const form of forms) {
      counts.set(form, (counts.get(form) ?? 0) + 1);
      bookCounts.set(form, (bookCounts.get(form) ?? 0) + 1);
      totalSections += 1;
    }
    if (forms.length >= 3) {
      for (const [form, count] of counts) {
        if (count * 2 > forms.length && !PINNED_FORMS.has(form)) {
          issues.push(`Chapter ${composition.chapterIndex} gives more than half its sections the form "${form}".`);
        }
      }
    }
    for (let index = 1; index < forms.length; index += 1) {
      if (forms[index] === forms[index - 1] && forms[index] !== "entry-cluster" && !PINNED_FORMS.has(forms[index]!)) {
        issues.push(`Chapter ${composition.chapterIndex} has two consecutive "${forms[index]}" sections.`);
        break;
      }
    }
    const sequence = forms.join(">");
    const earlier = sequences.get(sequence);
    if (earlier !== undefined && forms.length > 1) {
      issues.push(`Chapter ${composition.chapterIndex} repeats chapter ${earlier}'s exact form sequence.`);
    } else {
      sequences.set(sequence, composition.chapterIndex);
    }
    const opening = forms[0];
    if (opening !== undefined && previousOpening === opening && compositions.length > 2) {
      issues.push(`Chapter ${composition.chapterIndex} opens with "${opening}", the same form the previous chapter opened with.`);
    }
    previousOpening = opening;
    if (!composition.landing.trim()) {
      issues.push(`Chapter ${composition.chapterIndex} has no landing.`);
    }
  }
  if (totalSections >= 6) {
    for (const [form, count] of bookCounts) {
      if (count > totalSections * MAX_BOOK_FORM_SHARE && form !== "entry-cluster" && form !== "scene" && !PINNED_FORMS.has(form)) {
        issues.push(`The form "${form}" is used for ${count} of ${totalSections} sections across the book; keep any one form under 40%.`);
      }
    }
  }
  return [...issues, ...positionalIssues(compositions), ...landingIssues(compositions, options)];
}

const MAX_POSITIONAL_SHARE = 0.34;

/**
 * The third composed book's plan put "comparison" third in twelve of fifteen
 * chapters: the sequences differed, the shape did not. No form may hold the
 * same position in more than a third of the chapters.
 */
export function positionalIssues(compositions: readonly ChapterComposition[]): string[] {
  if (compositions.length < 5) return [];
  const issues: string[] = [];
  const longest = Math.max(...compositions.map((composition) => composition.sections.length));
  for (let position = 0; position < longest; position += 1) {
    const counts = new Map<string, number>();
    let chaptersWithPosition = 0;
    for (const composition of compositions) {
      const form = composition.sections[position]?.form;
      if (!form) continue;
      chaptersWithPosition += 1;
      counts.set(form, (counts.get(form) ?? 0) + 1);
    }
    for (const [form, count] of counts) {
      if (chaptersWithPosition >= 5 && count > chaptersWithPosition * MAX_POSITIONAL_SHARE && form !== "scene" && !PINNED_FORMS.has(form)) {
        issues.push(`The form "${form}" sits in position ${position + 1} of ${count} chapters out of ${chaptersWithPosition}; move it earlier or later in most of them.`);
      }
    }
  }
  return issues;
}

/**
 * Break a positional pile-up by swapping the over-used form with the form of
 * another section in the same chapter; subjects and ownership stay where they
 * are, only the shape assigned to them moves. A partner position is chosen so
 * the move does not push that position over the limit either.
 */
export function rotatePositionsForVariety(compositions: readonly ChapterComposition[]): ChapterComposition[] {
  const result = compositions.map((composition) => ({ ...composition, sections: composition.sections.map((section) => ({ ...section })) }));
  if (result.length < 5) return result;
  const longest = Math.max(...result.map((composition) => composition.sections.length));
  const holdersAt = (position: number) => result.filter((composition) => composition.sections[position]);
  const countAt = (position: number, form: string) =>
    holdersAt(position).filter((composition) => composition.sections[position]!.form === form).length;
  const allowedAt = (position: number) => Math.max(1, Math.floor(holdersAt(position).length * MAX_POSITIONAL_SHARE));
  for (let position = 0; position < longest; position += 1) {
    if (holdersAt(position).length < 5) continue;
    const forms = new Set(holdersAt(position).map((composition) => composition.sections[position]!.form));
    for (const form of forms) {
      if (form === "scene" || PINNED_FORMS.has(form)) continue;
      for (const composition of holdersAt(position)) {
        if (countAt(position, form) <= allowedAt(position)) break;
        const section = composition.sections[position]!;
        if (section.form !== form) continue;
        const partners = composition.sections
          .map((_, index) => index)
          .filter((index) => index !== position && composition.sections[index]!.form !== form && !PINNED_FORMS.has(composition.sections[index]!.form))
          .sort((left, right) => countAt(left, form) - countAt(right, form));
        const partner = partners.find(
          (index) =>
            countAt(index, form) + 1 <= allowedAt(index) &&
            countAt(position, composition.sections[index]!.form) + 1 <= allowedAt(position)
        ) ?? partners[0];
        if (partner === undefined) continue;
        const other = composition.sections[partner]!;
        const swapped = other.form;
        other.form = section.form;
        section.form = swapped;
      }
    }
  }
  return result;
}

/**
 * At most two chapters may end on `open-question`: three Opus readers heard every chapter close on the same
 * unanswered two-clause question. A later one swaps its last two sections. Pure and idempotent.
 */
export function capOpenQuestionEndings(compositions: readonly ChapterComposition[], palette: readonly SectionForm[] = ANALYTICAL_FORMS): ChapterComposition[] {
  let ending = 0;
  return compositions.map((composition) => {
    const sections = composition.sections.map((section) => ({ ...section }));
    const last = sections.length - 1;
    if (sections[last]?.form !== "open-question") return composition;
    ending += 1;
    if (ending <= 2) return composition;
    const swap = last === 0 ? palette.find((form) => form.id !== "open-question")?.id : sections[last - 1]!.form;
    if (last > 0) sections[last - 1]!.form = "open-question";
    if (swap) sections[last]!.form = swap;
    return { ...composition, sections };
  });
}

/** Forms and positions rotated in turn until the non-positional contract holds, bounded. */
export function settleFormVariety(
  compositions: readonly ChapterComposition[],
  palette: readonly SectionForm[]
): ChapterComposition[] {
  let current = rotateFormsForVariety(compositions, palette);
  for (let round = 0; round < 3; round += 1) {
    current = rotatePositionsForVariety(current);
    const remaining = compositionVarietyIssues(current, palette).filter((issue) => !issue.includes("sits in position"));
    if (remaining.length === 0) break;
    current = rotateFormsForVariety(current, palette);
  }
  return capOpenQuestionEndings(current, palette);
}

/** A composition nothing came back for: forms rotated by chapter offset, subjects from the plan. */
export function fallbackChapterComposition(
  range: ChapterFormRange,
  palette: readonly SectionForm[],
  offset: number
): ChapterComposition {
  const bounds = sectionCountForPages(range.endPage - range.startPage + 1, range.words);
  const count = Math.min(bounds.max, Math.max(bounds.min, range.chapter.keyBeats.length || 3));
  const subjects = range.chapter.keyBeats.length > 0 ? range.chapter.keyBeats : [range.chapter.summary];
  const usable = palette.filter((form) => form.id !== "quiet-transition");
  return {
    chapterIndex: range.chapter.index,
    throughLine: range.chapter.summary,
    sections: Array.from({ length: count }, (_, index) => ({
      form: usable[(offset + index * 2) % usable.length]!.id,
      subject: subjects[index % subjects.length]!,
      share: 1 / count,
      owns: []
    })),
    landing: range.chapter.keyBeats.at(-1) ?? range.chapter.summary,
    avoid: []
  };
}

function canonicalFormId(form: string, palette: readonly SectionForm[]): string | undefined {
  const slug = form.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (palette.some((candidate) => candidate.id === slug)) {
    return slug;
  }
  return palette.find((candidate) => slug.includes(candidate.id) || candidate.id.includes(slug))?.id;
}

function leastUsedForm(
  palette: readonly SectionForm[],
  counts: Map<string, number>,
  exclude: ReadonlySet<string>
): string {
  let best: SectionForm | undefined;
  for (const form of palette) {
    if (exclude.has(form.id) || form.id === "quiet-transition") {
      continue;
    }
    if (!best || (counts.get(form.id) ?? 0) < (counts.get(best.id) ?? 0)) {
      best = form;
    }
  }
  return (best ?? palette[0]!).id;
}

/**
 * Bring a parsed answer onto the chapter ranges: every chapter present once,
 * section counts within range, forms canonical, shares summing to one.
 * Unknown forms and missing chapters are replaced deterministically; the
 * variety issues that remain are the repair call's to fix.
 */
export function normalizeChapterCompositions(
  raw: unknown,
  ranges: readonly ChapterFormRange[],
  palette: readonly SectionForm[],
  /** A toolkit plan keeps each section's heading and covers; every other plan drops them, as it did before they existed. */
  options: { toolkit?: boolean | undefined } = {}
): ChapterComposition[] {
  const parsed = chapterCompositionsResponseSchema.safeParse(raw);
  const byChapter = new Map<number, ChapterComposition>();
  if (parsed.success) {
    for (const candidate of parsed.data.chapters) {
      const composition = chapterCompositionSchema.safeParse(withoutUnreadableFigures(candidate));
      if (composition.success && !byChapter.has(composition.data.chapterIndex)) {
        byChapter.set(composition.data.chapterIndex, composition.data);
      }
    }
  }
  const bookCounts = new Map<string, number>();
  return ranges.map((range, offset) => {
    const bounds = sectionCountForPages(range.endPage - range.startPage + 1, range.words);
    const found = byChapter.get(range.chapter.index);
    const fallback = fallbackChapterComposition(range, palette, offset);
    const source = found ?? fallback;
    let sections = source.sections
      .map((section) => {
        const form = canonicalFormId(section.form, palette);
        if (!form) return undefined;
        if (options.toolkit) return { ...section, form };
        const { heading: _heading, covers: _covers, ...legacy } = section;
        return { ...legacy, form };
      })
      .filter((section): section is ChapterSection => section !== undefined)
      .slice(0, bounds.max);
    if (sections.length < bounds.min) {
      const used = new Set(sections.map((section) => section.form));
      for (const extra of fallback.sections) {
        if (sections.length >= bounds.min) break;
        const counts = new Map<string, number>();
        for (const section of sections) counts.set(section.form, (counts.get(section.form) ?? 0) + 1);
        sections = [...sections, { ...extra, form: leastUsedForm(palette, counts, used) }];
        used.add(sections.at(-1)!.form);
      }
    }
    const totalShare = sections.reduce((sum, section) => sum + (section.share ?? 0), 0);
    sections = sections.map((section) => ({
      ...section,
      share: totalShare > 0 && sections.every((candidate) => candidate.share !== undefined)
        ? section.share! / totalShare
        : 1 / sections.length
    }));
    for (const section of sections) bookCounts.set(section.form, (bookCounts.get(section.form) ?? 0) + 1);
    return {
      chapterIndex: range.chapter.index,
      throughLine: source.throughLine.trim() || range.chapter.summary,
      sections,
      landing: source.landing.trim() || fallback.landing,
      avoid: source.avoid
    };
  });
}

/**
 * A figure the planner spelled in a way the schema refuses is dropped from
 * its section rather than costing the chapter its whole form plan.
 */
function withoutUnreadableFigures(candidate: unknown): unknown {
  if (!isRecord(candidate) || !Array.isArray(candidate.sections)) return candidate;
  return {
    ...candidate,
    sections: candidate.sections.map((section) => {
      if (!isRecord(section) || section.figure === undefined || figurePlanSchema.safeParse(section.figure).success) return section;
      const { figure: _unreadable, ...rest } = section;
      return rest;
    })
  };
}

/** Three chapters in four may carry a figure. */
export function figureCapFor(chapterCount: number): number {
  return Math.ceil(chapterCount * 0.75);
}

/**
 * At most one figure per chapter and `maxPerBook` across the book: the first
 * section's figure wins its chapter, and chapters are kept by whether they
 * name a source, then by order. Chapters in `keep` are never stripped. Never
 * blocks, never touches forms, subjects or ownership.
 */
export function capFigures(
  compositions: readonly ChapterComposition[],
  options: { maxPerBook: number; keep?: ReadonlySet<number> | undefined }
): ChapterComposition[] {
  const onePerChapter: ChapterComposition[] = compositions.map((composition) => {
    let seen = false;
    return {
      ...composition,
      sections: composition.sections.map((section): ChapterSection => {
        if (!section.figure) return section;
        if (seen) {
          const { figure: _second, ...rest } = section;
          return rest;
        }
        seen = true;
        return section;
      })
    };
  });
  const holders = onePerChapter.filter((composition) => composition.sections.some((section) => section.figure));
  const ranked = [...holders].sort((left, right) => {
    const keptLeft = options.keep?.has(left.chapterIndex) ? 1 : 0;
    const keptRight = options.keep?.has(right.chapterIndex) ? 1 : 0;
    const sourcedLeft = left.sections.some((section) => section.figure?.source) ? 1 : 0;
    const sourcedRight = right.sections.some((section) => section.figure?.source) ? 1 : 0;
    return keptRight - keptLeft || sourcedRight - sourcedLeft || left.chapterIndex - right.chapterIndex;
  });
  const keepIndexes = new Set(ranked.slice(0, Math.max(0, options.maxPerBook)).map((composition) => composition.chapterIndex));
  for (const index of options.keep ?? []) keepIndexes.add(index);
  return onePerChapter.map((composition) =>
    keepIndexes.has(composition.chapterIndex)
      ? composition
      : { ...composition, sections: composition.sections.map(({ figure: _stripped, ...rest }): ChapterSection => rest) }
  );
}

/**
 * Deterministic last resort for a plan the repair call could not clear:
 * replace over-used, doubled and same-opening forms with the least-used form
 * in the palette. The subjects, ownership and landings stay as planned.
 */
export function rotateFormsForVariety(
  compositions: readonly ChapterComposition[],
  palette: readonly SectionForm[]
): ChapterComposition[] {
  const total = compositions.reduce((sum, composition) => sum + composition.sections.length, 0);
  const counts = new Map<string, number>();
  const sequences = new Set<string>();
  let previousOpening: string | undefined;
  return compositions.map((composition) => {
    const sections = composition.sections.map((section) => ({ ...section }));
    for (let index = 0; index < sections.length; index += 1) {
      const section = sections[index]!;
      const previous = index > 0 ? sections[index - 1]!.form : undefined;
      const exclude = new Set<string>();
      if (previous) exclude.add(previous);
      if (index === 0 && previousOpening) exclude.add(previousOpening);
      const overused = total >= 6 && (counts.get(section.form) ?? 0) + 1 > total * MAX_BOOK_FORM_SHARE && section.form !== "scene";
      if ((exclude.has(section.form) || overused) && !PINNED_FORMS.has(section.form)) {
        section.form = leastUsedForm(palette, counts, exclude);
      }
      counts.set(section.form, (counts.get(section.form) ?? 0) + 1);
    }
    let sequence = sections.map((section) => section.form).join(">");
    if (sequences.has(sequence) && sections.length > 1 && !PINNED_FORMS.has(sections[1]!.form)) {
      const target = sections[1]!;
      const exclude = new Set([sections[0]!.form, sections[2]?.form ?? ""]);
      target.form = leastUsedForm(palette, counts, exclude);
      sequence = sections.map((section) => section.form).join(">");
    }
    sequences.add(sequence);
    previousOpening = sections[0]?.form;
    return { ...composition, sections };
  });
}

export type ChapterFormsResult = {
  compositions: ChapterComposition[];
  /** Variety issues still standing after repair; empty on a clean plan. */
  issues: string[];
  source: "model" | "repaired" | "rotated" | "fallback";
  /** The recurring example people (`exampleCast.ts`): planned when asked for, or the fixed cast handed back. */
  cast?: ExampleCastMember[] | undefined;
  /** A toolkit book's whole-book decisions (`instructionalPlanning.ts`), and how its brief's asks were homed. */
  toolkit?: InstructionalToolkit | undefined;
  coverage?: { issues: string[]; homed: string[]; shared: string[] } | undefined;
};

export type PlanChapterFormsOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  stance?: AuthorStance | undefined;
  ranges: readonly ChapterFormRange[];
  /** Chapters already composed on an earlier run: kept as they are, planned against. */
  fixed?: readonly ChapterComposition[] | undefined;
  /** Whether this book may carry figures (`usesFigures` and the gate): the rule and the key reach the planner only then. */
  figures?: boolean | undefined;
  /** The book's episodes when they were planned first: the cases each chapter is built from, so the planner does not choose a second set. */
  episodes?: BookEpisodes | undefined;
  /** The `formPlanRepair` gate: false goes straight from a plan with issues to the rotation. Defaults to true. */
  repair?: boolean | undefined;
  /** What the brief explicitly asks the book to contain (its requirement inventory): each is given a section. */
  requirements?: readonly string[] | undefined;
  /** "plan" asks for a cast of recurring example people; a cast is the one earlier chapters use, kept as it is. */
  exampleCast?: "plan" | readonly ExampleCastMember[] | undefined;
  /** A toolkit book's setting, decided with its research leads (`planResearchLeads`). */
  setting?: InstructionalSetting | undefined;
  /** A toolkit book's stored decisions: handed back unchanged and planned against. */
  toolkit?: InstructionalToolkit | undefined;
  textModel: TextModelAdapter;
};

/**
 * The brief's explicit asks, as sections. Readers kept finding a promised item
 * missing — no question bank, no meeting cadence, a tracker or a worksheet
 * referred to and never printed (2026-09-30) — because nothing assigned it to
 * a chapter; the compile's coverage review only found it afterwards.
 */
const BRIEF_REQUIREMENTS_RULE =
  "briefRequirements lists what the request explicitly asks the book to contain. Give every one a home: name it in the subject or owns of the one section that delivers it, and give a requested table, worksheet, template, checklist, tracker or list of questions a section whose form can print it. Do not drop one, and do not spread one across chapters.";

const CASE_ASSIGNMENTS_RULE =
  "caseAssignments is the material already selected for this book. Build each chapter's sections from its assigned episodes and their specific contributions; do not invent a second competing case list. A case has one home for its full treatment. Other chapters may use a brief comparison that adds a new inference, without retelling the episode. Use the chapter's remaining space to explain how its own events, institutions or documents worked.";

const CHAPTER_FOCUS_RULE =
  "A chapter with focus investigates that specific question using its assigned material. Give its investigation enough room to show what happened and why; arrange sections in the order that explanation needs. alreadyEstablished is reader knowledge, not a new section to repeat. contribution is the new distinction earned by this chapter, not a sentence to paste. Do not finish each chapter by translating its result back into the same book-wide thesis.";

/**
 * One call for the whole book, so variety can be global, then one repair
 * call against the deterministic issues (unless `repair` is false), then
 * rotation. Never blocks: a provider failure drafts from the rotated fallback.
 */
export async function planChapterForms(options: PlanChapterFormsOptions): Promise<ChapterFormsResult> {
  const mode = inferWritingMode(options.input, options.plan);
  const palette = formPaletteFor(mode);
  const fixedIndexes = new Set((options.fixed ?? []).map((composition) => composition.chapterIndex));
  const open = options.ranges.filter((range) => !fixedIndexes.has(range.chapter.index));
  if (open.length === 0) {
    const kept = Array.isArray(options.exampleCast) && options.exampleCast.length > 0 ? { cast: [...options.exampleCast] } : {};
    return { compositions: [...(options.fixed ?? [])], issues: [], source: "model", ...kept };
  }
  // Every chapter's cases, the written ones included, so an open chapter is
  // planned around what its neighbours already own; never the search queries.
  const caseAssignments =
    options.episodes && options.episodes.chapters.length > 0
      ? options.episodes.chapters.map((chapter) => ({
          chapterIndex: chapter.index,
          episodes: chapter.episodes.map(({ title, person, place, date, document, why }) => ({ title, person, place, date, document, why })),
          ...(chapter.focus ? { focus: chapter.focus } : {})
        }))
      : undefined;
  const anyFocus = options.episodes?.chapters.some((chapter) => chapter.focus !== undefined) ?? false;
  const requirements = options.requirements?.length ? options.requirements : undefined;
  const fixedCast = Array.isArray(options.exampleCast) && options.exampleCast.length > 0 ? [...options.exampleCast] : undefined;
  const planCast = options.exampleCast === "plan" || Boolean(fixedCast);
  // A disabled gate strips any figure the model volunteered; chapters already
  // written keep theirs, since their pages already carry the block. The cap
  // is a ceiling against a figure in every chapter, not a target: the first
  // live book was an algorithms book that got one figure in eight chapters.
  const capped = (compositions: ChapterComposition[]): ChapterComposition[] =>
    capFigures(compositions, { maxPerBook: options.figures ? figureCapFor(options.ranges.length) : 0, keep: fixedIndexes });
  const merge = (planned: ChapterComposition[]): ChapterComposition[] =>
    options.ranges.map(
      (range) =>
        (options.fixed ?? []).find((composition) => composition.chapterIndex === range.chapter.index) ??
        planned.find((composition) => composition.chapterIndex === range.chapter.index) ??
        fallbackChapterComposition(range, palette, range.chapter.index)
    );

  const request = (repair: { compositions: ChapterComposition[]; issues: string[] } | undefined) =>
    generateJsonWithRetry(options.textModel, {
      purpose: PLAN_CHAPTER_FORMS_PURPOSE,
      temperature: Math.min(0.7, options.input.temperature),
      maxTokens: Math.min(32000, 1500 + open.length * 700),
      schema: z.unknown(),
      messages: [
        {
          role: "system",
          content: [
            "You are the book's structural editor. Plan the shape of every chapter as an ordered list of sections, each with a form from the palette, so that no two chapters read alike and no chapter repeats one shape.",
            "Return one JSON object with a chapters array. Each chapter object has chapterIndex, throughLine, sections, landing, and avoid, exactly like outputContract.chapters[0].",
            "A section's form governs the shape of its prose, not its topic. Choose the form the material wants: a single vivid episode wants a scene; a document or object wants a close reading; a genuine dispute wants an argument or a counterargument; a list of things wants a catalogue and is allowed to read as one; an unsettled matter wants an open question left open.",
            "Each section's subject is concrete and specific to this book; owns lists the particular cases, sources, scenes, people or objects that section alone treats, and no two sections anywhere in the book own the same one.",
            ...(caseAssignments ? [CASE_ASSIGNMENTS_RULE] : []),
            ...(anyFocus ? [CHAPTER_FOCUS_RULE] : []),
            ...(requirements ? [BRIEF_REQUIREMENTS_RULE] : []),
            ...(planCast ? [EXAMPLE_CAST_RULE, ...(fixedCast ? [FIXED_EXAMPLE_CAST_RULE] : [])] : []),
            "landing is the claim this chapter adds to the book's argument, particular to this chapter's cases: what the author concludes from them, in one sentence. It is never a restatement of the book's thesis, never a general statement about institutions, capacities or human nature, and never built as a negation and its correction (\"X did not simply A; it B\"). No two landings share a shape or a subject. The writer reasons toward it in the chapter's final paragraph rather than quoting it.",
            "Each section carries a handoff: the question or unfinished business it leaves for the next section, so the chapter reads as one argument in movements rather than a stack of separate essays. The last section's handoff is empty.",
            ...(options.figures ? [FIGURE_FORM_PLAN_RULE] : []),
            "The final chapter is not a summary chapter whatever its title says: its sections are new material, and its landing is the author's own conclusion to the book, argued through the chapter's case rather than by re-listing the earlier chapters.",
            "Variety rules, enforced after you answer: within a chapter no form takes more than half the sections and no form follows itself; no two chapters share the same form sequence; consecutive chapters do not open with the same form; across the book no form exceeds 40% of all sections; no form sits in the same position (first, second, third, last) in more than a third of the chapters, so a comparison or an argument comes first in some chapters and last in others; every chapter uses at least three distinct forms when it has three or more sections.",
            // The sustained stretch is a share of a short chapter and a word count of a
            // long one: a 40% section of a 4,940-word chapter asked the writer for 1,976
            // words and got half, and the chapter came in at 55% (see SECTION_ASK_WORDS).
            "Section counts per chapter are given as sectionCount; shares are fractions of the chapter's length and sum to 1. Vary the count from chapter to chapter across that range, and give every chapter one section that takes at least its sustainedShare of its length and one that takes under 15%, so no two chapters have the same silhouette. Where a chapter has many sections, the sections are short passages of a few paragraphs each, not essays; every one still has its own subject and owns its own material.",
            "avoid names what earlier chapters already established that this chapter must not re-explain or re-argue.",
            "Where a chapter carries kind, its forms serve it: a case chapter is mostly scenes and close readings of one episode, a document chapter is close readings of one text, a complication chapter ends on an open question, a portrait follows one person, an argument chapter carries an argument and a counterargument, a method chapter shows a procedure, a resolution closes with a verdict.",
            ...(repair
              ? [
                  "Your previous plan is in previousPlan and failed the checks listed in issues. Return a corrected complete plan for the same chapters that resolves every issue while keeping subjects and ownership."
                ]
              : []),
            ...targetLanguageGenerationGuidance(options.input.language)
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              language: targetLanguagePayload(options.input.language),
              book: {
                title: options.plan.title,
                premise: options.plan.premise,
                audience: options.plan.audience,
                writingMode: mode,
                ...(options.stance ? { thesisNeverRestatedByALanding: options.stance.thesis, positions: options.stance.positions } : {}),
                promises: options.plan.promises
              },
              palette: palette.map((form) => ({ form: form.id, rule: form.rule })),
              chapters: open.map((range) => ({
                chapterIndex: range.chapter.index,
                title: range.chapter.title,
                // Under an arc the job stands in for the summary: the plan's summary says what the chapter proves.
                summary: range.job ?? range.chapter.summary,
                keyBeats: range.chapter.keyBeats,
                pages: range.endPage - range.startPage + 1,
                ...(range.words !== undefined ? { words: range.words } : {}),
                // Assigned, not requested: told to vary the count the planner returned
                // 4 or 5 everywhere (composed-22); a count is a content assignment.
                sectionCount: assignedSectionCount(range.chapter.index, range.endPage - range.startPage + 1, range.words),
                sustainedShare: sustainedSectionShare(range.words),
                ...(range.kind ? { kind: range.kind } : {}),
                ...(range.job ? { job: range.job } : {})
              })),
              ...(caseAssignments ? { caseAssignments } : {}),
              ...(requirements ? { briefRequirements: requirements } : {}),
              ...(fixedCast ? { exampleCast: fixedCast } : {}),
              ...(options.fixed && options.fixed.length > 0
                ? {
                    alreadyWrittenChapters: options.fixed.map((composition) => ({
                      chapterIndex: composition.chapterIndex,
                      forms: composition.sections.map((section) => section.form),
                      owns: composition.sections.flatMap((section) => section.owns)
                    }))
                  }
                : {}),
              ...(repair ? { previousPlan: repair.compositions, issues: repair.issues } : {}),
              outputContract: {
                chapters: [
                  {
                    chapterIndex: 1,
                    throughLine: "What this chapter does for the book, in one sentence.",
                    sections: [
                      {
                        form: palette[0]!.id,
                        subject: "The concrete subject of this section.",
                        share: 0.3,
                        owns: ["A case, source, scene or person this section alone treats."],
                        handoff: "The question this section leaves for the next.",
                        note: "Optional: anything the writer must know about this section.",
                        ...(options.figures ? FIGURE_FORM_PLAN_CONTRACT : {})
                      }
                    ],
                    landing: "The claim this chapter adds to the book's argument, in one sentence.",
                    avoid: ["What earlier chapters already established."]
                  }
                ],
                ...(planCast ? { cast: [{ name: "A first name", role: "The one situation this person is in, in every chapter." }] } : {})
              }
            },
            null,
            2
          )
        }
      ]
    });

  let planned: ChapterComposition[];
  // The cast rides every return: a fixed one always, a planned one when the reply carried it.
  let cast = fixedCast;
  const withCast = (result: ChapterFormsResult): ChapterFormsResult => (cast ? { ...result, cast } : result);
  try {
    const reply = (await request(undefined)).data;
    planned = normalizeChapterCompositions(reply, open, palette);
    if (!fixedCast && planCast) cast = exampleCastFrom(reply);
  } catch (error) {
    if (isStopLike(error)) throw error;
    const fallback = settleFormVariety(
      merge(open.map((range) => fallbackChapterComposition(range, palette, range.chapter.index))),
      palette
    );
    return withCast({ compositions: capped(fallback), issues: compositionVarietyIssues(fallback, palette, { thesis: options.stance?.thesis }), source: "fallback" });
  }
  const thesis = options.stance?.thesis;
  let merged = merge(planned);
  let issues = compositionVarietyIssues(merged, palette, { thesis });
  // Shape issues ride along to the one repair call; they never block and the
  // deterministic settle below is not asked to clear them. Without the call
  // (the formPlanRepair gate) they stand, and the rotation alone settles
  // the forms — never the landings, which only the repair rewrites.
  const repair = options.repair !== false;
  const shape = compositionShapeIssues(merged);
  if (issues.length === 0 && (shape.length === 0 || !repair)) {
    return withCast({ compositions: capped(merged), issues, source: "model" });
  }
  if (repair) {
    try {
      const reply = (await request({ compositions: planned, issues: [...issues, ...shape] })).data;
      const repaired = normalizeChapterCompositions(reply, open, palette);
      if (!fixedCast && planCast) cast = exampleCastFrom(reply) ?? cast;
      const repairedMerged = merge(repaired);
      const repairedIssues = compositionVarietyIssues(repairedMerged, palette, { thesis });
      if (repairedIssues.length + compositionShapeIssues(repairedMerged).length < issues.length + shape.length) {
        merged = repairedMerged;
        issues = repairedIssues;
      }
      if (issues.length === 0) {
        return withCast({ compositions: capped(merged), issues, source: "repaired" });
      }
    } catch (error) {
      if (isStopLike(error)) throw error;
    }
  }
  const rotated = settleFormVariety(merged, palette);
  return withCast({ compositions: capped(rotated), issues: compositionVarietyIssues(rotated, palette, { thesis }), source: "rotated" });
}

/** A stop must escape every best-effort catch here; it is recognised by name so this module stays free of worker imports. */
function isStopLike(error: unknown): boolean {
  return error instanceof Error && /stop/i.test(error.name);
}

/**
 * The composition as the writer sees it: forms, subjects and owned cases
 * only. The through-line, the landing and the handoffs stayed in the plan and
 * reached the read; shown to the writer they were pasted into the prose at
 * 76–100% and became the chapter endings and the seam questions the blind
 * panel quoted. `compositionPromptLines` keeps the full view for the read.
 */
export function compositionWriterLines(
  composition: ChapterComposition,
  palette: readonly SectionForm[],
  targetWords?: number
): string[] {
  const rules = new Map(palette.map((form) => [form.id, form.rule]));
  return composition.sections.map((section, index) => {
    const owns = section.owns.length > 0 ? ` Its material: ${section.owns.join("; ")}.` : "";
    const note = section.note ? ` Note: ${section.note}` : "";
    const share = section.share ?? 1 / composition.sections.length;
    const length = targetWords ? ` About ${Math.max(120, Math.round(share * targetWords))} words.` : "";
    const heading = section.heading ? `, headed "${section.heading}"` : "";
    return `Section ${index + 1}${heading}, form "${section.form}" (${rules.get(section.form) ?? "as its name says"}): ${section.subject}.${owns}${note}${length}`;
  });
}

/** The composition as prompt lines for the read and the plan's own consumers. */
export function compositionPromptLines(composition: ChapterComposition, palette: readonly SectionForm[]): string[] {
  const rules = new Map(palette.map((form) => [form.id, form.rule]));
  return [
    `This chapter's through-line: ${composition.throughLine}`,
    ...composition.sections.map((section, index) => {
      const share = section.share !== undefined ? ` (about ${Math.round(section.share * 100)}% of the chapter)` : "";
      const owns = section.owns.length > 0 ? ` Owns: ${section.owns.join("; ")}.` : "";
      const note = section.note ? ` Note: ${section.note}` : "";
      const handoff = section.handoff ? ` Hands to the next section: ${section.handoff}` : "";
      const figure = section.figure
        ? ` Figure: a ${section.figure.kind === "flow" ? "flow diagram" : `${section.figure.kind} chart`} showing ${section.figure.shows}${section.figure.source ? ` (from ${section.figure.source})` : ""}.`
        : "";
      return `Section ${index + 1}, form "${section.form}" (${rules.get(section.form) ?? "as its name says"})${share}: ${section.subject}.${owns}${handoff}${note}${figure}`;
    }),
    `The claim this chapter adds to the book's argument, which its final paragraph reasons toward in the author's voice: ${composition.landing}`,
    ...(composition.avoid.length > 0 ? [`Already established earlier in the book, not to be re-explained here: ${composition.avoid.join("; ")}`] : [])
  ];
}

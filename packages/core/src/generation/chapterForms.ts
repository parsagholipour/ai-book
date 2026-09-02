import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";
import type { AuthorStance, BookPlan, ChapterPlan, CreateProjectInput } from "../schemas/book.js";
import { isRecord } from "../schemas/jsonCoercion.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import { inferWritingMode, type WritingMode } from "./styleContract.js";

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

export type SectionForm = { id: string; rule: string };

const DOCUMENTED_SCENE =
  "a documented episode from a named source or site, narrated in time through people acting; when the source records little, say what it records in a paragraph and move on, and never present an unnamed or composite person as witnessed";

const ANALYTICAL_FORMS: readonly SectionForm[] = [
  { id: "scene", rule: DOCUMENTED_SCENE },
  { id: "close-reading", rule: "one source, object, document or site examined at length, quoted or described in detail, and what the author makes of it" },
  { id: "portrait", rule: "one named person or one named institution followed through time, from a named source" },
  { id: "argument", rule: "the author's own claim about this chapter's cases, argued through them, naming the historian, school or source it answers when the notes supply one" },
  { id: "counterargument", rule: "a rival explanation stated at its strongest and then answered on the evidence, in the author's own words rather than a formula" },
  { id: "mechanism", rule: "how one thing actually worked, step by step, with the concrete parts named" },
  { id: "catalogue", rule: "a deliberate inventory or list, allowed to read as one" },
  { id: "open-question", rule: "a question the chapter has made sharp, left open in a sentence or two; not an inventory of the records that would settle it" },
  { id: "comparison", rule: "two cases set side by side and a verdict on what differs and why" },
  { id: "aftermath", rule: "consequences traced forward through named people and places" },
  { id: "quiet-transition", rule: "a short connective passage with no thesis" }
];

const INSTRUCTIONAL_FORMS: readonly SectionForm[] = [
  { id: "worked-example", rule: "one example carried from start to finish with every step shown" },
  { id: "principle", rule: "one idea stated and grounded in one case, without a list of applications" },
  { id: "procedure", rule: "steps in order, allowed to read as steps" },
  { id: "failure-case", rule: "something done wrong, what it cost, and what would have caught it" },
  { id: "diagnosis", rule: "how to tell which situation you are in, by observable signs" },
  { id: "story-from-practice", rule: "a real or realistic episode told in time and framed as such, before any lesson is drawn; the lesson, if any, is one sentence" },
  { id: "objection", rule: "the reader's strongest doubt, taken seriously, then answered or conceded in the author's own words" },
  { id: "exercise", rule: "something the reader does now, with the expected result" },
  { id: "open-question", rule: "what the field does not know, left open in a sentence or two" },
  { id: "quiet-transition", rule: "a short connective passage with no thesis" }
];

const NARRATIVE_FORMS: readonly SectionForm[] = [
  { id: "scene", rule: "continuous action in one place and time, dramatised, with dialogue where people would speak" },
  { id: "sequel", rule: "the reaction after a scene: feeling, dilemma, decision, in that order, kept short" },
  { id: "dialogue", rule: "a conversation carrying the beat, with little narration between lines" },
  { id: "interior", rule: "inside one character's perception, close and specific, without summary" },
  { id: "setpiece", rule: "a long sustained scene with rising pressure and a turn" },
  { id: "montage", rule: "time compressed through a handful of concrete moments" },
  { id: "reveal", rule: "information the reader did not have, delivered through action, not explanation" },
  { id: "confrontation", rule: "two wants collide and one gives way" },
  { id: "document", rule: "a letter, record, message or artefact reproduced within the story" },
  { id: "quiet", rule: "a still passage with no plot movement, observed rather than reflected upon" }
];

const REFERENCE_FORMS: readonly SectionForm[] = [
  { id: "overview", rule: "what the reader needs to place the entries that follow, without previewing their conclusions" },
  { id: "entry-cluster", rule: "several entries in canonical form, allowed to repeat their structure" },
  { id: "worked-example", rule: "one entry applied in a concrete case" },
  { id: "comparison", rule: "entries set side by side to show where they differ" },
  { id: "history", rule: "how a term, practice or object came to be, told in time" },
  { id: "caveat", rule: "where the reference is unreliable or contested, stated plainly" },
  { id: "quiet-transition", rule: "a short connective passage with no thesis and no landing" }
];

const CHILDREN_FORMS: readonly SectionForm[] = [
  { id: "scene", rule: "one thing happening, in one place, that a child can picture" },
  { id: "dialogue", rule: "characters talking, short lines" },
  { id: "refrain", rule: "a repeated phrase or pattern, changed a little each time" },
  { id: "discovery", rule: "the character finds or notices something new" },
  { id: "problem", rule: "something goes wrong or gets harder" },
  { id: "quiet", rule: "a calm moment, seen rather than explained" }
];

export function formPaletteFor(mode: WritingMode): readonly SectionForm[] {
  switch (mode) {
    case "analytical-history":
      return ANALYTICAL_FORMS;
    case "instructional":
      return INSTRUCTIONAL_FORMS;
    case "reference":
      return REFERENCE_FORMS;
    case "children-narrative":
      return CHILDREN_FORMS;
    case "narrative":
      return NARRATIVE_FORMS;
  }
}

export const chapterSectionSchema = z.object({
  form: z.string().min(1),
  subject: z.string().min(1),
  /** Any positive number: models answer in fractions or percentages, and shares are renormalised to sum to one. */
  share: z.number().positive().optional(),
  owns: z.array(z.string()).default([]),
  note: z.string().optional(),
  /** The question or unfinished business this section hands to the next: the seam the writer carries across. */
  handoff: z.string().optional()
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

export type ChapterFormRange = { chapter: ChapterPlan; startPage: number; endPage: number };

/** One count per chapter, walking the range so consecutive chapters differ and the book uses the whole range. */
export function assignedSectionCount(chapterIndex: number, pageCount: number): { min: number; max: number } {
  const { min, max } = sectionCountForPages(pageCount);
  const span = max - min + 1;
  const offsets = [0, 2, 1, 3, 0, 2, 1, 3];
  const count = min + (offsets[(Math.max(1, chapterIndex) - 1) % offsets.length]! % span);
  return { min: count, max: count };
}

export function sectionCountForPages(pageCount: number): { min: number; max: number } {
  const pages = Math.max(1, pageCount);
  const ideal = Math.round(pages / 1.75);
  // Three sections of 1,600 words each read as three self-contained essays;
  // the blind panel called those chapters anthologies. Four is the floor once
  // a chapter has the room.
  return {
    min: Math.max(2, Math.min(pages >= 8 ? 4 : 3, ideal)),
    max: Math.max(3, Math.min(8, ideal + 2))
  };
}

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
      issues.push(`Chapter ${composition.chapterIndex} splits its length evenly across sections; give it one section of at least 40% and one under 15%.`);
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
        if (count * 2 > forms.length) {
          issues.push(`Chapter ${composition.chapterIndex} gives more than half its sections the form "${form}".`);
        }
      }
    }
    for (let index = 1; index < forms.length; index += 1) {
      if (forms[index] === forms[index - 1] && forms[index] !== "entry-cluster") {
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
      if (count > totalSections * MAX_BOOK_FORM_SHARE && form !== "entry-cluster" && form !== "scene") {
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
      if (chaptersWithPosition >= 5 && count > chaptersWithPosition * MAX_POSITIONAL_SHARE && form !== "scene") {
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
      if (form === "scene") continue;
      for (const composition of holdersAt(position)) {
        if (countAt(position, form) <= allowedAt(position)) break;
        const section = composition.sections[position]!;
        if (section.form !== form) continue;
        const partners = composition.sections
          .map((_, index) => index)
          .filter((index) => index !== position && composition.sections[index]!.form !== form)
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
  return current;
}

/** A composition nothing came back for: forms rotated by chapter offset, subjects from the plan. */
export function fallbackChapterComposition(
  range: ChapterFormRange,
  palette: readonly SectionForm[],
  offset: number
): ChapterComposition {
  const pages = range.endPage - range.startPage + 1;
  const count = Math.min(sectionCountForPages(pages).max, Math.max(sectionCountForPages(pages).min, range.chapter.keyBeats.length || 3));
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
  palette: readonly SectionForm[]
): ChapterComposition[] {
  const parsed = chapterCompositionsResponseSchema.safeParse(raw);
  const byChapter = new Map<number, ChapterComposition>();
  if (parsed.success) {
    for (const candidate of parsed.data.chapters) {
      const composition = chapterCompositionSchema.safeParse(candidate);
      if (composition.success && !byChapter.has(composition.data.chapterIndex)) {
        byChapter.set(composition.data.chapterIndex, composition.data);
      }
    }
  }
  const bookCounts = new Map<string, number>();
  return ranges.map((range, offset) => {
    const pages = range.endPage - range.startPage + 1;
    const bounds = sectionCountForPages(pages);
    const found = byChapter.get(range.chapter.index);
    const fallback = fallbackChapterComposition(range, palette, offset);
    const source = found ?? fallback;
    let sections = source.sections
      .map((section) => {
        const form = canonicalFormId(section.form, palette);
        return form ? { ...section, form } : undefined;
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
      if (exclude.has(section.form) || overused) {
        section.form = leastUsedForm(palette, counts, exclude);
      }
      counts.set(section.form, (counts.get(section.form) ?? 0) + 1);
    }
    let sequence = sections.map((section) => section.form).join(">");
    if (sequences.has(sequence) && sections.length > 1) {
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
};

export type PlanChapterFormsOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  stance?: AuthorStance | undefined;
  ranges: readonly ChapterFormRange[];
  /** Chapters already composed on an earlier run: kept as they are, planned against. */
  fixed?: readonly ChapterComposition[] | undefined;
  textModel: TextModelAdapter;
};

/**
 * One call for the whole book, so variety can be global, then one repair
 * call against the deterministic issues, then rotation. Never blocks: a
 * provider failure drafts from the rotated fallback.
 */
export async function planChapterForms(options: PlanChapterFormsOptions): Promise<ChapterFormsResult> {
  const mode = inferWritingMode(options.input, options.plan);
  const palette = formPaletteFor(mode);
  const fixedIndexes = new Set((options.fixed ?? []).map((composition) => composition.chapterIndex));
  const open = options.ranges.filter((range) => !fixedIndexes.has(range.chapter.index));
  if (open.length === 0) {
    return { compositions: [...(options.fixed ?? [])], issues: [], source: "model" };
  }
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
            "landing is the claim this chapter adds to the book's argument, particular to this chapter's cases: what the author concludes from them, in one sentence. It is never a restatement of the book's thesis, never a general statement about institutions, capacities or human nature, and never built as a negation and its correction (\"X did not simply A; it B\"). No two landings share a shape or a subject. The writer reasons toward it in the chapter's final paragraph rather than quoting it.",
            "Each section carries a handoff: the question or unfinished business it leaves for the next section, so the chapter reads as one argument in movements rather than a stack of separate essays. The last section's handoff is empty.",
            "The final chapter is not a summary chapter whatever its title says: its sections are new material, and its landing is the author's own conclusion to the book, argued through the chapter's case rather than by re-listing the earlier chapters.",
            "Variety rules, enforced after you answer: within a chapter no form takes more than half the sections and no form follows itself; no two chapters share the same form sequence; consecutive chapters do not open with the same form; across the book no form exceeds 40% of all sections; no form sits in the same position (first, second, third, last) in more than a third of the chapters, so a comparison or an argument comes first in some chapters and last in others; every chapter uses at least three distinct forms when it has three or more sections.",
            "Section counts per chapter are given as sectionCount; shares are fractions of the chapter's length and sum to 1. Vary the count from chapter to chapter across that range, and give every chapter one section that takes at least 40% of its length and one that takes under 15%, so no two chapters have the same silhouette.",
            "avoid names what earlier chapters already established that this chapter must not re-explain or re-argue.",
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
                summary: range.chapter.summary,
                keyBeats: range.chapter.keyBeats,
                pages: range.endPage - range.startPage + 1,
                // Assigned, not requested: told to vary the count the planner returned
                // 4 or 5 everywhere (composed-22); a count is a content assignment.
                sectionCount: assignedSectionCount(range.chapter.index, range.endPage - range.startPage + 1)
              })),
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
                        note: "Optional: anything the writer must know about this section."
                      }
                    ],
                    landing: "The claim this chapter adds to the book's argument, in one sentence.",
                    avoid: ["What earlier chapters already established."]
                  }
                ]
              }
            },
            null,
            2
          )
        }
      ]
    });

  let planned: ChapterComposition[];
  try {
    planned = normalizeChapterCompositions((await request(undefined)).data, open, palette);
  } catch (error) {
    if (isStopLike(error)) throw error;
    const fallback = settleFormVariety(
      merge(open.map((range) => fallbackChapterComposition(range, palette, range.chapter.index))),
      palette
    );
    return { compositions: fallback, issues: compositionVarietyIssues(fallback, palette, { thesis: options.stance?.thesis }), source: "fallback" };
  }
  const thesis = options.stance?.thesis;
  let merged = merge(planned);
  let issues = compositionVarietyIssues(merged, palette, { thesis });
  // Shape issues ride along to the one repair call; they never block and the
  // deterministic settle below is not asked to clear them.
  const shape = compositionShapeIssues(merged);
  if (issues.length === 0 && shape.length === 0) {
    return { compositions: merged, issues, source: "model" };
  }
  try {
    const repaired = normalizeChapterCompositions(
      (await request({ compositions: planned, issues: [...issues, ...shape] })).data,
      open,
      palette
    );
    const repairedMerged = merge(repaired);
    const repairedIssues = compositionVarietyIssues(repairedMerged, palette, { thesis });
    if (repairedIssues.length + compositionShapeIssues(repairedMerged).length < issues.length + shape.length) {
      merged = repairedMerged;
      issues = repairedIssues;
    }
    if (issues.length === 0) {
      return { compositions: merged, issues, source: "repaired" };
    }
  } catch (error) {
    if (isStopLike(error)) throw error;
  }
  const rotated = settleFormVariety(merged, palette);
  return { compositions: rotated, issues: compositionVarietyIssues(rotated, palette, { thesis }), source: "rotated" };
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
    return `Section ${index + 1}, form "${section.form}" (${rules.get(section.form) ?? "as its name says"}): ${section.subject}.${owns}${note}${length}`;
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
      return `Section ${index + 1}, form "${section.form}" (${rules.get(section.form) ?? "as its name says"})${share}: ${section.subject}.${owns}${handoff}${note}`;
    }),
    `The claim this chapter adds to the book's argument, which its final paragraph reasons toward in the author's voice: ${composition.landing}`,
    ...(composition.avoid.length > 0 ? [`Already established earlier in the book, not to be re-explained here: ${composition.avoid.join("; ")}`] : [])
  ];
}

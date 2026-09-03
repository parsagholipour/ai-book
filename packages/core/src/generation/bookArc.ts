import type { TextModelAdapter } from "../adapters/types.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { isRecord } from "../schemas/jsonCoercion.js";
import type { AuthorStance } from "../schemas/plan.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";

/**
 * The book's arc: a proposal written before any chapter, as the author would
 * pitch it — one question with live answers, a named opponent, the chapter
 * where the answer gets into trouble, and one job per chapter with a kind and
 * a length. Twenty-three composed runs on one plan (spec.md) showed that
 * fifteen equal chapters each demonstrating one thesis, with the thesis in
 * every call, draw the same five complaints from every reader and every
 * writer: the argument is complete by chapter four and re-demonstrated after.
 * The arc gives each chapter something to do that no other chapter does, and
 * withholds the thesis from the writer of every chapter but the first and the
 * last (`arcChapterLines`).
 */
export const ARCHITECT_BOOK_PURPOSE = "architect-book";

export {
  ARC_KINDS,
  bookArcSchema,
  type ArcChapter,
  type ArcKind,
  type BookArc
} from "../schemas/bookArc.js";
import { ARC_KINDS, bookArcSchema, type ArcKind, type BookArc } from "../schemas/bookArc.js";

/** The arc a plan stores, or nothing: a stored arc that no longer parses is no arc. */
export function planBookArc(plan: BookPlan): BookArc | undefined {
  const stored = (plan as { bookArc?: unknown }).bookArc;
  if (!isRecord(stored)) {
    return undefined;
  }
  const parsed = bookArcSchema.safeParse(stored);
  return parsed.success ? parsed.data : undefined;
}

export const MIN_ARC_CHAPTER_PAGES = 3;
export const MAX_ARC_CHAPTER_PAGES = 14;

/**
 * The arc's pages made to sum to the book: scaled, rounded, and the residual
 * moved one page at a time onto the largest chapters, within the floor and
 * ceiling a chapter may have. Models miss the sum routinely, and dropping the
 * cut for it would drop the one axis the arc exists to test.
 */
export function repairArcPages(pages: readonly number[], targetPages: number): number[] | undefined {
  const count = pages.length;
  if (count === 0 || targetPages < count) return undefined;
  const floor = Math.max(1, Math.min(MIN_ARC_CHAPTER_PAGES, Math.floor(targetPages / count)));
  const ceiling = Math.max(MAX_ARC_CHAPTER_PAGES, Math.ceil(targetPages / count));
  const sum = pages.reduce((total, value) => total + Math.max(0, value), 0) || count;
  const repaired = pages.map((value) => Math.min(ceiling, Math.max(floor, Math.round((Math.max(0, value) || 1) * (targetPages / sum)))));
  let residual = targetPages - repaired.reduce((total, value) => total + value, 0);
  let guard = 0;
  // One page per chapter per round, largest first, so a four-page residual
  // widens four chapters by one rather than one chapter by four.
  let touched = new Set<number>();
  while (residual !== 0 && guard++ < 20 * count) {
    const order = repaired.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value || a.index - b.index);
    const fits = (entry: { value: number; index: number }) => (residual > 0 ? entry.value < ceiling : entry.value > floor);
    let target = order.find((entry) => fits(entry) && !touched.has(entry.index));
    if (!target) {
      touched = new Set<number>();
      target = order.find(fits);
      if (!target) return undefined;
    }
    touched.add(target.index);
    repaired[target.index] = repaired[target.index]! + (residual > 0 ? 1 : -1);
    residual += residual > 0 ? -1 : 1;
  }
  return repaired;
}

/**
 * The plan with the arc's page cut applied, when the arc covers every chapter
 * once: a cut whose pages do not sum to the book is repaired
 * (`repairArcPages`) and the repaired arc returned beside the plan, so what is
 * persisted is what the rows were cut to. Only an arc that does not match the
 * plan's chapters keeps the plan's own targets.
 */
export function applyBookArcPages(
  plan: BookPlan,
  arc: BookArc,
  targetPages: number
): { plan: BookPlan; arc: BookArc; applied: boolean; reason?: string } {
  const byIndex = new Map(arc.chapters.map((chapter) => [chapter.index, chapter]));
  if (byIndex.size !== plan.chapters.length || plan.chapters.some((chapter) => !byIndex.has(chapter.index))) {
    return { plan, arc, applied: false, reason: "arc chapters do not match the plan's" };
  }
  const ordered = plan.chapters.map((chapter) => byIndex.get(chapter.index)!);
  const requested = ordered.map((chapter) => chapter.pages);
  const sum = requested.reduce((total, value) => total + value, 0);
  const pages = sum === targetPages ? requested : repairArcPages(requested, targetPages);
  if (!pages) {
    return { plan, arc, applied: false, reason: `arc pages sum to ${sum}, the book has ${targetPages}, and no repair fits` };
  }
  const repairedArc: BookArc = {
    ...arc,
    chapters: arc.chapters.map((chapter) => {
      const position = plan.chapters.findIndex((entry) => entry.index === chapter.index);
      return position >= 0 ? { ...chapter, pages: pages[position]! } : chapter;
    })
  };
  return {
    plan: { ...plan, chapters: plan.chapters.map((chapter, position) => ({ ...chapter, targetPages: pages[position]! })) },
    arc: repairedArc,
    applied: true,
    ...(sum === targetPages ? {} : { reason: `arc pages summed to ${sum} for a ${targetPages}-page book; scaled and rounded` })
  };
}

const KIND_RULES: Record<ArcKind, string> = {
  case: "This is a case chapter: one episode narrated at length, in time, from its own sources, with named people acting; it ends when the episode ends, on its last event.",
  argument: "This is an argument chapter: it argues with the named opponent by name and answers the dispute; the first person is permitted here and nowhere else.",
  portrait: "This is a portrait chapter: it follows one person through what they did and what was done to them, and ends with that person.",
  document: "This is a document chapter: it reads one text closely, quoting only words that appear verbatim in researchNotes and paraphrasing the rest, and ends on the document.",
  complication: "This is a complication chapter: it puts the book's answer in trouble with a case the answer cannot yet absorb, and ends on the problem, unrepaired.",
  method: "This is a method chapter: it shows how a trace becomes a claim, on one example, and says what the book will ask.",
  resolution: "This is the resolution: the answer is spoken plainly, once, through one last case that the earlier chapters could not have carried."
};

const ANSWER_OVERLAP_WORDS = 4;

function contentWordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z\u00C0-\u024F]{4,}/g) ?? []);
}

/** Whether a prompt line shares enough content words with the answer to be the answer in other words. */
export function sharesAnswer(line: string, answer: string): boolean {
  const answerWords = contentWordSet(answer);
  let shared = 0;
  for (const word of contentWordSet(line)) if (answerWords.has(word)) shared += 1;
  return shared >= ANSWER_OVERLAP_WORDS;
}

/** The chapter after the turn that repairs it: the first whose job says so, else the next one. */
export function repairChapterIndex(arc: BookArc): number | undefined {
  if (!arc.turn) return undefined;
  const after = arc.chapters.filter((chapter) => chapter.index > arc.turn!.chapterIndex).sort((a, b) => a.index - b.index);
  return (after.find((chapter) => /^\s*repair/i.test(chapter.job.does)) ?? after[0])?.index;
}

/**
 * The lines a chapter's writer sees from the arc: its own job and kind, the
 * opponent where the chapter argues with it, the turn where it happens — and
 * never the book's answer. Every chapter but the resolution is also filtered:
 * a job line that shares four content words with the answer is the answer in
 * other words (`believesSoFar` after the turn, typically) and is dropped.
 */
export function arcChapterLines(arc: BookArc, chapterIndex: number): string[] {
  const chapter = arc.chapters.find((entry) => entry.index === chapterIndex);
  if (!chapter) {
    return [];
  }
  const indexes = arc.chapters.map((entry) => entry.index);
  const last = Math.max(...indexes);
  const first = Math.min(...indexes);
  const resolution = chapter.kind === "resolution";
  const fixed: string[] = [`The book asks: ${arc.question}`, KIND_RULES[chapter.kind]];
  const filtered: string[] = [];
  const job = chapter.job;
  if (job.believesSoFar) filtered.push(`What the reader believes by now: ${job.believesSoFar}`);
  if (job.does) filtered.push(`What this chapter does: ${job.does}`);
  if (job.adds) filtered.push(`What it adds that no other chapter adds: ${job.adds}`);
  if (job.leavesOpen && chapterIndex !== last) filtered.push(`What it leaves open, for the next chapter to take up: ${job.leavesOpen}`);
  if (chapter.cast.length > 0) filtered.push(`People this chapter carries: ${chapter.cast.join("; ")}.`);
  // The dispute reaches only an argument chapter. Shown to every chapter it
  // manufactured the panel's newest template (composed-24, all nine readers):
  // two named scholars, each granted a part, "the disagreement improves the
  // question", once per chapter.
  if (chapter.kind === "argument" && chapter.dispute && (chapter.dispute.sideA.name || chapter.dispute.sideB.name)) {
    filtered.push(
      `The dispute in this chapter: ${chapter.dispute.sideA.name} holds that ${chapter.dispute.sideA.claim}; ${chapter.dispute.sideB.name} holds that ${chapter.dispute.sideB.claim}; at stake: ${chapter.dispute.atStake}. Argue it by name.`
    );
  }
  const opponent = arc.opponent;
  if (opponent?.name && (chapterIndex === first || chapter.kind === "argument" || resolution)) {
    const named = `${opponent.name}${opponent.work ? `, ${opponent.work}` : ""}${opponent.year ? ` (${opponent.year})` : ""}`;
    filtered.push(
      `The opponent the book argues with, by name: ${named}: ${opponent.claim}${opponent.whereRight ? ` Where they are right: ${opponent.whereRight}` : ""}${
        resolution && opponent.whereTheBookBreaks ? ` Where the book breaks with them: ${opponent.whereTheBookBreaks}` : ""
      }`
    );
  }
  if (arc.turn?.trouble && arc.turn.chapterIndex === chapterIndex) {
    filtered.push(`This is the chapter where the book's own answer runs into trouble: ${arc.turn.trouble} Let the trouble stand; nothing here repairs it.`);
  } else if (arc.turn?.repair && repairChapterIndex(arc) === chapterIndex) {
    filtered.push(`This chapter repairs the trouble the chapter before it raised: ${arc.turn.repair}`);
  }
  if (resolution) {
    return [...fixed, ...filtered];
  }
  return [
    ...fixed,
    ...filtered.filter((line) => !sharesAnswer(line, arc.answer)),
    "Do not state the book's answer; this chapter is one step toward it, and the reader should finish it wanting the next."
  ];
}

export type ArchitectResult = { arc?: BookArc | undefined; failure?: string | undefined };

export async function architectBook(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  stance: AuthorStance;
  textModel: TextModelAdapter;
}): Promise<ArchitectResult> {
  const targetPages = options.input.targetPages;
  try {
    const result = await generateJsonWithRetry(options.textModel, {
      purpose: ARCHITECT_BOOK_PURPOSE,
      temperature: Math.min(0.6, options.input.temperature),
      maxTokens: 8000,
      schema: bookArcSchema,
      messages: [
        {
          role: "system",
          content: [
            `You are the architect of the book "${options.plan.title}", writing its proposal before a word of it exists, as its author would pitch it to an editor who has read everything in the field.`,
            "Return one JSON object with question, opponent, answer, turn and chapters, shaped exactly like outputContract.",
            "question: the one question the book answers, on which the literature holds at least two live answers. opponent: a real, published, named work the book argues with — name, work, year, its claim, where it is right, where the book breaks with it — never invented. answer: the book's own claim, contestable, stated once. turn: the chapter where the answer gets into trouble and how a later chapter repairs it.",
            `chapters: one entry per chapter of the plan, keeping the plan's titles and order exactly. kind is one of ${ARC_KINDS.join(", ")}: at least one case chapter of ten pages or more that narrates one episode from its sources, one document chapter of three or four pages that reads one text closely, one complication chapter, the first chapter may be method, the last is resolution. pages is between 3 and 14 and the pages sum to exactly ${targetPages}. job.does is one verb — establish, complicate, reverse, repair, resolve — then one sentence; job.believesSoFar is what a reader believes after the chapters before it; job.adds is what this chapter adds that no other does; job.leavesOpen is the question the next chapter takes up. cast: two to four named people from the record. dispute, only for an argument chapter and only where the matter is genuinely contested in the literature: two named sides and what is at stake; every other chapter leaves dispute out.`,
            ...targetLanguageGenerationGuidance(options.input.language)
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              language: targetLanguagePayload(options.input.language),
              book: { title: options.plan.title, premise: options.plan.premise, audience: options.plan.audience, targetPages },
              stance: { thesis: options.stance.thesis, positions: options.stance.positions },
              chapters: options.plan.chapters.map((chapter) => ({
                index: chapter.index,
                title: chapter.title,
                summary: chapter.summary,
                keyBeats: chapter.keyBeats,
                targetPages: chapter.targetPages
              })),
              outputContract: {
                question: "One sentence.",
                opponent: { name: "", work: "", year: 2011, claim: "", whereRight: "", whereTheBookBreaks: "" },
                answer: "One sentence.",
                turn: { chapterIndex: 10, trouble: "", repair: "" },
                chapters: [
                  {
                    index: 1,
                    kind: "method",
                    pages: 5,
                    job: { believesSoFar: "", does: "establish: …", adds: "", leavesOpen: "" },
                    cast: ["…"],
                    dispute: { sideA: { name: "", claim: "" }, sideB: { name: "", claim: "" }, atStake: "" }
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
    return { arc: result.data };
  } catch (error) {
    if (error instanceof Error && /stop|abort/i.test(error.name + error.message)) {
      throw error;
    }
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

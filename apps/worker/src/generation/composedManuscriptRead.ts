import {
  chapterDigest,
  chapterEdges,
  chapterWordBudget,
  citedChapters,
  countReadableWords,
  cutChapter,
  figureStandInMarkdown,
  isRecord,
  mapWithConcurrency,
  paragraphShapeReport,
  proseWordCount,
  readManuscript,
  reinsertFigureFences,
  stripFigureFences,
  type AuthorStance,
  type BookArc,
  type BookPlan,
  type ChapterComposition,
  type CreateProjectInput,
  type EditedChapterText,
  type GenerateJsonOptions,
  type JsonResult,
  type TextModelAdapter
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import type { RunLogger } from "../providers/runLogging.js";
import { updateJobProgress } from "../runtime/jobLifecycle.js";
import { isStopRequestedError, type ChapterSetup } from "../runtime/jobTypes.js";
import {
  loadComposedBookState,
  stageComposedChapter,
  storedPagesInRange,
  type ComposedChapterReport,
  type ComposedPageRow
} from "./composedChaptersState.js";

/**
 * The composed pass's whole-manuscript read and the deletion-only cuts it
 * flags (`composedChaptersPass.ts` hands over its memory of the book). The
 * cuts run beside each other and are staged one at a time in the read's order:
 * Balanced books spent 7.8–8.2 minutes here on 2026-10-15, one cut and its
 * acceptance (36–107 s each) after another.
 */

/** Flagged chapters cut at once; the read flags at most a few per book, so this is all of them on most. */
export const CUTS_IN_FLIGHT = 4;
/** The purpose core's `acceptsChapterEdit` reviews under; the guard reads that review's retained evidence. */
const CUT_ACCEPTANCE_PURPOSE = "review-chapter-edit-acceptance";
/** A quoted fragment shorter than this names no passage, so it proves nothing either way. */
const MIN_QUOTE_CHARACTERS = 8;

type CutChapterOptions = Parameters<typeof cutChapter>[0];

export type ManuscriptReadContext = {
  projectId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  stance: AuthorStance;
  arc?: BookArc | undefined;
  setups: readonly ChapterSetup[];
  chapterIds: ReadonlyMap<number, string>;
  textModel: TextModelAdapter;
  generationJobId?: string | undefined;
  runLog?: Pick<RunLogger, "append"> | undefined;
  /** `manuscriptReadCuts`: off, every chapter that drew notes is re-staged with them and nothing is cut. */
  cuts: boolean;
  /** The pass's memory of the book: read before any cut, written as each changed chapter is staged. */
  finalText: Map<number, string>;
  edges: Map<number, { opening: string; closing: string }>;
  digests: Map<number, string>;
  reports: Map<number, ComposedChapterReport>;
  compositionFor: (setup: ChapterSetup) => ChapterComposition;
  composeOptionsFor: (setup: ChapterSetup, drafts: Map<number, string>) => Promise<Omit<CutChapterOptions, "markdown" | "notes">>;
  describePages: (setup: ChapterSetup, markdown: string) => Promise<ComposedPageRow[]>;
  reportFor: (setup: ChapterSetup, draftWords: number, editedWords: number, editorChanged: boolean, markdown: string) => ComposedChapterReport;
  notesForDraft: (markdown: string) => string[];
};

type ReadEntry = { chapterIndex: number; edit: boolean; notes: string[] };
type FlaggedChapter = { offset: number; entry: ReadEntry; setup: ChapterSetup; chapterId: string; current: string };
type CutOutcome = FlaggedChapter & {
  prose: string;
  edited: EditedChapterText;
  /** The cut chapter with its figures back, and its pages described; absent when nothing changed. */
  reshaped?: string | undefined;
  pages?: ComposedPageRow[] | undefined;
  /** The other chapters the acceptance reviewer was shown: the ones the notes cite, and the previous one's tail. */
  shown: number[];
  /** `unreviewed` with the acceptance gate off; otherwise what the reviewer quoted as retained, per removed span. */
  retained: "unreviewed" | string[];
};

/**
 * Reads the manuscript, cuts what it flags and stages every flagged chapter,
 * returning the read's book notes for the seams. A cut or a stop that fails
 * any flagged chapter stages none of them (see `cutFlaggedChapters`).
 */
export async function readManuscriptAndCut(context: ManuscriptReadContext): Promise<{ bookNotes: string[] }> {
  const { projectId, setups, finalText, reports } = context;
  const chaptersForRead = setups.map((setup) => {
    const markdown = finalText.get(setup.chapter.index) ?? "";
    return {
      index: setup.chapter.index,
      title: setup.chapter.title,
      markdown,
      expectedClaim: context.compositionFor(setup).landing,
      measurements: context.notesForDraft(markdown)
    };
  });
  const read = await readManuscript({ input: context.input, plan: context.plan, stance: context.stance, ...(context.arc ? { arc: context.arc } : {}), chapters: chaptersForRead, textModel: context.textModel });
  if (read.skipped) {
    console.warn("Manuscript read skipped", { event: "generation.composed_chapters.read_skipped", projectId, reason: read.skipped });
  }
  if (read.stopsDevelopingAt !== undefined || read.swappable !== undefined || read.answerStatedIn !== undefined) {
    const readMetrics = {
      ...(read.stopsDevelopingAt !== undefined ? { stopsDevelopingAt: read.stopsDevelopingAt } : {}),
      ...(read.swappable !== undefined ? { swappable: read.swappable } : {}),
      ...(read.answerStatedIn !== undefined ? { answerStatedIn: read.answerStatedIn } : {})
    };
    console.warn("Manuscript read metrics", { event: "generation.composed_chapters.read_metrics", projectId, ...readMetrics });
    const firstIndex = setups[0]?.chapter.index;
    const firstReport = firstIndex === undefined ? undefined : reports.get(firstIndex);
    if (firstIndex !== undefined && firstReport) {
      reports.set(firstIndex, { ...firstReport, readMetrics });
    }
  }
  // With the cuts off, every chapter that drew notes is still re-staged below
  // with the notes on its report; only the cut call is skipped.
  const flagged = read.chapters.filter((entry) => (context.cuts ? entry.edit : entry.notes.length > 0));
  const eligible: FlaggedChapter[] = [];
  for (const [offset, entry] of flagged.entries()) {
    const setup = setups.find((candidate) => candidate.chapter.index === entry.chapterIndex);
    const chapterId = setup ? context.chapterIds.get(setup.chapter.index) : undefined;
    const current = setup ? finalText.get(setup.chapter.index) : undefined;
    if (!setup || !chapterId || !current) continue;
    const pendingRows = await prisma.page.count({
      where: { projectId, status: "PENDING", index: { gte: setup.startPage, lte: setup.endPage } }
    });
    if (pendingRows !== setup.endPage - setup.startPage + 1) continue;
    eligible.push({ offset, entry, setup, chapterId, current });
  }
  const outcomes = await guardRetainedEvidence(context, await cutFlaggedChapters(context, eligible, flagged.length, read.bookNotes));
  // Staged one at a time, in the read's order: `stageComposedChapter` rewrites the chapter's PENDING rows.
  for (const outcome of outcomes) await stageOutcome(context, outcome);
  return { bookNotes: read.bookNotes };
}

/**
 * Cuts every flagged chapter, `CUTS_IN_FLIGHT` at a time, each against the
 * text every chapter had before any of them was cut. A cut that throws stops
 * any chapter not yet started, waits for the ones in flight, and fails the
 * batch with nothing staged: a stop wherever one came from, otherwise the
 * first failure in the read's order, which is the error the serial loop
 * would have thrown (`settleIndependentLoads` makes the same choice). In-flight
 * calls see a stop on their own (`withStopAbort` polls the job), so a stop
 * ends the batch within seconds and nothing is written after it.
 */
async function cutFlaggedChapters(context: ManuscriptReadContext, eligible: readonly FlaggedChapter[], flaggedCount: number, bookNotes: string[]): Promise<CutOutcome[]> {
  // Progress goes out in the read's order and doubles as the stop check before each cut.
  let announced: Promise<unknown> = Promise.resolve();
  const announce = ({ offset, setup }: FlaggedChapter) => {
    const next = announced.then(() => updateJobProgress(context.generationJobId, {
      progress: 70 + Math.round(((offset + 1) / flaggedCount) * 5),
      message: context.cuts
        ? `Cutting chapter ${setup.chapter.index}/${context.setups.length} from the manuscript read`
        : `Recording the manuscript read's notes on chapter ${setup.chapter.index}/${context.setups.length}`
    }));
    announced = next.catch(() => undefined);
    return next;
  };
  let failed = false;
  const settled = await mapWithConcurrency(eligible, CUTS_IN_FLIGHT, async (chapter) => {
    if (failed) return { status: "skipped" as const };
    try {
      await announce(chapter);
      return { status: "fulfilled" as const, value: await cutOne(context, chapter, bookNotes) };
    } catch (reason) {
      failed = true;
      return { status: "rejected" as const, reason };
    }
  });
  const failures = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  const stop = failures.find((failure) => isStopRequestedError(failure));
  if (stop !== undefined) throw stop;
  if (failures.length > 0) throw failures[0];
  return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

async function cutOne(context: ManuscriptReadContext, chapter: FlaggedChapter, bookNotes: string[]): Promise<CutOutcome> {
  const { setup, entry, current } = chapter;
  // Deletion only: the read names the sentences, the cut removes them, and
  // `deletionOnlyResult` refuses anything the model wrote.
  const { prose, fences } = stripFigureFences(current);
  // The cut may spend only the room the chapter has over its page floor.
  const cutBudget = chapterWordBudget(context.input, setup.endPage - setup.startPage + 1);
  if (!context.cuts) {
    return { ...chapter, prose, edited: { markdown: current, words: proseWordCount(current), attempts: 0, changed: false }, shown: [], retained: "unreviewed" };
  }
  // The acceptance reviewer judges a cut against the retained passage the note names, so it
  // is shown the chapters the notes cite and not the rest of the book: run 3 of the 100-page
  // Balanced evaluation sent all fourteen other chapters (270–288 KB) to each of eight cut
  // reviews, and every retained passage the reviewer cited lay in the chapter being cut or in
  // the one the note named. Notes that cite nothing recognisable keep the whole book in view.
  const surroundingChapters = cutSurroundingChapters(context, setup, entry.notes);
  const options = await context.composeOptionsFor(setup, new Map());
  const reviews: unknown[] = [];
  const edited = await cutChapter({
    ...options,
    textModel: recordingCutReviews(options.textModel, reviews),
    markdown: prose,
    notes: entry.notes,
    surroundingChapters,
    bookNotes,
    maxRemovableWords: Math.max(0, countReadableWords(prose) - cutBudget.min)
  });
  const reshaped = edited.changed ? reinsertFigureFences(edited.markdown, fences) : undefined;
  const pages = reshaped ? await context.describePages(setup, reshaped) : undefined;
  const previous = context.setups.filter((other) => other.chapter.index < setup.chapter.index).at(-1)?.chapter.index;
  const shown = [...new Set([...surroundingChapters.map((other) => other.index), ...(previous === undefined ? [] : [previous])])];
  return {
    ...chapter,
    prose,
    edited,
    ...(reshaped ? { reshaped } : {}),
    ...(pages ? { pages } : {}),
    shown,
    retained: options.semanticAcceptance === false ? "unreviewed" : reviews.flatMap(retainedEvidenceOf)
  };
}

function cutSurroundingChapters(context: ManuscriptReadContext, setup: ChapterSetup, notes: readonly string[]) {
  const chapters = context.setups.flatMap((other) => {
    const text = context.finalText.get(other.chapter.index);
    return text ? [{ index: other.chapter.index, title: other.chapter.title, markdown: figureStandInMarkdown(text) }] : [];
  });
  const cited = citedChapters(notes, chapters, { language: context.input.language, except: setup.chapter.index });
  const surrounding = chapters.filter((other) => other.index !== setup.chapter.index && (cited === undefined || cited.includes(other.index)));
  console.warn("Cut acceptance context", {
    event: "generation.composed_chapters.cut_context",
    projectId: context.projectId,
    chapterIndex: setup.chapter.index,
    cited: cited ?? "unrecognised",
    surroundingChapters: surrounding.map((other) => other.index),
    surroundingBytes: surrounding.reduce((sum, other) => sum + Buffer.byteLength(other.markdown, "utf8"), 0)
  });
  return surrounding;
}

/**
 * The cut's own text model with its acceptance review kept: core's
 * `acceptsChapterEdit` answers a boolean, and the guard needs what the
 * reviewer quoted. Every call still goes through the caller's adapter.
 */
function recordingCutReviews(textModel: TextModelAdapter, reviews: unknown[]): TextModelAdapter {
  return {
    generateText: (options) => textModel.generateText(options),
    generateJson: async <T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> => {
      const result = await textModel.generateJson(options);
      if (options.purpose === CUT_ACCEPTANCE_PURPOSE) reviews.push(result.data);
      return result;
    },
    streamText: (options) => textModel.streamText(options),
    generateWithTools: (options) => textModel.generateWithTools(options),
    ...(textModel.prepareReviewContext ? { prepareReviewContext: textModel.prepareReviewContext.bind(textModel) } : {}),
    ...(textModel.bindForCall ? { bindForCall: textModel.bindForCall.bind(textModel) } : {})
  };
}

function retainedEvidenceOf(review: unknown): string[] {
  if (!isRecord(review) || !Array.isArray(review.removedSpanReviews)) return [];
  return review.removedSpanReviews.flatMap((span) => (isRecord(span) && typeof span.retainedEvidence === "string" ? [span.retainedEvidence] : []));
}

const foldQuoted = (text: string) => text.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/\s+/g, " ").trim();

/**
 * The passages a reviewer's `retainedEvidence` quotes, each a fragment the
 * book has to contain verbatim. The field is the reviewer's prose around its
 * quotations ("…says that “X,” and later, “Y.”"), so the quoted spans are the
 * claim; a field with no quotation marks is taken whole. Ellipses and
 * bracketed insertions ("show[s]") split a quotation into the fragments
 * around them, and the punctuation the reviewer's own sentence put at a
 * fragment's ends is not part of it.
 */
export function retainedEvidenceQuotes(evidence: string): string[] {
  const folded = foldQuoted(evidence);
  const quoted = [...folded.matchAll(/"([^"]+)"|«([^»]+)»|「([^」]+)」|『([^』]+)』/gu)]
    .map((match) => (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim())
    .filter(Boolean);
  return (quoted.length > 0 ? quoted : [folded])
    .flatMap((quote) => quote.split(/\s*(?:\.{3}|…|\[[^\]]*\])\s*/u))
    .map((fragment) => fragment.replace(/^[\s"'.,;:!?،؛؟。，、]+|[\s"',;:.!?،؛؟。，、]+$/gu, ""))
    .filter((fragment) => fragment.length >= MIN_QUOTE_CHARACTERS);
}

/**
 * Every cut reads the other chapters as they stood before any of the batch
 * was cut, and a deletion-only cut can take from the book only what its own
 * chapter held — so the one thing a neighbour's concurrent cut can do to this
 * one is delete the passage its reviewer accepted it against as "retained".
 * The serial loop never had that hazard: a later cut's reviewer read the
 * earlier cuts' results. So a kept cut whose reviewer was shown a chapter that
 * was itself cut has to find every passage its review quoted in the book as
 * the batch leaves it, or it is dropped and its chapter keeps its original.
 * The quote is the reviewer's prose and may paraphrase, so a miss is read as a
 * loss: conservative on purpose, and only where two shown chapters both cut.
 * Dropping only ever puts text back, so the cuts are judged in the read's
 * order against the cuts still standing, and no kept cut can lose a quote to a
 * later decision.
 */
async function guardRetainedEvidence(context: ManuscriptReadContext, outcomes: CutOutcome[]): Promise<CutOutcome[]> {
  const after = new Map(outcomes.flatMap((outcome) => (outcome.reshaped ? [[outcome.setup.chapter.index, outcome.reshaped] as const] : [])));
  const guarded: CutOutcome[] = [];
  for (const outcome of outcomes) {
    const own = outcome.setup.chapter.index;
    const cutNeighbours = outcome.reshaped ? outcome.shown.filter((index) => index !== own && after.has(index)) : [];
    if (cutNeighbours.length === 0 || outcome.retained === "unreviewed") {
      guarded.push(outcome);
      continue;
    }
    const view = foldQuoted([outcome.edited.markdown, ...outcome.shown.flatMap((index) => {
      const text = after.get(index) ?? context.finalText.get(index);
      return text ? [figureStandInMarkdown(text)] : [];
    })].join("\n\u0000\n"));
    const quotes = outcome.retained.flatMap(retainedEvidenceQuotes);
    const missing = quotes.filter((quote) => !view.includes(quote));
    if (quotes.length > 0 && missing.length === 0) {
      guarded.push(outcome);
      continue;
    }
    after.delete(own);
    const dropped = {
      projectId: context.projectId,
      chapterIndex: own,
      cutNeighbours,
      reason: quotes.length === 0 ? "no retained evidence recorded" : "retained evidence not found",
      missing: missing.slice(0, 5)
    };
    console.warn("Concurrent cut dropped", { event: "generation.composed_chapters.cut_guard_dropped", ...dropped });
    await context.runLog?.append("generation.composed_chapters.cut_guard_dropped", dropped);
    guarded.push({ ...outcome, reshaped: undefined, pages: undefined,
      edited: { markdown: outcome.prose, words: countReadableWords(outcome.prose), attempts: outcome.edited.attempts, changed: false } });
  }
  return guarded;
}

async function stageOutcome(context: ManuscriptReadContext, outcome: CutOutcome): Promise<void> {
  const { projectId, reports } = context;
  const { setup, chapterId, current, entry, edited, reshaped, pages } = outcome;
  const previous = reports.get(setup.chapter.index) ??
    context.reportFor(setup, proseWordCount(current), proseWordCount(current), false, current);
  const report: ComposedChapterReport = {
    ...previous,
    readNotes: entry.notes,
    secondEditApplied: edited.changed,
    ...(edited.changed ? { editedWords: edited.words, paragraphCv: paragraphShapeReport(edited.markdown).cv } : {})
  };
  reports.set(setup.chapter.index, report);
  if (!pages || !reshaped) {
    // The notes are still worth keeping beside the chapter: the console
    // shows what the read said even when the edit changed nothing. Its pages
    // keep the continuity notes its own staging wrote, read back from the row:
    // the chapters the pass loaded at the start are none on a fresh run.
    const state = await loadComposedBookState(projectId);
    const pageNotes = state.chapters.find((chapter) => chapter.index === setup.chapter.index)?.pageNotes;
    await stageComposedChapter({
      projectId,
      chapterId,
      setup,
      composition: context.compositionFor(setup),
      pages: storedPagesInRange(state.pages, setup).map((page) => ({
        index: page.index,
        title: page.title,
        summary: page.summary,
        continuityNotes: pageNotes?.get(page.index) ?? [],
        ...(page.imagePrompt ? { imagePrompt: page.imagePrompt } : {}),
        markdown: page.markdown
      })),
      report,
      replace: true
    });
    return;
  }
  await stageComposedChapter({ projectId, chapterId, setup, composition: context.compositionFor(setup), pages, report, replace: true });
  context.finalText.set(setup.chapter.index, reshaped);
  context.edges.set(setup.chapter.index, chapterEdges(reshaped));
  context.digests.set(setup.chapter.index, chapterDigest(pages.map((page) => page.summary)));
}

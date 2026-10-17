import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  chapters: [] as Array<{ id: string; index: number; title: string; targetPages: number; productionBrief: unknown }>,
  pages: [] as Array<{ index: number; status: string; title: string; markdown: string; summary: string; imagePrompt: string | null }>
}));

const mocks = vi.hoisted(() => {
  const prisma = {
    chapter: {
      findMany: vi.fn(async () => store.chapters.map((chapter) => ({ ...chapter }))),
      update: vi.fn(async (args: { where: { id: string }; data: { productionBrief: unknown } }) => {
        const chapter = store.chapters.find((candidate) => candidate.id === args.where.id);
        if (chapter) chapter.productionBrief = args.data.productionBrief;
        return chapter;
      })
    },
    page: {
      findMany: vi.fn(async () => [...store.pages].sort((a, b) => a.index - b.index).map((page) => ({ ...page }))),
      count: vi.fn(async (args: { where: { status: string; index: { gte: number; lte: number } } }) =>
        store.pages.filter((page) => page.status === args.where.status && page.index >= args.where.index.gte && page.index <= args.where.index.lte).length),
      updateMany: vi.fn(async (args: { where: { index: number; status: string }; data: Record<string, unknown> }) => {
        const page = store.pages.find((candidate) => candidate.index === args.where.index && candidate.status === args.where.status);
        if (page) Object.assign(page, args.data);
        return { count: page ? 1 : 0 };
      })
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma))
  };
  return { prisma, updateJobProgress: vi.fn(async (_jobId: string | undefined, _update: { progress?: number; message?: string }) => undefined) };
});

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("../runtime/jobLifecycle.js", () => ({ updateJobProgress: mocks.updateJobProgress }));

import {
  chapterDigest,
  chapterEdges,
  chapterWordBudget,
  citedChapters,
  countReadableWords,
  cutChapter,
  describeChapterPages,
  figureStandInMarkdown,
  paginateChapterMarkdown,
  paragraphShapeReport,
  proseWordCount,
  range,
  readManuscript,
  reinsertFigureFences,
  stripFigureFences,
  type AuthorStance,
  type BookPlan,
  type ChapterComposition,
  type CreateProjectInput,
  type EditedChapterText,
  type GenerateJsonOptions,
  type GenerateTextOptions,
  type JsonResult,
  type TextModelAdapter
} from "@book-maker/core";
import { StopRequestedError, type ChapterSetup } from "../runtime/jobTypes.js";
import { loadComposedBookState, stageComposedChapter, storedPagesInRange, type ComposedChapterReport } from "./composedChaptersState.js";
import { CUTS_IN_FLIGHT, readManuscriptAndCut, retainedEvidenceQuotes, type ManuscriptReadContext } from "./composedManuscriptRead.js";
import recordedJson from "./testing/manuscriptReadCuts1015.json" with { type: "json" };

type RecordedChapter = { index: number; startPage: number; endPage: number; markdown: string; composition: ChapterComposition };
type Recording = {
  read: unknown;
  cuts: Record<string, string>;
  reviews: Record<string, unknown>;
  descriptions: Record<string, unknown>;
};
type Book = { input: CreateProjectInput; plan: BookPlan; chapters: RecordedChapter[] };

/** The Balanced nonfiction book of 2026-10-15: one read, three cut/acceptance pairs (two kept), two re-descriptions. */
const recorded = recordedJson as unknown as Book & Recording & { source: string };

/**
 * The read/cut block of `composedChaptersPass.ts` as it stood until
 * 2026-10-15, with its closure turned into the context: one flagged chapter
 * at a time, each staged before the next is cut. The reference the
 * concurrent orchestration is replayed against.
 */
async function serialReadAndCut(context: ManuscriptReadContext): Promise<{ bookNotes: string[] }> {
  const { projectId, input, plan, setups, finalText, edges, digests, reports, generationJobId, compositionFor, composeOptionsFor, describePages, reportFor } = context;
  const readCuts = context.cuts;
  const chaptersForRead = setups.map((setup) => {
    const markdown = finalText.get(setup.chapter.index) ?? "";
    return { index: setup.chapter.index, title: setup.chapter.title, markdown, expectedClaim: compositionFor(setup).landing, measurements: context.notesForDraft(markdown) };
  });
  const cutSurroundingChapters = (setup: ChapterSetup, notes: readonly string[]) => {
    const chapters = setups.flatMap((other) => {
      const text = finalText.get(other.chapter.index);
      return text ? [{ index: other.chapter.index, title: other.chapter.title, markdown: figureStandInMarkdown(text) }] : [];
    });
    const cited = citedChapters(notes, chapters, { language: input.language, except: setup.chapter.index });
    return chapters.filter((other) => other.index !== setup.chapter.index && (cited === undefined || cited.includes(other.index)));
  };
  const read = await readManuscript({ input, plan, stance: context.stance, ...(context.arc ? { arc: context.arc } : {}), chapters: chaptersForRead, textModel: context.textModel });
  if (read.stopsDevelopingAt !== undefined || read.swappable !== undefined || read.answerStatedIn !== undefined) {
    const readMetrics = {
      ...(read.stopsDevelopingAt !== undefined ? { stopsDevelopingAt: read.stopsDevelopingAt } : {}),
      ...(read.swappable !== undefined ? { swappable: read.swappable } : {}),
      ...(read.answerStatedIn !== undefined ? { answerStatedIn: read.answerStatedIn } : {})
    };
    const firstIndex = setups[0]?.chapter.index;
    const firstReport = firstIndex === undefined ? undefined : reports.get(firstIndex);
    if (firstIndex !== undefined && firstReport) reports.set(firstIndex, { ...firstReport, readMetrics });
  }
  const flagged = read.chapters.filter((entry) => (readCuts ? entry.edit : entry.notes.length > 0));
  for (const [offset, entry] of flagged.entries()) {
    const setup = setups.find((candidate) => candidate.chapter.index === entry.chapterIndex);
    const chapterId = setup ? context.chapterIds.get(setup.chapter.index) : undefined;
    const current = setup ? finalText.get(setup.chapter.index) : undefined;
    if (!setup || !chapterId || !current) continue;
    const pendingRows = await mocks.prisma.page.count({ where: { status: "PENDING", index: { gte: setup.startPage, lte: setup.endPage } } });
    if (pendingRows !== setup.endPage - setup.startPage + 1) continue;
    await mocks.updateJobProgress(generationJobId, {
      progress: 70 + Math.round(((offset + 1) / flagged.length) * 5),
      message: readCuts
        ? `Cutting chapter ${setup.chapter.index}/${setups.length} from the manuscript read`
        : `Recording the manuscript read's notes on chapter ${setup.chapter.index}/${setups.length}`
    });
    const { prose: currentProse, fences: currentFences } = stripFigureFences(current);
    const cutBudget = chapterWordBudget(input, setup.endPage - setup.startPage + 1);
    const surroundingChapters = readCuts ? cutSurroundingChapters(setup, entry.notes) : [];
    const edited: EditedChapterText = readCuts
      ? await cutChapter({ ...(await composeOptionsFor(setup, new Map())), markdown: currentProse, notes: entry.notes, surroundingChapters, bookNotes: read.bookNotes,
          maxRemovableWords: Math.max(0, countReadableWords(currentProse) - cutBudget.min) })
      : { markdown: current, words: proseWordCount(current), attempts: 0, changed: false };
    const previous = reports.get(setup.chapter.index) ?? reportFor(setup, proseWordCount(current), proseWordCount(current), false, current);
    const report: ComposedChapterReport = {
      ...previous,
      readNotes: entry.notes,
      secondEditApplied: edited.changed,
      ...(edited.changed ? { editedWords: edited.words, paragraphCv: paragraphShapeReport(edited.markdown).cv } : {})
    };
    reports.set(setup.chapter.index, report);
    const reshaped = edited.changed ? reinsertFigureFences(edited.markdown, currentFences) : undefined;
    const pages = reshaped ? await describePages(setup, reshaped) : undefined;
    if (!pages) {
      // The serial loop read these notes off the chapters the pass loaded at its start, which a
      // fresh run had emptied; the reference reads them back from the row, as the fix does.
      const state = await loadComposedBookState(projectId);
      const storedPages = storedPagesInRange(state.pages, setup);
      await stageComposedChapter({ projectId, chapterId, setup, composition: compositionFor(setup), report, replace: true,
        pages: storedPages.map((page) => ({ index: page.index, title: page.title, summary: page.summary,
          continuityNotes: state.chapters.find((chapter) => chapter.index === setup.chapter.index)?.pageNotes.get(page.index) ?? [],
          ...(page.imagePrompt ? { imagePrompt: page.imagePrompt } : {}), markdown: page.markdown })) });
      continue;
    }
    await stageComposedChapter({ projectId, chapterId, setup, composition: compositionFor(setup), pages, report, replace: true });
    finalText.set(setup.chapter.index, reshaped!);
    edges.set(setup.chapter.index, chapterEdges(reshaped!));
    digests.set(setup.chapter.index, chapterDigest(pages.map((page) => page.summary)));
  }
  return { bookNotes: read.bookNotes };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const userJson = (options: GenerateTextOptions) => JSON.parse(options.messages.find((message) => message.role === "user")!.content) as Record<string, unknown>;

/**
 * Answers every call from the recording, keyed by what it is about rather than
 * by the order it arrives in, and refuses any call nothing was recorded for.
 */
function replayModel(recording: Recording, options: { cut?: (chapterIndex: number) => Promise<void> } = {}) {
  const log: string[] = [];
  let inFlight = 0;
  const track = { maxCutsInFlight: 0 };
  const answer = <T>(request: GenerateJsonOptions<T>, data: unknown): JsonResult<T> => ({ data: request.schema.parse(data), text: JSON.stringify(data), provider: "replay", model: "replay" });
  const model: TextModelAdapter = {
    async generateText(request) {
      if (request.purpose !== "cut-chapter") throw new Error(`No recorded ${request.purpose} call`);
      const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join(" ");
      const chapterIndex = Number(/cutting chapter (\d+)/.exec(system)![1]);
      const text = recording.cuts[String(chapterIndex)];
      if (text === undefined) throw new Error(`No recorded cut for chapter ${chapterIndex}`);
      log.push(`cut ${chapterIndex}`);
      inFlight += 1;
      track.maxCutsInFlight = Math.max(track.maxCutsInFlight, inFlight);
      try {
        await (options.cut ? options.cut(chapterIndex) : delay(40));
      } finally {
        inFlight -= 1;
        log.push(`cut ${chapterIndex} settled`);
      }
      return { text, provider: "replay", model: "replay" };
    },
    async generateJson<T>(request: GenerateJsonOptions<T>) {
      if (request.purpose === "read-manuscript") return answer(request, recording.read);
      const payload = userJson(request);
      const chapterIndex = request.purpose === "describe-pages" ? (payload.chapter as { index: number }).index : payload.chapterIndex as number;
      const data = request.purpose === "review-chapter-edit-acceptance" ? recording.reviews[String(chapterIndex)]
        : request.purpose === "describe-pages" ? recording.descriptions[String(chapterIndex)] : undefined;
      if (data === undefined) throw new Error(`No recorded ${request.purpose} call for chapter ${chapterIndex}`);
      log.push(`${request.purpose} ${chapterIndex}`);
      return answer(request, data);
    },
    streamText() {
      throw new Error("No recorded stream");
    },
    async generateWithTools() {
      throw new Error("No recorded tool call");
    }
  };
  return { model, log, track };
}

function seed(book: Book) {
  store.chapters = book.chapters.map((chapter) => {
    const plan = book.plan.chapters.find((candidate) => candidate.index === chapter.index)!;
    return { id: `chapter-${chapter.index}`, index: chapter.index, title: plan.title, targetPages: plan.targetPages, productionBrief: null };
  });
  store.pages = book.chapters.flatMap((chapter) => {
    const paginated = paginateChapterMarkdown(chapter.markdown, chapter.endPage - chapter.startPage + 1);
    return range(chapter.startPage, chapter.endPage).map((index, offset) => ({
      index, status: "PENDING", title: `Page ${index}`, markdown: paginated.pages[offset] ?? "", summary: `What page ${index} covers.`, imagePrompt: null
    }));
  });
}

function contextFor(book: Book, textModel: TextModelAdapter): ManuscriptReadContext & { runLog: { append: ReturnType<typeof vi.fn> } } {
  const { input, plan } = book;
  const stance = plan.authorStance as AuthorStance;
  const setups: ChapterSetup[] = book.chapters.map((chapter) => ({
    chapter: plan.chapters.find((candidate) => candidate.index === chapter.index)!,
    startPage: chapter.startPage,
    endPage: chapter.endPage
  }));
  const compositionFor = (setup: ChapterSetup) => book.chapters.find((chapter) => chapter.index === setup.chapter.index)!.composition;
  const reportFor = (setup: ChapterSetup, draftWords: number, editedWords: number, editorChanged: boolean): ComposedChapterReport => {
    const budget = chapterWordBudget(input, setup.endPage - setup.startPage + 1);
    return { formPlanSource: "model", formPlanIssues: [], draftWords, editedWords, editorChanged, readNotes: [], secondEditApplied: false,
      wordBudget: { min: budget.min, target: budget.target, max: budget.max }, paragraphCv: 0, shapePassApplied: false };
  };
  return {
    projectId: "project-1",
    input,
    plan,
    stance,
    setups,
    chapterIds: new Map(setups.map((setup) => [setup.chapter.index, `chapter-${setup.chapter.index}`])),
    textModel,
    generationJobId: "job-1",
    runLog: { append: vi.fn(async (_event: string, _data: Record<string, unknown>) => "") },
    cuts: true,
    finalText: new Map(book.chapters.map((chapter) => [chapter.index, chapter.markdown])),
    edges: new Map(book.chapters.map((chapter) => [chapter.index, chapterEdges(chapter.markdown)])),
    digests: new Map(book.chapters.map((chapter) => [chapter.index, `Digest of chapter ${chapter.index}.`])),
    reports: new Map(setups.map((setup) => {
      const markdown = book.chapters.find((chapter) => chapter.index === setup.chapter.index)!.markdown;
      return [setup.chapter.index, reportFor(setup, proseWordCount(markdown), proseWordCount(markdown), true)];
    })),
    compositionFor,
    composeOptionsFor: async (setup) => ({
      input, plan, stance, chapter: setup.chapter, composition: compositionFor(setup), chapterPageStart: setup.startPage, chapterPageEnd: setup.endPage,
      earlierChapters: [], continuityNotes: [], researchNotes: [], textModel, semanticAcceptance: true
    }),
    describePages: async (setup, markdown) => {
      const paginated = paginateChapterMarkdown(markdown, setup.endPage - setup.startPage + 1);
      const pages = range(setup.startPage, setup.endPage).map((index, offset) => ({ index, markdown: paginated.pages[offset] ?? "" }));
      const described = await describeChapterPages({ input, plan, chapter: setup.chapter, pages, illustratedIndexes: [], textModel });
      return described.map((page, offset) => ({ ...page, markdown: pages[offset]!.markdown }));
    },
    reportFor,
    notesForDraft: () => []
  };
}

/** Everything an orchestration leaves behind: rows, briefs, the pass's memory and what it told the job. */
async function outcomeOf(run: (context: ManuscriptReadContext) => Promise<{ bookNotes: string[] }>, book: Book, recording: Recording) {
  seed(book);
  mocks.updateJobProgress.mockClear();
  const replay = replayModel(recording);
  const context = contextFor(book, replay.model);
  const { bookNotes } = await run(context);
  return {
    bookNotes,
    pages: store.pages.map((page) => ({ ...page })),
    briefs: store.chapters.map((chapter) => JSON.parse(JSON.stringify(chapter.productionBrief)) as unknown),
    reports: [...context.reports.entries()],
    finalText: [...context.finalText.entries()],
    edges: [...context.edges.entries()],
    digests: [...context.digests.entries()],
    progress: mocks.updateJobProgress.mock.calls.map((call) => call[1]),
    cuts: replay.log.filter((entry) => /^cut \d+$/.test(entry)).sort(),
    maxCutsInFlight: replay.track.maxCutsInFlight,
    events: context.runLog.append.mock.calls.map(([event]) => event)
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("readManuscriptAndCut", () => {
  it("replays the recorded Balanced read through the serial loop and the concurrent one and stages the same book", async () => {
    const serial = await outcomeOf(serialReadAndCut, recorded, recorded);
    const concurrent = await outcomeOf(readManuscriptAndCut, recorded, recorded);

    // The recording's own decisions: three cuts asked for, chapters 2 and 8 kept, chapter 4 retained as a regression.
    expect(serial.cuts).toEqual(["cut 2", "cut 4", "cut 8"]);
    const applied = new Map(serial.reports.map(([index, report]) => [index, report.secondEditApplied]));
    expect([...applied].filter(([, changed]) => changed).map(([index]) => index)).toEqual([2, 8]);
    expect(serial.reports.filter(([, report]) => report.readNotes.length > 0).map(([index]) => index)).toEqual([1, 2, 4, 5, 6, 7, 8]);
    expect(serial.maxCutsInFlight).toBe(1);

    expect(concurrent.maxCutsInFlight).toBe(3);
    expect(concurrent.events).not.toContain("generation.composed_chapters.cut_guard_dropped");
    const { maxCutsInFlight: _serialInFlight, ...serialBook } = serial;
    const { maxCutsInFlight: _concurrentInFlight, ...concurrentBook } = concurrent;
    expect(concurrentBook).toEqual(serialBook);
  });

  it("records the read's notes and cuts nothing with the cuts off, as the serial loop did", async () => {
    const notesOnly = (run: typeof serialReadAndCut) => (context: ManuscriptReadContext) => run({ ...context, cuts: false });
    const serial = await outcomeOf(notesOnly(serialReadAndCut), recorded, recorded);
    const concurrent = await outcomeOf(notesOnly(readManuscriptAndCut), recorded, recorded);
    expect(serial.cuts).toEqual([]);
    expect(concurrent).toEqual(serial);
  });
});

describe("a flagged chapter the read leaves uncut", () => {
  // On a fresh run the pass empties the chapters it loaded at its start, so re-staging an uncut
  // chapter from them wrote every page's continuity notes away, and finalize published none for
  // it (3 of 4 chapters of the 2026-10-15 novel). The notes are the chapter's own staged brief.
  it("keeps the continuity notes its own staging wrote", async () => {
    seed(recorded);
    for (const chapter of store.chapters) {
      const pages = store.pages.filter((page) => recorded.chapters.find((entry) => entry.index === chapter.index)!.startPage <= page.index
        && page.index <= recorded.chapters.find((entry) => entry.index === chapter.index)!.endPage);
      chapter.productionBrief = { pages: pages.map((page) => ({ pageIndex: page.index, requiredContinuity: [`Page ${page.index} fixes the ledger's date.`] })) };
    }
    const context = contextFor(recorded, replayModel(recorded).model);
    await readManuscriptAndCut({ ...context, cuts: false });

    const restaged = [...context.reports].filter(([, report]) => report.readNotes.length > 0).map(([index]) => index);
    expect(restaged.length).toBeGreaterThan(0);
    for (const index of restaged) {
      const brief = store.chapters.find((chapter) => chapter.index === index)!.productionBrief as { pages: Array<{ pageIndex: number; requiredContinuity: string[] }> };
      expect(brief.pages.length).toBeGreaterThan(0);
      for (const page of brief.pages) expect(page.requiredContinuity).toEqual([`Page ${page.pageIndex} fixes the ledger's date.`]);
    }
  });
});

describe("the retained-evidence guard", () => {
  const paragraph = (chapter: number, passage: number) => range(0, 4)
    .map((at) => `Chapter ${chapter} passage ${passage} sentence ${at} records the toll the ${["river", "harbour", "granary", "mill", "market"][at]} office kept that season.`)
    .join(" ");
  const chapterText = (chapter: number, without?: number) => range(1, 10).filter((passage) => passage !== without).map((passage) => paragraph(chapter, passage)).join("\n\n");
  const opening = (chapter: number, passage: number) => paragraph(chapter, passage).split(/(?<=\.) /)[0]!;

  /** Chapters of one page each, every one flagged; `cuts` names the paragraph each removes and the passage its reviewer cites. */
  function syntheticBook(cuts: Record<number, { removes: number; cites: string; quotes: string }>, chapters = 3) {
    const indexes = range(1, chapters);
    const book: Book = {
      input: { ...recorded.input, targetPages: chapters },
      plan: { ...recorded.plan, chapters: indexes.map((index) => ({ ...recorded.plan.chapters[0]!, index, title: `Ledger ${index}`, targetPages: 1 })) },
      chapters: indexes.map((index) => ({ index, startPage: index, endPage: index, markdown: chapterText(index), composition: { ...recorded.chapters[0]!.composition, chapterIndex: index } }))
    };
    const recording: Recording = {
      read: { chapters: indexes.map((index) => ({ chapterIndex: index, edit: index in cuts, notes: index in cuts ? [`Cut passage ${cuts[index]!.removes} of chapter ${index}; ${cuts[index]!.cites} already records it.`] : [] })), bookNotes: [] },
      cuts: Object.fromEntries(Object.entries(cuts).map(([index, cut]) => [index, chapterText(Number(index), cut.removes)])),
      reviews: Object.fromEntries(Object.entries(cuts).map(([index, cut]) => [index, {
        meaning: "pass", intent: "pass", meaningReason: "Nothing lost.", intentReason: "The note's cut.",
        removedSpanReviews: [{ index: 0, meaning: "pass", join: "pass", retainedEvidence: `The retained passage reads “${cut.quotes}”`, joinReason: "The paragraphs on either side stand alone." }]
      }])),
      descriptions: Object.fromEntries(indexes.map((index) => [index, { pages: [{ index, title: `Ledger ${index} after the cut`, summary: `Chapter ${index}, cut.`, continuityNotes: [] }] }]))
    };
    return { book, recording };
  }

  async function runConcurrent(book: Book, recording: Recording, replayOptions: Parameters<typeof replayModel>[1] = {}) {
    seed(book);
    const replay = replayModel(recording, replayOptions);
    const context = contextFor(book, replay.model);
    const run = readManuscriptAndCut(context);
    return { run, context, replay };
  }

  const appliedCuts = (context: ManuscriptReadContext) => [...context.reports].filter(([, report]) => report.secondEditApplied).map(([index]) => index);

  it("drops a cut whose quoted passage a neighbour's concurrent cut removed, and keeps the neighbour's", async () => {
    const { book, recording } = syntheticBook({
      1: { removes: 3, cites: "Chapter 2", quotes: opening(1, 4) },
      2: { removes: 5, cites: "Chapter 1", quotes: opening(1, 3) }
    });
    const { run, context } = await runConcurrent(book, recording);
    await run;
    expect(appliedCuts(context)).toEqual([1]);
    expect(context.finalText.get(1)).toBe(chapterText(1, 3));
    expect(context.finalText.get(2)).toBe(chapterText(2));
    expect(store.pages.find((page) => page.index === 2)!.markdown).toContain(opening(2, 5));
    expect(context.reports.get(2)).toMatchObject({ secondEditApplied: false, readNotes: [expect.stringContaining("Chapter 1")] });
    expect(context.runLog.append).toHaveBeenCalledWith("generation.composed_chapters.cut_guard_dropped", expect.objectContaining({
      chapterIndex: 2, cutNeighbours: [1], reason: "retained evidence not found", missing: [opening(1, 3).replace(/\.$/, "")]
    }));
  });

  it("keeps both cuts when every quoted passage survives the batch", async () => {
    const { book, recording } = syntheticBook({
      1: { removes: 3, cites: "Chapter 2", quotes: opening(2, 2) },
      2: { removes: 5, cites: "Chapter 1", quotes: opening(1, 6) }
    });
    const { run, context } = await runConcurrent(book, recording);
    await run;
    expect(appliedCuts(context)).toEqual([1, 2]);
    expect(context.runLog.append).not.toHaveBeenCalled();
  });

  it("settles two cuts that took each other's evidence by dropping the first, whose drop restores the second's", async () => {
    const { book, recording } = syntheticBook({
      1: { removes: 3, cites: "Chapter 2", quotes: opening(2, 5) },
      2: { removes: 5, cites: "Chapter 1", quotes: opening(1, 3) }
    });
    const { run, context } = await runConcurrent(book, recording);
    await run;
    expect(appliedCuts(context)).toEqual([2]);
    expect(context.runLog.append).toHaveBeenCalledTimes(1);
    expect(context.runLog.append).toHaveBeenCalledWith("generation.composed_chapters.cut_guard_dropped", expect.objectContaining({ chapterIndex: 1 }));
  });

  it("drops a guarded cut whose review left no quotation to check", async () => {
    const { book, recording } = syntheticBook({
      1: { removes: 3, cites: "Chapter 2", quotes: opening(1, 4) },
      2: { removes: 5, cites: "Chapter 1", quotes: opening(1, 6) }
    });
    (recording.reviews["2"] as { removedSpanReviews: Array<{ retainedEvidence: string }> }).removedSpanReviews[0]!.retainedEvidence = "Kept.";
    const { run, context } = await runConcurrent(book, recording);
    await run;
    expect(appliedCuts(context)).toEqual([1]);
    expect(context.runLog.append).toHaveBeenCalledWith("generation.composed_chapters.cut_guard_dropped", expect.objectContaining({ chapterIndex: 2, reason: "no retained evidence recorded" }));
  });

  it("reads the quotations out of the reviewer's prose", () => {
    expect(retainedEvidenceQuotes("The retained discussion presents both sides: “Supporters of Guedes’s program have a serious case,” and later, “Critics, in turn, can overstate…”"))
      .toEqual(["Supporters of Guedes's program have a serious case", "Critics, in turn, can overstate"]);
    expect(retainedEvidenceQuotes("PNAD COVID19 “show[s] why the assistance cannot be treated as the sole explanation for economic outcomes”"))
      .toEqual(["why the assistance cannot be treated as the sole explanation for economic outcomes"]);
    expect(retainedEvidenceQuotes("Yet the ink had pressed the river toward the garden.")).toEqual(["Yet the ink had pressed the river toward the garden"]);
    expect(retainedEvidenceQuotes("Kept.")).toEqual([]);
  });

  describe("a failure in the batch", () => {
    const fiveCuts = () => syntheticBook(Object.fromEntries(range(1, 5).map((index) => [index, { removes: 3, cites: "Chapter 9", quotes: opening(index, 4) }])), 5);

    /**
     * Four cuts in flight, then chapter 3 fails first; the rest are let go
     * only after it has, and chapter 4 outlasts them all. A batch that
     * rejected on the first failure would settle before chapter 4 did.
     */
    function gatedCuts(failures: { first: Error; second: unknown }) {
      const deferred = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => { resolve = done; });
        return { promise, resolve };
      };
      const allIn = deferred();
      const released = deferred();
      let entered = 0;
      return async (chapterIndex: number) => {
        entered += 1;
        if (entered === CUTS_IN_FLIGHT) allIn.resolve();
        if (chapterIndex === 3) {
          await allIn.promise;
          setTimeout(released.resolve, 10);
          throw failures.first;
        }
        await released.promise;
        if (chapterIndex === 2) throw failures.second;
        if (chapterIndex === 4) await delay(30);
      };
    }

    it("ends at a stop wherever it came from, after the cuts in flight settle, with nothing staged", async () => {
      const { book, recording } = fiveCuts();
      const stop = new StopRequestedError();
      const { run, replay } = await runConcurrent(book, recording, { cut: gatedCuts({ first: new Error("connection reset"), second: stop }) });
      await expect(run).rejects.toBe(stop);
      // Chapter 5 never started: the batch stopped taking chapters at the first failure.
      expect(replay.log.filter((entry) => /^cut \d+$/.test(entry)).sort()).toEqual(["cut 1", "cut 2", "cut 3", "cut 4"]);
      // Chapter 4 was still cutting when the stop came; the batch waited for it.
      expect(replay.log).toContain("cut 4 settled");
      expect(mocks.prisma.chapter.update).not.toHaveBeenCalled();
      expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
    });

    it("fails with the first failure in the read's order, not the first to arrive, with nothing staged", async () => {
      const { book, recording } = fiveCuts();
      const { run, replay } = await runConcurrent(book, recording, {
        cut: gatedCuts({ first: new Error("a later chapter failed first"), second: new Error("provider unavailable") })
      });
      await expect(run).rejects.toThrow("provider unavailable");
      expect(replay.log).not.toContain("cut 5");
      expect(replay.log).toContain("cut 4 settled");
      expect(mocks.prisma.chapter.update).not.toHaveBeenCalled();
      expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
    });

    it("stages a cut book as the serial loop would once every cut has returned", async () => {
      const { book, recording } = fiveCuts();
      const serial = await outcomeOf(serialReadAndCut, book, recording);
      const concurrent = await outcomeOf(readManuscriptAndCut, book, recording);
      expect(serial.reports.filter(([, report]) => report.secondEditApplied)).toHaveLength(5);
      expect(concurrent.maxCutsInFlight).toBe(4);
      const { maxCutsInFlight: _serial, ...serialBook } = serial;
      const { maxCutsInFlight: _concurrent, ...concurrentBook } = concurrent;
      expect(concurrentBook).toEqual(serialBook);
    });
  });
});

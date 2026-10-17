import {
  chapterDigest,
  chapterEdges,
  chapterWordBudget,
  composeChapter as composeChapterText,
  describeChapterPages,
  editChapter,
  formatStoryStateLines,
  generateAuthorStance,
  measureProse,
  measurementNotes,
  paginateChapterMarkdown,
  paragraphShapeReport,
  planAuthorStance,
  range,
  sampleSentenceLeaks,
  plannedFigures,
  printedWordCount,
  proseWordCount,
  reinsertFigureFences,
  stripFigureFences,
  type BookGenerationStrategy,
  type BookEpisodes,
  type InstructionalSetting,
  type BookPlan,
  type ChapterComposition,
  type ChapterFormsResult,
  type CreateProjectInput,
  type ProviderSet,
  chapterDegeneracy,
  describeScriptLeaks,
  guardComposedDraft,
  chapterEpigraph,
  withEpigraph,
  checkQuoteProvenance,
  composeScene,
  episodesForChapter,
  openingEpisode,
  stripMisattributedQuotes,
  type BookDossier,
  type ChapterMaterial,
  type ChapterResearchScope,
  type ComposedScene,
  type ResearchSource,
  chapterCaseEvidence, planBookArc, planEpisodesFromPlan, shouldGenerateCharacterReferences, sourceResearchFits
} from "@book-maker/core";
import { composedDevelopmentWillRun, persistGeneratedAuthorStance, prepareComposedDevelopment } from "./composedPreparation.js";
import { startBookMaterial } from "./composedChaptersMaterial.js";
import { openPreparedComposition } from "./composedPrepHandoff.js";
import { finalizePendingPages } from "./composedChaptersFinalize.js";
import { readManuscriptAndCut } from "./composedManuscriptRead.js";
import { briefRequirementsForForms, storeBriefInventory, takeBriefInventory } from "./composedBriefInventory.js";
import { planComposedForms } from "./composedFormPlan.js";
import { BOOK_ARC, developmentalEditApplies, prepareBookArc, reviewChapterClaims, rewriteSeamsAfterRead, runComposedDevelopmentalEdit } from "./composedExperiments.js";
import { validateComposedChapterFigures } from "./composedFigures.js";
import { repairChapterArithmetic } from "./composedArithmeticRepair.js";
import { measureComposedChapterLength } from "./composedChapterLength.js";
import { chapterFactLedger, earlierChapterContext } from "./composedChapterMemory.js";
import type { RunLogger } from "../providers/runLogging.js";
import { prisma } from "@book-maker/db";
import { maybeEnqueueCompile, maybeEnqueueCover } from "../runtime/dispatch.js";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";
import type { ChapterSetup } from "../runtime/jobTypes.js";
import { chapterSetupsForPlan } from "./bookHelpers.js";
import { resetBookForDirectGeneration } from "./bookState.js";
import { ensureCharacterReferenceAssets } from "./characterReferences.js";
import { loadContinuityNotes, loadResearchNotesForGeneration } from "./generationContext.js";
import { loadQualityContext } from "./qualitySettings.js";
import { loadProjectStoryState } from "./storyStateStore.js";
import {
  composedResumeState,
  loadComposedBookState,
  stageComposedChapter,
  storedPagesInRange,
  type ComposedPageRow,
  type ComposedChapterReport
} from "./composedChaptersState.js";
export { composedResumeState, derivedChapterBrief } from "./composedChaptersState.js";

/** Chapters finishing beside the one being composed: three model calls in flight at most. */
const FINISHES_IN_FLIGHT = 2;
/**
 * The share of a draft's surplus over its minimum counted toward the book's lead. Set for the
 * line edit's cuts, kept for the manuscript read's, which may still take a chapter down to its
 * floor; not re-measured since the line edit was removed (2026-10-16).
 */
const SLACK_KEPT_SHARE = 0.7;

/**
 * The composed-chapters pass: author stance → chapter form plan → for each
 * chapter, compose as one piece of prose, repair its arithmetic where code
 * finds it wrong, paginate, describe the pages, checkpoint them as PENDING
 * rows → one read of the whole manuscript with bounded cuts → finalize every
 * PENDING page through the same staged publication the other passes use.
 * There is no line edit: the draft is the chapter (removed 2026-10-16,
 * packages/core/src/generation/CLAUDE.md).
 *
 * Three model calls are in flight at most: chapter N is composed while
 * chapters N-1 and N-2 are repaired, paginated, described and checkpointed.
 * Chapter N reads the *draft* tail of N-1 (a repair keeps its opening and
 * closing substance), so the pipeline never waits on a finish.
 *
 * A chapter's pages are written in one transaction, so a worker restart finds
 * whole chapters or none of a chapter, and resumes at the first chapter with no
 * pages. The chapter form plan is re-planned for the remaining chapters against
 * the compositions the finished chapters stored beside their derived briefs.
 * See `.scratch/composed-chapters/spec.md`.
 */

type ComposedPassOptions = {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
  /** The job's run log, for the events a rerun is measured from; the provider calls log through their own decorators. */
  runLog?: Pick<RunLogger, "append">;
  /**
   * The strategy's research expansion: started once a book the stance says
   * is written from sources has its episodes, scoped to the chapters no
   * lead answered for (`ChapterResearchScope`), run beside the dossier and
   * the form plan (its notes are read only when a chapter is composed), and
   * waited for before the first chapter — or, with `readyFor`, chapter by chapter (harness redesign H4), the rows
   * settled so far read from `pendingRows` until the expansion writes them.
   */
  research?: {
    start: (scope?: ChapterResearchScope) => void;
    ready: () => Promise<void>;
    readyFor?: ((chapterIndex: number) => Promise<void>) | undefined;
    pendingRows?: (() => readonly ResearchSource[]) | undefined;
  } | undefined;
};

export async function generateBookComposedChapters(options: ComposedPassOptions): Promise<void> {
  // Work the pass starts and does not wait for chapter by chapter (the whole dossier): a failed pass waits for it
  // too, so nothing it writes lands behind the job.
  const background = new Set<Promise<unknown>>();
  try {
    await composeBookChapters(options, background);
  } finally {
    await Promise.allSettled(background);
  }
}

async function composeBookChapters(options: ComposedPassOptions, background: Set<Promise<unknown>>): Promise<void> {
  const { projectId, planId, input, providers, strategy, generationJobId, runLog } = options;
  let plan = options.plan;
  const textModel = providers.text;
  // A lead's search answers with text as well as documents; the research strategy keeps it as the chapter's notes (core `leadResearch.ts`).
  const caseSourceSearch = (query: string) => providers.research.search({ query, projectId, purpose: "case-source-search" });
  const searchSources = async (query: string) => (await caseSourceSearch(query)).sources.flatMap((source) => source.url ? [{ title: source.title, url: source.url }] : []);
  const quality = await loadQualityContext(input);
  await advanceJobStep(generationJobId, "briefs", 12, "Deciding the author's stance", { phase: "stance" });
  const originalState = await loadComposedBookState(projectId);
  // What the speculative composition prep stored while the reader read the plan (`composedPrepHandoff.ts`):
  // each answer is read where this run would have asked for it, and a step the prep did not answer is this run's.
  const prepared = await openPreparedComposition({ projectId, planId, generationJobId, input, plan, qualitySettings: quality.settings, runLog });
  plan = prepared.plan;
  // It reads only the brief, so it runs beside the stance (`composedBriefInventory.ts`) — unless every page is already written.
  const briefInventory = originalState.pages.length > 0 && originalState.pages.every((page) => page.status !== "PENDING") ? Promise.resolve(undefined) : prepared.forStep("inventory").then((stored) => takeBriefInventory({ input, plan: stored, textModel }));
  briefInventory.catch(() => undefined);
  // A method-shaped stance is refused only on a fresh run: a resumed one
  // composes from the stance its finished chapters were written to.
  let stance = planAuthorStance(plan) ?? (await prepared.stance());
  if (stance && !planAuthorStance(plan)) plan = { ...plan, authorStance: stance };
  if (!stance) {
    stance = await generateAuthorStance({ input, plan, textModel });
    await persistGeneratedAuthorStance(planId, stance);
    // Every later mode read in this pass sees the stance's research answer (`inferWritingMode`).
    plan = { ...plan, authorStance: stance };
  }
  // Sources only for a book its author says is made from them (`STANCE_RESEARCH_RULE`): none for a novel.
  const sourced = sourceResearchFits(input, plan, stance);
  // Started once, when the material knows which chapters their leads will answer for, or after it.
  let researchStarted = false;
  const startResearch = (scope?: ChapterResearchScope) => {
    if (!sourced || researchStarted) return;
    researchStarted = true;
    options.research?.start(scope);
  };
  await runLog?.append("generation.composed_chapters.source_research", { projectId, sourced, decidedBy: stance.research ? "stance" : "writing-mode" });
  // The shelved development and arc rewrite the plan the prep planned against, and compare the stored one: the prep stops first.
  if (composedDevelopmentWillRun({ input, plan, quality, hasPages: originalState.pages.length > 0 }) || (BOOK_ARC && !planBookArc(plan))) await prepared.takeOver();
  plan = await prepareComposedDevelopment({ projectId, planId, input, plan, stance, textModel, quality, hasPages: originalState.pages.length > 0, generationJobId, searchSources, ...(runLog ? { runLog } : {}) });
  stance = planAuthorStance(plan) ?? stance;
  if (plan.bookDevelopment || plan.dossier?.evidencePackets?.length) await runLog?.append("generation.composed_chapters.development_prepared", { projectId, chapters: plan.chapters.length, casePackets: plan.dossier?.evidencePackets?.length ?? 0, excludedCases: plan.dossier?.excludedCases?.length ?? 0, replanned: Boolean(plan.bookDevelopment), reviewNotes: plan.bookDevelopment?.reviewNotes ?? [] });
  // The shelved arc (`composedExperiments.ts`): a stored one re-cuts the pages before the setups are derived from them.
  const bookArc = await prepareBookArc({ projectId, planId, input, plan, stance, textModel, generationJobId });
  plan = bookArc.plan;
  const { arc, arcSource } = bookArc;

  const setups = chapterSetupsForPlan(plan, input.targetPages);
  const stored = await loadComposedBookState(projectId);
  const developmentalEditing = developmentalEditApplies(input, plan, quality, stored.pages);
  const resume = composedResumeState({
    ranges: setups.map((setup) => ({
      chapterIndex: setup.chapter.index,
      title: setup.chapter.title,
      targetPages: setup.chapter.targetPages,
      startPage: setup.startPage,
      endPage: setup.endPage
    })),
    storedChapters: stored.chapters,
    storedPages: stored.pages
  });
  if (resume.kind === "already-complete") {
    await advanceJobStep(generationJobId, "enqueue", 90, "All chapters already written; queueing export");
    await maybeEnqueueCompile(projectId, planId);
    return;
  }
  const inventoryStored = briefInventory.then((inventory) => storeBriefInventory({ planId, input, plan, inventory }));
  // The chapters an earlier run finished keep their compositions.
  const fixed = resume.kind === "fresh" ? [] : stored.chapters
    .filter((chapter) => resume.doneChapterIndexes.includes(chapter.index) && chapter.composition)
    .map((chapter) => chapter.composition!);
  // The form plan reads the episodes, never the dossier: it starts as soon as
  // they settle and plans while the sources are gathered (2026-09-30).
  let formsPlanned: Promise<ChapterFormsResult> | undefined;
  const startForms = (planned: BookEpisodes | undefined, setting?: InstructionalSetting): Promise<ChapterFormsResult> => {
    if (!formsPlanned) {
      formsPlanned = Promise.all([briefInventory, prepared.forStep("forms")]).then(([inventory, stored]) => planComposedForms({ projectId, planId, input, plan, stance, arc, setups, fixed, episodes: planned, ...(setting ? { setting } : {}), quality, textModel, requirements: briefRequirementsForForms(inventory), stored: stored.compositions }));
      // Awaited below; a stop that lands while the sources are still gathering is not an unhandled rejection.
      formsPlanned.catch(() => undefined);
    }
    return formsPlanned;
  };

  // Episodes the prep is still planning are its to finish; the stored ones are read off the plan below.
  if (!planEpisodesFromPlan(plan)) {
    const stored = await prepared.forStep("episodes");
    const storedEpisodes = planEpisodesFromPlan(stored);
    if (storedEpisodes) plan = { ...plan, episodes: storedEpisodes, ...(stored.instructionalSetting ? { instructionalSetting: stored.instructionalSetting } : {}) };
  }
  // The writer's contract and, material-first, the book's episodes and
  // dossier: planned once per book and stored on the plan like the arc
  // (`composedChaptersMaterial.ts`). Each chapter waits for its own dossier
  // (`dossierFor`), and the whole one is stored once every chapter's is.
  const gatheringProgress = { muted: false };
  const material = await startBookMaterial({ projectId, planId, input, plan, stance, textModel, quality, generationJobId, searchSources,
    ...(strategy.researchDepth ? { leadResearch: caseSourceSearch } : {}), onResearchScope: startResearch, progress: gatheringProgress,
    onEpisodes: (planned, setting) => void startForms(planned, setting), ...(runLog ? { runLog } : {}) });
  background.add(material.whole);
  material.whole.catch(() => undefined);
  startResearch();
  const { contract, episodes } = material;
  // The stored dossier (its case packets) until the whole one settles; each chapter reads its own view.
  let dossier: BookDossier | undefined = material.storedDossier;
  void material.whole.then((whole) => { if (whole) dossier = whole; }, () => undefined);
  const chapterDossiers = new Map<number, BookDossier | undefined>();
  plan = { ...plan, ...(episodes ? { episodes } : {}), ...(dossier ? { dossier } : {}) };
  const scenes = new Map<number, ComposedScene>();
  // Under the apparatus flag no two consecutive chapters open on a scene:
  // rung 3 of the 2026-09-03 ladder told an opening episode in 13–15
  // chapters of 15 and the readers named "the same machine — a cinematic
  // named-witness vignette" as a new template. The chapter without a scene
  // still has its episodes and dossier; it opens on a document or a figure.
  const rotateOpenings = quality.enabled("chapterApparatus");
  const materialFor = (chapterIndex: number): ChapterMaterial | undefined => {
    if (!episodes) return undefined;
    const chapterEpisodes = episodesForChapter(episodes, chapterIndex);
    const evidencePackets = chapterCaseEvidence(plan, chapterIndex);
    if (chapterEpisodes.length === 0 && evidencePackets.length === 0) return undefined;
    const scene = scenes.get(chapterIndex);
    // The chapter's own question, planned with its episodes; absent on older episodes and narrative books.
    const focus = episodes.chapters.find((chapter) => chapter.index === chapterIndex)?.focus;
    // The other chapters' cases, named only: the writer refers to them, never retells them.
    const reservedCases = episodes.chapters
      .filter((chapter) => chapter.index !== chapterIndex && chapter.episodes.length > 0)
      .map((chapter) => ({
        chapterIndex: chapter.index,
        episodes: chapter.episodes.map(({ title, person, place, date, document }) => ({ title, person, place, date, document }))
      }));
    return {
      episodes: chapterEpisodes,
      excerpts: chapterDossiers.get(chapterIndex)?.excerpts.filter((excerpt) => excerpt.chapterIndex === chapterIndex) ?? [],
      ...(focus ? { focus } : {}),
      ...(reservedCases.length > 0 ? { reservedCases } : {}),
      ...(dossier?.evidencePackets ? { evidencePackets } : {}),
      ...(scene ? { scene } : {})
    };
  };

  let chapterIds: Map<number, string>;
  const doneChapters = new Set<number>();
  const chapterTotal = setups.length;
  const reportChapter = (
    progress: number,
    message: string,
    phase: "compose" | "scene" | "read" | "finalize",
    chapterIndex?: number
  ) =>
    advanceJobStep(generationJobId, "setup", progress, message, {
      done: doneChapters.size,
      total: chapterTotal,
      phase,
      ...(typeof chapterIndex === "number" ? { chapterIndex } : {})
    });
  let stillPreparing = true;
  if (resume.kind === "fresh") {
    chapterIds = await resetBookForDirectGeneration(projectId, setups, plan.promises ?? []);
    stored.chapters = [];
    stored.pages = [];
  } else {
    chapterIds = new Map(stored.chapters.map((chapter) => [chapter.index, chapter.id]));
    for (const index of resume.doneChapterIndexes) doneChapters.add(index);
    if (resume.partialChapterIndexes.length > 0) {
      const partialRanges = setups.filter((setup) => resume.partialChapterIndexes.includes(setup.chapter.index));
      await prisma.page.deleteMany({
        where: {
          projectId,
          OR: partialRanges.map((setup) => ({ index: { gte: setup.startPage, lte: setup.endPage } }))
        }
      });
      stored.pages = stored.pages.filter(
        (page) => !partialRanges.some((setup) => page.index >= setup.startPage && page.index <= setup.endPage)
      );
    }
    await prisma.project.update({ where: { id: projectId }, data: { status: "GENERATING" } });
    await reportChapter(20, `Resuming with ${doneChapters.size} finished chapters`, "compose");
    stillPreparing = false;
  }

  if (stillPreparing && shouldGenerateCharacterReferences(input, plan)) {
    await advanceJobStep(generationJobId, "briefs", 16, "Drawing character reference sheets", { phase: "references" });
  }
  await ensureCharacterReferenceAssets({ projectId, planId, input, plan, providers, strategy, generationJobId });
  await maybeEnqueueCover(projectId, planId, input);

  if (stillPreparing) {
    await advanceJobStep(generationJobId, "briefs", 16, "Planning the shape of every chapter", { phase: "forms" });
  } else {
    await updateJobProgress(generationJobId, { progress: 16, message: "Planning the shape of every chapter" });
  }
  const forms = await startForms(episodes);
  const compositionFor = (setup: ChapterSetup): ChapterComposition =>
    forms.compositions.find((composition) => composition.chapterIndex === setup.chapter.index)!;

  // Memory of the book so far, in chapter order: final text, digest, page notes
  // and the continuity ledger. Finished chapters are read back from their rows;
  // chapters written this run fill in as they finish. A chapter is told only
  // about the chapters below it (`composedChapterMemory.ts`).
  const finalText = new Map<number, string>();
  const digests = new Map<number, string>();
  const provisionalDigests = new Map<number, string>();
  const pageNotes = new Map<number, string[]>();
  const ledger = chapterFactLedger({ enabled: quality.enabled("chapterFactLedger"), projectId, title: plan.title, language: input.language, textModel, lastChapterIndex: setups.at(-1)?.chapter.index, runLog });
  for (const setup of setups) {
    if (!doneChapters.has(setup.chapter.index)) continue;
    const pages = storedPagesInRange(stored.pages, setup);
    const text = pages.map((page) => page.markdown).join("\n\n");
    finalText.set(setup.chapter.index, text);
    digests.set(setup.chapter.index, chapterDigest(pages.map((page) => page.summary)));
    const storedChapter = stored.chapters.find((chapter) => chapter.index === setup.chapter.index);
    pageNotes.set(setup.chapter.index, [...(storedChapter?.pageNotes.values() ?? [])].flat());
    if (storedChapter?.facts) ledger.seed(setup.chapter.index, storedChapter.facts);
    else ledger.record(setup.chapter.index, text);
  }
  // The first and last sentence of every finished chapter, in order: the
  // moves the next chapter may not repeat. Stored chapters contribute theirs
  // from their rows; chapters written this run add theirs as they finish.
  const edges = new Map<number, { opening: string; closing: string }>();
  for (const [index, text] of finalText) edges.set(index, chapterEdges(text));
  const memory = { setups, finalText, digests, provisionalDigests, edges, notes: pageNotes, compositionFor };
  // Deterministic measurements of a draft with the sentences behind them, plus
  // any sentence of the voice sample that reached the prose verbatim.
  const notesForDraft = (markdown: string): string[] => {
    const leaks = sampleSentenceLeaks(stance.voiceSample, markdown);
    return [
      ...measurementNotes(measureProse(markdown)),
      ...(leaks.length > 0
        ? [`Sentences copied from the voice sample, which is not text for the book; remove or rewrite them: ${leaks.map((leak) => `"${leak}"`).join(" ")}`]
        : [])
    ];
  };
  const composeOptionsFor = async (setup: ChapterSetup, drafts: Map<number, string>) => {
    const [storedNotes, researchNotes, storyState, establishedFacts] = await Promise.all([
      loadContinuityNotes(projectId, { beforePageIndex: setup.startPage }),
      loadResearchNotesForGeneration(projectId, strategy, setup.chapter, undefined, [...material.pendingRows(), ...(options.research?.pendingRows?.() ?? [])]),
      loadProjectStoryState(projectId, plan.promises ?? []),
      // Chapter N waits here for chapter N-1's facts, read off its draft the moment it was validated.
      ledger.before(setup.chapter.index)
    ]);
    const { earlierNotes, ...earlier } = earlierChapterContext(setup, memory, drafts);
    return {
      input,
      plan,
      stance,
      ...(arc ? { arc } : {}),
      chapter: setup.chapter,
      composition: compositionFor(setup),
      chapterPageStart: setup.startPage,
      chapterPageEnd: setup.endPage,
      ...earlier,
      continuityNotes: [...storedNotes, ...earlierNotes],
      researchNotes,
      storyStateLines: formatStoryStateLines(storyState),
      establishedFacts,
      textModel,
      semanticAcceptance: quality.enabled("chapterEditAcceptance"),
      contract,
      sourced,
      ...(forms.cast ? { exampleCast: forms.cast } : {}),
      ...(forms.toolkit ? { toolkit: forms.toolkit } : {}),
      ...(materialFor(setup.chapter.index) ? { material: materialFor(setup.chapter.index) } : {})
    };
  };

  const todo = setups.filter((setup) => !doneChapters.has(setup.chapter.index));
  const drafts = new Map<number, string>();
  const reports = new Map<number, ComposedChapterReport>();
  const reportFor = (setup: ChapterSetup, draftWords: number, editedWords: number, editorChanged: boolean, markdown: string): ComposedChapterReport => {
    const { wordBudget: budget } = measureComposedChapterLength(input, setup.endPage - setup.startPage + 1, markdown);
    return {
      formPlanSource: forms.source,
      formPlanIssues: forms.issues,
      draftWords,
      editedWords,
      editorChanged,
      lineEdited: false,
      readNotes: [],
      secondEditApplied: false,
      wordBudget: { min: budget.min, target: budget.target, max: budget.max },
      paragraphCv: 0,
      shapePassApplied: false,
      contract,
      ...(arcSource ? { arc: arcSource } : {})
    };
  };

  const finishChapter = async (setup: ChapterSetup, draftMarkdown: string): Promise<void> => {
    const chapterId = chapterIds.get(setup.chapter.index);
    if (!chapterId) {
      throw new Error(`Chapter ${setup.chapter.index} has no row to write pages into.`);
    }
    // Figures aside: every pass below reads and rewrites prose. A repair's
    // editor sees a stand-in line where each figure sits, the deterministic
    // passes see nothing, and the blocks go back before the cut into pages.
    // No line edit runs: blind readers preferred the draft on every tier and
    // writing mode (E2 and h2i, 2026-10-16), so the draft is the chapter.
    const { prose: draftProse, fences } = stripFigureFences(draftMarkdown);
    let markdown = draftProse;
    // Editorial judgments belong to the contextual editor. Pattern matches do
    // not authorize rewriting claims, deleting qualifications or joining paragraphs.
    // The dormant claim review (`composedExperiments.ts`): only a plan's case-evidence packets reach it.
    const { markdown: reviewed, ...claimReport } = await reviewChapterClaims({ projectId, planId, input, plan, chapter: setup.chapter, markdown, textModel, searchSources, runLog,
      dossier, editOptions: () => composeOptionsFor(setup, drafts) });
    markdown = reviewed;
    // The arithmetic check: every fully numeric statement in the chapter's math is redone, and a
    // wrong one goes back to the editor as a factual correction whose evidence is the computation.
    const arithmeticMaxWords = Math.ceil(proseWordCount(markdown) * 1.1);
    const arithmetic = await repairChapterArithmetic({
      markdown,
      edit: async (text, correction) => (await editChapter({ ...(await composeOptionsFor(setup, drafts)), markdown: text, allowExtension: false, degeneracyMaxWords: arithmeticMaxWords, readerNotes: correction.instructions, factualCorrection: { ...correction, evidence: [] } })).markdown,
      degenerate: (text) => chapterDegeneracy(text, { maxWords: arithmeticMaxWords, language: input.language }).degenerate
    });
    if (arithmetic) {
      markdown = arithmetic.markdown;
      await runLog?.append("generation.composed_chapters.arithmetic", { projectId, chapterIndex: setup.chapter.index, findings: arithmetic.findings, repairs: arithmetic.repairs, unresolved: arithmetic.unresolved });
      if (arithmetic.unresolved.length) console.warn("Chapter arithmetic findings remain after repair", { event: "generation.composed_chapters.arithmetic_unresolved", projectId, chapterIndex: setup.chapter.index, unresolved: arithmetic.unresolved });
    }
    // The quote guard: every quoted span of eight words or more is checked
    // against the chapter's dossier; a miss hung on a dossier document loses
    // its marks, every other miss is counted and left (quoteProvenance.ts).
    const material = materialFor(setup.chapter.index);
    let quotes: ComposedChapterReport["quotes"];
    if (material && material.excerpts.length > 0) {
      const provenance = checkQuoteProvenance(markdown, material.excerpts);
      const stripped = stripMisattributedQuotes(markdown, provenance);
      markdown = stripped.markdown;
      quotes = { checked: provenance.checked, verbatim: provenance.verbatim, misattributed: provenance.misattributed, stripped: stripped.stripped };
      if (stripped.stripped > 0) {
        console.warn("Quote guard stripped misattributed quotation marks", {
          event: "generation.composed_chapters.quotes_stripped",
          projectId,
          chapterIndex: setup.chapter.index,
          ...quotes
        });
      }
    }
    // The epigraph: verbatim from the dossier, attributed, ahead of the prose.
    let epigraph = false;
    if (quality.enabled("chapterApparatus") && material && material.excerpts.length > 0) {
      const block = chapterEpigraph(material.excerpts, { body: markdown });
      if (block) {
        markdown = withEpigraph(markdown, block);
        epigraph = true;
      }
    }
    markdown = reinsertFigureFences(markdown, fences);
    const pages = await describePages(setup, markdown);
    const scene = scenes.get(setup.chapter.index);
    const facts = await ledger.of(setup.chapter.index);
    const report: ComposedChapterReport = {
      ...reportFor(setup, proseWordCount(draftMarkdown), proseWordCount(markdown), false, markdown),
      paragraphCv: paragraphShapeReport(markdown).cv,
      ...(scene ? { scene: { words: scene.words, episodeTitle: scene.episodeTitle } } : {}),
      ...(material
        ? {
            dossier: {
              episodes: material.episodes.length,
              documents: chapterDossiers.get(setup.chapter.index)?.documents.filter((document) => document.chapterIndex === setup.chapter.index).length ?? 0,
              excerpts: material.excerpts.length
            }
          }
        : {}),
      ...(quotes ? { quotes } : {}),
      ...(epigraph ? { epigraph } : {}),
      ...claimReport,
      ...(arithmetic ? { arithmetic: { findings: arithmetic.findings, repairs: arithmetic.repairs, unresolved: arithmetic.unresolved } } : {}),
      ...(facts ? { facts } : {})
    };
    reports.set(setup.chapter.index, report);
    await stageComposedChapter({ projectId, chapterId, setup, composition: compositionFor(setup), pages, report, replace: false });
    doneChapters.add(setup.chapter.index);
    finalText.set(setup.chapter.index, markdown);
    edges.set(setup.chapter.index, chapterEdges(markdown));
    digests.set(setup.chapter.index, chapterDigest(pages.map((page) => page.summary)));
    pageNotes.set(setup.chapter.index, pages.flatMap((page) => page.continuityNotes));
  };

  const describePages = async (setup: ChapterSetup, markdown: string): Promise<ComposedPageRow[]> => {
    const pageCount = setup.endPage - setup.startPage + 1;
    const paginated = paginateChapterMarkdown(markdown, pageCount);
    const indexes = range(setup.startPage, setup.endPage);
    const pagesForDescription = indexes.map((index, offset) => ({ index, markdown: paginated.pages[offset] ?? "" }));
    const illustratedIndexes = indexes.filter((index) => strategy.shouldIllustratePage(input, plan, index));
    const described = await describeChapterPages({
      input,
      plan,
      chapter: setup.chapter,
      pages: pagesForDescription,
      illustratedIndexes,
      textModel
    });
    return described.map((page, offset) => ({ ...page, markdown: pagesForDescription[offset]!.markdown }));
  };

  // Without per-chapter readiness the whole expansion is waited for here, as it always was.
  if (!options.research?.readyFor) await options.research?.ready();
  gatheringProgress.muted = true;
  await reportChapter(22, "Writing chapters", "compose", todo[0]?.chapter.index);
  // A finish (edit, review, descriptions: 30–40 s) outlasted the next compose (20–28 s) and paced the
  // loop; the next compose reads only this chapter's draft tail and digest, so two finish at once.
  const finishing: Promise<void>[] = [];
  let bookSlack = 0;
  for (const [offset, setup] of todo.entries()) {
    const position = `${setup.chapter.index}/${setups.length}`;
    const progress = 22 + Math.round((offset / Math.max(todo.length, 1)) * 46);
    // This chapter's own material — its dossier and lead notes, its research — and nobody else's (H4).
    chapterDossiers.set(setup.chapter.index, await material.dossierFor(setup.chapter.index));
    await options.research?.readyFor?.(setup.chapter.index);
    // Material-first: the chapter's opening episode is told first by a call
    // whose only job is to narrate, then the chapter is composed to continue
    // from it. The scene is printed ahead of the draft, so the degeneracy
    // guard and the editor see the chapter as the reader will.
    const openingMaterial = materialFor(setup.chapter.index);
    const opening = openingMaterial ? openingEpisode(openingMaterial.episodes) : undefined;
    const previousOpenedOnScene = scenes.has(setup.chapter.index - 1);
    if (openingMaterial && opening && !(rotateOpenings && previousOpenedOnScene)) {
      await reportChapter(progress, `Telling the opening episode of chapter ${position}`, "scene", setup.chapter.index);
      const scene = await composeScene({
        input,
        plan,
        stance,
        chapter: setup.chapter,
        episode: opening,
        excerpts: openingMaterial.excerpts,
        evidencePackets: openingMaterial.evidencePackets,
        contract,
        textModel
      });
      if (scene) scenes.set(setup.chapter.index, scene);
    }
    await reportChapter(progress, `Writing chapter ${position}`, "compose", setup.chapter.index);
    const composeOptions = { ...(await composeOptionsFor(setup, drafts)), lengthSlack: Math.max(0, bookSlack) };
    const withScene = (draft: { markdown: string; words: number; attempts: number }) => {
      const scene = scenes.get(setup.chapter.index);
      if (!scene) return draft;
      const markdown = `${scene.text}\n\n${draft.markdown}`;
      return { ...draft, markdown, words: printedWordCount(markdown) };
    };
    // A length retry that failed kept the earlier draft (core `composeChapter`); the run log says so.
    const composeChapter = async (options: Parameters<typeof composeChapterText>[0]) => {
      const composed = await composeChapterText(options);
      if (composed.lengthRetryError) await runLog?.append("generation.composed_chapters.length_retry_failed", {
        projectId, chapterIndex: setup.chapter.index, keptWords: composed.words, error: composed.lengthRetryError });
      return composed;
    };
    let draft = withScene(await composeChapter(composeOptions));
    // A draft that is not prose — a verb-chain loop, a runaway, a script the
    // book is not in — is composed once more and, if it comes back the same,
    // fails the job rather than being edited, paginated and published
    // (composed-13-fast, chapter 5, shipped at 2.8/10). A word in another
    // script ("покрыیده", E1c) is composed once more too, and the cleaner
    // draft kept: it never fails the job (core `guardComposedDraft`).
    const budgetForGuard = chapterWordBudget(input, setup.endPage - setup.startPage + 1);
    const guard = (markdown: string) => chapterDegeneracy(markdown, { maxWords: budgetForGuard.max, language: input.language, brief: input.prompt });
    const guarded = await guardComposedDraft({
      draft,
      guard,
      chapterIndex: setup.chapter.index,
      recompose: async () => withScene(await composeChapter({ ...composeOptions, variant: "second" })),
      onRecompose: (verdict) => console.warn("Composed chapter degenerate; recomposing", {
        event: "generation.composed_chapters.degenerate_draft",
        projectId,
        chapterIndex: setup.chapter.index,
        reasons: verdict.reasons,
        scriptLeaks: describeScriptLeaks(verdict.scriptLeaks)
      })
    });
    draft = guarded.draft;
    if (guarded.verdict.scriptLeaks.length) await runLog?.append("generation.composed_chapters.script_leak", {
      projectId, chapterIndex: setup.chapter.index, leaks: guarded.verdict.scriptLeaks });
    const composition = compositionFor(setup);
    const planned = plannedFigures(composition);
    // The figure blocks the writer returned, checked against the plan: an
    // unreadable one is dropped, one beyond the planned count is dropped, a
    // kept one is re-serialised to its canonical line.
    draft = { ...draft, markdown: await validateComposedChapterFigures({
      planned: planned.length,
      ...(planned[0] ? { kind: planned[0].kind } : {}),
      projectId,
      chapterIndex: setup.chapter.index,
      ...(runLog ? { runLog } : {}),
      markdown: draft.markdown
    }) };
    drafts.set(setup.chapter.index, draft.markdown);
    ledger.record(setup.chapter.index, draft.markdown);
    // What this draft adds to the book's lead over its floor, with the surplus discounted for the editor's cuts.
    const over = draft.words - budgetForGuard.min;
    bookSlack += over > 0 ? over * SLACK_KEPT_SHARE : over;
    // Subjects only: the through-line reached the next chapter's writer through
    // this digest and was quoted there.
    provisionalDigests.set(setup.chapter.index, chapterDigest(composition.sections.map((section) => section.subject)));
    if (finishing.length >= FINISHES_IN_FLIGHT) await finishing.shift();
    const finish = finishChapter(setup, draft.markdown);
    // Awaited above or below; the branch only keeps a rejection that lands
    // while later chapters are composed from surfacing as unhandled first.
    finish.catch(() => undefined);
    finishing.push(finish);
  }
  const failed = (await Promise.allSettled(finishing)).find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  // The whole dossier is stored and its rows written before anything reads the book as a whole; a failed
  // expansion fails the book here, where it used to before the first chapter.
  const wholeDossier = await material.whole;
  if (wholeDossier) plan = { ...plan, dossier: wholeDossier };
  if (options.research?.readyFor) await options.research.ready();

  if (developmentalEditing) {
    await reportChapter(69, "Editing the manuscript's progression and overlapping sections", "read");
    await runComposedDevelopmentalEdit({
      projectId, planId, input, plan, textModel, setups, chapterIds, finalText, reports,
      compositionFor, composeOptionsFor, describePages, lineEdit: false, generationJobId
    });
  }

  const readCuts = quality.enabled("manuscriptReadCuts");
  if (!developmentalEditing && quality.enabled("manuscriptReadPass") && setups.length > 1) {
    await reportChapter(70, "Reading the whole manuscript", "read");
    // The read and the cuts it flags (`composedManuscriptRead.ts`): cut beside each other, staged in the read's order.
    const readContext = { projectId, input, plan, stance, arc, setups, chapterIds, textModel, generationJobId, runLog, cuts: readCuts,
      finalText, edges, digests, reports, compositionFor, composeOptionsFor, describePages, reportFor, notesForDraft };
    const read = await readManuscriptAndCut(readContext);
    // The shelved seams come after the cuts: the read's notes quote the pre-seam
    // paragraphs, so a closing replaced first would leave a cut nothing to
    // find, or take away the paragraph the seams had just bought.
    await rewriteSeamsAfterRead(readContext, read.bookNotes);
  }

  await finalizePendingPages({ projectId, planId, input, plan, providers, strategy, generationJobId, ...(runLog ? { runLog } : {}) });
  await inventoryStored;
  await advanceJobStep(generationJobId, "enqueue", 90, "Queueing export");
  await maybeEnqueueCompile(projectId, planId);
}

import { config } from "../runtime/config.js";
import {
  chapterDigest,
  chapterEdges,
  chapterWordBudget,
  composeChapter as composeChapterText,
  describeChapterPages,
  editChapter,
  formatStoryStateLines,
  judgeChapterDrafts,
  generateAuthorStance,
  measureProse,
  measurementNotes,
  paginateChapterMarkdown,
  paragraphShapeNotes,
  paragraphShapeReport,
  planAuthorStance,
  range,
  readManuscript,
  sampleSentenceLeaks,
  figureStandInMarkdown,
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
  type TextModelAdapter,
  type EditedChapterText,
  chapterDegeneracy,
  countReadableWords,
  applyBookArcPages,
  applySeam,
  architectBook,
  chapterSeams,
  cutChapter,
  citedChapters,
  planBookArc,
  rewriteSeams,
  type BookArc,
  mapWithConcurrency,
  seamsSupported,
  chapterEpigraph,
  withEpigraph,
  checkQuoteProvenance,
  composeScene,
  episodesForChapter,
  openingEpisode,
  stripMisattributedQuotes,
  type ChapterMaterial,
  type ComposedScene,
  chapterCaseEvidence, shouldGenerateCharacterReferences, sourceResearchFits, supportsBookDevelopment
} from "@book-maker/core";
import { persistBookArc, persistGeneratedAuthorStance, prepareComposedDevelopment } from "./composedPreparation.js";
import { prepareBookMaterial, persistDossierSupplement, recordDossierSources } from "./composedChaptersMaterial.js";
import { finalizePendingPages } from "./composedChaptersFinalize.js";
import { briefRequirementsForForms, storeBriefInventory, takeBriefInventory } from "./composedBriefInventory.js";
import { planComposedForms } from "./composedFormPlan.js";
import { runComposedDevelopmentalEdit } from "./composedDevelopmentalEdit.js";
import { validateComposedChapterFigures } from "./composedFigures.js";
import { repairComposedClaims } from "./composedClaimReview.js";
import { mergeSourceDossiers } from "./sourceDossier.js";
import { proseArithmeticChecker, repairChapterArithmetic } from "./composedArithmeticRepair.js";
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
  COMPOSE_CANDIDATES,
  SHAPE_NOTES_TO_EDITOR,
  MEASUREMENT_NOTES_TO_EDITOR,
  SECOND_CANDIDATE_TEMPERATURE_STEP,
  stageComposedChapter,
  storedPagesInRange,
  type ComposedPageRow,
  type ComposedChapterReport,
  BOOK_ARC,
  SEAMS_TOGETHER
} from "./composedChaptersState.js";
export { composedResumeState, derivedChapterBrief } from "./composedChaptersState.js";

/** Chapters finishing beside the one being composed: three model calls in flight at most. */
const FINISHES_IN_FLIGHT = 2;
/** A draft's surplus over its minimum, counted toward the book's lead after the line edit's cuts. */
const SLACK_KEPT_AFTER_EDIT = 0.7;

/**
 * The composed-chapters pass: author stance → chapter form plan → for each
 * chapter, compose as one piece of prose, line-edit, paginate, describe the
 * pages, checkpoint them as PENDING rows → one read of the whole manuscript
 * with a bounded second edit → finalize every PENDING page through the same
 * staged publication the other passes use.
 *
 * Three model calls are in flight at most: chapter N is composed while
 * chapters N-1 and N-2 are edited, paginated, described and checkpointed.
 * Chapter N reads the *draft* tail of N-1 (the edit keeps its opening and
 * closing substance), so the pipeline never waits on an edit.
 *
 * A chapter's pages are written in one transaction, so a worker restart finds
 * whole chapters or none of a chapter, and resumes at the first chapter with no
 * pages. The chapter form plan is re-planned for the remaining chapters against
 * the compositions the finished chapters stored beside their derived briefs.
 * See `.scratch/composed-chapters/spec.md`.
 */

export async function generateBookComposedChapters(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
  /** A judge from another model family; with one, every chapter is drafted twice and chosen. */
  judgeTextModel?: TextModelAdapter | undefined;
  /** The job's run log, for the events a rerun is measured from; the provider calls log through their own decorators. */
  runLog?: Pick<RunLogger, "append">;
  /**
   * The strategy's research expansion: started once the stance has said the
   * book is written from sources, run beside the material and the form plan
   * (its notes are read only when a chapter is composed), and waited for
   * before the first chapter.
   */
  research?: { start: () => void; ready: () => Promise<void> } | undefined;
}): Promise<void> {
  const { projectId, planId, input, providers, strategy, generationJobId, judgeTextModel, runLog } = options;
  let plan = options.plan;
  const textModel = providers.text;
  const searchSources = async (query: string) => (await providers.research.search({ query, projectId, purpose: "case-source-search" })).sources.flatMap((source) => source.url ? [{ title: source.title, url: source.url }] : []);
  const quality = await loadQualityContext(input);
  await advanceJobStep(generationJobId, "briefs", 12, "Deciding the author's stance", { phase: "stance" });
  const originalState = await loadComposedBookState(projectId);
  // It reads only the brief, so it runs beside the stance (`composedBriefInventory.ts`) — unless every page is already written.
  const briefInventory = originalState.pages.length > 0 && originalState.pages.every((page) => page.status !== "PENDING") ? Promise.resolve(undefined) : takeBriefInventory({ input, plan, textModel });
  // A method-shaped stance is refused only on a fresh run: a resumed one
  // composes from the stance its finished chapters were written to.
  let stance = planAuthorStance(plan);
  if (!stance) {
    stance = await generateAuthorStance({ input, plan, textModel });
    await persistGeneratedAuthorStance(planId, stance);
    // Every later mode read in this pass sees the stance's research answer (`inferWritingMode`).
    plan = { ...plan, authorStance: stance };
  }
  // Sources only for a book its author says is made from them (`STANCE_RESEARCH_RULE`): none for a novel.
  const sourced = sourceResearchFits(input, plan, stance);
  if (sourced) options.research?.start();
  await runLog?.append("generation.composed_chapters.source_research", { projectId, sourced, decidedBy: stance.research ? "stance" : "writing-mode" });
  plan = await prepareComposedDevelopment({ projectId, planId, input, plan, stance, textModel, quality, hasPages: originalState.pages.length > 0, generationJobId, searchSources, ...(runLog ? { runLog } : {}) });
  stance = planAuthorStance(plan) ?? stance;
  if (plan.bookDevelopment || plan.dossier?.evidencePackets?.length) await runLog?.append("generation.composed_chapters.development_prepared", { projectId, chapters: plan.chapters.length, casePackets: plan.dossier?.evidencePackets?.length ?? 0, excludedCases: plan.dossier?.excludedCases?.length ?? 0, replanned: Boolean(plan.bookDevelopment), reviewNotes: plan.bookDevelopment?.reviewNotes ?? [] });
  // The book's arc: planned once per book and stored on the plan together
  // with its page cut, so a resumed run re-cuts the same pages; without an arc
  // the pass runs as before. It comes before the chapter setups because the
  // Chapter rows, the form plan and the word budgets are all derived from the
  // cut — computed after them it reached only the prompts (developer review,
  // 2026-09-03).
  let arc = planBookArc(plan);
  let arcSource: "stored" | "model" | undefined = arc ? "stored" : undefined;
  if (!arc && BOOK_ARC) {
    await advanceJobStep(generationJobId, "briefs", 13, "Planning the book's arc", { phase: "arc" });
    const architected = await architectBook({ input, plan, stance, textModel });
    if (architected.arc) {
      arc = architected.arc;
      arcSource = "model";
    } else {
      console.warn("Book arc not produced; composing without one", {
        event: "generation.composed_chapters.arc_not_produced",
        projectId,
        reason: architected.failure
      });
    }
  }
  if (arc) {
    const cut = applyBookArcPages(plan, arc, input.targetPages);
    if (cut.applied) {
      plan = cut.plan;
      arc = cut.arc;
      if (cut.reason) {
        console.warn("Book arc page cut repaired", { event: "generation.composed_chapters.arc_pages_repaired", projectId, reason: cut.reason });
      }
    } else {
      console.warn("Book arc page cut not applied", { event: "generation.composed_chapters.arc_pages_not_applied", projectId, reason: cut.reason });
    }
    if (arcSource === "model") {
      await persistBookArc(planId, arc, cut.applied ? cut.plan.chapters : undefined);
    }
  }

  const setups = chapterSetupsForPlan(plan, input.targetPages);
  const stored = await loadComposedBookState(projectId);
  const developmentalEditing = !config.MOCK_AI && supportsBookDevelopment(input, plan) && quality.enabled("developmentalEdit") && stored.pages.every((page) => page.status === "PENDING");
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
      formsPlanned = briefInventory.then((inventory) => planComposedForms({ projectId, planId, input, plan, stance, arc, setups, fixed, episodes: planned, ...(setting ? { setting } : {}), quality, textModel, requirements: briefRequirementsForForms(inventory) }));
      // Awaited below; a stop that lands while the sources are still gathering is not an unhandled rejection.
      formsPlanned.catch(() => undefined);
    }
    return formsPlanned;
  };

  // The writer's contract and, material-first, the book's episodes and
  // dossier: planned once per book and stored on the plan like the arc
  // (`composedChaptersMaterial.ts`).
  const { contract, episodes, dossier } = await prepareBookMaterial({ projectId, planId, input, plan, stance, textModel, quality, generationJobId, searchSources,
    onEpisodes: (planned, setting) => void startForms(planned, setting), ...(runLog ? { runLog } : {}) });
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
      excerpts: dossier?.excerpts.filter((excerpt) => excerpt.chapterIndex === chapterIndex) ?? [],
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
    phase: "compose" | "scene" | "edit" | "read" | "finalize",
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
      loadResearchNotesForGeneration(projectId, strategy, setup.chapter),
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
  const editorEnabled = quality.enabled("chapterEditorPass");
  const drafts = new Map<number, string>();
  const bestOfVerdicts = new Map<number, { pick: number; agreed: boolean; reasons: string[] }>();
  const reports = new Map<number, ComposedChapterReport>();
  const reportFor = (setup: ChapterSetup, draftWords: number, editedWords: number, editorChanged: boolean, markdown: string): ComposedChapterReport => {
    const { wordBudget: budget } = measureComposedChapterLength(input, setup.endPage - setup.startPage + 1, markdown);
    return {
      formPlanSource: forms.source,
      formPlanIssues: forms.issues,
      draftWords,
      editedWords,
      editorChanged,
      readNotes: [],
      secondEditApplied: false,
      wordBudget: { min: budget.min, target: budget.target, max: budget.max },
      paragraphCv: 0,
      shapePassApplied: false,
      contract,
      ...(arcSource ? { arc: arcSource } : {})
    };
  };

  const proseArithmetic = proseArithmeticChecker({ input, plan, textModel, enabled: quality.enabled("proseArithmeticCheck") });
  const finishChapter = async (setup: ChapterSetup, draftMarkdown: string, position: string): Promise<void> => {
    const chapterId = chapterIds.get(setup.chapter.index);
    if (!chapterId) {
      throw new Error(`Chapter ${setup.chapter.index} has no row to write pages into.`);
    }
    // Figures aside: every pass below reads and rewrites prose. The editor
    // sees a stand-in line where each figure sits, the deterministic passes
    // see nothing, and the blocks go back before the cut into pages.
    const { prose: draftProse, fences } = stripFigureFences(draftMarkdown);
    let markdown = draftProse;
    let editorChanged = false;
    let shapePassApplied = false;
    if (editorEnabled) {
      await reportChapter(22 + Math.round((doneChapters.size / Math.max(chapterTotal, 1)) * 46), `Editing chapter ${position}`, "edit", setup.chapter.index);
      // One edit with everything measured on the draft: the second composed
      // book ran a cutting edit and then a reshaping edit that re-expanded
      // it, and the paragraphs came out the same size either way.
      const shapeNotes = SHAPE_NOTES_TO_EDITOR ? paragraphShapeNotes(draftProse) : [];
      const edited = await editChapter({
        ...(await composeOptionsFor(setup, drafts)),
        markdown: draftProse,
        measurementNotes: MEASUREMENT_NOTES_TO_EDITOR ? [...notesForDraft(draftProse), ...shapeNotes] : []
      });
      markdown = edited.markdown;
      editorChanged = edited.changed;
      shapePassApplied = shapeNotes.length > 0;
    }
    // Editorial judgments belong to the contextual editor. Pattern matches do
    // not authorize rewriting claims, deleting qualifications or joining paragraphs.
    // The prose-evidence review: two targeted repairs, then whatever stands is recorded on the
    // chapter and flagged at compile time (composedEvidenceResiduals.ts), never a failed book.
    const maxWords = Math.ceil(proseWordCount(markdown) * 1.1);
    const verified = await repairComposedClaims({ projectId, input, plan, chapter: setup.chapter, markdown, textModel, searchSources, runLog,
      edit: async (text, correction) => (await editChapter({ ...(await composeOptionsFor(setup, drafts)), markdown: text, allowExtension: false, degeneracyMaxWords: maxWords, readerNotes: [...correction.instructions], factualCorrection: correction })).markdown,
      degenerate: (text) => chapterDegeneracy(text, { maxWords, language: input.language }).degenerate,
      persistSources: async (supplement) => {
        await persistDossierSupplement(planId, supplement);
        await recordDossierSources(projectId, supplement);
        if (dossier) Object.assign(dossier, mergeSourceDossiers(dossier, supplement));
      }
    });
    const repair = verified.repair;
    const evidence = repair ? { findings: repair.findings, repairs: repair.repairs, unresolved: repair.unresolved, dropped: repair.dropped } : undefined;
    if (repair) markdown = repair.markdown;
    // The arithmetic check: every fully numeric statement in the chapter's math is redone, and a
    // wrong one goes back to the editor as a factual correction whose evidence is the computation.
    const arithmeticMaxWords = Math.ceil(proseWordCount(markdown) * 1.1);
    const arithmetic = await repairChapterArithmetic({
      markdown,
      edit: async (text, correction) => (await editChapter({ ...(await composeOptionsFor(setup, drafts)), markdown: text, allowExtension: false, degeneracyMaxWords: arithmeticMaxWords, readerNotes: correction.instructions, factualCorrection: { ...correction, evidence: [] } })).markdown,
      degenerate: (text) => chapterDegeneracy(text, { maxWords: arithmeticMaxWords, language: input.language }).degenerate,
      ...(proseArithmetic ? { proseFindings: proseArithmetic } : {})
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
    const bestOf = bestOfVerdicts.get(setup.chapter.index);
    const scene = scenes.get(setup.chapter.index);
    const facts = await ledger.of(setup.chapter.index);
    const report: ComposedChapterReport = {
      ...reportFor(setup, proseWordCount(draftMarkdown), proseWordCount(markdown), editorChanged, markdown),
      paragraphCv: paragraphShapeReport(markdown).cv,
      shapePassApplied,
      ...(bestOf ? { bestOf } : {}),
      ...(scene ? { scene: { words: scene.words, episodeTitle: scene.episodeTitle } } : {}),
      ...(material
        ? {
            dossier: {
              episodes: material.episodes.length,
              documents: dossier?.documents.filter((document) => document.chapterIndex === setup.chapter.index).length ?? 0,
              excerpts: material.excerpts.length
            }
          }
        : {}),
      ...(quotes ? { quotes } : {}),
      ...(epigraph ? { epigraph } : {}),
      ...(evidence ? { evidence } : {}),
      ...(verified.sourceClaims ? { sourceClaims: verified.sourceClaims } : {}),
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

  await options.research?.ready();
  await reportChapter(22, "Writing chapters", "compose", todo[0]?.chapter.index);
  // A finish (edit, review, descriptions: 30–40 s) outlasted the next compose (20–28 s) and paced the
  // loop; the next compose reads only this chapter's draft tail and digest, so two finish at once.
  const finishing: Promise<void>[] = [];
  let bookSlack = 0;
  for (const [offset, setup] of todo.entries()) {
    const position = `${setup.chapter.index}/${setups.length}`;
    const progress = 22 + Math.round((offset / Math.max(todo.length, 1)) * 46);
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
    const candidates = judgeTextModel && COMPOSE_CANDIDATES > 1
      ? await Promise.all([
          composeChapter(composeOptions),
          composeChapter({
            ...composeOptions,
            variant: "second",
            temperature: Math.min(1, input.temperature + SECOND_CANDIDATE_TEMPERATURE_STEP)
          })
        ])
      : [withScene(await composeChapter(composeOptions))];
    let draft = candidates[0]!;
    // A draft that is not prose — a verb-chain loop, a runaway, a script the
    // book is not in — is composed once more and, if it comes back the same,
    // fails the job rather than being edited, paginated and published
    // (composed-13-fast, chapter 5, shipped at 2.8/10).
    const budgetForGuard = chapterWordBudget(input, setup.endPage - setup.startPage + 1);
    const guard = (markdown: string) => chapterDegeneracy(markdown, { maxWords: budgetForGuard.max, language: input.language });
    let degeneracy = guard(draft.markdown);
    if (degeneracy.degenerate) {
      console.warn("Composed chapter degenerate; recomposing", {
        event: "generation.composed_chapters.degenerate_draft",
        projectId,
        chapterIndex: setup.chapter.index,
        reasons: degeneracy.reasons
      });
      draft = withScene(await composeChapter({ ...composeOptions, variant: "second" }));
      degeneracy = guard(draft.markdown);
      if (degeneracy.degenerate) {
        throw new Error(
          `Chapter ${setup.chapter.index} came back degenerate twice (${degeneracy.reasons.join("; ")}); the book is not published with it.`
        );
      }
    }
    const composition = compositionFor(setup);
    const planned = plannedFigures(composition);
    // The figure blocks the writer returned, checked against the plan: an
    // unreadable one is dropped, one beyond the planned count is dropped, a
    // kept one is re-serialised to its canonical line. The same check on
    // every compose candidate, so best-of never scores raw fences: judging
    // is prose rhythm, so it sees the stand-in, not the JSON, and only after
    // those drops.
    const figureOptions = {
      planned: planned.length,
      ...(planned[0] ? { kind: planned[0].kind } : {}),
      projectId,
      chapterIndex: setup.chapter.index,
      ...(runLog ? { runLog } : {})
    };
    const markdowns =
      judgeTextModel && candidates.length === 2
        ? candidates.map((candidate) => candidate.markdown)
        : [draft.markdown];
    const validated = await Promise.all(
      markdowns.map((markdown) => validateComposedChapterFigures({ ...figureOptions, markdown }))
    );
    if (judgeTextModel && candidates.length === 2) {
      const verdict = await judgeChapterDrafts({
        input,
        plan,
        chapter: setup.chapter,
        drafts: validated.map(figureStandInMarkdown),
        decisions: providers.decisions,
        judge: judgeTextModel
      });
      draft = { ...(candidates[verdict.pick] ?? draft), markdown: validated[verdict.pick] ?? validated[0]! };
      bestOfVerdicts.set(setup.chapter.index, verdict);
    } else {
      draft = { ...draft, markdown: validated[0]! };
    }
    drafts.set(setup.chapter.index, draft.markdown);
    ledger.record(setup.chapter.index, draft.markdown);
    // What this draft adds to the book's lead over its floor, with the surplus discounted for the editor's cuts.
    const over = draft.words - budgetForGuard.min;
    bookSlack += over > 0 ? over * SLACK_KEPT_AFTER_EDIT : over;
    // Subjects only: the through-line reached the next chapter's writer through
    // this digest and was quoted there.
    provisionalDigests.set(setup.chapter.index, chapterDigest(composition.sections.map((section) => section.subject)));
    if (finishing.length >= FINISHES_IN_FLIGHT) await finishing.shift();
    const finish = finishChapter(setup, draft.markdown, position);
    // Awaited above or below; the branch only keeps a rejection that lands
    // while later chapters are composed from surfacing as unhandled first.
    finish.catch(() => undefined);
    finishing.push(finish);
  }
  const failed = (await Promise.allSettled(finishing)).find((result) => result.status === "rejected");
  if (failed) throw failed.reason;

  if (developmentalEditing) {
    await reportChapter(69, "Editing the manuscript's progression and overlapping sections", "read");
    await runComposedDevelopmentalEdit({
      projectId, planId, input, plan, textModel, setups, chapterIds, finalText, reports,
      compositionFor, composeOptionsFor, describePages, lineEdit: editorEnabled, generationJobId
    });
  }

  const readCuts = quality.enabled("manuscriptReadCuts");
  if (!developmentalEditing && quality.enabled("manuscriptReadPass") && setups.length > 1) {
    await reportChapter(70, "Reading the whole manuscript", "read");
    // Every chapter's first and last paragraph rewritten in one call, so the
    // seams differ from each other; a paragraph the deterministic check refuses
    // keeps the original. Changed chapters are re-described and re-staged.
    const rewriteSeamsTogether = async (bookArc: BookArc, bookNotes: string[]) => {
      const seamChapters = setups
        .filter((setup) => finalText.has(setup.chapter.index))
        .map((setup) => {
          const kind = bookArc.chapters.find((entry) => entry.index === setup.chapter.index)?.kind;
          return { index: setup.chapter.index, title: setup.chapter.title, ...(kind ? { kind } : {}), ...chapterSeams(figureStandInMarkdown(finalText.get(setup.chapter.index)!)) };
        });
      await updateJobProgress(generationJobId, { progress: 69, message: "Rewriting the chapter openings and closings together" });
      const seams = await rewriteSeams({ input, plan, arc: bookArc, chapters: seamChapters, bookNotes, textModel });
      if (seams.skipped) {
        console.warn("Seams skipped", { event: "generation.composed_chapters.seams_skipped", projectId, reason: seams.skipped });
        return;
      }
      console.warn("Seams rewritten", { event: "generation.composed_chapters.seams", projectId, accepted: seams.accepted, rejected: seams.rejected });
      // The re-describes are independent, so they run three at a time; the
      // staging after them is sequential because it writes page rows.
      const described = await mapWithConcurrency(seams.replacements, 3, async (replacement) => {
        const setup = setups.find((candidate) => candidate.chapter.index === replacement.index);
        const chapterId = setup ? chapterIds.get(setup.chapter.index) : undefined;
        const current = setup ? finalText.get(setup.chapter.index) : undefined;
        if (!setup || !chapterId || !current) return undefined;
        const { prose: currentProse, fences: currentFences } = stripFigureFences(current);
        const seamedProse = applySeam(currentProse, replacement);
        if (seamedProse === currentProse) return undefined;
        const seamed = reinsertFigureFences(seamedProse, currentFences);
        return { setup, chapterId, current, seamed, pages: await describePages(setup, seamed) };
      });
      for (const entry of described) {
        if (!entry) continue;
        const { setup, chapterId, current, seamed, pages } = entry;
        const previous = reports.get(setup.chapter.index) ?? reportFor(setup, proseWordCount(current), proseWordCount(seamed), false, seamed);
        const report: ComposedChapterReport = { ...previous, seamsApplied: true };
        reports.set(setup.chapter.index, report);
        await stageComposedChapter({ projectId, chapterId, setup, composition: compositionFor(setup), pages, report, replace: true });
        finalText.set(setup.chapter.index, seamed);
        edges.set(setup.chapter.index, chapterEdges(seamed));
        digests.set(setup.chapter.index, chapterDigest(pages.map((page) => page.summary)));
      }
    };
    const chaptersForRead = setups.map((setup) => {
      const markdown = finalText.get(setup.chapter.index) ?? "";
      return {
        index: setup.chapter.index,
        title: setup.chapter.title,
        markdown,
        expectedClaim: compositionFor(setup).landing,
        measurements: notesForDraft(markdown)
      };
    });
    const cutSurroundingChapters = (setup: ChapterSetup, notes: readonly string[]) => {
      const chapters = setups.flatMap((other) => {
        const text = finalText.get(other.chapter.index);
        return text ? [{ index: other.chapter.index, title: other.chapter.title, markdown: figureStandInMarkdown(text) }] : [];
      });
      const cited = citedChapters(notes, chapters, { language: input.language, except: setup.chapter.index });
      const surrounding = chapters.filter((other) => other.index !== setup.chapter.index && (cited === undefined || cited.includes(other.index)));
      console.warn("Cut acceptance context", {
        event: "generation.composed_chapters.cut_context",
        projectId,
        chapterIndex: setup.chapter.index,
        cited: cited ?? "unrecognised",
        surroundingChapters: surrounding.map((other) => other.index),
        surroundingBytes: surrounding.reduce((sum, other) => sum + Buffer.byteLength(other.markdown, "utf8"), 0)
      });
      return surrounding;
    };
    const read = await readManuscript({ input, plan, stance, ...(arc ? { arc } : {}), chapters: chaptersForRead, textModel });
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
    // With the cuts off, every chapter that drew notes still goes through the
    // loop below, whose unchanged-edit branch re-stages the brief with the
    // notes on its report; only the cut call is skipped.
    const flagged = read.chapters.filter((entry) => (readCuts ? entry.edit : entry.notes.length > 0));
    for (const [offset, entry] of flagged.entries()) {
      const setup = setups.find((candidate) => candidate.chapter.index === entry.chapterIndex);
      const chapterId = setup ? chapterIds.get(setup.chapter.index) : undefined;
      const current = setup ? finalText.get(setup.chapter.index) : undefined;
      if (!setup || !chapterId || !current) continue;
      const pendingRows = await prisma.page.count({
        where: { projectId, status: "PENDING", index: { gte: setup.startPage, lte: setup.endPage } }
      });
      if (pendingRows !== setup.endPage - setup.startPage + 1) continue;
      await updateJobProgress(generationJobId, {
        progress: 70 + Math.round(((offset + 1) / flagged.length) * 5),
        message: readCuts
          ? `Cutting chapter ${setup.chapter.index}/${setups.length} from the manuscript read`
          : `Recording the manuscript read's notes on chapter ${setup.chapter.index}/${setups.length}`
      });
      // Deletion only: the read names the sentences, the cut removes them, and
      // `deletionOnlyResult` refuses anything the model wrote.
      const { prose: currentProse, fences: currentFences } = stripFigureFences(current);
      // The cut may spend only the room the chapter has over its page floor.
      const cutBudget = chapterWordBudget(input, setup.endPage - setup.startPage + 1);
      // The acceptance reviewer judges a cut against the retained passage the note names, so it
      // is shown the chapters the notes cite and not the rest of the book: run 3 of the 100-page
      // Balanced evaluation sent all fourteen other chapters (270–288 KB) to each of eight cut
      // reviews, and every retained passage the reviewer cited lay in the chapter being cut or in
      // the one the note named. Notes that cite nothing recognisable keep the whole book in view.
      const surroundingChapters = readCuts ? cutSurroundingChapters(setup, entry.notes) : [];
      const edited: EditedChapterText = readCuts
        ? await cutChapter({
            ...(await composeOptionsFor(setup, new Map())),
            markdown: currentProse,
            notes: entry.notes,
            surroundingChapters,
            bookNotes: read.bookNotes,
            maxRemovableWords: Math.max(0, countReadableWords(currentProse) - cutBudget.min)
          })
        : { markdown: current, words: proseWordCount(current), attempts: 0, changed: false };
      const previous = reports.get(setup.chapter.index) ??
        reportFor(setup, proseWordCount(current), proseWordCount(current), false, current);
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
        // The notes are still worth keeping beside the chapter: the console
        // shows what the read said even when the edit changed nothing.
        const storedPages = storedPagesInRange((await loadComposedBookState(projectId)).pages, setup);
        await stageComposedChapter({
          projectId,
          chapterId,
          setup,
          composition: compositionFor(setup),
          pages: storedPages.map((page) => ({
            index: page.index,
            title: page.title,
            summary: page.summary,
            continuityNotes: stored.chapters.find((chapter) => chapter.index === setup.chapter.index)?.pageNotes.get(page.index) ?? [],
            ...(page.imagePrompt ? { imagePrompt: page.imagePrompt } : {}),
            markdown: page.markdown
          })),
          report,
          replace: true
        });
        continue;
      }
      await stageComposedChapter({ projectId, chapterId, setup, composition: compositionFor(setup), pages, report, replace: true });
      finalText.set(setup.chapter.index, reshaped!);
      edges.set(setup.chapter.index, chapterEdges(reshaped!));
      digests.set(setup.chapter.index, chapterDigest(pages.map((page) => page.summary)));
    }
    // The seams come after the cuts: the read's notes quote the pre-seam
    // paragraphs, so a closing replaced first would leave a cut nothing to
    // find, or take away the paragraph the seams had just bought.
    if (SEAMS_TOGETHER && arc && seamsSupported(input.language)) {
      await rewriteSeamsTogether(arc, read.bookNotes);
    }
  }

  await finalizePendingPages({ projectId, planId, input, plan, providers, strategy, generationJobId, ...(runLog ? { runLog } : {}) });
  await inventoryStored;
  await advanceJobStep(generationJobId, "enqueue", 90, "Queueing export");
  await maybeEnqueueCompile(projectId, planId);
}

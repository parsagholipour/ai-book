import { config } from "../runtime/config.js";
import {
  PREVIOUS_CHAPTER_TAIL_WORDS,
  chapterDigest,
  chapterEdges,
  chapterTail,
  chapterWordBudget,
  composeChapter,
  describeChapterPages,
  dropDuplicateSentences,
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
  planChapterForms,
  range,
  readManuscript,
  sampleSentenceLeaks,
  varyParagraphs,
  figureStandInMarkdown,
  plannedFigures,
  proseWordCount,
  reinsertFigureFences,
  stripFigureFences,
  usesFigures,
  type BookGenerationStrategy,
  type BookPlan,
  type ChapterComposition,
  type CreateProjectInput,
  type EarlierChapterDigest,
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
  rewriteCouplets,
  stripMisattributedQuotes,
  type ChapterMaterial,
  type ComposedScene,
  chapterCaseEvidence, supportsBookDevelopment, reviewChapterCaseEvidence
} from "@book-maker/core";
import { persistBookArc, persistGeneratedAuthorStance, prepareComposedDevelopment } from "./composedPreparation.js";
import { prepareBookMaterial } from "./composedChaptersMaterial.js";
import { finalizePendingPages } from "./composedChaptersFinalize.js";
import { runComposedDevelopmentalEdit } from "./composedDevelopmentalEdit.js";
import { validateComposedChapterFigures } from "./composedFigures.js";
import { repairChapterEvidence } from "./composedEvidenceRepair.js";
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

/**
 * The composed-chapters pass: author stance → chapter form plan → for each
 * chapter, compose as one piece of prose, line-edit, paginate, describe the
 * pages, checkpoint them as PENDING rows → one read of the whole manuscript
 * with a bounded second edit → finalize every PENDING page through the same
 * staged publication the other passes use.
 *
 * Two model calls are in flight at most: chapter N is composed while chapter
 * N-1 is edited, paginated, described and checkpointed. Chapter N reads the
 * *draft* tail of N-1 (the edit keeps its opening and closing substance), so
 * the pipeline never waits on an edit.
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
}): Promise<void> {
  const { projectId, planId, input, providers, strategy, generationJobId, judgeTextModel, runLog } = options;
  let plan = options.plan;
  const textModel = providers.text;
  const quality = await loadQualityContext(input);
  await advanceJobStep(generationJobId, "briefs", 12, "Deciding the author's stance");
  const originalState = await loadComposedBookState(projectId);
  // A method-shaped stance is refused only on a fresh run: a resumed one
  // composes from the stance its finished chapters were written to.
  let stance = planAuthorStance(plan, { rejectMethodShaped: originalState.pages.length === 0 });
  if (!stance) {
    stance = await generateAuthorStance({ input, plan, textModel });
    await persistGeneratedAuthorStance(planId, stance);
  }
  plan = await prepareComposedDevelopment({ projectId, planId, input, plan, stance, textModel, quality, hasPages: originalState.pages.length > 0, generationJobId,
    searchSources: async (query) => (await providers.research.search({ query, projectId, purpose: "case-source-search" })).sources.flatMap((source) => source.url ? [{ title: source.title, url: source.url }] : [])
  });
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
    await updateJobProgress(generationJobId, { progress: 13, message: "Planning the book's arc" });
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

  // The writer's contract and, material-first, the book's episodes and
  // dossier: planned once per book and stored on the plan like the arc
  // (`composedChaptersMaterial.ts`).
  const { contract, episodes, dossier } = plan.dossier?.evidencePackets
    ? { contract: "grounded" as const, episodes: plan.episodes, dossier: plan.dossier }
    : await prepareBookMaterial({ projectId, planId, input, plan, stance, textModel, quality, generationJobId });
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

  let chapterIds: Map<number, string>;
  const doneChapters = new Set<number>();
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
    await advanceJobStep(generationJobId, "setup", 20, `Resuming with ${doneChapters.size} finished chapters`);
  }

  await ensureCharacterReferenceAssets({ projectId, planId, input, plan, providers, strategy, generationJobId });
  await maybeEnqueueCover(projectId, planId, input);

  await updateJobProgress(generationJobId, { progress: 16, message: "Planning the shape of every chapter" });
  const fixed = stored.chapters
    .filter((chapter) => doneChapters.has(chapter.index) && chapter.composition)
    .map((chapter) => chapter.composition!);
  // Figures: eligible books with the gate on. The planner sees the rule and
  // the key only then, the writer sees the syntax only in a chapter the plan
  // gave a figure, and every later pass sees prose (`composedFigures.ts`).
  const figures = usesFigures(input, plan) && quality.enabled("figures");
  const forms = await planChapterForms({
    input,
    plan,
    // Under an arc the form planner sees the question and never the answer:
    // its subjects and notes reach the writer.
    stance: arc ? { ...stance, thesis: arc.question, positions: [] } : stance,
    ranges: setups.map((setup) => {
      const arcChapter = arc?.chapters.find((entry) => entry.index === setup.chapter.index);
      return {
        chapter: setup.chapter,
        startPage: setup.startPage,
        endPage: setup.endPage,
        ...(arcChapter ? { kind: arcChapter.kind } : {}),
        ...(arcChapter?.job.does ? { job: arcChapter.job.does } : {})
      };
    }),
    fixed,
    figures,
    // The cases already selected for every chapter, so the planner builds on them rather than choosing a second set.
    episodes,
    textModel
  });
  if (forms.issues.length > 0) {
    console.warn("Chapter form plan kept variety issues", {
      event: "generation.composed_chapters.form_plan_issues",
      projectId,
      source: forms.source,
      issues: forms.issues
    });
  }
  const compositionFor = (setup: ChapterSetup): ChapterComposition =>
    forms.compositions.find((composition) => composition.chapterIndex === setup.chapter.index)!;

  // Memory of the book so far, in chapter order: final text, digest and the
  // facts each chapter's pages established. Finished chapters are read back
  // from their rows; chapters written this run fill in as they finish.
  const finalText = new Map<number, string>();
  const digests = new Map<number, string>();
  const provisionalDigests = new Map<number, string>();
  const establishedNotes: string[] = [];
  for (const setup of setups) {
    if (!doneChapters.has(setup.chapter.index)) continue;
    const pages = storedPagesInRange(stored.pages, setup);
    finalText.set(setup.chapter.index, pages.map((page) => page.markdown).join("\n\n"));
    digests.set(setup.chapter.index, chapterDigest(pages.map((page) => page.summary)));
    const storedChapter = stored.chapters.find((chapter) => chapter.index === setup.chapter.index);
    for (const notes of storedChapter?.pageNotes.values() ?? []) establishedNotes.push(...notes);
  }
  // The first and last sentence of every finished chapter, in order: the
  // moves the next chapter may not repeat. Stored chapters contribute theirs
  // from their rows; chapters written this run add theirs as they finish.
  const edges = new Map<number, { opening: string; closing: string }>();
  for (const [index, text] of finalText) edges.set(index, chapterEdges(text));
  const earlierEdgesFor = (setup: ChapterSetup) => {
    const earlier = setups.filter((candidate) => candidate.chapter.index < setup.chapter.index);
    return {
      earlierOpenings: earlier.map((candidate) => edges.get(candidate.chapter.index)?.opening ?? "").filter(Boolean),
      earlierClosings: earlier.map((candidate) => edges.get(candidate.chapter.index)?.closing ?? "").filter(Boolean)
    };
  };
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
  const earlierChaptersFor = (setup: ChapterSetup): EarlierChapterDigest[] =>
    setups
      .filter((candidate) => candidate.chapter.index < setup.chapter.index)
      .map((candidate) => {
        const digest =
          digests.get(candidate.chapter.index) ?? provisionalDigests.get(candidate.chapter.index) ?? candidate.chapter.summary;
        const told = [...new Set(compositionFor(candidate).sections.flatMap((section) => section.owns ?? []))];
        return {
          index: candidate.chapter.index,
          title: candidate.chapter.title,
          // Sixty words: 11k characters of digests rode in every call before.
          digest: digest.split(/\s+/).slice(0, 60).join(" "),
          ...(told.length > 0 ? { told } : {})
        };
      });
  const previousTailFor = (setup: ChapterSetup, drafts: Map<number, string>): string | undefined => {
    const previous = setups.filter((candidate) => candidate.chapter.index < setup.chapter.index).at(-1);
    if (!previous) return undefined;
    const text = drafts.get(previous.chapter.index) ?? finalText.get(previous.chapter.index);
    return text ? chapterTail(text, PREVIOUS_CHAPTER_TAIL_WORDS) : undefined;
  };
  const composeOptionsFor = async (setup: ChapterSetup, drafts: Map<number, string>) => {
    const [storedNotes, researchNotes, storyState] = await Promise.all([
      loadContinuityNotes(projectId, { beforePageIndex: null }),
      loadResearchNotesForGeneration(projectId, strategy, setup.chapter),
      loadProjectStoryState(projectId, plan.promises ?? [])
    ]);
    const previousChapterTail = previousTailFor(setup, drafts);
    return {
      input,
      plan,
      stance,
      ...(arc ? { arc } : {}),
      chapter: setup.chapter,
      composition: compositionFor(setup),
      chapterPageStart: setup.startPage,
      chapterPageEnd: setup.endPage,
      ...(previousChapterTail ? { previousChapterTail } : {}),
      earlierChapters: earlierChaptersFor(setup),
      ...earlierEdgesFor(setup),
      continuityNotes: [...storedNotes, ...establishedNotes],
      researchNotes,
      storyStateLines: formatStoryStateLines(storyState),
      textModel,
      contract,
      ...(materialFor(setup.chapter.index) ? { material: materialFor(setup.chapter.index) } : {})
    };
  };

  const todo = setups.filter((setup) => !doneChapters.has(setup.chapter.index));
  const editorEnabled = quality.enabled("chapterEditorPass");
  const drafts = new Map<number, string>();
  const bestOfVerdicts = new Map<number, { pick: number; agreed: boolean; reasons: string[] }>();
  const reports = new Map<number, ComposedChapterReport>();
  const reportFor = (setup: ChapterSetup, draftWords: number, editedWords: number, editorChanged: boolean): ComposedChapterReport => {
    const budget = chapterWordBudget(input, setup.endPage - setup.startPage + 1);
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
      await updateJobProgress(generationJobId, { message: `Editing chapter ${position}` });
      // One edit with everything measured on the draft: the second composed
      // book ran a cutting edit and then a reshaping edit that re-expanded
      // it, and the paragraphs came out the same size either way.
      const shapeNotes = SHAPE_NOTES_TO_EDITOR ? paragraphShapeNotes(draftProse) : [];
      const edited = await editChapter({
        ...(await composeOptionsFor(setup, drafts)),
        markdown: draftProse,
        measurementNotes: MEASUREMENT_NOTES_TO_EDITOR ? [...notesForDraft(draftProse), ...shapeNotes] : []
      });
      const editedDegeneracy = chapterDegeneracy(edited.markdown, {
        maxWords: chapterWordBudget(input, setup.endPage - setup.startPage + 1).max,
        language: input.language
      });
      if (editedDegeneracy.degenerate) {
        console.warn("Edited chapter degenerate; keeping the draft", {
          event: "generation.composed_chapters.degenerate_edit",
          projectId,
          chapterIndex: setup.chapter.index,
          reasons: editedDegeneracy.reasons
        });
      } else {
        markdown = edited.markdown;
        editorChanged = edited.changed;
      }
      shapePassApplied = shapeNotes.length > 0;
    }
    // The couplet rewrite: the pairs the detector finds, sent alone to the
    // editor lane, accepted only when the pattern is gone (coupletRewrite.ts).
    let couplets: ComposedChapterReport["couplets"];
    if (quality.enabled("coupletRewrite")) {
      await updateJobProgress(generationJobId, { message: `Breaking the couplets of chapter ${position}` });
      try {
        const rewritten = await rewriteCouplets({ input, plan, chapter: setup.chapter, markdown, textModel });
        couplets = { found: rewritten.found, rewritten: rewritten.rewritten };
        if (rewritten.changed) markdown = rewritten.markdown;
      } catch (error) {
        if (error instanceof Error && /stop|abort/i.test(error.name + error.message)) throw error;
        console.warn("Couplet rewrite skipped", {
          event: "generation.composed_chapters.couplet_rewrite_failed",
          projectId,
          chapterIndex: setup.chapter.index,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    // Paragraph variety by merge, since no instruction produced it, and one
    // copy of any sentence the edits wrote twice.
    markdown = dropDuplicateSentences(varyParagraphs(markdown));
    // The prose-evidence review: two targeted repairs, then whatever stands is recorded on the
    // chapter and flagged at compile time (composedEvidenceResiduals.ts), never a failed book.
    const evidencePackets = chapterCaseEvidence(plan, setup.chapter.index);
    let evidence: ComposedChapterReport["evidence"];
    if (evidencePackets.length) {
      const maxWords = Math.ceil(proseWordCount(markdown) * 1.1);
      const repair = await repairChapterEvidence({
        markdown,
        review: (text) => reviewChapterCaseEvidence({ markdown: text, packets: evidencePackets, textModel }),
        edit: async (text, notes) => (await editChapter({ ...(await composeOptionsFor(setup, drafts)), markdown: text, allowExtension: false, readerNotes: notes })).markdown,
        degenerate: (text) => chapterDegeneracy(text, { maxWords, language: input.language }).degenerate
      });
      markdown = repair.markdown;
      evidence = { findings: repair.findings, repairs: repair.repairs, unresolved: repair.unresolved, dropped: repair.dropped };
      if (repair.unresolved.length || repair.dropped) {
        console.warn("Chapter evidence findings remain after repair", { event: "generation.composed_chapters.evidence_unresolved", projectId, chapterIndex: setup.chapter.index, ...evidence });
        await runLog?.append("generation.composed_chapters.evidence_unresolved", { projectId, chapterIndex: setup.chapter.index, ...evidence });
      }
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
      const block = chapterEpigraph(material.excerpts);
      if (block) {
        markdown = withEpigraph(markdown, block);
        epigraph = true;
      }
    }
    markdown = reinsertFigureFences(markdown, fences);
    const pages = await describePages(setup, markdown);
    const bestOf = bestOfVerdicts.get(setup.chapter.index);
    const scene = scenes.get(setup.chapter.index);
    const report: ComposedChapterReport = {
      ...reportFor(setup, proseWordCount(draftMarkdown), proseWordCount(markdown), editorChanged),
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
      ...(couplets ? { couplets } : {}),
      ...(epigraph ? { epigraph } : {}),
      ...(evidence ? { evidence } : {})
    };
    reports.set(setup.chapter.index, report);
    await stageComposedChapter({ projectId, chapterId, setup, composition: compositionFor(setup), pages, report, replace: false });
    finalText.set(setup.chapter.index, markdown);
    edges.set(setup.chapter.index, chapterEdges(markdown));
    digests.set(setup.chapter.index, chapterDigest(pages.map((page) => page.summary)));
    for (const page of pages) establishedNotes.push(...page.continuityNotes);
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

  await advanceJobStep(generationJobId, "setup", 22, "Writing chapters");
  let pendingFinish: Promise<void> | undefined;
  for (const [offset, setup] of todo.entries()) {
    const position = `${setup.chapter.index}/${setups.length}`;
    await updateJobProgress(generationJobId, {
      progress: 22 + Math.round((offset / Math.max(todo.length, 1)) * 46),
      message: `Writing chapter ${position}`
    });
    // Material-first: the chapter's opening episode is told first by a call
    // whose only job is to narrate, then the chapter is composed to continue
    // from it. The scene is printed ahead of the draft, so the degeneracy
    // guard and the editor see the chapter as the reader will.
    const openingMaterial = materialFor(setup.chapter.index);
    const opening = openingMaterial ? openingEpisode(openingMaterial.episodes) : undefined;
    const previousOpenedOnScene = scenes.has(setup.chapter.index - 1);
    if (openingMaterial && opening && !(rotateOpenings && previousOpenedOnScene)) {
      await updateJobProgress(generationJobId, { message: `Telling the opening episode of chapter ${position}` });
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
    const composeOptions = await composeOptionsFor(setup, drafts);
    const withScene = (draft: { markdown: string; words: number; attempts: number }) => {
      const scene = scenes.get(setup.chapter.index);
      if (!scene) return draft;
      const markdown = `${scene.text}\n\n${draft.markdown}`;
      return { ...draft, markdown, words: proseWordCount(markdown) };
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
        judge: judgeTextModel
      });
      draft = { ...(candidates[verdict.pick] ?? draft), markdown: validated[verdict.pick] ?? validated[0]! };
      bestOfVerdicts.set(setup.chapter.index, verdict);
    } else {
      draft = { ...draft, markdown: validated[0]! };
    }
    drafts.set(setup.chapter.index, draft.markdown);
    // Subjects only: the through-line reached the next chapter's writer through
    // this digest and was quoted there.
    provisionalDigests.set(setup.chapter.index, chapterDigest(composition.sections.map((section) => section.subject)));
    if (pendingFinish) {
      await pendingFinish;
    }
    const finish = finishChapter(setup, draft.markdown, position);
    // Awaited on the next iteration or below; the branch only keeps a rejection
    // that lands while the next chapter is being composed from surfacing as
    // unhandled before it is awaited.
    finish.catch(() => undefined);
    pendingFinish = finish;
  }
  if (pendingFinish) {
    await pendingFinish;
  }

  if (developmentalEditing) {
    await runComposedDevelopmentalEdit({
      projectId, planId, input, plan, textModel, setups, chapterIds, finalText, reports,
      compositionFor, composeOptionsFor, describePages, lineEdit: editorEnabled, generationJobId
    });
  }

  const readCuts = quality.enabled("manuscriptReadCuts");
  if (!developmentalEditing && quality.enabled("manuscriptReadPass") && setups.length > 1) {
    await updateJobProgress(generationJobId, { progress: 70, message: "Reading the whole manuscript" });
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
        const previous = reports.get(setup.chapter.index) ?? reportFor(setup, proseWordCount(current), proseWordCount(seamed), false);
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
      const edited: EditedChapterText = readCuts
        ? await cutChapter({
            ...(await composeOptionsFor(setup, new Map())),
            markdown: currentProse,
            notes: entry.notes,
            bookNotes: read.bookNotes,
            maxRemovableWords: Math.max(0, countReadableWords(currentProse) - cutBudget.min)
          })
        : { markdown: current, words: proseWordCount(current), attempts: 0, changed: false };
      const previous = reports.get(setup.chapter.index) ??
        reportFor(setup, proseWordCount(current), proseWordCount(current), false);
      const report: ComposedChapterReport = {
        ...previous,
        readNotes: entry.notes,
        secondEditApplied: edited.changed,
        ...(edited.changed ? { editedWords: edited.words, paragraphCv: paragraphShapeReport(edited.markdown).cv } : {})
      };
      reports.set(setup.chapter.index, report);
      const reshaped = edited.changed ? reinsertFigureFences(dropDuplicateSentences(varyParagraphs(edited.markdown)), currentFences) : undefined;
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
  await advanceJobStep(generationJobId, "enqueue", 90, "Queueing export");
  await maybeEnqueueCompile(projectId, planId);
}

import {
  PREVIOUS_CHAPTER_TAIL_WORDS,
  chapterDigest,
  chapterEdges,
  chapterTail,
  chapterWordBudget,
  composeChapter,
  countReadableWords,
  describeChapterPages,
  dropDuplicateSentences,
  editChapter,
  formatStoryStateLines,
  judgeChapterDrafts,
  generateAuthorStance,
  isRecord,
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
  type AuthorStance,
  type BookGenerationStrategy,
  type BookPlan,
  type ChapterComposition,
  type CreateProjectInput,
  type EarlierChapterDigest,
  type ProviderSet,
  type TextModelAdapter,
  type EditedChapterText,
  chapterDegeneracy,
  cutChapter
} from "@book-maker/core";
import { Prisma, prisma, pageScope } from "@book-maker/db";
import { maybeEnqueueCompile, maybeEnqueueCover } from "../runtime/dispatch.js";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";
import type { ChapterSetup, IndexedPageDraft } from "../runtime/jobTypes.js";
import { chapterSetupsForPlan } from "./bookHelpers.js";
import { resetBookForDirectGeneration } from "./bookState.js";
import { ensureCharacterReferenceAssets } from "./characterReferences.js";
import { loadContinuityNotes, loadResearchNotesForGeneration } from "./generationContext.js";
import {
  GeneratedPagePublicationClaimLostError,
  loadGeneratedPagePublicationSnapshot,
  publishStagedGeneratedPage,
  stageGeneratedPageAndBrief
} from "./pagePublication.js";
import { persistKeeperStoryDelta } from "./qualityEnrichment.js";
import { loadQualityContext } from "./qualitySettings.js";
import { loadProjectStoryState } from "./storyStateStore.js";
import { reviewWholeBookDraftPages } from "./wholeBookPageReview.js";
import {
  composedResumeState,
  loadComposedBookState,
  READ_SECOND_EDITS,
  COMPOSE_CANDIDATES,
  SHAPE_NOTES_TO_EDITOR,
  MEASUREMENT_NOTES_TO_EDITOR,
  SECOND_CANDIDATE_TEMPERATURE_STEP,
  stageComposedChapter,
  storedPagesInRange,
  type ComposedPageRow,
  type ComposedChapterReport,
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
}): Promise<void> {
  const { projectId, planId, input, plan, providers, strategy, generationJobId, judgeTextModel } = options;
  const textModel = providers.text;
  const quality = await loadQualityContext(input);
  const setups = chapterSetupsForPlan(plan, input.targetPages);
  const stored = await loadComposedBookState(projectId);
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

  await advanceJobStep(generationJobId, "briefs", 12, "Deciding the author's stance");
  let stance = planAuthorStance(plan);
  if (!stance) {
    stance = await generateAuthorStance({ input, plan, textModel });
    await persistGeneratedAuthorStance(planId, stance);
  }

  await updateJobProgress(generationJobId, { progress: 16, message: "Planning the shape of every chapter" });
  const fixed = stored.chapters
    .filter((chapter) => doneChapters.has(chapter.index) && chapter.composition)
    .map((chapter) => chapter.composition!);
  const forms = await planChapterForms({
    input,
    plan,
    stance,
    ranges: setups.map((setup) => ({ chapter: setup.chapter, startPage: setup.startPage, endPage: setup.endPage })),
    fixed,
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
      textModel
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
      shapePassApplied: false
    };
  };

  const finishChapter = async (setup: ChapterSetup, draftMarkdown: string, position: string): Promise<void> => {
    const chapterId = chapterIds.get(setup.chapter.index);
    if (!chapterId) {
      throw new Error(`Chapter ${setup.chapter.index} has no row to write pages into.`);
    }
    let markdown = draftMarkdown;
    let editorChanged = false;
    let shapePassApplied = false;
    if (editorEnabled) {
      await updateJobProgress(generationJobId, { message: `Editing chapter ${position}` });
      // One edit with everything measured on the draft: the second composed
      // book ran a cutting edit and then a reshaping edit that re-expanded
      // it, and the paragraphs came out the same size either way.
      const shapeNotes = SHAPE_NOTES_TO_EDITOR ? paragraphShapeNotes(draftMarkdown) : [];
      const edited = await editChapter({
        ...(await composeOptionsFor(setup, drafts)),
        markdown: draftMarkdown,
        measurementNotes: MEASUREMENT_NOTES_TO_EDITOR ? [...notesForDraft(draftMarkdown), ...shapeNotes] : []
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
    // Paragraph variety by merge, since no instruction produced it, and one
    // copy of any sentence the edits wrote twice.
    markdown = dropDuplicateSentences(varyParagraphs(markdown));
    const pages = await describePages(setup, markdown);
    const bestOf = bestOfVerdicts.get(setup.chapter.index);
    const report: ComposedChapterReport = {
      ...reportFor(setup, countReadableWords(draftMarkdown), countReadableWords(markdown), editorChanged),
      paragraphCv: paragraphShapeReport(markdown).cv,
      shapePassApplied,
      ...(bestOf ? { bestOf } : {})
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
    const composeOptions = await composeOptionsFor(setup, drafts);
    const candidates = judgeTextModel && COMPOSE_CANDIDATES > 1
      ? await Promise.all([
          composeChapter(composeOptions),
          composeChapter({
            ...composeOptions,
            variant: "second",
            temperature: Math.min(1, input.temperature + SECOND_CANDIDATE_TEMPERATURE_STEP)
          })
        ])
      : [await composeChapter(composeOptions)];
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
      draft = await composeChapter({ ...composeOptions, variant: "second" });
      degeneracy = guard(draft.markdown);
      if (degeneracy.degenerate) {
        throw new Error(
          `Chapter ${setup.chapter.index} came back degenerate twice (${degeneracy.reasons.join("; ")}); the book is not published with it.`
        );
      }
    }
    if (judgeTextModel && candidates.length === 2) {
      const verdict = await judgeChapterDrafts({
        input,
        plan,
        chapter: setup.chapter,
        drafts: candidates.map((candidate) => candidate.markdown),
        judge: judgeTextModel
      });
      draft = candidates[verdict.pick] ?? draft;
      bestOfVerdicts.set(setup.chapter.index, verdict);
    }
    drafts.set(setup.chapter.index, draft.markdown);
    const composition = compositionFor(setup);
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

  if (quality.enabled("manuscriptReadPass") && setups.length > 1) {
    await updateJobProgress(generationJobId, { progress: 70, message: "Reading the whole manuscript" });
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
    const read = await readManuscript({ input, plan, stance, chapters: chaptersForRead, textModel });
    if (read.skipped) {
      console.warn("Manuscript read skipped", { event: "generation.composed_chapters.read_skipped", projectId, reason: read.skipped });
    }
    // With second edits off, every chapter that drew notes still goes through
    // the loop below, whose unchanged-edit branch re-stages the brief with the
    // notes on its report; only the edit call is skipped.
    const flagged = read.chapters.filter((entry) => (READ_SECOND_EDITS ? entry.edit : entry.notes.length > 0));
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
        message: READ_SECOND_EDITS
          ? `Cutting chapter ${setup.chapter.index}/${setups.length} from the manuscript read`
          : `Recording the manuscript read's notes on chapter ${setup.chapter.index}/${setups.length}`
      });
      // Deletion only: the read names the sentences, the cut removes them, and
      // `deletionOnlyResult` refuses anything the model wrote.
      const edited: EditedChapterText = READ_SECOND_EDITS
        ? await cutChapter({
            ...(await composeOptionsFor(setup, new Map())),
            markdown: current,
            notes: entry.notes,
            bookNotes: read.bookNotes
          })
        : { markdown: current, words: countReadableWords(current), attempts: 0, changed: false };
      const previous = reports.get(setup.chapter.index) ??
        reportFor(setup, countReadableWords(current), countReadableWords(current), false);
      const report: ComposedChapterReport = {
        ...previous,
        readNotes: entry.notes,
        secondEditApplied: edited.changed,
        ...(edited.changed ? { editedWords: edited.words, paragraphCv: paragraphShapeReport(edited.markdown).cv } : {})
      };
      reports.set(setup.chapter.index, report);
      const reshaped = edited.changed ? dropDuplicateSentences(varyParagraphs(edited.markdown)) : undefined;
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
  }

  await finalizePendingPages({ projectId, planId, input, plan, providers, strategy, generationJobId });
  await advanceJobStep(generationJobId, "enqueue", 90, "Queueing export");
  await maybeEnqueueCompile(projectId, planId);
}

/**
 * Every PENDING page becomes terminal through the staged publication the other
 * passes use: deterministic local checks only (a prompt leak or placeholder
 * gets one revise), then COMPLETED, or GENERATING with an image job for an
 * illustration slot, with its continuity notes published beside it.
 */
async function finalizePendingPages(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
}): Promise<void> {
  const { projectId, planId, input, plan, providers, strategy, generationJobId } = options;
  const state = await loadComposedBookState(projectId);
  const pending = state.pages.filter((page) => page.status === "PENDING");
  if (pending.length === 0) {
    return;
  }
  const notesByIndex = new Map<number, string[]>();
  const chapterIdByIndex = new Map<number, string>();
  for (const chapter of state.chapters) {
    for (const [pageIndex, notes] of chapter.pageNotes) {
      notesByIndex.set(pageIndex, notes);
      chapterIdByIndex.set(pageIndex, chapter.id);
    }
  }
  await advanceJobStep(generationJobId, "setup", 76, `Finalizing ${pending.length} pages`);
  const drafts: IndexedPageDraft[] = pending.map((page) => ({
    index: page.index,
    title: page.title,
    markdown: page.markdown,
    summary: page.summary,
    continuityNotes: notesByIndex.get(page.index) ?? [],
    ...(page.imagePrompt ? { imagePrompt: page.imagePrompt } : {})
  }));
  const reviewed = await reviewWholeBookDraftPages({
    input,
    plan,
    strategy,
    textModel: providers.text,
    pages: drafts,
    generationJobId
  });

  let currentState = await loadProjectStoryState(projectId, plan.promises ?? []);
  for (const [offset, page] of reviewed.entries()) {
    const pageIndex = page.draft.index;
    const existing = await loadGeneratedPagePublicationSnapshot(projectId, pageIndex);
    if (!existing || existing.status !== "PENDING") {
      continue;
    }
    const approved = page.qualityReport.approved;
    const willIllustrate =
      approved && Boolean(page.draft.imagePrompt) && strategy.shouldIllustratePage(input, plan, pageIndex);
    const staged = await stageGeneratedPageAndBrief({
      projectId,
      chapterId: chapterIdByIndex.get(pageIndex) ?? null,
      pageIndex,
      draft: page.draft,
      revision: page.revision,
      qualityReport: page.qualityReport,
      status: approved ? (willIllustrate ? "GENERATING" : "COMPLETED") : "FAILED_QA",
      pendingBriefRepair: undefined,
      existingPage: existing
    });
    if (approved && !willIllustrate && page.draft.continuityNotes.length > 0) {
      await prisma.continuityNote.createMany({
        data: page.draft.continuityNotes.map((body) => ({
          projectId,
          pageId: staged.id,
          scope: pageScope(pageIndex),
          body,
          tags: ["page", String(pageIndex), strategy.id]
        }))
      });
    }
    if (willIllustrate) {
      const publication = await publishStagedGeneratedPage({
        projectId,
        planId,
        pageIndex,
        draft: page.draft,
        stagedPage: staged,
        willIllustrate: true,
        continuityTags: ["page", String(pageIndex), strategy.id]
      });
      if (publication === "enqueue-declined") {
        return;
      }
      if (publication === "superseded") {
        throw new GeneratedPagePublicationClaimLostError(pageIndex);
      }
    }
    if (approved) {
      const nextState = await persistKeeperStoryDelta({
        projectId,
        pageIndex,
        draft: page.draft,
        textModel: providers.text,
        plan,
        input,
        previousExtract: null,
        keeperWasRevised: page.revision > 1,
        currentState
      });
      if (nextState) {
        currentState = nextState;
      }
    }
    if ((offset + 1) % 10 === 0) {
      await updateJobProgress(generationJobId, {
        progress: 76 + Math.round(((offset + 1) / reviewed.length) * 12),
        message: `Finalized ${offset + 1}/${reviewed.length} pages`
      });
    }
  }
}

/**
 * A stance the pass had to generate is written back onto the approved plan, so
 * the console can show the author the book was written as and a later
 * continuation or chat edit reads the same one. The merge keeps every other
 * field of the stored package byte for byte.
 */
async function persistGeneratedAuthorStance(planId: string, stance: AuthorStance): Promise<void> {
  try {
    const row = await prisma.planVersion.findUnique({ where: { id: planId }, select: { planningPackage: true } });
    if (!row || !isRecord(row.planningPackage) || isRecord(row.planningPackage.authorStance)) {
      return;
    }
    await prisma.planVersion.update({
      where: { id: planId },
      data: { planningPackage: { ...row.planningPackage, authorStance: stance } as unknown as Prisma.InputJsonValue }
    });
  } catch (error) {
    if (error instanceof Error && /stop/i.test(error.name)) {
      throw error;
    }
    console.warn("Generated author stance was not persisted onto the plan", {
      event: "generation.composed_chapters.stance_not_persisted",
      planId,
      error
    });
  }
}

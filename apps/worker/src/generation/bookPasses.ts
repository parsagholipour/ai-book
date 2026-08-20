import {
  checkpointWholeBookDraftPages,
  directResumeStateForContext,
  effectiveWholeBookDraftContext,
  loadDirectResumeContext,
  persistAcceptedWholeBookTarget,
  prepareChapterSetups,
  priorPageContextsFromStored,
  rebuildChapterSetupsFromStored,
  reportAcceptedWholeBookDraft,
  resetBookForDirectGeneration
} from "./bookState.js";
import { ensureCharacterReferenceAssets } from "./characterReferences.js";
import { enqueueWorkerJob, maybeEnqueueCompile, maybeEnqueueCover } from "../runtime/dispatch.js";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";
import { type ChapterSetup, type IndexedPageDraft } from "../runtime/jobTypes.js";
import { range } from "../runtime/serialization.js";
import { chapterSetupsForPlan, reviewWholeBookDraftPages } from "./bookHelpers.js";
import { chapterSetupForPage, loadContinuityNotes, loadResearchNotesForGeneration } from "./generationContext.js";
import { reviewAndSaveGeneratedPage } from "./pageReview.js";
import { persistKeeperStoryDelta } from "./qualityEnrichment.js";
import { polishPageWithQualityGates } from "./qualityDrafting.js";
import { storeEmbedding, strategyUsesSemanticMemory } from "./embeddingWrites.js";
import { updateEntityStateFromPage } from "./entityState.js";
import {
  type BookGenerationStrategy,
  type BookPlan,
  type CreateProjectInput,
  type PriorPageContext,
  type ProviderSet,
  type WholeBookPageDraft,
  seedStoryStateFromPromises
} from "@book-maker/core";
import { pageScope, Prisma, prisma, PAGE_SCOPE_PREFIX } from "@book-maker/db";

/**
 * The book-level generation passes (chapter-whole, batch window, draft-then-polish,
 * whole-book) that produce page drafts for a plan.
 */

export async function generateBookChapterWholePass(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
}) {
  const generateChapterDraft = options.strategy.generateChapterDraft;
  if (!generateChapterDraft) {
    throw new Error(`Strategy ${options.strategy.id} does not support chapter whole-pass generation.`);
  }

  // A re-run keeps the settled page prefix instead of wiping the book; the
  // chapter containing the first missing page is redrafted whole (the page
  // upsert overwrites its partial pages).
  const resumeContext = await loadDirectResumeContext(options.projectId);
  const resumeState = directResumeStateForContext({
    targetPages: options.input.targetPages,
    plan: options.plan,
    context: resumeContext,
    requiresBriefs: true,
    requireAllPagesPresent: false
  });
  if (resumeState.kind === "already-complete") {
    await advanceJobStep(options.generationJobId, "enqueue", 90, "All pages already generated; queueing export");
    await maybeEnqueueCompile(options.projectId, options.planId);
    return;
  }

  let chapterSetups: ChapterSetup[];
  let chapterIds: Map<number, string>;
  const previousPages: PriorPageContext[] = [];
  let resumeFromPage = 1;
  if (resumeState.kind === "resume") {
    ({ chapterSetups, chapterIds } = rebuildChapterSetupsFromStored(
      options.plan,
      options.input.targetPages,
      resumeContext.chapters
    ));
    const resumeChapter = chapterSetupForPage(chapterSetups, resumeState.firstMissingPageIndex);
    resumeFromPage = resumeChapter?.startPage ?? resumeState.firstMissingPageIndex;
    previousPages.push(...priorPageContextsFromStored(resumeContext.pages, resumeFromPage));
    await advanceJobStep(
      options.generationJobId,
      "setup",
      35,
      `Resuming with ${previousPages.length} existing pages`
    );
    await prisma.project.update({ where: { id: options.projectId }, data: { status: "GENERATING" } });
  } else {
    chapterSetups = await prepareChapterSetups(options);
    await advanceJobStep(options.generationJobId, "setup", 35, "Preparing chapter records");
    chapterIds = await resetBookForDirectGeneration(options.projectId, chapterSetups, options.plan.promises ?? []);
  }
  await ensureCharacterReferenceAssets({
    projectId: options.projectId,
    planId: options.planId,
    input: options.input,
    plan: options.plan,
    providers: options.providers,
    strategy: options.strategy,
    generationJobId: options.generationJobId
  });
  await maybeEnqueueCover(options.projectId, options.planId, options.input);

  for (const [chapterIndex, setup] of chapterSetups.entries()) {
    if (setup.endPage < resumeFromPage) {
      continue;
    }
    await updateJobProgress(options.generationJobId, {
      progress: 35 + Math.round((chapterIndex / Math.max(chapterSetups.length, 1)) * 45),
      message: `Drafting chapter ${chapterIndex + 1}/${chapterSetups.length}`
    });
    // Whole book, here and at this file's three other note loads: these passes
    // write a book front to back, so nothing stored is ahead of what they are
    // drafting, and a resumed pass re-reads the same manuscript the finished
    // pages already agreed with.
    const continuityNotes = await loadContinuityNotes(options.projectId, { beforePageIndex: null });
    const researchNotes = await loadResearchNotesForGeneration(options.projectId, options.strategy, setup.chapter);
    const draft = await generateChapterDraft({
      input: options.input,
      plan: options.plan,
      chapter: setup.chapter,
      chapterBrief: setup.brief,
      chapterPageStart: setup.startPage,
      chapterPageEnd: setup.endPage,
      previousPages,
      continuityNotes,
      researchNotes,
      textModel: options.providers.text
    });

    for (const pageDraft of draft.pages) {
      const saved = await reviewAndSaveGeneratedPage({
        projectId: options.projectId,
        planId: options.planId,
        input: options.input,
        plan: options.plan,
        providers: options.providers,
        strategy: options.strategy,
        draft: pageDraft,
        chapterId: chapterIds.get(setup.chapter.index) ?? null,
        chapter: setup.chapter,
        chapterBrief: setup.brief,
        chapterPageStart: setup.startPage,
        chapterPageEnd: setup.endPage,
        previousPages,
        generationJobId: options.generationJobId
      });
      previousPages.push(saved);
    }
  }

  await advanceJobStep(options.generationJobId, "enqueue", 90, "Queueing export");
  await maybeEnqueueCompile(options.projectId, options.planId);
}

export async function generateBookBatchWindow(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
}) {
  const generateBatchDraft = options.strategy.generateBatchDraft;
  if (!generateBatchDraft) {
    throw new Error(`Strategy ${options.strategy.id} does not support batch-window generation.`);
  }

  // A re-run keeps the settled page prefix; the batch containing the first
  // missing page is redrafted whole (the page upsert overwrites its pages).
  const batchSize = Math.max(1, options.strategy.batchSize ?? 4);
  const resumeContext = await loadDirectResumeContext(options.projectId);
  const resumeState = directResumeStateForContext({
    targetPages: options.input.targetPages,
    plan: options.plan,
    context: resumeContext,
    requiresBriefs: true,
    requireAllPagesPresent: false
  });
  if (resumeState.kind === "already-complete") {
    await advanceJobStep(options.generationJobId, "enqueue", 90, "All pages already generated; queueing export");
    await maybeEnqueueCompile(options.projectId, options.planId);
    return;
  }

  let chapterSetups: ChapterSetup[];
  let chapterIds: Map<number, string>;
  const previousPages: PriorPageContext[] = [];
  let resumeFromPage = 1;
  if (resumeState.kind === "resume") {
    ({ chapterSetups, chapterIds } = rebuildChapterSetupsFromStored(
      options.plan,
      options.input.targetPages,
      resumeContext.chapters
    ));
    resumeFromPage = Math.floor((resumeState.firstMissingPageIndex - 1) / batchSize) * batchSize + 1;
    previousPages.push(...priorPageContextsFromStored(resumeContext.pages, resumeFromPage));
    await advanceJobStep(
      options.generationJobId,
      "setup",
      35,
      `Resuming with ${previousPages.length} existing pages`
    );
    await prisma.project.update({ where: { id: options.projectId }, data: { status: "GENERATING" } });
  } else {
    chapterSetups = await prepareChapterSetups(options);
    await advanceJobStep(options.generationJobId, "setup", 35, "Preparing batch records");
    chapterIds = await resetBookForDirectGeneration(options.projectId, chapterSetups, options.plan.promises ?? []);
  }
  await ensureCharacterReferenceAssets({
    projectId: options.projectId,
    planId: options.planId,
    input: options.input,
    plan: options.plan,
    providers: options.providers,
    strategy: options.strategy,
    generationJobId: options.generationJobId
  });
  await maybeEnqueueCover(options.projectId, options.planId, options.input);
  const totalBatches = Math.ceil(options.input.targetPages / batchSize);

  for (
    let pageStart = resumeFromPage, batchIndex = Math.floor((resumeFromPage - 1) / batchSize);
    pageStart <= options.input.targetPages;
    pageStart += batchSize, batchIndex += 1
  ) {
    const pageEnd = Math.min(options.input.targetPages, pageStart + batchSize - 1);
    await updateJobProgress(options.generationJobId, {
      progress: 35 + Math.round((batchIndex / Math.max(totalBatches, 1)) * 45),
      message: `Drafting pages ${pageStart}-${pageEnd}`
    });
    const continuityNotes = await loadContinuityNotes(options.projectId, { beforePageIndex: null });
    const researchNotes = await loadResearchNotesForGeneration(options.projectId, options.strategy);
    let draft: { pages: IndexedPageDraft[] };
    try {
      draft = await generateBatchDraft({
        input: options.input,
        plan: options.plan,
        chapterBriefs: chapterSetups.flatMap((setup) => (setup.brief ? [setup.brief] : [])),
        pageStart,
        pageEnd,
        previousPages,
        continuityNotes,
        researchNotes,
        textModel: options.providers.text
      });
    } catch (error) {
      if (!isRecoverableBatchDraftRangeError(error)) {
        throw error;
      }
      await updateJobProgress(options.generationJobId, {
        message: `Batch draft for pages ${pageStart}-${pageEnd} was incomplete; drafting those pages individually.`
      });
      draft = { pages: [] };
    }

    const draftsByIndex = new Map(draft.pages.map((pageDraft) => [pageDraft.index, pageDraft]));
    for (const pageIndex of range(pageStart, pageEnd)) {
      let pageDraft = draftsByIndex.get(pageIndex);
      if (!pageDraft) {
        await updateJobProgress(options.generationJobId, {
          message: `Batch omitted page ${pageIndex}; drafting it individually.`
        });
        pageDraft = await generateBatchFallbackPageDraft({
          projectId: options.projectId,
          input: options.input,
          plan: options.plan,
          providers: options.providers,
          strategy: options.strategy,
          chapterSetups,
          pageIndex,
          previousPages
        });
      }

      const setup = chapterSetupForPage(chapterSetups, pageIndex);
      const saved = await reviewAndSaveGeneratedPage({
        projectId: options.projectId,
        planId: options.planId,
        input: options.input,
        plan: options.plan,
        providers: options.providers,
        strategy: options.strategy,
        draft: pageDraft,
        chapterId: setup ? chapterIds.get(setup.chapter.index) ?? null : null,
        chapter: setup?.chapter,
        chapterBrief: setup?.brief,
        chapterPageStart: setup?.startPage,
        chapterPageEnd: setup?.endPage,
        previousPages,
        generationJobId: options.generationJobId
      });
      previousPages.push(saved);
    }
  }

  await advanceJobStep(options.generationJobId, "enqueue", 90, "Queueing export");
  await maybeEnqueueCompile(options.projectId, options.planId);
}

export async function generateBatchFallbackPageDraft(options: {
  projectId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  chapterSetups: ChapterSetup[];
  pageIndex: number;
  previousPages: PriorPageContext[];
}): Promise<IndexedPageDraft> {
  const setup = chapterSetupForPage(options.chapterSetups, options.pageIndex);
  const chapterBrief = setup?.brief;
  const continuityNotes = await loadContinuityNotes(options.projectId, { beforePageIndex: null });
  const researchNotes = await loadResearchNotesForGeneration(options.projectId, options.strategy, setup?.chapter);
  const draft = await options.strategy.generatePageDraft({
    input: options.input,
    plan: options.plan,
    chapter: setup?.chapter,
    chapterBrief,
    pageBrief: chapterBrief?.pages.find((brief) => brief.pageIndex === options.pageIndex),
    pageIndex: options.pageIndex,
    previousSummaries: options.previousPages.map((page) => page.summary).filter(Boolean),
    previousPages: options.previousPages,
    continuityNotes,
    researchNotes,
    textModel: options.providers.text
  });

  return { ...draft, index: options.pageIndex };
}

export function isRecoverableBatchDraftRangeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^Page batch returned (?:pages out of order or outside the requested range|an invalid page set)/i.test(error.message)
  );
}

export async function generateBookDraftThenPolish(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
}) {
  const generateWholeBookDraft = options.strategy.generateWholeBookDraft;
  const polishPageDraft = options.strategy.polishPageDraft;
  if (!generateWholeBookDraft || !polishPageDraft) {
    throw new Error(`Strategy ${options.strategy.id} does not support draft-then-polish generation.`);
  }

  // The accepted whole-book draft is checkpointed as PENDING rows before the
  // polish loop, so a re-run resumes polishing instead of repeating the draft
  // call. requiresBriefs is false because effectiveWholeBookDraftContext drops
  // briefs when the accepted draft was renumbered — polish tolerates both.
  const resumeContext = await loadDirectResumeContext(options.projectId);
  const resumeState = directResumeStateForContext({
    targetPages: options.input.targetPages,
    plan: options.plan,
    context: resumeContext,
    requiresBriefs: false,
    requireAllPagesPresent: true
  });
  if (resumeState.kind === "already-complete") {
    await advanceJobStep(options.generationJobId, "enqueue", 90, "All pages already polished; queueing export");
    await maybeEnqueueCompile(options.projectId, options.planId);
    return;
  }

  let effectiveInput: CreateProjectInput;
  let effectivePlan: BookPlan;
  let chapterSetups: ChapterSetup[];
  let chapterIds: Map<number, string>;
  let rawPages: PriorPageContext[];
  let pagesToPolish: WholeBookPageDraft[];
  const previousPages: PriorPageContext[] = [];

  if (resumeState.kind === "resume") {
    // persistAcceptedWholeBookTarget already ran before the first polish, so
    // options.input/options.plan reflect the accepted draft on this re-run.
    effectiveInput = options.input;
    effectivePlan = options.plan;
    ({ chapterSetups, chapterIds } = rebuildChapterSetupsFromStored(
      options.plan,
      options.input.targetPages,
      resumeContext.chapters
    ));
    rawPages = resumeContext.pages.map((page) => ({
      index: page.index,
      title: page.title,
      markdown: page.markdown,
      summary: page.summary
    }));
    pagesToPolish = resumeContext.pages
      .filter((page) => page.status === "PENDING")
      .map((page) => ({
        index: page.index,
        title: page.title,
        markdown: page.markdown,
        summary: page.summary,
        continuityNotes: [],
        ...(page.imagePrompt ? { imagePrompt: page.imagePrompt } : {})
      }));
    previousPages.push(...priorPageContextsFromStored(resumeContext.pages, resumeState.firstMissingPageIndex));
    await advanceJobStep(
      options.generationJobId,
      "setup",
      35,
      `Resuming polish with ${previousPages.length} finished pages; the saved draft is reused`
    );
    await prisma.project.update({ where: { id: options.projectId }, data: { status: "GENERATING" } });
  } else {
    const draftChapterSetups: ChapterSetup[] = options.strategy.createChapterBriefs
      ? await prepareChapterSetups(options)
      : chapterSetupsForPlan(options.plan, options.input.targetPages);
    const chapterBriefs = draftChapterSetups.flatMap((setup) => (setup.brief ? [setup.brief] : []));
    const research = await prisma.researchSource.findMany({ where: { projectId: options.projectId }, take: 20 });
    await advanceJobStep(options.generationJobId, "briefs", chapterBriefs.length > 0 ? 30 : 20, "Drafting whole book");
    const draft = await generateWholeBookDraft({
      input: options.input,
      plan: options.plan,
      chapterBriefs: chapterBriefs.length > 0 ? chapterBriefs : undefined,
      researchNotes: research.map((source) => `${source.title}: ${source.summary}`),
      textModel: options.providers.text
    });
    const acceptanceMessage = await reportAcceptedWholeBookDraft(options.generationJobId, draft);
    const effective = effectiveWholeBookDraftContext(options.input, options.plan, draft, draftChapterSetups);

    await advanceJobStep(
      options.generationJobId,
      "setup",
      35,
      acceptanceMessage ? `${acceptanceMessage} Preparing polish records.` : "Preparing polish records"
    );
    effectiveInput = effective.input;
    effectivePlan = effective.plan;
    chapterSetups = effective.chapterSetups;
    chapterIds = await resetBookForDirectGeneration(options.projectId, effective.chapterSetups, effective.plan.promises ?? []);
    await checkpointWholeBookDraftPages({
      projectId: options.projectId,
      chapterSetups: effective.chapterSetups,
      chapterIds,
      pages: draft.pages
    });
    // Persisted before polishing (not after) so a resumed run loads the
    // accepted page target and matches the checkpointed structure.
    await persistAcceptedWholeBookTarget({
      projectId: options.projectId,
      planId: options.planId,
      input: effective.input,
      plan: effective.plan,
      draft
    });
    rawPages = draft.pages.map((page) => ({
      index: page.index,
      title: page.title,
      markdown: page.markdown,
      summary: page.summary
    }));
    pagesToPolish = draft.pages;
  }

  await ensureCharacterReferenceAssets({
    projectId: options.projectId,
    planId: options.planId,
    input: effectiveInput,
    plan: effectivePlan,
    providers: options.providers,
    strategy: options.strategy,
    generationJobId: options.generationJobId
  });
  await maybeEnqueueCover(options.projectId, options.planId, effectiveInput);

  for (const [pageOffset, pageDraft] of pagesToPolish.entries()) {
    await updateJobProgress(options.generationJobId, {
      progress: 35 + Math.round((pageOffset / Math.max(pagesToPolish.length, 1)) * 45),
      message: `Polishing page ${pageDraft.index}`
    });
    const continuityNotes = await loadContinuityNotes(options.projectId, { beforePageIndex: null });
    const setup = chapterSetupForPage(chapterSetups, pageDraft.index);
    const chapterBrief = setup?.brief;
    const pageBrief = chapterBrief?.pages.find((brief) => brief.pageIndex === pageDraft.index);
    const researchNotes = await loadResearchNotesForGeneration(options.projectId, options.strategy, setup?.chapter);
    const polished = await polishPageWithQualityGates({
      polishPageDraft,
      polishOptions: {
        input: effectiveInput,
        plan: effectivePlan,
        chapter: setup?.chapter,
        chapterBrief,
        pageBrief,
        pageIndex: pageDraft.index,
        draft: pageDraft,
        previousPages,
        nextPages: rawPages.filter((page) => page.index > pageDraft.index).slice(0, 3),
        continuityNotes,
        researchNotes,
        textModel: options.providers.text
      },
      providers: options.providers,
      input: effectiveInput
    });
    const saved = await reviewAndSaveGeneratedPage({
      projectId: options.projectId,
      planId: options.planId,
      input: effectiveInput,
      plan: effectivePlan,
      providers: options.providers,
      strategy: options.strategy,
      draft: { ...polished, index: pageDraft.index },
      chapterId: setup ? chapterIds.get(setup.chapter.index) ?? null : null,
      chapter: setup?.chapter,
      chapterBrief,
      chapterPageStart: setup?.startPage,
      chapterPageEnd: setup?.endPage,
      previousPages,
      generationJobId: options.generationJobId
    });
    previousPages.push(saved);
  }

  await advanceJobStep(options.generationJobId, "enqueue", 90, "Queueing export");
  await maybeEnqueueCompile(options.projectId, options.planId);
}

/**
 * Intentionally restart-only: the entire book comes from a single LLM call and
 * pages are saved in one transaction, so there is no mid-run checkpoint to
 * resume from (unlike the other direct modes, see directGenerationResume.ts).
 * A failed run leaves prior book state untouched and a retry simply re-runs
 * the one call.
 */
export async function generateBookWholePass(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
}) {
  const generateWholeBookDraft = options.strategy.generateWholeBookDraft;
  if (!generateWholeBookDraft) {
    throw new Error(`Strategy ${options.strategy.id} does not support whole-book generation.`);
  }

  const research = await prisma.researchSource.findMany({ where: { projectId: options.projectId }, take: 20 });
  await advanceJobStep(options.generationJobId, "briefs", 20, "Preparing whole-book prompt");
  const draft = await generateWholeBookDraft({
    input: options.input,
    plan: options.plan,
    researchNotes: research.map((source) => `${source.title}: ${source.summary}`),
    textModel: options.providers.text
  });
  const acceptanceMessage = await reportAcceptedWholeBookDraft(options.generationJobId, draft);
  const effective = effectiveWholeBookDraftContext(options.input, options.plan, draft);

  await advanceJobStep(
    options.generationJobId,
    "setup",
    55,
    acceptanceMessage ? `${acceptanceMessage} Reviewing ${draft.pages.length} generated pages.` : `Reviewing ${draft.pages.length} generated pages`
  );
  const reviewedPages = await reviewWholeBookDraftPages({
    input: effective.input,
    plan: effective.plan,
    strategy: options.strategy,
    textModel: options.providers.text,
    pages: draft.pages,
    generationJobId: options.generationJobId
  });

  await advanceJobStep(options.generationJobId, "setup", 70, `Saving ${reviewedPages.length} generated pages`);
  const chapterRanges = effective.chapterSetups;
  const savedPages =   await prisma.$transaction(async (tx) => {
    await tx.imageAsset.deleteMany({ where: { projectId: options.projectId } });
    await tx.page.deleteMany({ where: { projectId: options.projectId } });
    await tx.chapter.deleteMany({ where: { projectId: options.projectId } });
    await tx.continuityNote.deleteMany({ where: { projectId: options.projectId } });
    await tx.embedding.deleteMany({ where: { projectId: options.projectId, scope: { startsWith: PAGE_SCOPE_PREFIX } } });
    await tx.project.update({
      where: { id: options.projectId },
      data: {
        status: "GENERATING",
        storyState: seedStoryStateFromPromises(effective.plan.promises ?? []) as Prisma.InputJsonValue
      }
    });

    const chapterIds = new Map<number, string>();
    for (const setup of chapterRanges) {
      const chapter = await tx.chapter.create({
        data: {
          projectId: options.projectId,
          index: setup.chapter.index,
          title: setup.chapter.title,
          summary: setup.chapter.summary,
          targetPages: setup.chapter.targetPages
        }
      });
      chapterIds.set(setup.chapter.index, chapter.id);
    }

    const pages: Array<{ id: string; index: number; summary: string; imagePrompt: string | null; revision: number }> = [];
    const continuityNotes: Array<{ pageId: string; scope: string; body: string; tags: string[] }> = [];
    for (const reviewedPage of reviewedPages) {
      const pageDraft = reviewedPage.draft;
      const chapterIndex = chapterRanges.find(
        (setup) => pageDraft.index >= setup.startPage && pageDraft.index <= setup.endPage
      )?.chapter.index;
      const page = await tx.page.create({
        data: {
          projectId: options.projectId,
          chapterId: chapterIndex ? chapterIds.get(chapterIndex) ?? null : null,
          index: pageDraft.index,
          title: pageDraft.title,
          markdown: pageDraft.markdown,
          summary: pageDraft.summary,
          imagePrompt: pageDraft.imagePrompt ?? null,
          status: "COMPLETED",
          revision: reviewedPage.revision,
          qualityReport: reviewedPage.qualityReport as Prisma.InputJsonValue
        }
      });
      pages.push({
        id: page.id,
        index: page.index,
        summary: page.summary,
        imagePrompt: page.imagePrompt,
        revision: page.revision
      });
      for (const body of pageDraft.continuityNotes) {
        continuityNotes.push({
          pageId: page.id,
          scope: pageScope(pageDraft.index),
          body,
          tags: ["page", String(pageDraft.index), "whole-book"]
        });
      }
    }

    if (continuityNotes.length > 0) {
      await tx.continuityNote.createMany({
        data: continuityNotes.map((note) => ({ projectId: options.projectId, ...note }))
      });
    }

    return pages;
  });

  let currentState = seedStoryStateFromPromises(effective.plan.promises ?? []);
  for (const reviewedPage of reviewedPages) {
    const nextState = await persistKeeperStoryDelta({
      projectId: options.projectId,
      pageIndex: reviewedPage.draft.index,
      draft: reviewedPage.draft,
      textModel: options.providers.text,
      plan: effective.plan,
      input: effective.input,
      previousExtract: null,
      keeperWasRevised: true,
      currentState
    });
    if (nextState) {
      currentState = nextState;
    }
  }

  // Semantic memory is only ever read by sequential-pages jobs; the direct
  // passes writing it paid one embedding per page for rows nothing queries.
  if (strategyUsesSemanticMemory(options.strategy)) {
    for (const page of savedPages) {
      await storeEmbedding(
        { projectId: options.projectId, scope: pageScope(page.index), sourceId: page.id, text: page.summary },
        options.providers.embedding
      );
    }
    for (const reviewedPage of reviewedPages) {
      await updateEntityStateFromPage(options.projectId, reviewedPage.draft.index, reviewedPage.draft.continuityNotes);
    }
  }

  await advanceJobStep(options.generationJobId, "enqueue", 88, "Queueing images and export");
  await persistAcceptedWholeBookTarget({
    projectId: options.projectId,
    planId: options.planId,
    input: effective.input,
    plan: effective.plan,
    draft
  });
  await ensureCharacterReferenceAssets({
    projectId: options.projectId,
    planId: options.planId,
    input: effective.input,
    plan: effective.plan,
    providers: options.providers,
    strategy: options.strategy,
    generationJobId: options.generationJobId
  });
  await maybeEnqueueCover(options.projectId, options.planId, effective.input);
  for (const page of savedPages) {
    if (page.imagePrompt && options.strategy.shouldIllustratePage(effective.input, effective.plan, page.index)) {
      await enqueueWorkerJob({
        projectId: options.projectId,
        type: "GENERATE_IMAGE",
        payload: { pageId: page.id, planId: options.planId, prompt: page.imagePrompt },
        dedupeKey: `generate-image:${page.id}:${options.planId}:${page.revision}`
      });
    }
  }

  await maybeEnqueueCompile(options.projectId, options.planId);
}

import { quickDraftPageQuality } from "./quickDraftReviewPolicy.js";
import {
  directResumeStateForContext,
  effectiveWholeBookDraftContext,
  loadDirectResumeContext,
  persistAcceptedWholeBookTarget,
  prepareChapterSetups,
  priorPageContextsFromStored,
  rebuildChapterSetupsFromStored,
  reportAcceptedWholeBookDraft,
  resetBookForDirectGeneration,
  type StoredResumePage
} from "./bookState.js";
import { ensureCharacterReferenceAssets } from "./characterReferences.js";
import { maybeEnqueueCompile, maybeEnqueueCover } from "../runtime/dispatch.js";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";
import { type ChapterSetup, type IndexedPageDraft } from "../runtime/jobTypes.js";
import { styleExcerptsForPage } from "./bookHelpers.js";
import { chapterSetupForPage, loadContinuityNotes, loadResearchNotesForGeneration } from "./generationContext.js";
import { reviewAndSaveGeneratedPage } from "./pageReview.js";
import { type QualityGateContext } from "./qualityEnrichment.js";
import { loadQualityContext } from "./qualitySettings.js";
import { reviewWholeBookDraftPages } from "./wholeBookPageReview.js";
import {
  GeneratedPagePublicationClaimLostError,
  publishStagedGeneratedPage,
  stageGeneratedPageWithClient,
  type GeneratedPagePublicationSnapshot,
  type StagedGeneratedPage
} from "./pagePublication.js";
import { storeEmbedding, strategyUsesSemanticMemory } from "./embeddingWrites.js";
import { updateEntityStateFromPage } from "./entityState.js";
import type { DirectResumeState } from "./directGenerationResume.js";
import {
  type BookGenerationStrategy,
  type BookPlan,
  type CreateProjectInput,
  range,
  type PriorPageContext,
  type ProviderSet,
  seedStoryStateFromPromises
} from "@book-maker/core";
import { pageScope, Prisma, prisma, PAGE_SCOPE_PREFIX } from "@book-maker/db";

/**
 * The book-level generation passes (chapter-whole, batch window, draft-then-polish,
 * whole-book) that produce page drafts for a plan.
 */

function settledPageToReplaceForResume(
  resumeState: DirectResumeState,
  pages: StoredResumePage[],
  resumeFromPage: number,
  pageIndex: number
): StoredResumePage | undefined {
  if (
    resumeState.kind !== "resume" ||
    pageIndex < resumeFromPage ||
    pageIndex >= resumeState.firstMissingPageIndex
  ) {
    return undefined;
  }
  return pages.find((page) => page.index === pageIndex);
}

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
  const quality = quickDraftPageQuality(options.input, await loadQualityContext(options.input));

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
    const styleExcerpts = await styleExcerptsForPage({
      projectId: options.projectId,
      pageIndex: setup.startPage,
      recencyPages: previousPages,
      input: options.input,
      quality
    });
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
      textModel: options.providers.text,
      ...(styleExcerpts.length > 0 ? { styleExcerpts } : {})
    });

    for (const pageDraft of draft.pages) {
      const settledPageToReplace = settledPageToReplaceForResume(
        resumeState,
        resumeContext.pages,
        resumeFromPage,
        pageDraft.index
      );
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
        generationJobId: options.generationJobId,
        ...(settledPageToReplace ? { settledPageToReplace } : {})
      });
      previousPages.push(saved.page);
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
  const quality = quickDraftPageQuality(options.input, await loadQualityContext(options.input));
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
    const styleExcerpts = await styleExcerptsForPage({
      projectId: options.projectId,
      pageIndex: pageStart,
      recencyPages: previousPages,
      input: options.input,
      quality
    });
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
        textModel: options.providers.text,
        ...(styleExcerpts.length > 0 ? { styleExcerpts } : {})
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
          previousPages,
          quality
        });
      }

      const setup = chapterSetupForPage(chapterSetups, pageIndex);
      const settledPageToReplace = settledPageToReplaceForResume(
        resumeState,
        resumeContext.pages,
        resumeFromPage,
        pageIndex
      );
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
        generationJobId: options.generationJobId,
        ...(settledPageToReplace ? { settledPageToReplace } : {})
      });
      previousPages.push(saved.page);
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
  quality: QualityGateContext;
}): Promise<IndexedPageDraft> {
  const setup = chapterSetupForPage(options.chapterSetups, options.pageIndex);
  const chapterBrief = setup?.brief;
  const continuityNotes = await loadContinuityNotes(options.projectId, { beforePageIndex: null });
  const researchNotes = await loadResearchNotesForGeneration(options.projectId, options.strategy, setup?.chapter);
  const styleExcerpts = await styleExcerptsForPage({
    projectId: options.projectId,
    pageIndex: options.pageIndex,
    recencyPages: options.previousPages,
    input: options.input,
    quality: options.quality
  });
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
    textModel: options.providers.text,
    ...(styleExcerpts.length > 0 ? { styleExcerpts } : {})
  });

  return { ...draft, index: options.pageIndex };
}

export function isRecoverableBatchDraftRangeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^Page batch returned (?:pages out of order or outside the requested range|an invalid page set)/i.test(error.message)
  );
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

  const researchNotes = await loadResearchNotesForGeneration(options.projectId, options.strategy);
  await advanceJobStep(options.generationJobId, "briefs", 20, "Preparing whole-book prompt");
  const draft = await generateWholeBookDraft({
    input: options.input,
    plan: options.plan,
    researchNotes,
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
  const savedPages = await prisma.$transaction(async (tx) => {
    const existingPages = await tx.page.findMany({
      where: { projectId: options.projectId },
      select: {
        id: true,
        index: true,
        status: true,
        title: true,
        markdown: true,
        summary: true,
        imagePrompt: true,
        revision: true,
        updatedAt: true
      }
    });
    const acceptedPageIndexes = new Set(reviewedPages.map((page) => page.draft.index));
    const removedPageIds = existingPages
      .filter((page) => !acceptedPageIndexes.has(page.index))
      .map((page) => page.id);
    // A Bull retry keeps stable ids for accepted page indexes. Tokened jobs
    // already made durable by an earlier delivery can then either continue to
    // own an identical keeper or stand down against its replacement, instead
    // of failing because a wholesale delete made their page disappear.
    if (removedPageIds.length > 0) {
      await tx.imageAsset.deleteMany({ where: { projectId: options.projectId, pageId: { in: removedPageIds } } });
      await tx.page.deleteMany({ where: { id: { in: removedPageIds } } });
    }
    // Cover/reference assets are rebuilt for the accepted whole-book plan.
    // Page-owned assets are retired by keeper identity in the shared staging
    // helper, which preserves both same-keeper renders and manual assets.
    await tx.imageAsset.deleteMany({ where: { projectId: options.projectId, pageId: null } });
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

    const pages: Array<StagedGeneratedPage & {
      index: number;
      draft: (typeof reviewedPages)[number]["draft"];
      willIllustrate: boolean;
    }> = [];
    const continuityNotes: Array<{ pageId: string; scope: string; body: string; tags: string[] }> = [];
    const existingPagesByIndex = new Map(existingPages.map((page) => [page.index, page]));
    for (const reviewedPage of reviewedPages) {
      const pageDraft = reviewedPage.draft;
      const chapterIndex = chapterRanges.find(
        (setup) => pageDraft.index >= setup.startPage && pageDraft.index <= setup.endPage
      )?.chapter.index;
      const approved = reviewedPage.qualityReport.approved;
      const willIllustrate =
        approved &&
        Boolean(pageDraft.imagePrompt) &&
        options.strategy.shouldIllustratePage(effective.input, effective.plan, pageDraft.index);
      const stagedPage = await stageGeneratedPageWithClient(tx, {
        projectId: options.projectId,
        chapterId: chapterIndex ? chapterIds.get(chapterIndex) ?? null : null,
        pageIndex: pageDraft.index,
        draft: pageDraft,
        revision: reviewedPage.revision,
        qualityReport: reviewedPage.qualityReport,
        status: approved ? (willIllustrate ? "GENERATING" : "COMPLETED") : "FAILED_QA",
        existingPage: (existingPagesByIndex.get(pageDraft.index) as GeneratedPagePublicationSnapshot | undefined) ?? null
      });
      pages.push({
        ...stagedPage,
        index: pageDraft.index,
        draft: pageDraft,
        willIllustrate
      });
      // Illustrated pages publish their notes in the exact-keeper completion
      // transaction after their durable job exists. Pages needing no image are
      // already terminal here, so their notes remain part of this manuscript
      // replacement transaction just as before.
      for (const body of willIllustrate ? [] : pageDraft.continuityNotes) {
        continuityNotes.push({
          pageId: stagedPage.id,
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

  await advanceJobStep(options.generationJobId, "enqueue", 88, "Queueing images and export");
  // A tolerated whole-book page count changes the plan snapshot image workers
  // read. Publish it before any of those tokened jobs can start.
  await persistAcceptedWholeBookTarget({
    projectId: options.projectId,
    planId: options.planId,
    input: effective.input,
    plan: effective.plan,
    draft
  });
  for (const page of savedPages) {
    if (!page.willIllustrate) {
      continue;
    }
    const publication = await publishStagedGeneratedPage({
      projectId: options.projectId,
      planId: options.planId,
      pageIndex: page.index,
      draft: page.draft,
      stagedPage: page,
      willIllustrate: true,
      continuityTags: ["page", String(page.index), "whole-book"]
    });
    // Declined project ownership leaves this exact page non-terminal. Never
    // run stale semantic tails or compile over it; a durable old token will
    // make the same keeper check and stand down.
    if (publication === "enqueue-declined") {
      return;
    }
    if (publication === "superseded") {
      // A version-preserving structural move can be the only failed predicate.
      // The whole-book job must retry against that new ordering instead of
      // becoming terminal while its staged stable page remains GENERATING.
      throw new GeneratedPagePublicationClaimLostError(page.index);
    }
  }

  // Semantic memory is only ever read by sequential-pages jobs; the direct
  // passes writing it paid one embedding per page for rows nothing queries.
  if (strategyUsesSemanticMemory(options.strategy)) {
    for (const page of savedPages) {
      await storeEmbedding(
        { projectId: options.projectId, scope: pageScope(page.index), sourceId: page.id, text: page.draft.summary },
        options.providers.embedding
      );
    }
    for (const reviewedPage of reviewedPages) {
      await updateEntityStateFromPage(options.projectId, reviewedPage.draft.index, reviewedPage.draft.continuityNotes);
    }
  }

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

  await maybeEnqueueCompile(options.projectId, options.planId);
}

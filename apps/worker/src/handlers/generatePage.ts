import { formatQualityFailure, getProjectOrThrow, parseChapterBrief, strategyForInput, toPriorPageContext } from "../generation/bookHelpers.js";
import { loadResearchNotesForGeneration } from "../generation/generationContext.js";
import { pageRevisionMessage, runPageQualityLoop } from "../generation/pageReview.js";
import {
  enrichPageQualityReport,
  mergeEntityAndStoryStateLines,
  persistKeeperStoryDelta
} from "../generation/qualityEnrichment.js";
import { applyPlanThinkingBoost, loadQualityContext } from "../generation/qualitySettings.js";
import { loadProjectStoryState } from "../generation/storyStateStore.js";
import {
  RECENT_PAGE_WINDOW,
  embedSemanticQuery,
  loadEntityStateLines,
  retrieveSemanticPageMemory,
  retrieveSemanticResearchNotes,
  storeEmbedding,
  updateEntityStateFromPage
} from "../generation/semanticMemory.js";
import { MAX_PAGE_QA_CANDIDATES, MAX_PAGE_QA_REWRITE_ATTEMPTS } from "../generation/tuning.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { enqueueNextPageIfReady, enqueueWorkerJob } from "../runtime/dispatch.js";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";
import {
  bestOfCandidateCount,
  bookPlanSchema,
  createProviders,
  formatStoryStateLines,
  generateBestOfPageDrafts,
  generatePageDraftWithWriterTools,
  missingStyleLockIndexes,
  pagesForStyleExcerpts,
  pinStyleExcerpts,
  sampleExcerptsFromInput,
  type PriorPageContext
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { Job } from "bullmq";

/**
 * `generate-page` job: draft, review and save a single page.
 */

export async function generatePage(job: Job) {
  const { projectId, pageId, planId } = job.data as { projectId: string; pageId: string; planId: string };
  const generationJobId = job.data.generationJobId as string | undefined;
  const [project, page, planVersion] = await Promise.all([
    getProjectOrThrow(projectId),
    prisma.page.findUnique({ where: { id: pageId }, include: { chapter: true } }),
    prisma.planVersion.findUnique({ where: { id: planId } })
  ]);
  if (!page || !planVersion) {
    throw new Error("Page or plan not found");
  }

  const input = inputForPlanVersion(project, planVersion.inputSnapshot);
  const strategy = strategyForInput(input);
  const plan = bookPlanSchema.parse(planVersion.planningPackage);
  const providers = createLoggedProviders(job, createProviders(config, input), input);
  await prisma.page.update({ where: { id: pageId }, data: { status: "GENERATING" } });
  const previousPages = await prisma.page.findMany({
    where: { projectId, index: { lt: page.index }, status: "COMPLETED" },
    orderBy: { index: "desc" },
    take: 18
  });
  const continuity = await prisma.continuityNote.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 28
  });
  const chapterPlan = plan.chapters.find((chapter) => chapter.index === page.chapter?.index);
  const orderedPreviousPages = previousPages.reverse();
  const priorPageContext = orderedPreviousPages.map(toPriorPageContext);
  const chapterBrief = parseChapterBrief(page.chapter?.productionBrief);
  const pageBrief = chapterBrief?.pages.find((brief) => brief.pageIndex === page.index);

  const semanticQueryText = [
    pageBrief ? `${pageBrief.purpose} ${pageBrief.beat}` : "",
    chapterPlan ? `${chapterPlan.title} ${chapterPlan.summary}` : "",
    plan.premise
  ]
    .filter(Boolean)
    .join("\n");
  // Embedded once: the research retrieval and the page-memory retrieval share
  // this vector instead of paying two embedding calls for the same string.
  const semanticQueryVector = await embedSemanticQuery(providers.embedding, semanticQueryText, projectId);
  const researchNotes = await loadResearchNotesForGeneration(projectId, strategy, chapterPlan, {
    embedding: providers.embedding,
    queryText: semanticQueryText,
    ...(semanticQueryVector ? { vector: semanticQueryVector } : {})
  });
  const semanticMemory =
    page.index > RECENT_PAGE_WINDOW + 1
      ? await retrieveSemanticPageMemory({
          projectId,
          queryText: semanticQueryText,
          embedding: providers.embedding,
          excludePageIndexes: orderedPreviousPages.map((previousPage) => previousPage.index),
          ...(semanticQueryVector ? { vector: semanticQueryVector } : {})
        })
      : [];
  const entityStateLines = await loadEntityStateLines(projectId, plan);
  const quality = await loadQualityContext(input);
  applyPlanThinkingBoost(providers.text, quality.enabled("planThinkingBoost"));
  const storyState = await loadProjectStoryState(projectId, plan.promises ?? []);
  const storyLines = formatStoryStateLines(storyState);
  const entityState = mergeEntityAndStoryStateLines(entityStateLines, storyLines);
  const styleLockPages = quality.enabled("styleExcerpts")
    ? await loadStyleLockPages(projectId, page.index, priorPageContext)
    : [];
  const styleExcerpts = quality.enabled("styleExcerpts")
    ? pinStyleExcerpts(
        pagesForStyleExcerpts(priorPageContext, styleLockPages),
        sampleExcerptsFromInput(input)
      )
    : [];

  // Sequential drafting still honors operator `draftCandidates`. Ultra-only
  // best-of lives on the polish path (`polishPageWithQualityGates`).
  const candidateCount = bestOfCandidateCount(input);
  await advanceJobStep(
    generationJobId,
    "draft",
    30,
    candidateCount > 1 ? `Drafting page ${page.index} (${candidateCount} candidates)` : `Drafting page ${page.index}`
  );
  const draftOptions = {
    input,
    plan,
    chapter: chapterPlan,
    chapterBrief,
    pageBrief,
    pageIndex: page.index,
    previousSummaries: orderedPreviousPages.map((previousPage) => previousPage.summary).filter(Boolean),
    previousPages: priorPageContext,
    continuityNotes: continuity.map((note) => note.body),
    researchNotes,
    semanticMemory,
    entityState,
    ...(styleExcerpts.length > 0 ? { styleExcerpts } : {}),
    textModel: providers.text
  };
  const draftPage = async (options: typeof draftOptions) => {
    if (!quality.enabled("writerTools")) {
      return strategy.generatePageDraft(options);
    }
    return generatePageDraftWithWriterTools({
      ...options,
      storyState,
      fallback: () => strategy.generatePageDraft(options)
    });
  };
  const initialDraft =
    candidateCount > 1
      ? await generateBestOfPageDrafts({
          draftPage,
          baseOptions: draftOptions,
          candidateCount,
          judgeModel: providers.text
        })
      : await draftPage(draftOptions);
  await advanceJobStep(generationJobId, "qa", 55, `Reviewing page ${page.index}`);
  const initialReport = await strategy.reviewPageDraft({
    input,
    plan,
    chapter: chapterPlan,
    chapterBrief,
    pageBrief,
    pageIndex: page.index,
    draft: initialDraft,
    previousPages: priorPageContext,
    continuityNotes: continuity.map((note) => note.body),
    textModel: providers.text,
    ...(styleExcerpts.length > 0 ? { styleExcerpts } : {})
  });
  const enriched = await enrichPageQualityReport({
    input,
    plan,
    pageIndex: page.index,
    draft: initialDraft,
    report: initialReport,
    previousPages: priorPageContext,
    researchNotes,
    textModel: providers.text,
    projectId,
    ...(quality.enabled("styleExcerpts") ? { styleExcerpts } : {})
  });

  const outcome = await runPageQualityLoop({
    strategy,
    input,
    plan,
    chapter: chapterPlan,
    chapterBrief,
    pageBrief,
    chapterId: page.chapterId,
    pageIndex: page.index,
    draft: initialDraft,
    report: enriched.report,
    previousPages: priorPageContext,
    continuityNotes: continuity.map((note) => note.body),
    textModel: providers.text,
    generationJobId,
    maxCandidates: MAX_PAGE_QA_CANDIDATES,
    repairBrief: true,
    reviseContext: `Page ${page.index}`,
    reviseProgress: 70,
    ...(styleExcerpts.length > 0 ? { styleExcerpts } : {}),
    ...(quality.enabled("claimRetrieve")
      ? {
          retrieveResearch: (draft) =>
            retrieveSemanticResearchNotes({
              projectId,
              queryText: `${draft.title}\n${draft.summary}\n${draft.markdown}`.slice(0, 1200),
              embedding: providers.embedding,
              topK: 6
            })
        }
      : {}),
    onRewrite: (nextRevision) =>
      advanceJobStep(generationJobId, "revise", 70, pageRevisionMessage(page.index, nextRevision, MAX_PAGE_QA_REWRITE_ATTEMPTS))
  });
  const { draft, revision, report: qualityReport } = outcome;

  if (!qualityReport.approved) {
    // Page-level failure isolation: keep the best draft with its honest
    // report, flag the page, and let the rest of the book continue. The page
    // can be retried individually and the final review can still repair it.
    await prisma.page.update({
      where: { id: pageId },
      data: {
        title: draft.title,
        markdown: draft.markdown,
        summary: draft.summary,
        imagePrompt: draft.imagePrompt ?? null,
        status: "FAILED_QA",
        revision,
        qualityReport: qualityReport as Prisma.InputJsonValue
      }
    });
    await persistKeeperStoryDelta({
      projectId,
      pageIndex: page.index,
      draft,
      textModel: providers.text,
      plan,
      input,
      previousExtract: enriched.extract,
      keeperWasRevised: revision > 1,
      currentState: enriched.storyState
    });
    await updateJobProgress(generationJobId, {
      message: `Page ${page.index} kept its best draft but failed quality review; continuing with the next page. ${formatQualityFailure(page.index, qualityReport)}`
    });
    // No maybeEnqueueCompile here: this job's own row is still ACTIVE, so the
    // open-jobs gate can never pass from inside the handler. The compile check
    // that actually fires is maybeCompileAfterCompletedJob in processJob.ts.
    await enqueueNextPageIfReady(projectId, planId, input);
    return;
  }

  await advanceJobStep(generationJobId, "save", 88, `Saving page ${page.index}`);
  // Enqueued before the page is marked COMPLETED, not after: a sibling page's
  // own maybeEnqueueCompile call reads "is this page terminal, are there open
  // image jobs" as two separate queries with nothing serializing them against
  // this function's writes. Saving the page as COMPLETED first opened a window
  // where a concurrent reader could see this page as done with zero open image
  // jobs for it — because the job to make its illustration didn't exist yet —
  // and fire the compile before this page's picture was even queued. Creating
  // that job first closes the window: by the time this page is observably
  // terminal to anyone else, its image job is already there to be counted.
  const willIllustrate = Boolean(draft.imagePrompt) && strategy.shouldIllustratePage(input, plan, page.index);
  if (willIllustrate) {
    await enqueueWorkerJob({
      projectId,
      type: "GENERATE_IMAGE",
      payload: { pageId, planId, prompt: draft.imagePrompt },
      dedupeKey: `generate-image:${pageId}:${planId}:${revision}`
    });
  }
  await prisma.page.update({
    where: { id: pageId },
    data: {
      title: draft.title,
      markdown: draft.markdown,
      summary: draft.summary,
      imagePrompt: draft.imagePrompt ?? null,
      status: "COMPLETED",
      revision,
      qualityReport: qualityReport as Prisma.InputJsonValue
    }
  });
  await persistKeeperStoryDelta({
    projectId,
    pageIndex: page.index,
    draft,
    textModel: providers.text,
    plan,
    input,
    previousExtract: enriched.extract,
    keeperWasRevised: revision > 1,
    currentState: enriched.storyState
  });

  if (draft.continuityNotes.length > 0) {
    await prisma.continuityNote.createMany({
      data: draft.continuityNotes.map((body) => ({
        projectId,
        scope: `page:${page.index}`,
        body,
        tags: ["page", String(page.index)]
      }))
    });
    await updateEntityStateFromPage(projectId, page.index, draft.continuityNotes);
  }

  await storeEmbedding(projectId, `page:${page.index}`, pageId, draft.summary, providers.embedding);

  await enqueueNextPageIfReady(projectId, planId, input);
}

async function loadStyleLockPages(
  projectId: string,
  pageIndex: number,
  recencyPages: PriorPageContext[]
): Promise<PriorPageContext[]> {
  const missing = missingStyleLockIndexes(recencyPages, pageIndex);
  if (missing.length === 0) {
    return [];
  }
  const loaded = await prisma.page.findMany({
    where: { projectId, index: { in: missing }, status: "COMPLETED" }
  });
  return loaded.map(toPriorPageContext);
}

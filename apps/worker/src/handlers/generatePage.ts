import { formatQualityFailure, getProjectOrThrow, parseChapterBrief, strategyForInput, toPriorPageContext } from "../generation/bookHelpers.js";
import { loadResearchNotesForGeneration } from "../generation/generationContext.js";
import { pageRevisionMessage, runPageQualityLoop } from "../generation/pageReview.js";
import {
  RECENT_PAGE_WINDOW,
  loadEntityStateLines,
  retrieveSemanticPageMemory,
  storeEmbedding,
  updateEntityStateFromPage
} from "../generation/semanticMemory.js";
import { MAX_PAGE_QA_CANDIDATES, MAX_PAGE_QA_REWRITE_ATTEMPTS } from "../generation/tuning.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { enqueueNextPageIfReady, enqueueWorkerJob, maybeEnqueueCompile } from "../runtime/dispatch.js";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";
import { bestOfCandidateCount, bookPlanSchema, createProviders, generateBestOfPageDrafts } from "@book-maker/core";
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
  const researchNotes = await loadResearchNotesForGeneration(projectId, strategy, chapterPlan, {
    embedding: providers.embedding,
    queryText: semanticQueryText
  });
  const semanticMemory =
    page.index > RECENT_PAGE_WINDOW + 1
      ? await retrieveSemanticPageMemory({
          projectId,
          queryText: semanticQueryText,
          embedding: providers.embedding,
          excludePageIndexes: orderedPreviousPages.map((previousPage) => previousPage.index)
        })
      : [];
  const entityState = await loadEntityStateLines(projectId, plan);

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
    textModel: providers.text
  };
  const initialDraft =
    candidateCount > 1
      ? await generateBestOfPageDrafts({
          draftPage: strategy.generatePageDraft,
          baseOptions: draftOptions,
          candidateCount,
          judgeModel: providers.text
        })
      : await strategy.generatePageDraft(draftOptions);
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
    textModel: providers.text
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
    report: initialReport,
    previousPages: priorPageContext,
    continuityNotes: continuity.map((note) => note.body),
    textModel: providers.text,
    generationJobId,
    maxCandidates: MAX_PAGE_QA_CANDIDATES,
    repairBrief: true,
    reviseContext: `Page ${page.index}`,
    reviseProgress: 70,
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
    await updateJobProgress(generationJobId, {
      message: `Page ${page.index} kept its best draft but failed quality review; continuing with the next page. ${formatQualityFailure(page.index, qualityReport)}`
    });
    await enqueueNextPageIfReady(projectId, planId);
    await maybeEnqueueCompile(projectId, planId);
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
      name: "generate-image",
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

  await enqueueNextPageIfReady(projectId, planId);
  await maybeEnqueueCompile(projectId, planId);
}

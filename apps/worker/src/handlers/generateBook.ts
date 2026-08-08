import { getProjectOrThrow, strategyForInput } from "../generation/bookHelpers.js";
import {
  generateBookBatchWindow,
  generateBookChapterWholePass,
  generateBookDraftThenPolish,
  generateBookWholePass
} from "../generation/bookPasses.js";
import { prepareChapterSetups } from "../generation/bookState.js";
import { ensureCharacterReferenceAssets } from "../generation/characterReferences.js";
import { embedResearchSourcesForProject } from "../generation/semanticMemory.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { enqueueWorkerJob, maybeEnqueueCompile, maybeEnqueueCover, parallelPageWaveSize } from "../runtime/dispatch.js";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";
import {
  bookPlanSchema,
  createProviders,
  expandChapterResearch,
  type BookGenerationStrategy,
  type BookPlan,
  type CreateProjectInput,
  type ProviderSet
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { Job } from "bullmq";

/**
 * `generate-book` job: pick an execution strategy for a plan, set up chapters and
 * pages, and either fan out per-page jobs or run a direct in-process generation.
 */

export async function generateBook(job: Job) {
  const { projectId, planId } = job.data as { projectId: string; planId: string };
  const generationJobId = job.data.generationJobId as string | undefined;
  const project = await getProjectOrThrow(projectId);
  const planVersion = await prisma.planVersion.findUnique({ where: { id: planId } });
  if (!planVersion) {
    throw new Error("Approved plan not found");
  }
  const input = inputForPlanVersion(project, planVersion.inputSnapshot);
  const plan = bookPlanSchema.parse(planVersion.planningPackage);
  const strategy = strategyForInput(input);
  const providers = createLoggedProviders(job, createProviders(config, input), input);

  await maybeExpandStrategyResearch({
    projectId,
    input,
    plan,
    providers,
    strategy,
    generationJobId
  });

  switch (strategy.executionMode) {
    case "whole-book":
      await generateBookWholePass({
        projectId,
        planId,
        input,
        plan,
        providers,
        strategy,
        generationJobId
      });
      return;
    case "chapter-whole-pass":
      await generateBookChapterWholePass({
        projectId,
        planId,
        input,
        plan,
        providers,
        strategy,
        generationJobId
      });
      return;
    case "batch-window":
      await generateBookBatchWindow({
        projectId,
        planId,
        input,
        plan,
        providers,
        strategy,
        generationJobId
      });
      return;
    case "draft-then-polish":
      await generateBookDraftThenPolish({
        projectId,
        planId,
        input,
        plan,
        providers,
        strategy,
        generationJobId
      });
      return;
    case "sequential-pages":
      await generateBookSequential({
        projectId,
        planId,
        input,
        plan,
        providers,
        strategy,
        generationJobId
      });
      return;
    default:
      assertNeverExecutionMode(strategy.executionMode);
  }
}

export function assertNeverExecutionMode(mode: never): never {
  throw new Error(`Unhandled book generation execution mode: ${String(mode)}`);
}

export async function generateBookSequential(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
}) {
  if (await canResumeSequentialBook(options.projectId, options.plan, options.input)) {
    await advanceJobStep(options.generationJobId, "setup", 65, "Resuming with existing completed pages");
    await prisma.$transaction(async (tx) => {
      await tx.page.updateMany({
        where: { projectId: options.projectId, status: { in: ["GENERATING", "FAILED_QA"] } },
        data: { status: "PENDING" }
      });
      await tx.project.update({ where: { id: options.projectId }, data: { status: "GENERATING" } });
    });
  } else {
    const chapterSetups = await prepareChapterSetups(options);
    await advanceJobStep(options.generationJobId, "setup", 65);

    await prisma.$transaction(async (tx) => {
      await tx.imageAsset.deleteMany({ where: { projectId: options.projectId } });
      await tx.page.deleteMany({ where: { projectId: options.projectId } });
      await tx.chapter.deleteMany({ where: { projectId: options.projectId } });
      await tx.continuityNote.deleteMany({ where: { projectId: options.projectId } });
      await tx.embedding.deleteMany({ where: { projectId: options.projectId, scope: { startsWith: "page:" } } });
      await tx.project.update({ where: { id: options.projectId }, data: { status: "GENERATING" } });

      for (const setup of chapterSetups) {
        const chapter = await tx.chapter.create({
          data: {
            projectId: options.projectId,
            index: setup.chapter.index,
            title: setup.chapter.title,
            summary: setup.chapter.summary,
            targetPages: setup.chapter.targetPages,
            productionBrief: setup.brief as Prisma.InputJsonValue
          }
        });

        for (let pageIndex = setup.startPage; pageIndex <= setup.endPage; pageIndex += 1) {
          await tx.page.create({
            data: {
              projectId: options.projectId,
              chapterId: chapter.id,
              index: pageIndex,
              title: `Page ${pageIndex}`,
              markdown: "",
              summary: "",
              status: "PENDING"
            }
          });
        }
      }
    });
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
  const waveSize = parallelPageWaveSize(options.input);
  const pagesToStart = await prisma.page.findMany({
    where: { projectId: options.projectId, status: "PENDING" },
    orderBy: { index: "asc" },
    take: waveSize
  });
  if (pagesToStart.length > 0) {
    await advanceJobStep(
      options.generationJobId,
      "enqueue",
      85,
      waveSize > 1 ? `Starting ${pagesToStart.length} pages in parallel` : undefined
    );
    for (const pageToStart of pagesToStart) {
      await enqueueWorkerJob({
        projectId: options.projectId,
        type: "GENERATE_PAGE",
        name: "generate-page",
        payload: { pageId: pageToStart.id, planId: options.planId },
        dedupeKey: `generate-page:${pageToStart.id}:${options.planId}`
      });
    }
  } else {
    await maybeEnqueueCompile(options.projectId, options.planId);
  }
}

/**
 * A sequential GENERATE_BOOK re-run keeps completed pages when the existing
 * chapter/page structure still matches the approved plan, so resuming after a
 * failure does not discard finished work.
 */
export async function canResumeSequentialBook(projectId: string, plan: BookPlan, input: CreateProjectInput): Promise<boolean> {
  const [chapters, pages] = await Promise.all([
    prisma.chapter.findMany({ where: { projectId }, orderBy: { index: "asc" }, select: { index: true, title: true, targetPages: true } }),
    prisma.page.findMany({ where: { projectId }, orderBy: { index: "asc" }, select: { index: true, status: true } })
  ]);
  if (pages.length !== input.targetPages) {
    return false;
  }
  if (pages.some((page, position) => page.index !== position + 1)) {
    return false;
  }
  if (chapters.length !== plan.chapters.length) {
    return false;
  }
  const structureMatches = plan.chapters.every((chapterPlan) => {
    const stored = chapters.find((chapter) => chapter.index === chapterPlan.index);
    return stored !== undefined && stored.targetPages === chapterPlan.targetPages && stored.title === chapterPlan.title;
  });
  if (!structureMatches) {
    return false;
  }
  return pages.some((page) => page.status === "COMPLETED");
}

export async function maybeExpandStrategyResearch(options: {
  projectId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
}) {
  const cap = options.strategy.researchDepth ?? 0;
  if (cap <= 0) {
    return;
  }

  await updateJobProgress(options.generationJobId, {
    progress: 15,
    message: "Expanding chapter research"
  });
  const sources = await expandChapterResearch({
    input: options.input,
    plan: options.plan,
    research: options.providers.research,
    cap
  });
  if (sources.length === 0) {
    return;
  }

  await prisma.researchSource.createMany({
    data: sources.map((source) => ({
      projectId: options.projectId,
      query: source.query,
      title: source.title,
      url: source.url ?? null,
      summary: source.summary,
      publishedAt: source.publishedAt ? new Date(source.publishedAt) : null
    }))
  });
  await embedResearchSourcesForProject(options.projectId, options.providers.embedding);
}

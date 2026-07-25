import { directGenerationResumeState, type DirectResumeState } from "../generation/directGenerationResume.js";
import { chapterSetupsForPlan, getProjectOrThrow, normalizedChapters, planInputSnapshot, strategyForInput } from "../generation/bookHelpers.js";
import {
  generateBookBatchWindow,
  generateBookChapterWholePass,
  generateBookDraftThenPolish,
  generateBookWholePass
} from "../generation/bookPasses.js";
import { chapterSetupForPage } from "../generation/generationContext.js";
import { embedResearchSourcesForProject } from "../generation/semanticMemory.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { enqueueWorkerJob, maybeEnqueueCompile, maybeEnqueueCover, parallelPageWaveSize } from "../runtime/dispatch.js";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";
import { type ChapterSetup } from "../runtime/jobTypes.js";
import { jsonInputValue, range } from "../runtime/serialization.js";
import { ensureCharacterReferenceAssets } from "./generateCover.js";
import {
  bookPlanSchema,
  chapterBriefSchema,
  createProviders,
  expandChapterResearch,
  normalizePlanPageTargets,
  type BookGenerationStrategy,
  type BookPlan,
  type ChapterBrief,
  type CreateProjectInput,
  type PriorPageContext,
  type ProviderSet,
  type WholeBookDraft,
  type WholeBookPageDraft
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

export async function prepareChapterSetups(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
}): Promise<ChapterSetup[]> {
  const chapterRanges = chapterSetupsForPlan(options.plan, options.input.targetPages);
  const createChapterBriefs = options.strategy.createChapterBriefs;
  if (createChapterBriefs) {
    await updateJobProgress(options.generationJobId, {
      progress: 25,
      message: "Creating global page map"
    });
    const briefs = await createChapterBriefs({
      input: options.input,
      plan: options.plan,
      textModel: options.providers.text
    });
    return chapterRanges.map((setup) => ({
      ...setup,
      brief: requireBriefForChapter(briefs, setup)
    }));
  }

  const chapterSetups: ChapterSetup[] = [];
  for (const [chapterIndex, setup] of chapterRanges.entries()) {
    await updateJobProgress(options.generationJobId, {
      progress: 15 + Math.round((chapterIndex / Math.max(chapterRanges.length, 1)) * 40),
      message: `Chapter brief ${chapterIndex + 1}/${chapterRanges.length}`
    });
    const brief = await options.strategy.generateChapterBrief({
      input: options.input,
      plan: options.plan,
      chapter: setup.chapter,
      chapterPageStart: setup.startPage,
      chapterPageEnd: setup.endPage,
      textModel: options.providers.text
    });
    chapterSetups.push({ ...setup, brief });
  }
  return chapterSetups;
}

export function requireBriefForChapter(briefs: ChapterBrief[], setup: ChapterSetup): ChapterBrief {
  const brief = briefs.find((candidate) => candidate.chapterIndex === setup.chapter.index);
  if (!brief) {
    throw new Error(`Page map missing chapter ${setup.chapter.index}.`);
  }
  const expectedPages = range(setup.startPage, setup.endPage);
  const actualPages = brief.pages.map((page) => page.pageIndex);
  if (actualPages.length !== expectedPages.length || actualPages.some((pageIndex, index) => pageIndex !== expectedPages[index])) {
    throw new Error(
      `Page map for chapter ${setup.chapter.index} must contain pages ${expectedPages.join(", ")} in order. Received ${actualPages.join(", ")}.`
    );
  }
  return brief;
}

export async function resetBookForDirectGeneration(projectId: string, chapterSetups: ChapterSetup[]): Promise<Map<number, string>> {
  return prisma.$transaction(async (tx) => {
    await tx.imageAsset.deleteMany({ where: { projectId } });
    await tx.page.deleteMany({ where: { projectId } });
    await tx.chapter.deleteMany({ where: { projectId } });
    await tx.continuityNote.deleteMany({ where: { projectId } });
    await tx.embedding.deleteMany({ where: { projectId, scope: { startsWith: "page:" } } });
    await tx.project.update({ where: { id: projectId }, data: { status: "GENERATING" } });

    const chapterIds = new Map<number, string>();
    for (const setup of chapterSetups) {
      const chapter = await tx.chapter.create({
        data: {
          projectId,
          index: setup.chapter.index,
          title: setup.chapter.title,
          summary: setup.chapter.summary,
          targetPages: setup.chapter.targetPages,
          ...(setup.brief ? { productionBrief: setup.brief as Prisma.InputJsonValue } : {})
        }
      });
      chapterIds.set(setup.chapter.index, chapter.id);
    }
    return chapterIds;
  });
}

export type StoredResumeChapter = {
  id: string;
  index: number;
  title: string;
  targetPages: number;
  brief: ChapterBrief | undefined;
};

export type StoredResumePage = {
  index: number;
  status: string;
  title: string;
  markdown: string;
  summary: string;
  imagePrompt: string | null;
};

export type DirectResumeContext = {
  chapters: StoredResumeChapter[];
  pages: StoredResumePage[];
};

export async function loadDirectResumeContext(projectId: string): Promise<DirectResumeContext> {
  const [chapters, pages] = await Promise.all([
    prisma.chapter.findMany({
      where: { projectId },
      orderBy: { index: "asc" },
      select: { id: true, index: true, title: true, targetPages: true, productionBrief: true }
    }),
    prisma.page.findMany({
      where: { projectId },
      orderBy: { index: "asc" },
      select: { index: true, status: true, title: true, markdown: true, summary: true, imagePrompt: true }
    })
  ]);
  return {
    chapters: chapters.map((chapter) => {
      const parsed = chapter.productionBrief === null ? null : chapterBriefSchema.safeParse(chapter.productionBrief);
      return {
        id: chapter.id,
        index: chapter.index,
        title: chapter.title,
        targetPages: chapter.targetPages,
        brief: parsed?.success ? parsed.data : undefined
      };
    }),
    pages
  };
}

export function directResumeStateForContext(options: {
  targetPages: number;
  plan: BookPlan;
  context: DirectResumeContext;
  requiresBriefs: boolean;
  requireAllPagesPresent: boolean;
}): DirectResumeState {
  return directGenerationResumeState({
    targetPages: options.targetPages,
    planChapters: normalizedChapters(options.plan, options.targetPages).map((chapter) => ({
      index: chapter.index,
      title: chapter.title,
      targetPages: chapter.targetPages
    })),
    storedChapters: options.context.chapters.map((chapter) => ({
      index: chapter.index,
      title: chapter.title,
      targetPages: chapter.targetPages,
      hasBrief: chapter.brief !== undefined
    })),
    storedPages: options.context.pages.map((page) => ({ index: page.index, status: page.status })),
    requiresBriefs: options.requiresBriefs,
    requireAllPagesPresent: options.requireAllPagesPresent
  });
}

/**
 * Rebuilds chapter setups from the rows a previous run persisted so a resumed
 * job skips prepareChapterSetups (and its brief-generation model calls). Only
 * valid when directGenerationResumeState already confirmed the stored
 * structure matches the plan.
 */
export function rebuildChapterSetupsFromStored(
  plan: BookPlan,
  targetPages: number,
  storedChapters: StoredResumeChapter[]
): { chapterSetups: ChapterSetup[]; chapterIds: Map<number, string> } {
  const byIndex = new Map(storedChapters.map((chapter) => [chapter.index, chapter]));
  const chapterIds = new Map<number, string>();
  const chapterSetups = chapterSetupsForPlan(plan, targetPages).map((setup) => {
    const stored = byIndex.get(setup.chapter.index);
    if (stored) {
      chapterIds.set(setup.chapter.index, stored.id);
    }
    return { ...setup, brief: stored?.brief };
  });
  return { chapterSetups, chapterIds };
}

/** Settled pages before the resume point, as generation context for the remaining pages. */
export function priorPageContextsFromStored(pages: StoredResumePage[], beforeIndex: number): PriorPageContext[] {
  return pages
    .filter((page) => page.index < beforeIndex && (page.status === "COMPLETED" || page.status === "FAILED_QA"))
    .sort((a, b) => a.index - b.index)
    .map((page) => ({ index: page.index, title: page.title, markdown: page.markdown, summary: page.summary }));
}

/**
 * Persists an accepted whole-book draft as PENDING page rows before polishing
 * begins, so a failure during the polish loop can resume without repeating the
 * whole-book draft call — the most expensive step of draft-then-polish. The
 * polish loop's upsert flips each row to COMPLETED/FAILED_QA in place.
 */
export async function checkpointWholeBookDraftPages(options: {
  projectId: string;
  chapterSetups: ChapterSetup[];
  chapterIds: Map<number, string>;
  pages: WholeBookPageDraft[];
}): Promise<void> {
  await prisma.page.createMany({
    data: options.pages.map((page) => {
      const setup = chapterSetupForPage(options.chapterSetups, page.index);
      return {
        projectId: options.projectId,
        chapterId: setup ? options.chapterIds.get(setup.chapter.index) ?? null : null,
        index: page.index,
        title: page.title,
        markdown: page.markdown,
        summary: page.summary,
        imagePrompt: page.imagePrompt ?? null,
        status: "PENDING" as const
      };
    })
  });
}

export function effectiveWholeBookDraftContext(
  input: CreateProjectInput,
  plan: BookPlan,
  draft: WholeBookDraft,
  exactTargetChapterSetups?: ChapterSetup[]
): { input: CreateProjectInput; plan: BookPlan; chapterSetups: ChapterSetup[] } {
  const acceptedPages = draft.pageSetDiagnostics?.acceptedPages ?? draft.pages.length;
  const targetPages = Math.max(1, acceptedPages);
  const targetChanged = targetPages !== input.targetPages;
  const inputForAcceptedPages = targetChanged ? { ...input, targetPages } : input;
  const planForAcceptedPages = targetChanged ? normalizePlanPageTargets(plan, targetPages) : plan;
  const canReuseExactSetups =
    !targetChanged && draft.pageSetDiagnostics?.renumbered !== true && exactTargetChapterSetups !== undefined;

  return {
    input: inputForAcceptedPages,
    plan: planForAcceptedPages,
    chapterSetups: canReuseExactSetups ? exactTargetChapterSetups : chapterSetupsForPlan(planForAcceptedPages, targetPages)
  };
}

export async function reportAcceptedWholeBookDraft(
  generationJobId: string | undefined,
  draft: WholeBookDraft
): Promise<string | undefined> {
  const message = wholeBookDraftAcceptanceMessage(draft);
  if (!message) {
    return undefined;
  }
  await updateJobProgress(generationJobId, { message });
  return message;
}

export function wholeBookDraftAcceptanceMessage(draft: WholeBookDraft): string | undefined {
  const diagnostics = draft.pageSetDiagnostics;
  if (!diagnostics) {
    return undefined;
  }
  const noteworthy =
    diagnostics.acceptedPages !== diagnostics.requestedPages ||
    diagnostics.renumbered ||
    diagnostics.missingIndexes.length > 0 ||
    diagnostics.unexpectedIndexes.length > 0 ||
    diagnostics.duplicateIndexes.length > 0;
  if (!noteworthy) {
    return undefined;
  }

  const details = [
    diagnostics.missingIndexes.length ? `missing ${diagnostics.missingIndexes.join(", ")}` : "",
    diagnostics.unexpectedIndexes.length ? `unexpected ${diagnostics.unexpectedIndexes.join(", ")}` : "",
    diagnostics.duplicateIndexes.length ? `duplicate ${diagnostics.duplicateIndexes.join(", ")}` : ""
  ].filter(Boolean);
  const suffix = details.length > 0 ? ` (${details.join("; ")})` : "";
  return `Accepted ${diagnostics.acceptedPages} generated pages for a ${diagnostics.requestedPages}-page target${suffix}.`;
}

export async function persistAcceptedWholeBookTarget(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  draft: WholeBookDraft;
}): Promise<void> {
  const diagnostics = options.draft.pageSetDiagnostics;
  if (!diagnostics || diagnostics.acceptedPages === diagnostics.requestedPages) {
    return;
  }

  await prisma.$transaction([
    prisma.project.update({
      where: { id: options.projectId },
      data: { targetPages: diagnostics.acceptedPages }
    }),
    prisma.planVersion.update({
      where: { id: options.planId },
      data: {
        inputSnapshot: planInputSnapshot(options.input),
        planningPackage: jsonInputValue(options.plan)
      }
    })
  ]);
}

import { Job, Queue, UnrecoverableError, Worker, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertBookLikeMarkdown,
  bookPlanSchema,
  buildCoverArtworkPrompt,
  buildCharacterReferencePrompt,
  calculateImageGenerationCost,
  calculateTextGenerationCost,
  chapterBriefSchema,
  createProviders,
  createReaderChaptersForExport,
  expandChapterResearch,
  renderCoverPng,
  getBookGenerationStrategy,
  isDiagramFriendlyBookCategory,
  selectCharacterReferenceAssets,
  shouldGenerateCharacterReferences,
  shouldUseCharacterReferenceImages,
  isRecoverableNetworkError,
  loadConfig,
  normalizePlanPageTargets,
  optimizeImageForStorage,
  publicAssetUrl,
  resolvePublicImageUrl,
  type BookPlan,
  type BookGenerationStrategy,
  type ChapterBrief,
  type ChapterPlan,
  type CreateProjectInput,
  type EmbeddingAdapter,
  type FinalBookQa,
  type GenerateJsonOptions,
  type GenerateTextOptions,
  type ImageAdapter,
  type ImageAdapterCapabilities,
  type ImageRequest,
  type OptimizedImage,
  type JobStep,
  type PageQualityReport,
  type PageDraft,
  type PageProductionBeat,
  type ProviderSet,
  type PriorPageContext,
  type ResearchAdapter,
  type ResearchQuery,
  type RevisePageOptions,
  type TextModelAdapter,
  type Usage,
  withRecoverableNetworkRetry
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { inputForPlanVersion, inputFromProject, inputFromSnapshot } from "./projectInput.js";

const BOOK_QUEUE_NAME = "book-maker";
const MAX_FINAL_QA_REPAIR_PAGES = 4;
const MAX_FINAL_QA_REVISIONS_PER_PAGE = 4;
const MAX_PAGE_QA_CANDIDATES = 6;
const MAX_PAGE_REVISE_RESTARTS = 2;
const PAGE_QA_RECOVERY_CANDIDATE = 4;
const GENERATE_PAGE_RECOVERY_ATTEMPTS = 4;
const GENERATE_PAGE_RECOVERY_BACKOFF_MS = 15_000;
const PROVIDER_NETWORK_RETRY_ATTEMPTS = 3;
const PROVIDER_NETWORK_RETRY_DELAY_MS = 2_000;
const STOPPED_JOB_MESSAGE = "Stopped";
const STOPPED_JOB_ERROR = "Stopped by user";

type ExportPageForRepair = {
  id: string;
  index: number;
  title: string;
  markdown: string;
  summary: string;
  imagePrompt: string | null;
  revision: number;
  chapter?: { index: number; productionBrief: unknown } | null;
  images: Array<{ path: string }>;
};

type ChapterSetup = {
  chapter: ChapterPlan;
  brief?: ChapterBrief | undefined;
  startPage: number;
  endPage: number;
};

type IndexedPageDraft = PageDraft & {
  index: number;
};

class StopRequestedError extends Error {
  constructor() {
    super(STOPPED_JOB_ERROR);
    this.name = "StopRequestedError";
  }
}

type WorkerImageAsset = {
  id: string;
  path: string;
  metadata: unknown;
};

const JOB_STEP_TEMPLATES: Record<string, Array<{ key: string; label: string }>> = {
  "plan-book": [
    { key: "research", label: "Research" },
    { key: "plan", label: "Create plan" },
    { key: "save", label: "Save plan" }
  ],
  "revise-plan": [
    { key: "revise", label: "Revise plan" },
    { key: "save", label: "Save revision" }
  ],
  "generate-book": [
    { key: "briefs", label: "Prepare book" },
    { key: "setup", label: "Create pages" },
    { key: "enqueue", label: "Queue follow-ups" }
  ],
  "generate-page": [
    { key: "prepare", label: "Prepare context" },
    { key: "draft", label: "Draft page" },
    { key: "qa", label: "Quality review" },
    { key: "revise", label: "Revise draft" },
    { key: "save", label: "Save page" }
  ],
  "generate-image": [
    { key: "prompt", label: "Build prompt" },
    { key: "render", label: "Render image" },
    { key: "store", label: "Store asset" }
  ],
  "compile-export": [
    { key: "qa", label: "Final review" },
    { key: "compile", label: "Compile markdown" },
    { key: "write", label: "Write Markdown" },
    { key: "pdf", label: "Generate PDF" }
  ]
};

const config = loadConfig();
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(BOOK_QUEUE_NAME, { connection });

const worker = new Worker(
  BOOK_QUEUE_NAME,
  async (job) => {
    const runLogger = createRunLogger(job);
    await runLogger.append("job.start", {
      payload: job.data,
      attemptsMade: job.attemptsMade,
      opts: job.opts,
      providerConfig: providerConfigSnapshot()
    });
    await markActive(job);
    try {
      switch (job.name) {
        case "plan-book":
          await planBook(job);
          break;
        case "revise-plan":
          await revisePlan(job);
          break;
        case "generate-book":
          await generateBook(job);
          break;
        case "generate-page":
          await generatePage(job);
          break;
        case "generate-image":
          await generateImage(job);
          break;
        case "compile-export":
          await compileExport(job);
          break;
        default:
          throw new Error(`Unknown worker job: ${job.name}`);
      }
      await markCompleted(job);
      await runLogger.append("job.completed", {});
      await maybeCompileAfterCompletedJob(job);
    } catch (error) {
      if (isStopRequestedError(error)) {
        await runLogger.append("job.stopped", {});
        await markStopped(job);
        throw new UnrecoverableError(STOPPED_JOB_ERROR);
      }

      if (await hasStoppedGenerationJob(job.data.generationJobId as string | undefined)) {
        await runLogger.append("job.stopped", { interruptedError: serializeError(error) });
        await markStopped(job);
        throw new UnrecoverableError(STOPPED_JOB_ERROR);
      }

      if (shouldRecoverJobAttempt(job, error)) {
        await runLogger.append("job.recovering", {
          error: serializeError(error),
          attempt: job.attemptsMade + 1,
          maxAttempts: jobMaxAttempts(job)
        });
        await markRecovering(job, error);
        throw error;
      }

      await runLogger.append("job.failed", { error: serializeError(error) });
      await markFailed(job, error);
      if (shouldBypassConfiguredRetries(job, error)) {
        throw new UnrecoverableError(errorMessage(error));
      }
      throw error;
    }
  },
  {
    connection,
    concurrency: Math.max(config.MAX_PARALLEL_PAGE_JOBS, config.MAX_PARALLEL_IMAGE_JOBS)
  }
);

worker.on("ready", () => {
  console.log(`Book worker ready on queue "${BOOK_QUEUE_NAME}"`);
});

worker.on("failed", (job, error) => {
  console.error(`Job ${job?.id ?? "unknown"} failed`, error);
});

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

async function planBook(job: Job) {
  const { projectId, inputSnapshot } = job.data as { projectId: string; inputSnapshot?: unknown };
  const generationJobId = job.data.generationJobId as string | undefined;
  const project = await getProjectOrThrow(projectId);
  const input = inputFromSnapshot(inputSnapshot) ?? inputFromProject(project);
  const strategy = strategyForInput(input);
  const providers = createLoggedProviders(job, createProviders(config, input));
  await advanceJobStep(generationJobId, "research", 20);
  const plan = await strategy.createPlan({
    input,
    textModel: providers.text,
    research: providers.research,
    forceFallback: config.MOCK_AI
  });
  await advanceJobStep(generationJobId, "plan", 55);
  const version = await nextPlanVersion(projectId);

  await prisma.$transaction(async (tx) => {
    const planVersion = await tx.planVersion.create({
      data: {
        projectId,
        version,
        planningPackage: plan,
        inputSnapshot: planInputSnapshot(input),
        messages: []
      }
    });

    await tx.project.update({
      where: { id: projectId },
      data: { status: "PLAN_READY", currentPlanId: planVersion.id, title: plan.title }
    });

    await tx.character.deleteMany({ where: { projectId } });
    await tx.location.deleteMany({ where: { projectId } });

    if (plan.characters.length > 0) {
      await tx.character.createMany({
        data: plan.characters.map((character) => ({
          projectId,
          name: character.name,
          role: character.role,
          description: character.description,
          traits: character.traits,
          visualRules: character.visualRules
        }))
      });
    }

    if (plan.locations.length > 0) {
      await tx.location.createMany({
        data: plan.locations.map((location) => ({
          projectId,
          name: location.name,
          description: location.description,
          rules: location.rules
        }))
      });
    }

    if (plan.researchNotes.length > 0) {
      await tx.researchSource.createMany({
        data: plan.researchNotes.map((source) => ({
          projectId,
          query: source.query,
          title: source.title,
          url: source.url ?? null,
          summary: source.summary,
          publishedAt: source.publishedAt ? new Date(source.publishedAt) : null
        }))
      });
    }
  });
  await advanceJobStep(generationJobId, "save", 90);
}

async function revisePlan(job: Job) {
  const { projectId, planId, message } = job.data as { projectId: string; planId: string; message: string };
  const generationJobId = job.data.generationJobId as string | undefined;
  const planVersion = await prisma.planVersion.findUnique({ where: { id: planId }, include: { project: true } });
  if (!planVersion) {
    throw new Error("Plan not found");
  }
  const input = inputForPlanVersion(planVersion.project, planVersion.inputSnapshot);
  const strategy = strategyForInput(input);
  const providers = createLoggedProviders(job, createProviders(config, input));
  const currentPlan = bookPlanSchema.parse(planVersion.planningPackage);
  await advanceJobStep(generationJobId, "revise", 35);
  const revised = await strategy.revisePlan({
    currentPlan,
    userMessage: message,
    textModel: providers.text,
    targetPages: input.targetPages,
    temperature: input.temperature,
    lessCensored: input.mediaSettings.lessCensored === true,
    language: input.language,
    toneProfile: input.mediaSettings.toneProfile
  });
  const version = await nextPlanVersion(projectId);
  const priorMessages = Array.isArray(planVersion.messages) ? planVersion.messages : [];

  await prisma.$transaction(async (tx) => {
    await tx.planVersion.update({
      where: { id: planId },
      data: { status: "SUPERSEDED" }
    });
    const newPlan = await tx.planVersion.create({
      data: {
        projectId,
        version,
        planningPackage: revised,
        inputSnapshot: planInputSnapshot(input),
        messages: [...priorMessages, { role: "user", content: message, at: new Date().toISOString() }]
      }
    });
    await tx.project.update({
      where: { id: projectId },
      data: { currentPlanId: newPlan.id, status: "PLAN_READY", title: revised.title }
    });
  });
  await advanceJobStep(generationJobId, "save", 90);
}

async function generateBook(job: Job) {
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
  const providers = createLoggedProviders(job, createProviders(config, input));

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
  }

}

async function generateBookSequential(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
}) {
  const chapterSetups = await prepareChapterSetups(options);
  await advanceJobStep(options.generationJobId, "setup", 65);

  await prisma.$transaction(async (tx) => {
    await tx.imageAsset.deleteMany({ where: { projectId: options.projectId } });
    await tx.page.deleteMany({ where: { projectId: options.projectId } });
    await tx.chapter.deleteMany({ where: { projectId: options.projectId } });
    await tx.continuityNote.deleteMany({ where: { projectId: options.projectId } });
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
  const firstPage = await prisma.page.findFirst({ where: { projectId: options.projectId }, orderBy: { index: "asc" } });
  if (firstPage) {
    await advanceJobStep(options.generationJobId, "enqueue", 85);
    await enqueueWorkerJob({
      projectId: options.projectId,
      type: "GENERATE_PAGE",
      name: "generate-page",
      payload: { pageId: firstPage.id, planId: options.planId }
    });
  }
}

async function maybeExpandStrategyResearch(options: {
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
}

async function prepareChapterSetups(options: {
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

function requireBriefForChapter(briefs: ChapterBrief[], setup: ChapterSetup): ChapterBrief {
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

async function resetBookForDirectGeneration(projectId: string, chapterSetups: ChapterSetup[]): Promise<Map<number, string>> {
  return prisma.$transaction(async (tx) => {
    await tx.imageAsset.deleteMany({ where: { projectId } });
    await tx.page.deleteMany({ where: { projectId } });
    await tx.chapter.deleteMany({ where: { projectId } });
    await tx.continuityNote.deleteMany({ where: { projectId } });
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

async function generateBookChapterWholePass(options: {
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

  const chapterSetups = await prepareChapterSetups(options);
  await advanceJobStep(options.generationJobId, "setup", 35, "Preparing chapter records");
  const chapterIds = await resetBookForDirectGeneration(options.projectId, chapterSetups);
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
  const previousPages: PriorPageContext[] = [];

  for (const [chapterIndex, setup] of chapterSetups.entries()) {
    await updateJobProgress(options.generationJobId, {
      progress: 35 + Math.round((chapterIndex / Math.max(chapterSetups.length, 1)) * 45),
      message: `Drafting chapter ${chapterIndex + 1}/${chapterSetups.length}`
    });
    const continuityNotes = await loadContinuityNotes(options.projectId);
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

async function generateBookBatchWindow(options: {
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

  const chapterSetups = await prepareChapterSetups(options);
  await advanceJobStep(options.generationJobId, "setup", 35, "Preparing batch records");
  const chapterIds = await resetBookForDirectGeneration(options.projectId, chapterSetups);
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
  const previousPages: PriorPageContext[] = [];
  const batchSize = Math.max(1, options.strategy.batchSize ?? 4);
  const totalBatches = Math.ceil(options.input.targetPages / batchSize);

  for (let pageStart = 1, batchIndex = 0; pageStart <= options.input.targetPages; pageStart += batchSize, batchIndex += 1) {
    const pageEnd = Math.min(options.input.targetPages, pageStart + batchSize - 1);
    await updateJobProgress(options.generationJobId, {
      progress: 35 + Math.round((batchIndex / Math.max(totalBatches, 1)) * 45),
      message: `Drafting pages ${pageStart}-${pageEnd}`
    });
    const continuityNotes = await loadContinuityNotes(options.projectId);
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

async function generateBatchFallbackPageDraft(options: {
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
  const continuityNotes = await loadContinuityNotes(options.projectId);
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

function isRecoverableBatchDraftRangeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^Page batch returned (?:pages out of order or outside the requested range|an invalid page set)/i.test(error.message)
  );
}

async function generateBookDraftThenPolish(options: {
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

  const chapterSetups: ChapterSetup[] = options.strategy.createChapterBriefs
    ? await prepareChapterSetups(options)
    : chapterSetupsForPlan(options.plan, options.input.targetPages);
  const chapterBriefs = chapterSetups.flatMap((setup) => (setup.brief ? [setup.brief] : []));
  const research = await prisma.researchSource.findMany({ where: { projectId: options.projectId }, take: 20 });
  await advanceJobStep(options.generationJobId, "briefs", chapterBriefs.length > 0 ? 30 : 20, "Drafting whole book");
  const draft = await generateWholeBookDraft({
    input: options.input,
    plan: options.plan,
    chapterBriefs: chapterBriefs.length > 0 ? chapterBriefs : undefined,
    researchNotes: research.map((source) => `${source.title}: ${source.summary}`),
    textModel: options.providers.text
  });

  await advanceJobStep(options.generationJobId, "setup", 35, "Preparing polish records");
  const chapterIds = await resetBookForDirectGeneration(options.projectId, chapterSetups);
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
  const previousPages: PriorPageContext[] = [];
  const rawPages = draft.pages.map((page) => ({
    index: page.index,
    title: page.title,
    markdown: page.markdown,
    summary: page.summary
  }));

  for (const [pageOffset, pageDraft] of draft.pages.entries()) {
    await updateJobProgress(options.generationJobId, {
      progress: 35 + Math.round((pageOffset / Math.max(draft.pages.length, 1)) * 45),
      message: `Polishing page ${pageDraft.index}`
    });
    const continuityNotes = await loadContinuityNotes(options.projectId);
    const setup = chapterSetupForPage(chapterSetups, pageDraft.index);
    const chapterBrief = setup?.brief;
    const pageBrief = chapterBrief?.pages.find((brief) => brief.pageIndex === pageDraft.index);
    const researchNotes = await loadResearchNotesForGeneration(options.projectId, options.strategy, setup?.chapter);
    const polished = await polishPageDraft({
      input: options.input,
      plan: options.plan,
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
    });
    const saved = await reviewAndSaveGeneratedPage({
      projectId: options.projectId,
      planId: options.planId,
      input: options.input,
      plan: options.plan,
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

async function reviewAndSaveGeneratedPage(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  draft: IndexedPageDraft;
  chapterId: string | null;
  chapter?: ChapterPlan | undefined;
  chapterBrief?: ChapterBrief | undefined;
  chapterPageStart?: number | undefined;
  chapterPageEnd?: number | undefined;
  previousPages: PriorPageContext[];
  generationJobId?: string | undefined;
}): Promise<PriorPageContext> {
  let pageBrief = options.chapterBrief?.pages.find((brief) => brief.pageIndex === options.draft.index);
  const continuityNotes = await loadContinuityNotes(options.projectId);
  let revision = 1;
  let draft: PageDraft = options.draft;
  let qualityReport = await options.strategy.reviewPageDraft({
    input: options.input,
    plan: options.plan,
    chapter: options.chapter,
    chapterBrief: options.chapterBrief,
    pageBrief,
    chapterPageStart: options.chapterPageStart,
    chapterPageEnd: options.chapterPageEnd,
    pageIndex: options.draft.index,
    draft,
    previousPages: options.previousPages,
    continuityNotes,
    textModel: options.providers.text
  });

  while (!qualityReport.approved && revision < MAX_PAGE_QA_CANDIDATES) {
    const nextRevision = revision + 1;
    await updateJobProgress(options.generationJobId, {
      message: pageRevisionMessage(options.draft.index, nextRevision, MAX_PAGE_QA_CANDIDATES)
    });
    if (shouldRepairPageBriefForRecovery(nextRevision, qualityReport, pageBrief)) {
      pageBrief = await repairPageBriefForRecovery({
        strategy: options.strategy,
        input: options.input,
        plan: options.plan,
        chapter: options.chapter,
        chapterBrief: options.chapterBrief,
        chapterPageStart: options.chapterPageStart,
        chapterPageEnd: options.chapterPageEnd,
        chapterId: options.chapterId,
        pageBrief,
        pageIndex: options.draft.index,
        draft,
        qualityReport,
        previousPages: options.previousPages,
        continuityNotes,
        textModel: options.providers.text,
        generationJobId: options.generationJobId,
        context: `Page ${options.draft.index}`
      });
    }
    draft = await revisePageDraftWithRestart({
      strategy: options.strategy,
      generationJobId: options.generationJobId,
      context: `Page ${options.draft.index}`,
      reviseOptions: {
        input: options.input,
        plan: options.plan,
        chapter: options.chapter,
        chapterBrief: options.chapterBrief,
        pageBrief,
        chapterPageStart: options.chapterPageStart,
        chapterPageEnd: options.chapterPageEnd,
        pageIndex: options.draft.index,
        draft,
        report: pageRewriteReport(qualityReport, nextRevision),
        previousPages: options.previousPages,
        continuityNotes,
        textModel: options.providers.text
      }
    });
    revision = nextRevision;
    qualityReport = await options.strategy.reviewPageDraft({
      input: options.input,
      plan: options.plan,
      chapter: options.chapter,
      chapterBrief: options.chapterBrief,
      pageBrief,
      chapterPageStart: options.chapterPageStart,
      chapterPageEnd: options.chapterPageEnd,
      pageIndex: options.draft.index,
      draft,
      previousPages: options.previousPages,
      continuityNotes,
      textModel: options.providers.text
    });
  }

  if (!qualityReport.approved) {
    throw new Error(formatQualityFailure(options.draft.index, qualityReport));
  }

  const page = await prisma.page.upsert({
    where: { projectId_index: { projectId: options.projectId, index: options.draft.index } },
    create: {
      projectId: options.projectId,
      chapterId: options.chapterId,
      index: options.draft.index,
      title: draft.title,
      markdown: draft.markdown,
      summary: draft.summary,
      imagePrompt: draft.imagePrompt ?? null,
      status: "COMPLETED",
      revision,
      qualityReport: qualityReport as Prisma.InputJsonValue
    },
    update: {
      chapterId: options.chapterId,
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
        projectId: options.projectId,
        scope: `page:${options.draft.index}`,
        body,
        tags: ["page", String(options.draft.index), options.strategy.id]
      }))
    });
  }

  await storeEmbedding(options.projectId, `page:${options.draft.index}`, page.id, draft.summary, options.providers.embedding);

  if (draft.imagePrompt && options.strategy.shouldIllustratePage(options.input, options.plan, options.draft.index)) {
    await enqueueWorkerJob({
      projectId: options.projectId,
      type: "GENERATE_IMAGE",
      name: "generate-image",
      payload: { pageId: page.id, planId: options.planId, prompt: draft.imagePrompt }
    });
  }

  return {
    index: options.draft.index,
    title: draft.title,
    markdown: draft.markdown,
    summary: draft.summary
  };
}

async function revisePageDraftWithRestart(options: {
  strategy: BookGenerationStrategy;
  reviseOptions: RevisePageOptions;
  context: string;
  generationJobId?: string | undefined;
  progress?: number | undefined;
  maxRestarts?: number | undefined;
}): Promise<PageDraft> {
  const maxRestarts = options.maxRestarts ?? MAX_PAGE_REVISE_RESTARTS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRestarts + 1; attempt += 1) {
    try {
      return await options.strategy.revisePageDraft(options.reviseOptions);
    } catch (error) {
      lastError = error;
      if (attempt > maxRestarts) {
        throw error;
      }

      await updateJobProgress(options.generationJobId, {
        ...(options.progress !== undefined ? { progress: options.progress } : {}),
        message: `${options.context} revise failed; restarting with the generated page and revision (${attempt + 1}/${
          maxRestarts + 1
        }).`
      });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${options.context} revise failed.`);
}

function pageRevisionMessage(pageIndex: number, revision: number, maxRevisions: number): string {
  const phase = revision >= PAGE_QA_RECOVERY_CANDIDATE ? "Quality recovery rewrite" : "Revising";
  return `${phase} page ${pageIndex} (attempt ${revision}/${maxRevisions})`;
}

function pageRewriteReport(
  report: PageQualityReport,
  revision: number,
  recoveryRevision = PAGE_QA_RECOVERY_CANDIDATE
): PageQualityReport {
  if (revision < recoveryRevision) {
    return report;
  }

  const recoveryInstructions = [
    `Previous rewrite attempts still failed QA; produce a complete replacement page for attempt ${revision}.`,
    "Use the rejected page only as diagnostic context, not as prose to preserve.",
    "Do not relax quality: satisfy the page brief, advance beyond prior pages, avoid repetition, and keep the page reader-ready."
  ];

  return {
    ...report,
    issues: [...report.issues, "Earlier generated replacements for this page were still rejected by QA."],
    requiredRevisions: [...report.requiredRevisions, ...recoveryInstructions],
    notes: [report.notes, "Quality recovery mode: make a structural replacement rather than a light edit."]
      .filter(Boolean)
      .join(" ")
  };
}

function shouldRepairPageBriefForRecovery(
  revision: number,
  report: PageQualityReport,
  pageBrief: PageProductionBeat | undefined
): pageBrief is PageProductionBeat {
  if (!pageBrief || revision < PAGE_QA_RECOVERY_CANDIDATE) {
    return false;
  }

  if (!report.checks.repetitionOk || !report.checks.progressionOk) {
    return true;
  }

  const feedback = [...report.issues, ...report.requiredRevisions, report.notes].join(" ").toLowerCase();
  return /brief|assignment|repeat|repetition|already covered|same (argument|beat|point|scene)|stalled|does not progress|new distinct|fresh angle/.test(
    feedback
  );
}

async function repairPageBriefForRecovery(options: {
  strategy: BookGenerationStrategy;
  input: CreateProjectInput;
  plan: BookPlan;
  chapter?: ChapterPlan | undefined;
  chapterBrief?: ChapterBrief | undefined;
  chapterPageStart?: number | undefined;
  chapterPageEnd?: number | undefined;
  chapterId?: string | null | undefined;
  pageBrief: PageProductionBeat;
  pageIndex: number;
  draft: PageDraft;
  qualityReport: PageQualityReport;
  previousPages: PriorPageContext[];
  continuityNotes: string[];
  textModel: TextModelAdapter;
  generationJobId?: string | undefined;
  context: string;
}): Promise<PageProductionBeat> {
  await updateJobProgress(options.generationJobId, {
    message: `${options.context} brief conflict detected; repairing page brief before recovery rewrite.`
  });

  const repaired = await options.strategy.repairPageBrief({
    input: options.input,
    plan: options.plan,
    chapter: options.chapter,
    chapterBrief: options.chapterBrief,
    pageBrief: options.pageBrief,
    chapterPageStart: options.chapterPageStart,
    chapterPageEnd: options.chapterPageEnd,
    pageIndex: options.pageIndex,
    draft: options.draft,
    report: options.qualityReport,
    previousPages: options.previousPages,
    continuityNotes: options.continuityNotes,
    textModel: options.textModel
  });

  const updatedChapterBrief = replacePageBriefInChapterBrief(options.chapterBrief, repaired);
  if (options.chapterId && updatedChapterBrief) {
    await prisma.chapter.update({
      where: { id: options.chapterId },
      data: { productionBrief: updatedChapterBrief as Prisma.InputJsonValue }
    });
  }

  return repaired;
}

function replacePageBriefInChapterBrief(
  chapterBrief: ChapterBrief | undefined,
  repaired: PageProductionBeat
): ChapterBrief | undefined {
  if (!chapterBrief) {
    return undefined;
  }

  const replaced = chapterBrief.pages.some((page) => page.pageIndex === repaired.pageIndex);
  const updated: ChapterBrief = {
    ...chapterBrief,
    pages: replaced
      ? chapterBrief.pages.map((page) => (page.pageIndex === repaired.pageIndex ? repaired : page))
      : [...chapterBrief.pages, repaired].sort((a, b) => a.pageIndex - b.pageIndex),
    continuityFocus: uniqueStrings([...chapterBrief.continuityFocus, ...repaired.requiredContinuity]).slice(0, 20)
  };
  Object.assign(chapterBrief, updated);
  return updated;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

async function loadContinuityNotes(projectId: string): Promise<string[]> {
  const continuity = await prisma.continuityNote.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 28
  });
  return continuity.map((note) => note.body);
}

async function loadResearchNotesForGeneration(
  projectId: string,
  strategy: BookGenerationStrategy,
  chapter?: ChapterPlan | undefined
): Promise<string[]> {
  const take = strategy.researchDepth ? strategy.researchDepth + 12 : 12;
  const sources = await prisma.researchSource.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take
  });
  const notes = sources.map((source) => `${source.title}: ${source.summary}`);
  if (!strategy.researchDepth || !chapter) {
    return notes;
  }

  const chapterTerms = searchableTerms(`${chapter.title} ${chapter.summary} ${chapter.keyBeats.join(" ")}`);
  const matching = sources
    .filter((source) => hasSharedSearchTerm(chapterTerms, `${source.query} ${source.title} ${source.summary}`))
    .map((source) => `${source.title}: ${source.summary}`);
  const general = notes.filter((note) => !matching.includes(note)).slice(0, 4);
  return [...matching, ...general].slice(0, strategy.researchDepth + 4);
}

function chapterSetupForPage(chapterSetups: ChapterSetup[], pageIndex: number): ChapterSetup | undefined {
  return chapterSetups.find((setup) => pageIndex >= setup.startPage && pageIndex <= setup.endPage);
}

function searchableTerms(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((term) => term.length > 4)
  );
}

function hasSharedSearchTerm(terms: Set<string>, value: string): boolean {
  const target = searchableTerms(value);
  for (const term of terms) {
    if (target.has(term)) {
      return true;
    }
  }
  return false;
}

async function generateBookWholePass(options: {
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

  await advanceJobStep(options.generationJobId, "setup", 70, `Saving ${draft.pages.length} generated pages`);
  const chapterRanges = chapterSetupsForPlan(options.plan, options.input.targetPages);
  const savedPages = await prisma.$transaction(async (tx) => {
    await tx.imageAsset.deleteMany({ where: { projectId: options.projectId } });
    await tx.page.deleteMany({ where: { projectId: options.projectId } });
    await tx.chapter.deleteMany({ where: { projectId: options.projectId } });
    await tx.continuityNote.deleteMany({ where: { projectId: options.projectId } });
    await tx.project.update({ where: { id: options.projectId }, data: { status: "GENERATING" } });

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

    const pages: Array<{ id: string; index: number; summary: string; imagePrompt: string | null }> = [];
    const continuityNotes: Array<{ scope: string; body: string; tags: string[] }> = [];
    for (const pageDraft of draft.pages) {
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
          revision: 1,
          qualityReport: approvedWholeBookQualityReport() as Prisma.InputJsonValue
        }
      });
      pages.push({
        id: page.id,
        index: page.index,
        summary: page.summary,
        imagePrompt: page.imagePrompt
      });
      for (const body of pageDraft.continuityNotes) {
        continuityNotes.push({
          scope: `page:${pageDraft.index}`,
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

  for (const page of savedPages) {
    await storeEmbedding(options.projectId, `page:${page.index}`, page.id, page.summary, options.providers.embedding);
  }

  await advanceJobStep(options.generationJobId, "enqueue", 88, "Queueing images and export");
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
  for (const page of savedPages) {
    if (page.imagePrompt && options.strategy.shouldIllustratePage(options.input, options.plan, page.index)) {
      await enqueueWorkerJob({
        projectId: options.projectId,
        type: "GENERATE_IMAGE",
        name: "generate-image",
        payload: { pageId: page.id, planId: options.planId, prompt: page.imagePrompt }
      });
    }
  }

  await maybeEnqueueCompile(options.projectId, options.planId);
}

async function generatePage(job: Job) {
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
  const providers = createLoggedProviders(job, createProviders(config, input));
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
  const researchNotes = await loadResearchNotesForGeneration(projectId, strategy, chapterPlan);
  const orderedPreviousPages = previousPages.reverse();
  const priorPageContext = orderedPreviousPages.map(toPriorPageContext);
  let chapterBrief = parseChapterBrief(page.chapter?.productionBrief);
  let pageBrief = chapterBrief?.pages.find((brief) => brief.pageIndex === page.index);

  await advanceJobStep(generationJobId, "draft", 30, `Drafting page ${page.index}`);
  let revision = 1;
  let draft = await strategy.generatePageDraft({
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
    textModel: providers.text
  });
  await advanceJobStep(generationJobId, "qa", 55, `Reviewing page ${page.index}`);
  let qualityReport = await strategy.reviewPageDraft({
    input,
    plan,
    chapter: chapterPlan,
    chapterBrief,
    pageBrief,
    pageIndex: page.index,
    draft,
    previousPages: priorPageContext,
    continuityNotes: continuity.map((note) => note.body),
    textModel: providers.text
  });

  while (!qualityReport.approved && revision < MAX_PAGE_QA_CANDIDATES) {
    const nextRevision = revision + 1;
    await advanceJobStep(
      generationJobId,
      "revise",
      70,
      pageRevisionMessage(page.index, nextRevision, MAX_PAGE_QA_CANDIDATES)
    );
    if (shouldRepairPageBriefForRecovery(nextRevision, qualityReport, pageBrief)) {
      pageBrief = await repairPageBriefForRecovery({
        strategy,
        input,
        plan,
        chapter: chapterPlan,
        chapterBrief,
        chapterId: page.chapterId,
        pageBrief,
        pageIndex: page.index,
        draft,
        qualityReport,
        previousPages: priorPageContext,
        continuityNotes: continuity.map((note) => note.body),
        textModel: providers.text,
        generationJobId,
        context: `Page ${page.index}`
      });
      chapterBrief = replacePageBriefInChapterBrief(chapterBrief, pageBrief);
    }
    draft = await revisePageDraftWithRestart({
      strategy,
      generationJobId,
      progress: 70,
      context: `Page ${page.index}`,
      reviseOptions: {
        input,
        plan,
        chapter: chapterPlan,
        chapterBrief,
        pageBrief,
        pageIndex: page.index,
        draft,
        report: pageRewriteReport(qualityReport, nextRevision),
        previousPages: priorPageContext,
        continuityNotes: continuity.map((note) => note.body),
        textModel: providers.text
      }
    });
    revision = nextRevision;
    qualityReport = await strategy.reviewPageDraft({
      input,
      plan,
      chapter: chapterPlan,
      chapterBrief,
      pageBrief,
      pageIndex: page.index,
      draft,
      previousPages: priorPageContext,
      continuityNotes: continuity.map((note) => note.body),
      textModel: providers.text
    });
  }

  if (!qualityReport.approved) {
    await prisma.page.update({
      where: { id: pageId },
      data: {
        status: "FAILED_QA",
        revision,
        qualityReport: qualityReport as Prisma.InputJsonValue
      }
    });
    throw new Error(formatQualityFailure(page.index, qualityReport));
  }

  await advanceJobStep(generationJobId, "save", 88, `Saving page ${page.index}`);
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
  }

  await storeEmbedding(projectId, `page:${page.index}`, pageId, draft.summary, providers.embedding);

  if (draft.imagePrompt && strategy.shouldIllustratePage(input, plan, page.index)) {
    await enqueueWorkerJob({
      projectId,
      type: "GENERATE_IMAGE",
      name: "generate-image",
      payload: { pageId, planId, prompt: draft.imagePrompt }
    });
  }

  await enqueueNextPageIfReady(projectId, planId, page.index);
  await maybeEnqueueCompile(projectId, planId);
}

async function generateImage(job: Job) {
  if (jsonPayloadToRecord(job.data).assetType === "COVER") {
    await generateCover(job);
    return;
  }

  const { projectId, pageId, planId, prompt } = job.data as {
    projectId: string;
    pageId: string;
    planId: string;
    prompt: string;
  };
  const generationJobId = job.data.generationJobId as string | undefined;
  const [project, page, planVersion] = await Promise.all([
    getProjectOrThrow(projectId),
    prisma.page.findUnique({ where: { id: pageId } }),
    prisma.planVersion.findUnique({ where: { id: planId } })
  ]);
  if (!page || !planVersion) {
    throw new Error("Page or plan not found for image generation");
  }
  const input = inputForPlanVersion(project, planVersion.inputSnapshot);
  const strategy = strategyForInput(input);
  const providers = createLoggedProviders(job, createProviders(config, input));
  const plan = bookPlanSchema.parse(planVersion.planningPackage);
  const characterReferences = await ensureCharacterReferenceAssets({
    projectId,
    planId,
    input,
    plan,
    providers,
    strategy,
    generationJobId
  });
  const referenceImagePaths = selectReferenceImagePaths({
    input,
    plan,
    assets: characterReferences,
    projectId,
    image: providers.image,
    context: [prompt, page.title, page.summary, page.markdown].filter(Boolean).join("\n")
  });
  const imagePrompt = [
    prompt,
    referenceImagePaths.length > 0 ? characterReferencePromptInstruction(referenceImagePaths.length) : "",
    `Global visual style: ${plan.illustrationPlan.globalStyle}`,
    `Continuity rules: ${plan.illustrationPlan.pageRules.join(" ")}`
  ].filter(Boolean).join("\n");
  await advanceJobStep(generationJobId, "prompt", 25, `Building prompt for page ${page.index}`);
  await advanceJobStep(generationJobId, "render", 45, `Rendering page ${page.index}`);
  const image = await strategy.generateImageBytes({
    image: providers.image,
    prompt: imagePrompt,
    projectId,
    pageId,
    referenceImagePaths,
    lessCensored: input.mediaSettings.lessCensored === true
  });

  await advanceJobStep(generationJobId, "store", 80, `Storing image for page ${page.index}`);
  const optimizedImage = await optimizeImageForStorage({ bytes: image.bytes, mimeType: image.mimeType });
  const ext = optimizedImage.extension;
  const projectImageDir = join(config.IMAGE_STORAGE_DIR, projectId);
  await mkdir(projectImageDir, { recursive: true });
  const filename = `page-${page.index}.${ext}`;
  const filePath = join(projectImageDir, filename);
  await writeFile(filePath, optimizedImage.bytes);

  await prisma.imageAsset.create({
    data: {
      projectId,
      pageId,
      type: isDiagramFriendlyBookCategory(input.category) ? "DIAGRAM" : "SCENE_ILLUSTRATION",
      prompt: imagePrompt,
      provider: image.provider,
      path: publicAssetUrl(config.PUBLIC_API_URL, `/assets/images/${projectId}/${filename}`),
      metadata: {
        model: image.model,
        ...imageStorageMetadata(optimizedImage),
        revisedPrompt: image.revisedPrompt,
        characterReferenceCount: referenceImagePaths.length
      }
    }
  });

  await maybeEnqueueCompile(projectId, planId);
}

async function generateCover(job: Job) {
  const { projectId, planId } = job.data as {
    projectId: string;
    planId: string;
  };
  const generationJobId = job.data.generationJobId as string | undefined;
  const [project, planVersion] = await Promise.all([
    getProjectOrThrow(projectId),
    prisma.planVersion.findUnique({ where: { id: planId } })
  ]);
  if (!planVersion) {
    throw new Error("Plan not found for cover generation");
  }

  const input = inputForPlanVersion(project, planVersion.inputSnapshot);
  if (!input.mediaSettings.includeCover) {
    await advanceJobStep(generationJobId, "store", 90, "Cover disabled");
    await maybeEnqueueCompile(projectId, planId);
    return;
  }

  const strategy = strategyForInput(input);
  const providers = createLoggedProviders(job, createProviders(config, input));
  const plan = bookPlanSchema.parse(planVersion.planningPackage);
  const metadata = coverMetadataFromProject(project, plan);
  const characterReferences = await ensureCharacterReferenceAssets({
    projectId,
    planId,
    input,
    plan,
    providers,
    strategy,
    generationJobId
  });
  await advanceJobStep(generationJobId, "prompt", 20, "Building cover prompt");
  const baseArtworkPrompt = buildCoverArtworkPrompt({ input, plan, metadata });
  const referenceImagePaths = selectReferenceImagePaths({
    input,
    plan,
    assets: characterReferences,
    projectId,
    image: providers.image,
    context: [baseArtworkPrompt, ...plan.characters.map((character) => `${character.name}: ${character.description}`)].join("\n")
  });
  const artworkPrompt = [
    baseArtworkPrompt,
    referenceImagePaths.length > 0 ? characterReferencePromptInstruction(referenceImagePaths.length) : ""
  ].filter(Boolean).join("\n");

  await advanceJobStep(generationJobId, "render", 45, "Rendering cover artwork");
  const artwork = await strategy.generateImageBytes({
    image: providers.image,
    prompt: artworkPrompt,
    projectId,
    referenceImagePaths,
    aspectRatio: "3:4",
    lessCensored: input.mediaSettings.lessCensored === true
  });

  await advanceJobStep(generationJobId, "render", 68, "Rendering cover typography");
  const coverPng = await renderCoverPng({
    input,
    plan,
    metadata,
    artwork: {
      bytes: artwork.bytes,
      mimeType: artwork.mimeType
    }
  });

  await advanceJobStep(generationJobId, "store", 84, "Storing cover");
  const projectImageDir = join(config.IMAGE_STORAGE_DIR, projectId);
  await mkdir(projectImageDir, { recursive: true });
  const optimizedCover = await optimizeImageForStorage({ bytes: coverPng, mimeType: "image/png" });
  const filename = `cover.${optimizedCover.extension}`;
  const filePath = join(projectImageDir, filename);
  await writeFile(filePath, optimizedCover.bytes);
  const publicPath = publicAssetUrl(config.PUBLIC_API_URL, `/assets/images/${projectId}/${filename}`);

  await prisma.$transaction([
    prisma.imageAsset.deleteMany({ where: { projectId, type: "COVER" } }),
    prisma.imageAsset.create({
      data: {
        projectId,
        type: "COVER",
        prompt: artworkPrompt,
        provider: artwork.provider,
        path: publicPath,
        metadata: {
          model: artwork.model,
          ...imageStorageMetadata(optimizedCover),
          artworkMimeType: artwork.mimeType,
          revisedPrompt: artwork.revisedPrompt,
          coverTemplate: input.mediaSettings.coverTemplate,
          sourceImageProvider: artwork.provider,
          sourceImageModel: artwork.model,
          characterReferenceCount: referenceImagePaths.length,
          renderer: "puppeteer",
          fonts: [
            "Inter (OFL-1.1)",
            "Source Serif 4 (OFL-1.1)",
            "Playfair Display (OFL-1.1)",
            "Nunito (OFL-1.1)",
            "Bebas Neue (OFL-1.1)",
            "Noto Sans (OFL-1.1)"
          ]
        }
      }
    })
  ]);

  await maybeEnqueueCompile(projectId, planId);
}

async function ensureCharacterReferenceAssets(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
}): Promise<WorkerImageAsset[]> {
  if (!shouldGenerateCharacterReferences(options.input, options.plan)) {
    return [];
  }

  const capabilities = imageCapabilities(options.providers.image);
  if (!shouldUseCharacterReferenceImages(options.input, options.plan, capabilities)) {
    await updateJobProgress(options.generationJobId, {
      message: "Skipping character reference sheets for the selected image model"
    });
    return [];
  }

  const existing = await prisma.imageAsset.findMany({
    where: { projectId: options.projectId, type: "CHARACTER_REFERENCE" },
    orderBy: { createdAt: "asc" }
  });
  const current = existing.filter((asset) => imageAssetPlanId(asset.metadata) === options.planId);
  if (hasReferenceForEveryCharacter(current, options.plan)) {
    return current.map(toWorkerImageAsset);
  }

  if (existing.length > 0) {
    await prisma.imageAsset.deleteMany({ where: { projectId: options.projectId, type: "CHARACTER_REFERENCE" } });
  }

  const projectImageDir = join(config.IMAGE_STORAGE_DIR, options.projectId);
  await mkdir(projectImageDir, { recursive: true });
  const created: WorkerImageAsset[] = [];

  for (const [index, character] of options.plan.characters.entries()) {
    await updateJobProgress(options.generationJobId, {
      message: `Rendering character reference ${index + 1}/${options.plan.characters.length}: ${character.name}`
    });
    const prompt = buildCharacterReferencePrompt({
      input: options.input,
      plan: options.plan,
      character
    });
    const image = await options.strategy.generateImageBytes({
      image: options.providers.image,
      prompt,
      projectId: options.projectId,
      aspectRatio: "4:3",
      lessCensored: options.input.mediaSettings.lessCensored === true
    });
    const optimizedImage = await optimizeImageForStorage({ bytes: image.bytes, mimeType: image.mimeType });
    const ext = optimizedImage.extension;
    const filename = `character-reference-${characterSlug(character.name)}.${ext}`;
    const filePath = join(projectImageDir, filename);
    await writeFile(filePath, optimizedImage.bytes);
    const asset = await prisma.imageAsset.create({
      data: {
        projectId: options.projectId,
        type: "CHARACTER_REFERENCE",
        prompt,
        provider: image.provider,
        path: publicAssetUrl(config.PUBLIC_API_URL, `/assets/images/${options.projectId}/${filename}`),
        metadata: {
          planId: options.planId,
          characterName: character.name,
          role: character.role,
          visualRules: character.visualRules,
          model: image.model,
          ...imageStorageMetadata(optimizedImage),
          revisedPrompt: image.revisedPrompt,
          fileName: filename
        }
      }
    });
    created.push(toWorkerImageAsset(asset));
  }

  return created;
}

function selectReferenceImagePaths(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  assets: WorkerImageAsset[];
  projectId: string;
  image: ImageAdapter;
  context: string;
}): string[] {
  const capabilities = imageCapabilities(options.image);
  if (!capabilities.supportsReferenceImages || capabilities.maxReferenceImages <= 0) {
    return [];
  }
  const localAssets = options.assets.flatMap((asset) => {
    const path = localImagePathForAsset(asset.path, options.projectId);
    return path ? [{ path, metadata: asset.metadata }] : [];
  });
  return selectCharacterReferenceAssets({
    input: options.input,
    plan: options.plan,
    assets: localAssets,
    context: options.context,
    maxReferences: capabilities.maxReferenceImages
  }).map((asset) => asset.path);
}

function characterReferencePromptInstruction(count: number): string {
  return [
    `Use the ${count} attached character reference image${count === 1 ? "" : "s"} as the authoritative design source.`,
    "Preserve each referenced character's face, silhouette, outfit, colors, and distinctive details; change only pose, expression, lighting, and scene placement."
  ].join(" ");
}

function imageCapabilities(image: ImageAdapter): ImageAdapterCapabilities {
  return image.capabilities?.() ?? { supportsReferenceImages: false, maxReferenceImages: 0 };
}

function hasReferenceForEveryCharacter(assets: Array<{ metadata: unknown }>, plan: BookPlan): boolean {
  const names = new Set(
    assets
      .map((asset) => characterNameFromAssetMetadata(asset.metadata)?.toLowerCase())
      .filter((name): name is string => Boolean(name))
  );
  return plan.characters.every((character) => names.has(character.name.toLowerCase()));
}

function imageAssetPlanId(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>).planId;
  return typeof value === "string" ? value : undefined;
}

function characterNameFromAssetMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>).characterName;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function localImagePathForAsset(path: string, projectId: string): string | undefined {
  let pathname = path;
  try {
    pathname = new URL(path).pathname;
  } catch {
    // Stored paths can also be relative API asset paths.
  }
  const marker = `/assets/images/${projectId}/`;
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }
  const filename = decodeURIComponent(pathname.slice(markerIndex + marker.length));
  if (!filename || filename.includes("/")) {
    return undefined;
  }
  return join(config.IMAGE_STORAGE_DIR, projectId, filename);
}

function toWorkerImageAsset(asset: { id: string; path: string; metadata: unknown }): WorkerImageAsset {
  return {
    id: asset.id,
    path: asset.path,
    metadata: asset.metadata
  };
}

function characterSlug(value: string): string {
  return safePathPart(value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
}

async function compileExport(job: Job) {
  const { projectId, planId } = job.data as { projectId: string; planId: string };
  const generationJobId = job.data.generationJobId as string | undefined;
  const [planVersion, project] = await Promise.all([
    prisma.planVersion.findUnique({ where: { id: planId } }),
    prisma.project.findUnique({
      where: { id: projectId },
      include: {
        pages: { orderBy: { index: "asc" }, include: { images: true, chapter: true } },
        images: true,
        research: true
      }
    })
  ]);
  if (!planVersion || !project) {
    throw new Error("Cannot compile export without plan and project");
  }
  const plan = bookPlanSchema.parse(planVersion.planningPackage);
  const input = inputForPlanVersion(project, planVersion.inputSnapshot);
  const strategy = strategyForInput(input);
  const providers = createLoggedProviders(job, createProviders(config, input));
  let pages: ExportPageForRepair[] = project.pages;
  if (input.mediaSettings.finalReview) {
    await advanceJobStep(generationJobId, "qa", 25);
    let finalQa = await strategy.runFinalBookQa({
      input,
      plan,
      pages: pages.map(toFinalQaPage),
      researchNotes: strategy.researchDepth
        ? project.research.map((source) => `${source.title}: ${source.summary}`)
        : undefined,
      textModel: providers.text
    });
    if (!finalQa.approved) {
      const repairedPages = await repairPagesFromFinalQa({
        projectId,
        input,
        plan,
        providers,
        strategy,
        pages,
        finalQa,
        generationJobId
      });
      if (repairedPages) {
        pages = repairedPages;
        finalQa = await strategy.runFinalBookQa({
          input,
          plan,
          pages: pages.map(toFinalQaPage),
          researchNotes: strategy.researchDepth
            ? project.research.map((source) => `${source.title}: ${source.summary}`)
            : undefined,
          textModel: providers.text
        });
      }
    }
    if (!finalQa.approved) {
      throw new Error(`Final book QA failed: ${finalQa.issues.join(" ")}`);
    }
  } else {
    await advanceJobStep(generationJobId, "qa", 25, "Skipping final review");
  }

  await advanceJobStep(generationJobId, "compile", 55);
  const cover = project.images.find((image) => image.type === "COVER");
  const markdownPages = pages.map((page) => ({
    index: page.index,
    title: page.title,
    markdown: page.markdown,
    summary: page.summary,
    imagePath: resolvePublicImageUrl(page.images[0]?.path, config.PUBLIC_API_URL),
    imageAlt: "Illustration"
  }));
  await updateJobProgress(generationJobId, {
    progress: 62,
    message: "Placing reader chapters"
  });
  const readerChapters = await createReaderChaptersForExport({
    input,
    plan,
    pages: markdownPages,
    textModel: providers.text
  });
  const markdown = strategy.compileMarkdown({
    plan,
    category: input.category,
    language: input.language,
    readerChapters,
    ...(cover
      ? {
          cover: {
            imagePath: publicAssetUrl(config.PUBLIC_API_URL, cover.path),
            imageAlt: `Cover for ${plan.title}`
          }
        }
      : {}),
    pages: markdownPages,
    researchSources: project.research.map((source) => ({
      title: source.title,
      url: source.url ?? undefined,
      summary: source.summary
    }))
  });
  assertBookLikeMarkdown(markdown);
  await advanceJobStep(generationJobId, "write", 80);
  const projectDir = join(config.BOOK_STORAGE_DIR, projectId);
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "book.md"), markdown, "utf8");
  await advanceJobStep(generationJobId, "pdf", 92);
  await strategy.generatePdf(markdown, {
    imageStorageDir: config.IMAGE_STORAGE_DIR,
    publicApiUrl: config.PUBLIC_API_URL,
    outputPath: join(projectDir, "book.pdf")
  });
  await prisma.project.update({ where: { id: projectId }, data: { status: "COMPLETE" } });
}

async function repairPagesFromFinalQa(options: {
  projectId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  pages: ExportPageForRepair[];
  finalQa: FinalBookQa;
  generationJobId?: string | undefined;
}): Promise<ExportPageForRepair[] | undefined> {
  const repairPageIndexes = extractRepairPageIndexes(options.finalQa, options.input.targetPages).slice(
    0,
    MAX_FINAL_QA_REPAIR_PAGES
  );
  if (repairPageIndexes.length === 0) {
    return undefined;
  }

  await advanceJobStep(
    options.generationJobId,
    "qa",
    35,
    `Repairing pages ${repairPageIndexes.join(", ")} after final QA`
  );

  const continuity = await prisma.continuityNote.findMany({
    where: { projectId: options.projectId },
    orderBy: { createdAt: "desc" },
    take: 28
  });
  let pages = [...options.pages];

  for (const pageIndex of repairPageIndexes) {
    const page = pages.find((candidate) => candidate.index === pageIndex);
    if (!page) {
      continue;
    }

    const chapterPlan = page.chapter
      ? options.plan.chapters.find((chapter) => chapter.index === page.chapter?.index)
      : undefined;
    const chapterBrief = parseChapterBrief(page.chapter?.productionBrief);
    const pageBrief = chapterBrief?.pages.find((brief) => brief.pageIndex === page.index);
    const previousPages = pages.filter((candidate) => candidate.index < page.index).map(toPriorPageContext);
    const continuityNotes = continuity.map((note) => note.body);
    const finalQaReport = pageReportFromFinalQa(options.finalQa, pageIndex, options.input.targetPages);
    let draft = await revisePageDraftWithRestart({
      strategy: options.strategy,
      generationJobId: options.generationJobId,
      context: `Final QA repair for page ${pageIndex}`,
      reviseOptions: {
        input: options.input,
        plan: options.plan,
        chapter: chapterPlan,
        chapterBrief,
        pageBrief,
        pageIndex,
        draft: {
          title: page.title,
          markdown: page.markdown,
          summary: page.summary,
          continuityNotes: []
        },
        report: finalQaReport,
        previousPages,
        continuityNotes,
        textModel: options.providers.text
      }
    });

    let qualityReport = await options.strategy.reviewPageDraft({
      input: options.input,
      plan: options.plan,
      chapter: chapterPlan,
      chapterBrief,
      pageBrief,
      pageIndex,
      draft,
      previousPages,
      continuityNotes,
      textModel: options.providers.text
    });
    let revisionAttempts = 1;

    while (!qualityReport.approved && revisionAttempts < MAX_FINAL_QA_REVISIONS_PER_PAGE) {
      const nextRevisionAttempt = revisionAttempts + 1;
      draft = await revisePageDraftWithRestart({
        strategy: options.strategy,
        generationJobId: options.generationJobId,
        context: `Final QA repair for page ${pageIndex}`,
        reviseOptions: {
          input: options.input,
          plan: options.plan,
          chapter: chapterPlan,
          chapterBrief,
          pageBrief,
          pageIndex,
          draft,
          report: pageRewriteReport(qualityReport, nextRevisionAttempt, 3),
          previousPages,
          continuityNotes,
          textModel: options.providers.text
        }
      });
      revisionAttempts = nextRevisionAttempt;
      qualityReport = await options.strategy.reviewPageDraft({
        input: options.input,
        plan: options.plan,
        chapter: chapterPlan,
        chapterBrief,
        pageBrief,
        pageIndex,
        draft,
        previousPages,
        continuityNotes,
        textModel: options.providers.text
      });
    }

    if (!qualityReport.approved) {
      throw new Error(`Final QA repair failed. ${formatQualityFailure(pageIndex, qualityReport)}`);
    }

    const updatedPage = await prisma.page.update({
      where: { id: page.id },
      data: {
        title: draft.title,
        markdown: draft.markdown,
        summary: draft.summary,
        imagePrompt: draft.imagePrompt ?? page.imagePrompt,
        status: "COMPLETED",
        revision: { increment: revisionAttempts },
        qualityReport: qualityReport as Prisma.InputJsonValue
      },
      include: { images: true, chapter: true }
    });

    if (draft.continuityNotes.length > 0) {
      await prisma.continuityNote.createMany({
        data: draft.continuityNotes.map((body) => ({
          projectId: options.projectId,
          scope: `page:${page.index}`,
          body,
          tags: ["page", String(page.index), "final-qa-repair"]
        }))
      });
    }

    await storeEmbedding(options.projectId, `page:${page.index}`, page.id, draft.summary, options.providers.embedding);
    pages = pages.map((candidate) => (candidate.index === page.index ? updatedPage : candidate));
  }

  return loadPagesForExport(options.projectId);
}

async function enqueueWorkerJob(options: {
  projectId: string;
  type: "GENERATE_PAGE" | "GENERATE_IMAGE" | "COMPILE_EXPORT";
  name: "generate-page" | "generate-image" | "compile-export";
  payload: Record<string, unknown>;
}) {
  if (!(await canEnqueueProjectWork(options.projectId))) {
    return;
  }

  const generationJob = await prisma.generationJob.create({
    data: {
      projectId: options.projectId,
      type: options.type,
      status: "QUEUED",
      progress: 0,
      message: "Queued",
      payload: options.payload as Prisma.InputJsonValue
    }
  });
  const bullJob = await queue.add(
    options.name,
    {
      ...options.payload,
      projectId: options.projectId,
      generationJobId: generationJob.id
    },
    jobOptionsForName(options.name)
  );
  await prisma.generationJob.update({
    where: { id: generationJob.id },
    data: { bullJobId: bullJob.id ?? null }
  });
}

async function canEnqueueProjectWork(projectId: string): Promise<boolean> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { status: true }
  });
  return project !== null && project.status !== "FAILED";
}

function jobOptionsForName(name: string): JobsOptions | undefined {
  if (name !== "generate-page") {
    return undefined;
  }
  return {
    attempts: GENERATE_PAGE_RECOVERY_ATTEMPTS,
    backoff: {
      type: "exponential",
      delay: GENERATE_PAGE_RECOVERY_BACKOFF_MS
    }
  };
}

async function maybeEnqueueCover(projectId: string, planId: string, input: CreateProjectInput): Promise<boolean> {
  if (!input.mediaSettings.includeCover) {
    return false;
  }
  const [coverAssets, openCoverJobs] = await Promise.all([
    prisma.imageAsset.count({ where: { projectId, type: "COVER" } }),
    countOpenCoverJobs(projectId)
  ]);
  if (coverAssets > 0 || openCoverJobs > 0) {
    return false;
  }
  await enqueueWorkerJob({
    projectId,
    type: "GENERATE_IMAGE",
    name: "generate-image",
    payload: { planId, assetType: "COVER" }
  });
  return true;
}

async function countOpenCoverJobs(projectId: string): Promise<number> {
  const openJobs = await prisma.generationJob.findMany({
    where: {
      projectId,
      type: "GENERATE_IMAGE",
      status: { in: ["QUEUED", "ACTIVE"] }
    },
    select: { payload: true }
  });
  return openJobs.filter((job) => jsonPayloadToRecord(job.payload).assetType === "COVER").length;
}

async function enqueueNextPageIfReady(projectId: string, planId: string, completedPageIndex: number) {
  const nextPage = await prisma.page.findUnique({
    where: { projectId_index: { projectId, index: completedPageIndex + 1 } }
  });
  if (!nextPage || nextPage.status === "COMPLETED") {
    return;
  }
  if (await hasOpenGeneratePageJob(projectId, nextPage.id)) {
    return;
  }

  await enqueueWorkerJob({
    projectId,
    type: "GENERATE_PAGE",
    name: "generate-page",
    payload: { pageId: nextPage.id, planId }
  });
}

async function hasOpenGeneratePageJob(projectId: string, pageId: string): Promise<boolean> {
  const openJobs = await prisma.generationJob.findMany({
    where: {
      projectId,
      type: "GENERATE_PAGE",
      status: { in: ["QUEUED", "ACTIVE"] }
    },
    select: { payload: true }
  });
  return openJobs.some((job) => jsonPayloadToRecord(job.payload).pageId === pageId);
}

async function maybeEnqueueCompile(projectId: string, planId: string) {
  const [project, planVersion] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId } }),
    prisma.planVersion.findUnique({ where: { id: planId } })
  ]);
  if (!project) {
    return;
  }
  if (project.status === "FAILED") {
    return;
  }
  const input = inputForPlanVersion(project, planVersion?.inputSnapshot);
  const [totalPages, completedPages, openImageJobs, existingCompileJobs, coverAssets] = await Promise.all([
    prisma.page.count({ where: { projectId } }),
    prisma.page.count({ where: { projectId, status: "COMPLETED" } }),
    prisma.generationJob.count({
      where: { projectId, type: "GENERATE_IMAGE", status: { in: ["QUEUED", "ACTIVE"] } }
    }),
    prisma.generationJob.count({
      where: { projectId, type: "COMPILE_EXPORT", status: { in: ["QUEUED", "ACTIVE"] } }
    }),
    prisma.imageAsset.count({ where: { projectId, type: "COVER" } })
  ]);
  const pagesReady = totalPages === input.targetPages && completedPages === input.targetPages;
  if (pagesReady && input.mediaSettings.includeCover && coverAssets === 0 && openImageJobs === 0) {
    await maybeEnqueueCover(projectId, planId, input);
    return;
  }
  if (
    pagesReady &&
    openImageJobs === 0 &&
    existingCompileJobs === 0
  ) {
    await enqueueWorkerJob({
      projectId,
      type: "COMPILE_EXPORT",
      name: "compile-export",
      payload: { planId }
    });
  }
}

async function maybeCompileAfterCompletedJob(job: Job) {
  if (job.name !== "generate-page" && job.name !== "generate-image") {
    return;
  }
  const projectId = job.data.projectId as string | undefined;
  const planId = job.data.planId as string | undefined;
  if (!projectId || !planId) {
    return;
  }
  await maybeEnqueueCompile(projectId, planId);
}

async function storeEmbedding(
  projectId: string,
  scope: string,
  sourceId: string,
  text: string,
  embedding: { embed(text: string): Promise<number[]> }
) {
  try {
    const vector = await embedding.embed(text);
    const vectorLiteral = `[${vector.map((value) => Number(value).toFixed(7)).join(",")}]`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Embedding" ("id", "projectId", "scope", "sourceId", "text", "vector", "metadata")
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7::jsonb)`,
      randomUUID(),
      projectId,
      scope,
      sourceId,
      text,
      vectorLiteral,
      JSON.stringify({ provider: config.MOCK_AI ? "fake" : "gemini" })
    );
  } catch (error) {
    await prisma.embedding.create({
      data: {
        projectId,
        scope,
        sourceId,
        text,
        metadata: {
          vectorStored: false,
          error: error instanceof Error ? error.message : "Unknown embedding error"
        }
      }
    });
  }
}

type RunLogger = {
  filePath: string;
  append(event: string, data: Record<string, unknown>): Promise<string>;
};

function createLoggedProviders(job: Job, providers: ProviderSet): ProviderSet {
  const logger = createRunLogger(job);
  const generationJobId = job.data.generationJobId as string | undefined;
  const projectId = job.data.projectId as string | undefined;
  return {
    text: new LoggingTextModelAdapter(providers.text, logger, generationJobId, projectId),
    research: new LoggingResearchAdapter(providers.research, logger, generationJobId),
    image: new LoggingImageAdapter(providers.image, logger, generationJobId),
    embedding: new LoggingEmbeddingAdapter(providers.embedding, logger, generationJobId)
  };
}

function createRunLogger(job: Job): RunLogger {
  const projectId = (job.data.projectId as string | undefined) ?? "_unknown-project";
  const generationJobId = job.data.generationJobId as string | undefined;
  const runId = generationJobId ?? `bull-${job.id ?? "unknown"}`;
  const logDir = join(config.BOOK_STORAGE_DIR, projectId, "runs");
  const filePath = join(logDir, `${safePathPart(runId)}-${safePathPart(job.name)}.jsonl`);

  return {
    filePath,
    async append(event, data) {
      const timestamp = new Date().toISOString();
      const entry = {
        timestamp,
        event,
        job: {
          id: job.id,
          name: job.name,
          generationJobId,
          projectId,
          logFile: filePath
        },
        ...data
      };
      try {
        await mkdir(logDir, { recursive: true });
        await appendFile(filePath, `${safeJsonStringify(entry)}\n`, "utf8");
      } catch (error) {
        console.error(`Failed to write run log ${filePath}`, error);
      }
      return timestamp;
    }
  };
}

function providerConfigSnapshot() {
  return {
    alibaba: {
      apiKeySet: Boolean(config.ALIBABA_API_KEY),
      apiHost: config.ALIBABA_API_HOST,
      textModel: config.ALIBABA_TEXT_MODEL,
      imageModel: config.ALIBABA_IMAGE_MODEL
    }
  };
}

class LoggingTextModelAdapter implements TextModelAdapter {
  constructor(
    private readonly delegate: TextModelAdapter,
    private readonly logger: RunLogger,
    private readonly generationJobId: string | undefined,
    private readonly projectId: string | undefined
  ) {}

  async generateText(options: GenerateTextOptions) {
    const callId = randomUUID();
    const requestAt = await this.logger.append("text.generateText.request", { callId, request: logTextRequest(options) });
    try {
      await assertJobNotStopped(this.generationJobId);
      const result = await withRecoverableNetworkRetry(
        () => this.delegate.generateText(options),
        providerRetryOptions(this.logger, this.generationJobId, "text.generateText", options.purpose)
      );
      const responseAt = await this.logger.append("text.generateText.response", { callId, result });
      await recordProviderUsage({
        projectId: options.projectId ?? this.projectId,
        generationJobId: this.generationJobId,
        provider: result.provider,
        model: result.model,
        purpose: options.purpose ?? "text.generateText",
        operation: "text.generateText",
        callId,
        durationMs: durationBetweenTimestamps(requestAt, responseAt),
        usage: result.usage
      });
      await assertJobNotStopped(this.generationJobId);
      return result;
    } catch (error) {
      await this.logger.append("text.generateText.error", { callId, error: serializeError(error) });
      await assertJobNotStopped(this.generationJobId);
      throw error;
    }
  }

  async generateJson<T>(options: GenerateJsonOptions<T>) {
    const callId = randomUUID();
    const requestAt = await this.logger.append("text.generateJson.request", { callId, request: logTextRequest(options) });
    try {
      await assertJobNotStopped(this.generationJobId);
      const result = await withRecoverableNetworkRetry(
        () => this.delegate.generateJson(options),
        providerRetryOptions(this.logger, this.generationJobId, "text.generateJson", options.purpose)
      );
      const responseAt = await this.logger.append("text.generateJson.response", { callId, result });
      await recordProviderUsage({
        projectId: options.projectId ?? this.projectId,
        generationJobId: this.generationJobId,
        provider: result.provider,
        model: result.model,
        purpose: options.purpose ?? "text.generateJson",
        operation: "text.generateJson",
        callId,
        durationMs: durationBetweenTimestamps(requestAt, responseAt),
        usage: result.usage
      });
      await assertJobNotStopped(this.generationJobId);
      return result;
    } catch (error) {
      const errorAt = await this.logger.append("text.generateJson.error", { callId, error: serializeError(error) });
      await recordProviderUsageFromError({
        projectId: options.projectId ?? this.projectId,
        generationJobId: this.generationJobId,
        purpose: options.purpose ?? "text.generateJson",
        operation: "text.generateJson",
        callId,
        durationMs: durationBetweenTimestamps(requestAt, errorAt),
        error
      });
      await assertJobNotStopped(this.generationJobId);
      throw error;
    }
  }

  async *streamText(options: GenerateTextOptions) {
    const callId = randomUUID();
    await this.logger.append("text.streamText.request", { callId, request: logTextRequest(options) });
    let chunkCount = 0;
    let characterCount = 0;
    try {
      await assertJobNotStopped(this.generationJobId);
      for await (const chunk of this.delegate.streamText(options)) {
        await assertJobNotStopped(this.generationJobId);
        chunkCount += 1;
        characterCount += chunk.length;
        yield chunk;
      }
      await this.logger.append("text.streamText.response", { callId, chunkCount, characterCount });
      await assertJobNotStopped(this.generationJobId);
    } catch (error) {
      await this.logger.append("text.streamText.error", { callId, error: serializeError(error) });
      await assertJobNotStopped(this.generationJobId);
      throw error;
    }
  }
}

async function recordProviderUsage(options: {
  projectId: string | undefined;
  generationJobId: string | undefined;
  provider: string;
  model: string;
  purpose: string;
  operation: string;
  callId: string;
  durationMs: number | null;
  usage: Usage | undefined;
}) {
  const promptTokens = finiteTokenCount(options.usage?.promptTokens);
  const outputTokens = finiteTokenCount(options.usage?.outputTokens);
  const cacheHitTokens = finiteTokenCount(options.usage?.cacheHitTokens);
  if (promptTokens === null && outputTokens === null && cacheHitTokens === null) {
    return;
  }
  const costHint = calculateTextGenerationCost({
    provider: options.provider,
    model: options.model,
    promptTokens,
    outputTokens,
    cacheHitTokens
  });

  try {
    await prisma.providerCallLog.create({
      data: {
        projectId: options.projectId ?? null,
        generationJobId: options.generationJobId ?? null,
        provider: options.provider,
        model: options.model,
        purpose: options.purpose,
        promptTokens,
        outputTokens,
        cacheHitTokens,
        costHint,
        durationMs: options.durationMs,
        metadata: {
          operation: options.operation,
          callId: options.callId
        } satisfies Prisma.InputJsonValue
      }
    });
  } catch (error) {
    console.error("Failed to record provider token usage", error);
  }
}

async function recordProviderUsageFromError(options: {
  projectId: string | undefined;
  generationJobId: string | undefined;
  purpose: string;
  operation: string;
  callId: string;
  durationMs: number | null;
  error: unknown;
}) {
  const providerUsage = providerUsageFromError(options.error);
  if (!providerUsage) {
    return;
  }
  await recordProviderUsage({
    projectId: options.projectId,
    generationJobId: options.generationJobId,
    provider: providerUsage.provider,
    model: providerUsage.model,
    purpose: options.purpose,
    operation: options.operation,
    callId: options.callId,
    durationMs: options.durationMs,
    usage: providerUsage.usage
  });
}

function providerUsageFromError(error: unknown): { provider: string; model: string; usage: Usage } | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const candidate = error as { provider?: unknown; model?: unknown; usage?: unknown };
  if (typeof candidate.provider !== "string" || typeof candidate.model !== "string" || !isUsage(candidate.usage)) {
    return null;
  }
  return {
    provider: candidate.provider,
    model: candidate.model,
    usage: candidate.usage
  };
}

function isUsage(value: unknown): value is Usage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return "promptTokens" in value || "outputTokens" in value || "cacheHitTokens" in value;
}

async function recordProviderImageCost(options: {
  projectId: string | undefined;
  generationJobId: string | undefined;
  provider: string;
  model: string;
  operation: string;
  callId: string;
  costHint: number | null;
  durationMs: number | null;
  metadata: Record<string, unknown>;
}) {
  if (options.costHint === null) {
    return;
  }

  try {
    await prisma.providerCallLog.create({
      data: {
        projectId: options.projectId ?? null,
        generationJobId: options.generationJobId ?? null,
        provider: options.provider,
        model: options.model,
        purpose: options.operation,
        promptTokens: null,
        outputTokens: null,
        cacheHitTokens: null,
        costHint: options.costHint,
        durationMs: options.durationMs,
        metadata: jsonInputValue({
          operation: options.operation,
          callId: options.callId,
          ...options.metadata
        })
      }
    });
  } catch (error) {
    console.error("Failed to record provider image cost", error);
  }
}

function finiteTokenCount(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function durationBetweenTimestamps(start: string, end: string): number | null {
  const startedAt = Date.parse(start);
  const finishedAt = Date.parse(end);
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
    return null;
  }
  return Math.round(finishedAt - startedAt);
}

class LoggingResearchAdapter implements ResearchAdapter {
  constructor(
    private readonly delegate: ResearchAdapter,
    private readonly logger: RunLogger,
    private readonly generationJobId: string | undefined
  ) {}

  async search(query: ResearchQuery) {
    const callId = randomUUID();
    await this.logger.append("research.search.request", { callId, query });
    try {
      await assertJobNotStopped(this.generationJobId);
      const result = await withRecoverableNetworkRetry(
        () => this.delegate.search(query),
        providerRetryOptions(this.logger, this.generationJobId, "research.search", query.purpose)
      );
      await this.logger.append("research.search.response", { callId, result });
      await assertJobNotStopped(this.generationJobId);
      return result;
    } catch (error) {
      await this.logger.append("research.search.error", { callId, error: serializeError(error) });
      await assertJobNotStopped(this.generationJobId);
      throw error;
    }
  }
}

class LoggingImageAdapter implements ImageAdapter {
  constructor(
    private readonly delegate: ImageAdapter,
    private readonly logger: RunLogger,
    private readonly generationJobId: string | undefined
  ) {}

  capabilities(): ImageAdapterCapabilities {
    return this.delegate.capabilities?.() ?? { supportsReferenceImages: false, maxReferenceImages: 0 };
  }

  async generateImage(request: ImageRequest) {
    const callId = randomUUID();
    const requestAt = await this.logger.append("image.generate.request", { callId, request });
    try {
      await assertJobNotStopped(this.generationJobId);
      const result = await withRecoverableNetworkRetry(
        () => this.delegate.generateImage(request),
        providerRetryOptions(this.logger, this.generationJobId, "image.generate")
      );
      const responseAt = await this.logger.append("image.generate.response", { callId, result: logImageResult(result) });
      await recordProviderImageCost({
        projectId: request.projectId,
        generationJobId: this.generationJobId,
        provider: result.provider,
        model: result.model,
        operation: "image.generate",
        callId,
        costHint: calculateImageGenerationCost({
          provider: result.provider,
          model: result.model
        }),
        durationMs: durationBetweenTimestamps(requestAt, responseAt),
        metadata: {
          aspectRatio: request.aspectRatio,
          referenceImageCount: request.referenceImagePaths?.length ?? 0,
          mimeType: result.mimeType
        }
      });
      await assertJobNotStopped(this.generationJobId);
      return result;
    } catch (error) {
      await this.logger.append("image.generate.error", { callId, error: serializeError(error) });
      await assertJobNotStopped(this.generationJobId);
      throw error;
    }
  }
}

class LoggingEmbeddingAdapter implements EmbeddingAdapter {
  constructor(
    private readonly delegate: EmbeddingAdapter,
    private readonly logger: RunLogger,
    private readonly generationJobId: string | undefined
  ) {}

  async embed(text: string) {
    const callId = randomUUID();
    await this.logger.append("embedding.embed.request", {
      callId,
      textLength: text.length,
      textPreview: text.slice(0, 500)
    });
    try {
      await assertJobNotStopped(this.generationJobId);
      const vector = await withRecoverableNetworkRetry(
        () => this.delegate.embed(text),
        providerRetryOptions(this.logger, this.generationJobId, "embedding.embed")
      );
      await this.logger.append("embedding.embed.response", { callId, vectorLength: vector.length });
      await assertJobNotStopped(this.generationJobId);
      return vector;
    } catch (error) {
      await this.logger.append("embedding.embed.error", { callId, error: serializeError(error) });
      await assertJobNotStopped(this.generationJobId);
      throw error;
    }
  }
}

function providerRetryOptions(
  logger: RunLogger,
  generationJobId: string | undefined,
  operation: string,
  purpose?: string | undefined
) {
  return {
    attempts: PROVIDER_NETWORK_RETRY_ATTEMPTS,
    delayMs: PROVIDER_NETWORK_RETRY_DELAY_MS,
    onRetry: async ({
      attempt,
      attempts,
      delayMs,
      error
    }: {
      attempt: number;
      attempts: number;
      delayMs: number;
      error: unknown;
    }) => {
      await logger.append(`${operation}.retry`, {
        attempt,
        attempts,
        nextAttempt: attempt + 1,
        delayMs,
        recoverable: true,
        error: serializeError(error)
      });
      await updateJobProgress(generationJobId, {
        message: `${providerOperationLabel(operation, purpose)} hit a network interruption; retrying (${attempt + 1}/${attempts}).`
      });
    }
  };
}

function providerOperationLabel(operation: string, purpose?: string | undefined): string {
  if (purpose) {
    return purpose;
  }
  switch (operation) {
    case "research.search":
      return "Research";
    case "image.generate":
      return "Image generation";
    case "embedding.embed":
      return "Embedding";
    default:
      return "Provider call";
  }
}

function logTextRequest(options: GenerateTextOptions) {
  return {
    purpose: options.purpose,
    projectId: options.projectId,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    messages: options.messages
  };
}

function logImageResult(result: Awaited<ReturnType<ImageAdapter["generateImage"]>>) {
  return {
    provider: result.provider,
    model: result.model,
    mimeType: result.mimeType,
    url: result.url,
    revisedPrompt: result.revisedPrompt,
    dataBytes: result.data?.byteLength
  };
}

function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { value: error };
  }
  const extra = Object.fromEntries(Object.entries(error as Error & Record<string, unknown>));
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...extra
  };
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") {
      return item.toString();
    }
    if (Buffer.isBuffer(item)) {
      return { type: "Buffer", bytes: item.byteLength };
    }
    if (item && typeof item === "object") {
      if (seen.has(item)) {
        return "[Circular]";
      }
      seen.add(item);
    }
    return item;
  });
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

function jsonInputValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(safeJsonStringify(value)) as Prisma.InputJsonValue;
}

function buildStepTemplate(jobName: string): JobStep[] {
  const template = JOB_STEP_TEMPLATES[jobName];
  if (!template) {
    return [];
  }
  return template.map((step, index) => ({
    ...step,
    status: index === 0 ? "active" : "pending"
  }));
}

function parseJobSteps(value: unknown): JobStep[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (step): step is JobStep =>
      typeof step === "object" &&
      step !== null &&
      typeof (step as JobStep).key === "string" &&
      typeof (step as JobStep).label === "string" &&
      ["pending", "active", "done", "failed"].includes((step as JobStep).status)
  );
}

async function updateJobProgress(
  generationJobId: string | undefined,
  update: { progress?: number; message?: string; steps?: JobStep[] },
  options: { allowStopped?: boolean } = {}
) {
  if (!generationJobId) {
    return;
  }
  if (!options.allowStopped) {
    await assertJobNotStopped(generationJobId);
  }
  await prisma.generationJob.update({
    where: { id: generationJobId },
    data: {
      ...(update.progress !== undefined ? { progress: update.progress } : {}),
      ...(update.message !== undefined ? { message: update.message } : {}),
      ...(update.steps !== undefined ? { steps: update.steps as Prisma.InputJsonValue } : {})
    }
  });
}

async function advanceJobStep(
  generationJobId: string | undefined,
  activeKey: string,
  progress?: number,
  message?: string
) {
  if (!generationJobId) {
    return;
  }
  await assertJobNotStopped(generationJobId);
  const job = await prisma.generationJob.findUnique({
    where: { id: generationJobId },
    select: { steps: true }
  });
  const steps = parseJobSteps(job?.steps);
  if (!steps.length) {
    return;
  }
  let foundActive = false;
  const nextSteps = steps.map((step) => {
    if (step.key === activeKey) {
      foundActive = true;
      return { ...step, status: "active" as const };
    }
    if (!foundActive) {
      return { ...step, status: "done" as const };
    }
    return { ...step, status: "pending" as const };
  });
  const active = nextSteps.find((step) => step.status === "active");
  const stepMessage = message ?? active?.label;
  await updateJobProgress(generationJobId, {
    steps: nextSteps,
    ...(progress !== undefined ? { progress } : {}),
    ...(stepMessage ? { message: stepMessage } : {})
  });
}

async function completeAllJobSteps(generationJobId: string | undefined) {
  if (!generationJobId) {
    return;
  }
  const job = await prisma.generationJob.findUnique({
    where: { id: generationJobId },
    select: { steps: true }
  });
  const steps = parseJobSteps(job?.steps);
  if (!steps.length) {
    return;
  }
  await updateJobProgress(generationJobId, {
    steps: steps.map((step) => ({ ...step, status: "done" as const }))
  });
}

async function failActiveJobStep(
  generationJobId: string | undefined,
  options: { allowStopped?: boolean } = {}
) {
  if (!generationJobId) {
    return;
  }
  const job = await prisma.generationJob.findUnique({
    where: { id: generationJobId },
    select: { steps: true }
  });
  const steps = parseJobSteps(job?.steps);
  if (!steps.length) {
    return;
  }
  await updateJobProgress(generationJobId, {
    steps: steps.map((step) =>
      step.status === "active" ? { ...step, status: "failed" as const } : step
    )
  }, options);
}

async function markActive(job: Job) {
  const generationJobId = job.data.generationJobId as string | undefined;
  if (!generationJobId) {
    return;
  }
  await assertJobNotStopped(generationJobId);
  const steps = buildStepTemplate(job.name);
  await prisma.generationJob.update({
    where: { id: generationJobId },
    data: {
      status: "ACTIVE",
      startedAt: new Date(),
      message: steps[0]?.label ?? `Running ${job.name}`,
      progress: 10,
      ...(steps.length ? { steps: steps as Prisma.InputJsonValue } : {})
    }
  });
}

async function markCompleted(job: Job) {
  const generationJobId = job.data.generationJobId as string | undefined;
  if (!generationJobId) {
    return;
  }
  await assertJobNotStopped(generationJobId);
  await completeAllJobSteps(generationJobId);
  await prisma.generationJob.update({
    where: { id: generationJobId },
    data: { status: "COMPLETED", finishedAt: new Date(), message: "Completed", progress: 100 }
  });
}

async function markFailed(job: Job, error: unknown) {
  const generationJobId = job.data.generationJobId as string | undefined;
  const projectId = job.data.projectId as string | undefined;
  if (generationJobId) {
    await failActiveJobStep(generationJobId);
    await prisma.generationJob.update({
      where: { id: generationJobId },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        message: "Failed",
        error: error instanceof Error ? error.message : "Unknown error"
      }
    });
  }
  if (projectId) {
    await prisma.project.update({ where: { id: projectId }, data: { status: "FAILED" } }).catch(() => undefined);
  }
}

async function markStopped(job: Job) {
  const generationJobId = job.data.generationJobId as string | undefined;
  const projectId = job.data.projectId as string | undefined;
  if (generationJobId) {
    await failActiveJobStep(generationJobId, { allowStopped: true });
    await prisma.generationJob.update({
      where: { id: generationJobId },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        message: STOPPED_JOB_MESSAGE,
        error: STOPPED_JOB_ERROR
      }
    });
  }
  if (projectId) {
    await prisma.project.update({ where: { id: projectId }, data: { status: "FAILED" } }).catch(() => undefined);
  }
}

async function markRecovering(job: Job, error: unknown) {
  const generationJobId = job.data.generationJobId as string | undefined;
  const projectId = job.data.projectId as string | undefined;
  const nextAttempt = job.attemptsMade + 2;
  const maxAttempts = jobMaxAttempts(job);
  const message = `Network interruption during ${job.name}; retrying (${nextAttempt}/${maxAttempts}). ${errorMessage(error)}`;

  if (generationJobId) {
    await prisma.generationJob.update({
      where: { id: generationJobId },
      data: {
        status: "QUEUED",
        finishedAt: null,
        message,
        error: null
      }
    });
  }
  if (projectId) {
    await prisma.project.update({ where: { id: projectId }, data: { status: "GENERATING" } }).catch(() => undefined);
  }
}

function shouldRecoverJobAttempt(job: Job, error: unknown): boolean {
  return (
    job.name === "generate-page" &&
    isRecoverableNetworkError(error) &&
    job.attemptsMade + 1 < jobMaxAttempts(job)
  );
}

function shouldBypassConfiguredRetries(job: Job, error: unknown): boolean {
  return job.name === "generate-page" && jobMaxAttempts(job) > 1 && !isRecoverableNetworkError(error);
}

async function assertJobNotStopped(generationJobId: string | undefined) {
  if (await hasStoppedGenerationJob(generationJobId)) {
    throw new StopRequestedError();
  }
}

async function hasStoppedGenerationJob(generationJobId: string | undefined): Promise<boolean> {
  if (!generationJobId) {
    return false;
  }
  const job = await prisma.generationJob.findUnique({
    where: { id: generationJobId },
    select: { status: true, message: true, error: true }
  });
  return isStoppedGenerationJob(job);
}

function isStoppedGenerationJob(job: { status: string; message: string | null; error: string | null } | null): boolean {
  return job?.status === "FAILED" && (job.message === STOPPED_JOB_MESSAGE || job.error === STOPPED_JOB_ERROR);
}

function isStopRequestedError(error: unknown): boolean {
  return error instanceof StopRequestedError;
}

function jobMaxAttempts(job: Job): number {
  const attempts = job.opts.attempts;
  return typeof attempts === "number" && Number.isFinite(attempts) && attempts > 0 ? attempts : 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

async function getProjectOrThrow(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }
  return project;
}

function planInputSnapshot(input: CreateProjectInput): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(input)) as Prisma.InputJsonValue;
}

function coverMetadataFromProject(
  project: { title: string; subtitle?: string | null; authorName?: string | null; coverTagline?: string | null },
  plan: BookPlan
) {
  return {
    title: cleanOptionalText(project.title) ?? plan.title,
    subtitle: cleanOptionalText(project.subtitle) ?? cleanOptionalText(plan.subtitle),
    authorName: cleanOptionalText(project.authorName),
    coverTagline: cleanOptionalText(project.coverTagline)
  };
}

function cleanOptionalText(value: string | null | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed || undefined;
}

function strategyForInput(input: CreateProjectInput): BookGenerationStrategy {
  return getBookGenerationStrategy(input.mediaSettings.generationStrategy);
}

async function nextPlanVersion(projectId: string): Promise<number> {
  const latest = await prisma.planVersion.findFirst({
    where: { projectId },
    orderBy: { version: "desc" }
  });
  return (latest?.version ?? 0) + 1;
}

function chapterSetupsForPlan(
  plan: BookPlan,
  targetPages: number
): Array<{ chapter: ChapterPlan; startPage: number; endPage: number }> {
  let nextPageIndex = 1;
  return normalizedChapters(plan, targetPages).map((chapter) => {
    const startPage = nextPageIndex;
    const endPage = Math.min(targetPages, startPage + chapter.targetPages - 1);
    nextPageIndex = endPage + 1;
    return { chapter, startPage, endPage };
  });
}

function normalizedChapters(plan: BookPlan, targetPages: number): ChapterPlan[] {
  return normalizePlanPageTargets(plan, targetPages).chapters;
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function approvedWholeBookQualityReport(): PageQualityReport {
  return {
    approved: true,
    score: 100,
    issues: [],
    requiredRevisions: [],
    notes: "Generated by the whole-book single-pass strategy; page-level QA was not run.",
    checks: {
      placeholderFree: true,
      promptLeakFree: true,
      titleClean: true,
      repetitionOk: true,
      progressionOk: true,
      styleNatural: true
    }
  };
}

async function loadPagesForExport(projectId: string): Promise<ExportPageForRepair[]> {
  return prisma.page.findMany({
    where: { projectId },
    orderBy: { index: "asc" },
    include: { images: true, chapter: true }
  });
}

function toPriorPageContext(page: { index: number; title: string; markdown: string; summary: string }): PriorPageContext {
  return {
    index: page.index,
    title: page.title,
    markdown: page.markdown,
    summary: page.summary
  };
}

function toFinalQaPage(page: { index: number; title: string; markdown: string; summary: string }) {
  return {
    index: page.index,
    title: page.title,
    markdown: page.markdown,
    summary: page.summary
  };
}

function pageReportFromFinalQa(finalQa: FinalBookQa, pageIndex: number, targetPages: number): PageQualityReport {
  const scopedMessages = finalQaMessagesForPage(finalQa, pageIndex, targetPages);
  const issueText = scopedMessages.join(" ");
  const repetitionOk = !/(repeat|overlap|same|redundan|duplicate)/i.test(issueText);
  const progressionOk = !/(progress|restat|vague|ending|resolution|incomplete|commitment|decision)/i.test(issueText);

  return {
    approved: false,
    score: Math.min(finalQa.score, 60),
    issues: scopedMessages.length > 0 ? scopedMessages : finalQa.issues,
    requiredRevisions: scopedMessages.length > 0 ? scopedMessages : finalQa.requiredFixes,
    notes: finalQa.notes || "Final QA requested a targeted page repair.",
    checks: {
      placeholderFree: true,
      promptLeakFree: true,
      titleClean: true,
      repetitionOk,
      progressionOk,
      styleNatural: true
    }
  };
}

function finalQaMessagesForPage(finalQa: FinalBookQa, pageIndex: number, targetPages: number): string[] {
  const messages = [...finalQa.issues, ...finalQa.requiredFixes];
  const scoped = messages.filter((message) => messageTargetsPage(message, pageIndex, targetPages));
  return scoped.length > 0 ? scoped : finalQa.issues;
}

function messageTargetsPage(message: string, pageIndex: number, targetPages: number): boolean {
  const pageIndexes = extractRepairPageIndexesFromText(message, targetPages);
  if (pageIndexes.includes(pageIndex)) {
    return true;
  }
  return pageIndex === targetPages && /\b(final page|ending|conclusion|resolution|incomplete)\b/i.test(message);
}

function extractRepairPageIndexes(finalQa: FinalBookQa, targetPages: number): number[] {
  const indexes = new Set<number>();
  for (const message of [...finalQa.issues, ...finalQa.requiredFixes]) {
    for (const pageIndex of extractRepairPageIndexesFromText(message, targetPages)) {
      indexes.add(pageIndex);
    }
  }
  if ([...finalQa.issues, ...finalQa.requiredFixes].some((message) => /\b(final page|ending|conclusion|resolution)\b/i.test(message))) {
    indexes.add(targetPages);
  }
  return [...indexes].filter((pageIndex) => pageIndex >= 1 && pageIndex <= targetPages);
}

function extractRepairPageIndexesFromText(text: string, targetPages: number): number[] {
  const indexes = new Set<number>();
  const pagePattern = /\bpages?\s+(\d+)(?:\s*(?:,|and|to|-)\s*(\d+))?/gi;
  let match: RegExpExecArray | null;

  while ((match = pagePattern.exec(text)) !== null) {
    const first = Number(match[1]);
    const second = match[2] ? Number(match[2]) : undefined;
    const prefix = text.slice(Math.max(0, match.index - 8), match.index).toLowerCase();
    if (!second && /\bfrom\s+$/.test(prefix)) {
      continue;
    }
    const repairIndex = second ?? first;
    if (repairIndex >= 1 && repairIndex <= targetPages) {
      indexes.add(repairIndex);
    }
  }

  return [...indexes];
}

function parseChapterBrief(value: unknown): ChapterBrief | undefined {
  if (!value) {
    return undefined;
  }
  return chapterBriefSchema.parse(value);
}

function formatQualityFailure(pageIndex: number, report: PageQualityReport): string {
  const issues = report.issues.length > 0 ? report.issues.join(" ") : "Unknown quality failure.";
  const revisions =
    report.requiredRevisions.length > 0 ? ` Required revisions: ${report.requiredRevisions.join(" ")}` : "";
  return `Page ${pageIndex} failed quality review after rewrite attempts. ${issues}${revisions}`;
}

function jsonPayloadToRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  return payload as Record<string, unknown>;
}

function imageStorageMetadata(image: OptimizedImage): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      mimeType: image.mimeType,
      originalMimeType: image.originalMimeType,
      optimized: image.optimized,
      maxWidth: image.maxWidth,
      originalBytes: image.originalBytes,
      outputBytes: image.outputBytes,
      originalWidth: image.originalWidth,
      originalHeight: image.originalHeight,
      width: image.width,
      height: image.height
    }).filter(([, value]) => value !== undefined)
  );
}

async function shutdown() {
  await worker.close();
  await queue.close();
  connection.disconnect();
  await prisma.$disconnect();
}

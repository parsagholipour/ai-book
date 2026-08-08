import { Job, type JobsOptions } from "bullmq";
import { createHash } from "node:crypto";
import { coverArtSourceFor, resolveBookGenerationStrategy, type CreateProjectInput } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { retryJobOptions } from "./jobRetryPolicy.js";
import { acceptedSavedPageTarget, terminalSavedPageCount } from "../generation/wholeBookTolerance.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { config } from "./config.js";
import { queue } from "./queue.js";
import { errorMessage, jsonPayloadToRecord } from "./serialization.js";

/**
 * Queue dispatch and generation fan-out.
 *
 * GenerationJob rows are the source of truth: a row is created first, then
 * pushed to BullMQ. `reconcileUndispatchedWorkerJobs` re-pushes anything that
 * was persisted but never reached Redis, so a crash between the two cannot
 * strand a book mid-generation.
 */

/** Backoff bounds for re-dispatching jobs that failed to reach Redis. */
const DISPATCH_BACKOFF_BASE_MS = 5_000;
const DISPATCH_BACKOFF_MAX_MS = 5 * 60_000;

export async function enqueueWorkerJob(options: {
  projectId: string;
  type:
    | "GENERATE_BOOK"
    | "GENERATE_PAGE"
    | "GENERATE_IMAGE"
    | "COMPILE_EXPORT"
    | "PREPARE_CHARACTER_CANDIDATES"
    | "BUILD_CHARACTER_PERSONA"
    | "GENERATE_AUDIOBOOK";
  name:
    | "generate-book"
    | "generate-page"
    | "generate-image"
    | "compile-export"
    | "prepare-character-candidates"
    | "build-character-persona"
    | "generate-audiobook";
  payload: Record<string, unknown>;
  dedupeKey?: string | undefined;
  contentRevision?: number | undefined;
}) {
  if (!(await canEnqueueProjectWork(options.projectId))) {
    return;
  }

  if (options.dedupeKey) {
    const existing = await prisma.generationJob.findUnique({ where: { dedupeKey: options.dedupeKey } });
    if (existing) {
      if (existing.status === "QUEUED" && !existing.bullJobId) {
        await dispatchWorkerGenerationJob(existing.id);
      }
      return existing;
    }
  }
  let generationJob;
  try {
    generationJob = await prisma.generationJob.create({
      data: {
        projectId: options.projectId,
        type: options.type,
        status: "QUEUED",
        progress: 0,
        message: "Queued",
        ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
        ...(options.contentRevision !== undefined ? { contentRevision: options.contentRevision } : {}),
        payload: options.payload as Prisma.InputJsonValue
      }
    });
  } catch (error) {
    if (!(options.dedupeKey && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
      throw error;
    }
    generationJob = await prisma.generationJob.findUnique({ where: { dedupeKey: options.dedupeKey } });
    if (!generationJob) throw error;
  }
  await dispatchWorkerGenerationJob(generationJob.id);
  return generationJob;
}

export async function dispatchWorkerGenerationJob(generationJobId: string) {
  const generationJob = await prisma.generationJob.findUnique({ where: { id: generationJobId } });
  if (!generationJob || generationJob.status !== "QUEUED" || generationJob.bullJobId) {
    return generationJob;
  }
  const payload = jsonPayloadToRecord(generationJob.payload);
  // Inside the try: an unmapped type must count as a deferred dispatch, not a
  // rejection that poisons every reconciliation sweep.
  let name: string;
  try {
    name = workerJobNameForType(generationJob.type);
  } catch (error) {
    console.error("Generation job has no worker job name; leaving it undispatched", {
      generationJobId: generationJob.id,
      type: generationJob.type,
      error: errorMessage(error)
    });
    return generationJob;
  }
  try {
    const bullJob = await queue.add(
      name,
      { ...payload, projectId: generationJob.projectId, generationJobId: generationJob.id },
      { ...jobOptionsForName(name), jobId: generationJob.id }
    );
    return prisma.generationJob.update({
      where: { id: generationJob.id },
      data: {
        bullJobId: bullJob.id ?? generationJob.id,
        dispatchedAt: new Date(),
        nextDispatchAt: null,
        message: "Queued"
      }
    });
  } catch (error) {
    const attempts = generationJob.dispatchAttempts + 1;
    console.warn("Generation dispatch deferred", {
      event: "generation.consistency_warning",
      warning: "queue_dispatch_failed",
      generationJobId: generationJob.id,
      projectId: generationJob.projectId,
      type: generationJob.type,
      dispatchAttempt: attempts,
      error: errorMessage(error)
    });
    return prisma.generationJob.update({
      where: { id: generationJob.id },
      data: {
        dispatchAttempts: attempts,
        nextDispatchAt: new Date(Date.now() + dispatchBackoffMs(attempts)),
        message: "Waiting for the generation queue"
      }
    });
  }
}

export async function reconcileUndispatchedWorkerJobs(limit = 50): Promise<number> {
  const jobs = await prisma.generationJob.findMany({
    where: {
      status: "QUEUED",
      bullJobId: null,
      OR: [{ nextDispatchAt: null }, { nextDispatchAt: { lte: new Date() } }]
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true }
  });
  // allSettled, not all: one undispatchable row must not abort the sweep for
  // every other stranded job, every interval, forever.
  const results = await Promise.allSettled(jobs.map((job) => dispatchWorkerGenerationJob(job.id)));
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("Worker job reconciliation failed for a row", result.reason);
    }
  }
  return jobs.length;
}

export function workerJobNameForType(type: string): string {
  const names: Record<string, string> = {
    PLAN_BOOK: "plan-book",
    REVISE_PLAN: "revise-plan",
    GENERATE_BOOK: "generate-book",
    GENERATE_PAGE: "generate-page",
    GENERATE_IMAGE: "generate-image",
    COMPILE_EXPORT: "compile-export",
    APPLY_BOOK_EDIT: "apply-book-edit",
    REPLAN_BOOK: "replan-book",
    PREPARE_CHARACTER_CANDIDATES: "prepare-character-candidates",
    BUILD_CHARACTER_PERSONA: "build-character-persona",
    IMPORT_BOOK: "import-book",
    CONTINUE_BOOK: "continue-book",
    GENERATE_AUDIOBOOK: "generate-audiobook"
  };
  const name = names[type];
  if (!name) {
    throw new Error(`Unknown generation job type: ${type}`);
  }
  return name;
}

export async function canEnqueueProjectWork(projectId: string): Promise<boolean> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { status: true }
  });
  return project !== null && project.status !== "FAILED";
}

export function jobOptionsForName(name: string): JobsOptions | undefined {
  return retryJobOptions(name);
}

export function dispatchBackoffMs(attempt: number): number {
  return Math.min(DISPATCH_BACKOFF_MAX_MS, DISPATCH_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

export async function maybeEnqueueCover(projectId: string, planId: string, input: CreateProjectInput): Promise<boolean> {
  if (coverArtSourceFor(input.mediaSettings) === "none") {
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
    payload: { planId, assetType: "COVER" },
    dedupeKey: `generate-cover:${projectId}:${planId}`
  });
  return true;
}

export async function countOpenCoverJobs(projectId: string): Promise<number> {
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

/**
 * Fiction keeps strict page-by-page generation for continuity; non-fiction
 * drafts pages in parallel waves and reconciles in the final review. The
 * mediaSettings flag overrides the category default in either direction.
 */
export function parallelPageWaveSize(input: CreateProjectInput): number {
  const fiction = input.category === "STORY" || input.category === "KIDS";
  const enabled = input.mediaSettings.parallelPageGeneration ?? !fiction;
  return enabled ? Math.max(1, config.MAX_PARALLEL_PAGE_JOBS) : 1;
}

/**
 * Enqueues the next pending page that is not already in flight. Each page
 * completion tops the wave back up by one, so the number of concurrent page
 * jobs stays at the initial wave size.
 */
export async function enqueueNextPageIfReady(projectId: string, planId: string) {
  const [pendingPages, openJobs] = await Promise.all([
    prisma.page.findMany({
      where: { projectId, status: "PENDING" },
      orderBy: { index: "asc" },
      // One more than the wave can hold in flight, or a wave larger than the
      // fetch finds every fetched page already claimed and shrinks for good.
      take: Math.max(1, config.MAX_PARALLEL_PAGE_JOBS) + 1,
      select: { id: true, index: true }
    }),
    prisma.generationJob.findMany({
      where: { projectId, type: "GENERATE_PAGE", status: { in: ["QUEUED", "ACTIVE"] } },
      select: { payload: true }
    })
  ]);
  const inFlightPageIds = new Set(
    openJobs
      .map((job) => jsonPayloadToRecord(job.payload).pageId)
      .filter((pageId): pageId is string => typeof pageId === "string")
  );
  const nextPage = pendingPages.find((page) => !inFlightPageIds.has(page.id));
  if (!nextPage) {
    return;
  }

  await enqueueWorkerJob({
    projectId,
    type: "GENERATE_PAGE",
    name: "generate-page",
    payload: { pageId: nextPage.id, planId },
    dedupeKey: `generate-page:${nextPage.id}:${planId}`
  });
}

export async function maybeEnqueueCompile(
  projectId: string,
  planId: string,
  options: { skipFinalReview?: boolean } = {}
) {
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
  const strategy = resolveBookGenerationStrategy(input).strategy;
  const [pages, openPageJobs, openImageJobs, existingCompileJobs, coverAssets] =
    await Promise.all([
      prisma.page.findMany({
        where: { projectId },
        select: { id: true, index: true, status: true, markdown: true, revision: true }
      }),
      prisma.generationJob.count({
        where: { projectId, type: "GENERATE_PAGE", status: { in: ["QUEUED", "ACTIVE"] } }
      }),
      prisma.generationJob.count({
        where: { projectId, type: "GENERATE_IMAGE", status: { in: ["QUEUED", "ACTIVE"] } }
      }),
      prisma.generationJob.count({
        where: { projectId, type: "COMPILE_EXPORT", status: { in: ["QUEUED", "ACTIVE"] } }
      }),
      prisma.imageAsset.count({ where: { projectId, type: "COVER" } })
    ]);
  // FAILED_QA pages that kept a draft count as terminal so one stubborn page
  // cannot block the whole export; the final review pass can still repair it.
  const acceptedPageTarget = acceptedSavedPageTarget(input, strategy, pages);
  const terminalPages = terminalSavedPageCount(pages);
  const pagesReady =
    acceptedPageTarget !== undefined &&
    terminalPages === pages.length &&
    pages.length === acceptedPageTarget &&
    openPageJobs === 0;
  if (pagesReady && coverArtSourceFor(input.mediaSettings) !== "none" && coverAssets === 0 && openImageJobs === 0) {
    await maybeEnqueueCover(projectId, planId, input);
    return;
  }
  if (
    pagesReady &&
    openImageJobs === 0 &&
    existingCompileJobs === 0
  ) {
    const contentFingerprint = createHash("sha256")
      .update(pages.map((page) => `${page.id}:${page.revision}`).sort().join("|"))
      .digest("hex")
      .slice(0, 24);
    const contentRevision = project.contentRevision;
    await enqueueWorkerJob({
      projectId,
      type: "COMPILE_EXPORT",
      name: "compile-export",
      payload: { planId, contentRevision, ...(options.skipFinalReview ? { skipFinalReview: true } : {}) },
      dedupeKey: `compile-export:${projectId}:${planId}:${contentFingerprint}`,
      contentRevision
    });
  }
}

export async function maybeCompileAfterCompletedJob(job: Job) {
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

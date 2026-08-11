import { Job, type JobsOptions } from "bullmq";
import { createHash } from "node:crypto";
import {
  coverArtSourceFor,
  DETACHED_FROM_PROJECT_LIFECYCLE,
  dispatchBackoffMs,
  EXPORT_PUBLICATION_PROJECT_STATUS,
  isDetachedFromProjectLifecycle,
  jobOwnsQualityVerdict,
  resolveBookGenerationStrategy,
  retryJobOptions,
  workerJobNameForType,
  type CreateProjectInput
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { acceptedSavedPageTarget, terminalSavedPageCount } from "../generation/wholeBookTolerance.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { config } from "./config.js";
import { queue } from "./queue.js";
import { errorMessage, jsonPayloadToRecord } from "./serialization.js";
import { currentGenerationAttemptId } from "./generationAttemptContext.js";

/**
 * Queue dispatch and generation fan-out.
 *
 * GenerationJob rows are the source of truth: a row is created first, then
 * pushed to BullMQ. `reconcileUndispatchedWorkerJobs` re-pushes anything that
 * was persisted but never reached Redis, so a crash between the two cannot
 * strand a book mid-generation.
 */

export { dispatchBackoffMs, workerJobNameForType } from "@book-maker/core";

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

  // Detached work never belongs to the paid attempt that happens to be on the
  // async context: an attempt settling (stop, failure) marks its QUEUED/ACTIVE
  // sibling rows FAILED, which would kill the very rebuild a failure path just
  // queued to repair the book.
  const attemptId = isDetachedFromProjectLifecycle(options.payload) ? null : currentGenerationAttemptId();
  const dedupeKey =
    options.dedupeKey && attemptId ? `${options.dedupeKey}:attempt:${attemptId}` : options.dedupeKey;

  if (dedupeKey) {
    const existing = await prisma.generationJob.findUnique({ where: { dedupeKey } });
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
        ...(dedupeKey ? { dedupeKey } : {}),
        ...(attemptId ? { attemptId } : {}),
        ...(options.contentRevision !== undefined ? { contentRevision: options.contentRevision } : {}),
        // Promoted out of the payload alongside `contentRevision`: the API reads
        // the owning compile straight off this column, because a payload flag
        // cannot be negated in SQL without dropping every row that never
        // carried it. See `jobOwnsQualityVerdict`.
        ownsQualityVerdict: jobOwnsQualityVerdict(options.type, options.payload),
        payload: options.payload as Prisma.InputJsonValue
      }
    });
  } catch (error) {
    if (!(dedupeKey && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
      throw error;
    }
    generationJob = await prisma.generationJob.findUnique({ where: { dedupeKey } });
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
      {
        ...payload,
        projectId: generationJob.projectId,
        generationJobId: generationJob.id,
        ...(generationJob.attemptId ? { attemptId: generationJob.attemptId } : {})
      },
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
export async function enqueueNextPageIfReady(projectId: string, planId: string, input: CreateProjectInput) {
  const waveSize = parallelPageWaveSize(input);
  const [pendingPages, openJobs] = await Promise.all([
    prisma.page.findMany({
      where: { projectId, status: "PENDING" },
      orderBy: { index: "asc" },
      // Enough to refill the whole wave past every in-flight page, or a wave
      // larger than the fetch finds every fetched page already claimed and
      // shrinks for good.
      take: waveSize * 2,
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
  // Top the wave back up to size rather than by a fixed one: two pages
  // finishing together both pick the same next page and the dedupe key
  // collapses them into one job, so "+1 per completion" shrinks the wave by
  // one forever. The caller still counts itself in flight here (its row is
  // marked COMPLETED after this), hence the +1; the min keeps a serial wave
  // (fiction) strictly one page at a time.
  const deficit = Math.min(waveSize, Math.max(1, waveSize - inFlightPageIds.size + 1));
  const nextPages = pendingPages
    .filter((page) => !inFlightPageIds.has(page.id))
    .slice(0, deficit);
  for (const nextPage of nextPages) {
    await enqueueWorkerJob({
      projectId,
      type: "GENERATE_PAGE",
      name: "generate-page",
      payload: { pageId: nextPage.id, planId },
      dedupeKey: `generate-page:${nextPage.id}:${planId}`
    });
  }
}

/**
 * Whether an export is now on its way, which is what a caller that moved the
 * project needs to know.
 *
 * `applyBookEdit` is that caller: it takes the project EDITING, deletes the
 * compiled files and increments `contentRevision`, and *nothing but a compile*
 * takes it back out. A silent no-op there leaves a book mid-edit with no files,
 * no job, and no sweep that can reach it — `reconcileStrandedGeneration` only
 * looks at GENERATING and `ensureExportRepairQueued` only at COMPLETE and
 * REVIEW_REQUIRED.
 */
export type CompileDispatchOutcome =
  /** A compile for this manuscript is queued, or one was already in flight. */
  | "compile"
  /** Work in flight fans back in here when it lands — the cover, a page, an image. */
  | "waiting"
  /** Nothing is coming: the saved pages are not a publishable book. */
  | "not-ready"
  /** The project is gone or FAILED; its status is not this function's to move. */
  | "settled";

export async function maybeEnqueueCompile(
  projectId: string,
  planId: string,
  options: {
    skipFinalReview?: boolean;
    /**
     * Queue the compile as detached repair work: it owns neither the project's
     * status nor its charge, so its own failure cannot flip a settled book to
     * FAILED or refund the book's generation. Used by failure paths that must
     * rebuild exports for a book whose own job is about to settle.
     */
    detached?: boolean;
  } = {}
): Promise<CompileDispatchOutcome> {
  const [project, planVersion] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId } }),
    prisma.planVersion.findUnique({ where: { id: planId } })
  ]);
  if (!project) {
    return "settled";
  }
  if (project.status === "FAILED") {
    return "settled";
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
        where: {
          projectId,
          type: "COMPILE_EXPORT",
          status: { in: ["QUEUED", "ACTIVE"] },
          // Only a compile that will publish *this* manuscript counts as one
          // already coming. An export repair is queued against a book that is
          // COMPLETE, so it carries the pre-edit revision — and an edit that
          // lands under it makes it stand down at `publishCompiledExports`, or
          // be cancelled outright by `staleGenerationJobReason` before it
          // starts. Letting a compile that will publish nothing suppress the
          // edit's own recompile left the project EDITING with its exports
          // already deleted and nothing left to rebuild them. A null revision
          // claims unconditionally, so it does still count.
          OR: [{ contentRevision: null }, { contentRevision: project.contentRevision }]
        }
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
    return "waiting";
  }
  if (!pagesReady || openImageJobs > 0) {
    // A page or image job still in flight calls back here when it completes;
    // anything else means the saved pages do not add up to a book at all.
    return openPageJobs > 0 || openImageJobs > 0 ? "waiting" : "not-ready";
  }
  if (existingCompileJobs === 0) {
    const contentFingerprint = createHash("sha256")
      .update(pages.map((page) => `${page.id}:${page.revision}`).sort().join("|"))
      .digest("hex")
      .slice(0, 24);
    const contentRevision = project.contentRevision;
    await enqueueWorkerJob({
      projectId,
      type: "COMPILE_EXPORT",
      name: "compile-export",
      payload: {
        planId,
        contentRevision,
        [EXPORT_PUBLICATION_PROJECT_STATUS]: project.status,
        ...(options.skipFinalReview ? { skipFinalReview: true } : {}),
        ...(options.detached ? { [DETACHED_FROM_PROJECT_LIFECYCLE]: true } : {})
      },
      dedupeKey: `compile-export:${projectId}:${planId}:${contentFingerprint}`,
      contentRevision
    });
  }
  return "compile";
}

const STRANDED_GENERATION_GRACE_MS = 60_000;

/**
 * Recovers a run whose fan-in trigger was lost. The compile (or cover) is
 * enqueued only after the last page/image job is marked COMPLETED, so a worker
 * dying in between leaves a fully written, fully paid book GENERATING forever:
 * every job row terminal, no COMPILE_EXPORT row, and nothing left to push it
 * forward. `maybeEnqueueCompile` re-derives readiness from the rows and
 * dedupes on content, so replaying it here is idempotent — projects that are
 * merely unfinished no-op out of it.
 */
export async function reconcileStrandedGeneration(limit = 20): Promise<number> {
  const cutoff = new Date(Date.now() - STRANDED_GENERATION_GRACE_MS);
  const projects = await prisma.project.findMany({
    where: {
      status: "GENERATING",
      currentPlanId: { not: null },
      updatedAt: { lt: cutoff },
      jobs: { none: { status: { in: ["QUEUED", "ACTIVE"] } } }
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: { id: true, currentPlanId: true }
  });
  const results = await Promise.allSettled(
    projects.map((project) =>
      project.currentPlanId ? maybeEnqueueCompile(project.id, project.currentPlanId) : Promise.resolve()
    )
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("Stranded generation reconciliation failed for a project", result.reason);
    }
  }
  return projects.length;
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

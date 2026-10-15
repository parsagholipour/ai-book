import type { JobsOptions } from "bullmq";
import { createHash } from "node:crypto";
import {
  compilePolicyPayload,
  compilePublicationDedupeKey,
  compilePublicationPolicyFromPayload,
  compilePublicationPolicyIdentity,
  COVER_RETYPESET,
  coverArtSourceFor,
  coverRetypesetFingerprint,
  dispatchBackoffMs,
  errorMessage,
  clearLaneJobIdForAdd,
  exportPublicationProjectStatusFromPayload,
  generationJobPlacement,
  isCoverPurchasePayload,
  isDetachedFromProjectLifecycle,
  isRevisionOwnedCoverPayload,
  jobOwnsQualityVerdict,
  legacyCompilePolicy,
  resolveBookGenerationStrategy,
  retryJobOptions,
  workerJobNameForType,
  type CompilePublicationPolicy,
  type CreateProjectInput,
  type GenerationJobType,
  type LegacyCompileOptions
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { acceptedSavedPageTarget, terminalSavedPageCount } from "../generation/wholeBookTolerance.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { coverTypesetDrift } from "../generation/coverTypesetDrift.js";
import {
  forkedPublicationRecoveryPolicy,
  loadStrandedCompileRecoveryPolicy,
  strandedCompileRecoveryPolicy
} from "./compileRecoveryPolicy.js";
import { config } from "./config.js";
import { allLaneQueues, queueNamed } from "./queue.js";
import { jsonPayloadToRecord } from "./serialization.js";
import { currentGenerationAttemptId, runWithGenerationAttempt } from "./generationAttemptContext.js";
import {
  compileIdentityAfterCompletion,
  recoveredCompileSuccessorIdentity
} from "./compileSuccessor.js";
import type {
  EnqueuePayloadForType,
  WorkerRuntimeJob
} from "./jobPayloads.js";

/**
 * Queue dispatch and generation fan-out.
 *
 * GenerationJob rows are the source of truth: a row is created first, then
 * pushed to BullMQ. `reconcileUndispatchedWorkerJobs` re-pushes anything that
 * was persisted but never reached Redis, so a crash between the two cannot
 * strand a book mid-generation.
 */

export { dispatchBackoffMs, workerJobNameForType } from "@book-maker/core";
export { compilePublicationPolicyFromPayload };
export type { CompilePublicationPolicy };

/**
 * The subset of job types the worker fans out to itself.
 *
 * Deliberately narrower than `GenerationJobType`: planning, edits, replans and
 * imports are started by the API, which owns their charge and their retry
 * budget, so a handler reaching for one of those is a mistake the compiler
 * should catch. The `satisfies` clause is what keeps the narrowing honest —
 * renaming or removing an entry in `jobNames` fails here rather than silently
 * enqueueing a job the dispatch switch cannot name.
 *
 * There is deliberately no `name` beside this. The BullMQ job name is derived
 * from the type by `workerJobNameForType` at dispatch time, so the two can no
 * longer disagree; they were once independent unions, which typechecked
 * `{ type: "GENERATE_BOOK", name: "generate-page" }`.
 */
const WORKER_FANOUT_JOB_TYPES = [
  "GENERATE_BOOK",
  "GENERATE_PAGE",
  "GENERATE_IMAGE",
  "COMPILE_EXPORT",
  "PREPARE_CHARACTER_CANDIDATES",
  "BUILD_CHARACTER_PERSONA",
  "GENERATE_AUDIOBOOK"
] as const satisfies readonly GenerationJobType[];

export type WorkerFanoutJobType = (typeof WORKER_FANOUT_JOB_TYPES)[number];

type EnqueueWorkerJobOptions = {
  [Type in WorkerFanoutJobType]: {
    projectId: string;
    type: Type;
    payload: EnqueuePayloadForType<Type>;
    dedupeKey?: string | undefined;
    contentRevision?: number | undefined;
    attemptIdOverride?: string | null;
  };
}[WorkerFanoutJobType];

export async function enqueueWorkerJob(options: EnqueueWorkerJobOptions) {
  if (!(await canEnqueueProjectWork(options.projectId))) {
    return;
  }

  // Detached work never belongs to the paid attempt that happens to be on the
  // async context: an attempt settling (stop, failure) marks its QUEUED/ACTIVE
  // sibling rows FAILED, which would kill the very rebuild a failure path just
  // queued to repair the book.
  const attemptId = isDetachedFromProjectLifecycle(options.payload)
    ? null
    : options.attemptIdOverride === undefined ? currentGenerationAttemptId() : options.attemptIdOverride;
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
    if (!(await prepareDurableJobId(generationJob.id))) {
      const attempts = generationJob.dispatchAttempts + 1;
      return prisma.generationJob.update({
        where: { id: generationJob.id },
        data: {
          dispatchAttempts: attempts,
          nextDispatchAt: new Date(Date.now() + dispatchBackoffMs(attempts)),
          message: "Waiting for the generation queue"
        }
      });
    }
    // The lane is the row's (type, payload), so the API's dispatch of the same
    // row lands in the same queue and BullMQ's job-id dedupe still holds.
    const placement = generationJobPlacement(generationJob.type, payload);
    const bullJob = await queueNamed(placement.queueName).add(
      name,
      {
        ...payload,
        // Absent rather than null for account-level jobs (character portraits):
        // their schema intentionally has no projectId.
        ...(generationJob.projectId ? { projectId: generationJob.projectId } : {}),
        generationJobId: generationJob.id,
        ...(generationJob.attemptId ? { attemptId: generationJob.attemptId } : {})
      },
      {
        ...jobOptionsForName(name),
        ...(placement.priority !== undefined ? { priority: placement.priority } : {}),
        jobId: generationJob.id
      }
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

/**
 * BullMQ job ids are the durable row's id, so a delivery that is still in the
 * processor — or a failed one that has not been removed — occupies the only
 * id a requeue can use, in whichever lane it was put. Finished copies are
 * dropped; a live one anywhere means this push waits for reconciliation.
 */
function prepareDurableJobId(jobId: string): Promise<boolean> {
  return clearLaneJobIdForAdd(allLaneQueues, jobId);
}

/**
 * Puts an in-flight GenerationJob back on the queue without settling it.
 *
 * A structural rollback that threw left the manuscript shifted and the stamp
 * on the row. `markFailed` would refund that ACTIVE operation, clear its lease
 * and restore COMPLETE over pages that have not been put back. Claiming
 * ACTIVE → QUEUED and clearing `bullJobId` is what lets this delivery exit
 * unrecoverably while a later one resumes drafting. `apply-book-edit` has no
 * BullMQ retry budget, so the durable row is the retry.
 */
export async function redeliverWorkerGenerationJob(generationJobId: string): Promise<void> {
  const requeued = await prisma.generationJob.updateMany({
    where: { id: generationJobId, status: "ACTIVE" },
    data: {
      status: "QUEUED",
      finishedAt: null,
      error: null,
      message: "Queued to resume a structural edit",
      bullJobId: null,
      dispatchedAt: null,
      nextDispatchAt: null
    }
  });
  if (requeued.count !== 1) {
    return;
  }
  await dispatchWorkerGenerationJob(generationJobId);
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
    payload: { planId, assetType: "COVER" },
    dedupeKey: `generate-cover:${projectId}:${planId}`
  });
  return true;
}

/**
 * Sets the cover's words again before a book's first compile when the row has
 * moved on since the cover was typeset — a pen name or title given while the
 * book was being written — or the cover never recorded its words
 * (`coverTypesetDrift.ts`). Free, and it never draws.
 *
 * Waits only on a re-typeset this call queued or one still running. The dedupe
 * key names the current cover id and the change in words
 * (`coverRetypesetFingerprint`). A successful re-set replaces the cover row,
 * so a byline changed A → X → A → X gets a new attempt even when the same word
 * transition already succeeded on an earlier cover.
 *
 * Each change is attempted once per cover row. A re-set that could not change
 * the cover (its artwork gone, say) leaves the same row and words behind and
 * answers with its own spent job, allowing the book to compile without a loop.
 */
export async function maybeEnqueueCoverRetypeset(
  projectId: string,
  project: { title: string; subtitle: string | null; authorName: string | null; coverTagline: string | null },
  planId: string,
  planningPackage: unknown
): Promise<boolean> {
  const drift = await coverTypesetDrift(projectId, project, planningPackage);
  if (!drift) return false;
  const { coverId, stored, target } = drift;
  const job = await enqueueWorkerJob({
    projectId,
    type: "GENERATE_IMAGE",
    payload: { planId, assetType: "COVER", [COVER_RETYPESET]: true },
    dedupeKey: `retypeset-cover:${projectId}:${planId}:${coverId}:${coverRetypesetFingerprint(stored, target)}`
  });
  return job?.status === "QUEUED" || job?.status === "ACTIVE";
}

/**
 * Whether this revision's own cover already ended without a picture — FAILED,
 * or CANCELED under it. Then the cover question for this manuscript is
 * answered: the book publishes coverless (the title sheet) rather than asking
 * `maybeEnqueueCover` for a generation-style cover, which owns the book's
 * outcome and would mark a published book FAILED if it failed too — and whose
 * spent dedupe key would otherwise leave fan-in answering "waiting" forever.
 * The next publish or cover change draws again.
 */
async function revisionCoverSettledWithoutPicture(projectId: string, contentRevision: number): Promise<boolean> {
  const settled = await prisma.generationJob.findMany({
    where: { projectId, type: "GENERATE_IMAGE", contentRevision, status: { in: ["FAILED", "CANCELED"] } },
    select: { payload: true }
  });
  return settled.some((job) => isRevisionOwnedCoverPayload(job.payload));
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
 * no job and no immediate handoff that can reach it. The delayed
 * `reconcileStrandedGeneration` sweep covers both GENERATING and EDITING, while
 * `ensureExportRepairQueued` covers settled COMPLETE/REVIEW_REQUIRED books.
 */
export type CompileDispatchOutcome =
  /** A compile for this manuscript is queued, or one was already in flight. */
  | "compile"
  /** Work in flight fans back in here when it lands — the cover, a page, an image. */
  | "waiting"
  /** Nothing is coming: the saved pages are not a publishable book. */
  | "not-ready"
  /** The project is gone, FAILED, or outside an explicitly required revision. */
  | "settled";

export async function maybeEnqueueCompile(
  projectId: string,
  planId: string,
  options?: LegacyCompileOptions | CompilePublicationPolicy,
  optionsScope?: { contentRevision: number | null; completedPredecessorId?: string; requireContentRevisionMatch?: boolean }
): Promise<CompileDispatchOutcome> {
  const [project, planVersion] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId } }),
    prisma.planVersion.findUnique({ where: { id: planId } })
  ]);
  if (!project || project.status === "FAILED") {
    return "settled";
  }
  // A publication-tail replay is not generic fan-in. Its APPLIED operation
  // already owns one exact revision, so retargeting its compile options to a
  // newer manuscript would give stale work that newer revision's identity.
  if (optionsScope?.requireContentRevisionMatch && optionsScope.contentRevision !== project.contentRevision) {
    return "settled";
  }
  // A completion hook may carry the exact policy of an earlier compile while
  // an edit and its replacement image both land before the hook runs. Compare
  // the scope against this function's own project read: on a mismatch the
  // current revision must recover its own compile intent below, just like
  // optionless image fan-in, rather than inherit stale QA or ownership flags.
  const currentRevisionOptions =
    optionsScope === undefined || optionsScope.contentRevision === project.contentRevision ? options : undefined;
  const completedPredecessor = optionsScope?.contentRevision === project.contentRevision
    ? optionsScope.completedPredecessorId
    : undefined;
  const recoverCompletedPredecessor = options === undefined ||
    (optionsScope?.contentRevision === project.contentRevision && completedPredecessor === undefined);
  const input = inputForPlanVersion(project, planVersion?.inputSnapshot);
  const strategy = resolveBookGenerationStrategy(input).strategy;
  const [pages, openPageJobs, openImageJobs, openCompileJobs, coverAssets, currentRevisionCompiles, latestEdit] =
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
      prisma.generationJob.findMany({
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
        },
        select: { contentRevision: true, payload: true }
      }),
      prisma.imageAsset.count({ where: { projectId, type: "COVER" } }),
      currentRevisionOptions === undefined || recoverCompletedPredecessor
        ? prisma.generationJob.findMany({
            where: { projectId, type: "COMPILE_EXPORT", contentRevision: project.contentRevision },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { id: true, projectId: true, type: true, status: true, contentRevision: true,
              dedupeKey: true, attemptId: true, payload: true }
          })
        : Promise.resolve([]),
      // Image edits return "waiting" without writing a COMPILE_EXPORT row while
      // GENERATE_IMAGE jobs are still open. Live fan-in then arrives with no
      // options and no prior compile for this revision; recover the skip-review
      // policy from the latest APPLIED edit, the same mapping stranded recovery
      // already uses, so that wait cannot upgrade the edit into full QA.
      currentRevisionOptions === undefined
        ? prisma.bookEditOperation.findFirst({
            where: { projectId, status: "APPLIED" },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            // The apply job's payload carries the pre-edit status the recovered
            // edit recompile puts back if it fails (`compileRecoveryPolicy.ts`).
            select: { kind: true, status: true, generationJob: { select: { payload: true } } }
          })
        : Promise.resolve(null)
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
  if (
    pagesReady && coverArtSourceFor(input.mediaSettings) !== "none" && coverAssets === 0 && openImageJobs === 0 &&
    !(await revisionCoverSettledWithoutPicture(projectId, project.contentRevision))
  ) {
    await maybeEnqueueCover(projectId, planId, input);
    return "waiting";
  }
  if (!pagesReady || openImageJobs > 0) {
    // A page or image job still in flight calls back here when it completes;
    // anything else means the saved pages do not add up to a book at all.
    return openPageJobs > 0 || openImageJobs > 0 ? "waiting" : "not-ready";
  }
  if (
    project.status === "GENERATING" &&
    (await maybeEnqueueCoverRetypeset(projectId, project, planId, planVersion?.planningPackage))
  ) {
    return "waiting";
  }
  const policy = currentRevisionOptions
    ? "review" in currentRevisionOptions
      ? currentRevisionOptions
      : legacyCompilePolicy(currentRevisionOptions)
    : strandedCompileRecoveryPolicy({
        status: project.status,
        contentRevision: project.contentRevision,
        mediaSettings: project.mediaSettings,
        jobs: currentRevisionCompiles,
        editOperations: latestEdit ? [latestEdit] : []
      }) ?? (await forkedPublicationRecoveryPolicy({ id: projectId, contentRevision: project.contentRevision }));
  if (policy === null) {
    console.error("Stranded edit compile policy could not be recovered", {
      projectId,
      contentRevision: project.contentRevision
    });
    return "not-ready";
  }
  const policyIdentity = compilePublicationPolicyIdentity(policy, project.status);
  const matchingCompileIsOpen = openCompileJobs.some(
    (compile) =>
      (compile.contentRevision === null || compile.contentRevision === project.contentRevision) &&
      compilePublicationPolicyIdentity(
        compilePublicationPolicyFromPayload(compile.payload),
        project.status
      ) === policyIdentity
  );
  if (!matchingCompileIsOpen) {
    const contentFingerprint = createHash("sha256")
      .update(pages.map((page) => `${page.id}:${page.revision}`).sort().join("|"))
      .digest("hex")
      .slice(0, 24);
    const contentRevision = project.contentRevision;
    const baseDedupeKey = compilePublicationDedupeKey({
      projectId,
      planId,
      contentRevision,
      policy,
      projectStatus: project.status,
      contentFingerprint
    });
    const recoveredIdentity = recoverCompletedPredecessor ? recoveredCompileSuccessorIdentity({
      projectId, contentRevision, baseDedupeKey, policyIdentity, projectStatus: project.status,
      jobs: currentRevisionCompiles
    }) : null;
    const identity = completedPredecessor
      ? await compileIdentityAfterCompletion({
          projectId,
          contentRevision,
          baseDedupeKey,
          completedPredecessorId: completedPredecessor
        })
      : recoveredIdentity ?? { dedupeKey: baseDedupeKey };
    await enqueueWorkerJob({
      projectId,
      type: "COMPILE_EXPORT",
      payload: {
        planId,
        contentRevision,
        ...compilePolicyPayload(policy, project.status)
      },
      dedupeKey: identity.dedupeKey,
      contentRevision,
      ...(identity.attemptIdOverride !== undefined ? { attemptIdOverride: identity.attemptIdOverride } : {})
    });
  }
  return "compile";
}

const STRANDED_GENERATION_GRACE_MS = 60_000;

/**
 * Retires a publication barrier whose last Bull delivery can no longer do it.
 *
 * The manuscript transaction completes its GenerationJob before the
 * post-publication tail unlinks the old files. If that tail exhausts its Bull
 * attempts while the database is unavailable, the job is already terminal and
 * neither queue reconciliation can replay it. The stranded-generation sweep is
 * the remaining durable owner of the recovery.
 *
 * A live tail is excluded in database time, using the same operation lease it
 * heartbeats around filesystem invalidation. Ordinary edits own their project
 * directly. A book-replan operation remains on the source project, so its
 * completed GENERATE_BOOK successor is the durable relationship to the copy.
 * Once neither supported owner has a live lease, clearing is the safe
 * direction: a later delivery reads NULL as "already retired" and will not
 * unlink files a recovery compile installs.
 */
async function retireAbandonedCurrentExportBarrier(project: {
  id: string;
  status: string;
  contentRevision: number;
  exportInvalidationRevision: number | null;
}): Promise<boolean> {
  if (
    project.status !== "EDITING" ||
    project.exportInvalidationRevision !== project.contentRevision
  ) {
    return true;
  }
  const retired = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE "Project" project
        SET "exportInvalidationRevision" = NULL,
            "updatedAt" = CURRENT_TIMESTAMP
      WHERE project."id" = $1
        AND project."status" = 'EDITING'
        AND project."contentRevision" = $2
        AND project."exportInvalidationRevision" = $2
        AND NOT EXISTS (
          SELECT 1
            FROM "BookEditOperation" operation
           WHERE operation."publicationRevision" = $2
             AND operation."status" = 'APPLIED'
             AND operation."structuralLeaseToken" IS NOT NULL
             AND operation."structuralLeaseExpiresAt" > CURRENT_TIMESTAMP
             AND operation."structuralLeaseCompletedAt" IS NULL
             AND (
               operation."projectId" = project."id"
               OR (
                 operation."kind" = 'BOOK_REPLAN'
                 AND operation."projectId" <> project."id"
                 AND operation."sourceProjectId" = operation."projectId"
                 AND EXISTS (
                   SELECT 1
                     FROM "GenerationJob" job
                    WHERE job."id" = operation."generationJobId"
                      AND job."projectId" = project."id"
                      AND job."type" = 'GENERATE_BOOK'
                      AND job."status" = 'COMPLETED'
                 )
               )
             )
        )
      RETURNING project."id"`,
    project.id,
    project.contentRevision
  );
  return retired.length === 1;
}

/**
 * Recovers a run whose fan-in trigger was lost. The compile (or cover) is
 * enqueued only after the last page/image job is marked COMPLETED, so a worker
 * dying in between leaves a fully written, fully paid book GENERATING forever:
 * every job row terminal, no COMPILE_EXPORT row, and nothing left to push it
 * forward. EDITING has the same crash shape after an edit/restructure compile
 * stands down for a sibling replacement image: its post-completion fan-in is
 * best-effort because the delivered compile must not be failed or refunded if
 * Redis/DB is briefly unavailable. `maybeEnqueueCompile` re-derives readiness
 * from the rows and dedupes on content, so replaying it here is idempotent —
 * projects that are merely unfinished no-op out of it.
 */
export async function reconcileStrandedGeneration(limit = 20): Promise<number> {
  const cutoff = new Date(Date.now() - STRANDED_GENERATION_GRACE_MS);
  const projects = await prisma.project.findMany({
    where: {
      OR: [
        { status: { in: ["GENERATING", "EDITING"] } },
        // A completed import may exhaust its Bull tail attempts before its
        // first compile is persisted. Recover only that original manuscript;
        // later revisions and already dispatched exports have their own owner.
        {
          status: "COMPLETE", contentRevision: 1, currentPlan: { version: 1 },
          bookImport: { status: "COMPLETE" }, jobs: { none: { type: "COMPILE_EXPORT" } }
        }
      ],
      currentPlanId: { not: null },
      updatedAt: { lt: cutoff },
      jobs: { none: { status: { in: ["QUEUED", "ACTIVE"] } } }
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: {
      id: true,
      status: true,
      contentRevision: true,
      exportInvalidationRevision: true,
      currentPlanId: true,
      mediaSettings: true
    }
  });
  const results = await Promise.allSettled(
    projects.map(async (project) => {
      if (!project.currentPlanId) {
        return;
      }
      if (!(await retireAbandonedCurrentExportBarrier(project))) {
        return;
      }
      const recovery = await loadStrandedCompileRecoveryPolicy(project);
      if (recovery === null) {
        console.error("Stranded edit compile policy could not be recovered", {
          projectId: project.id,
          contentRevision: project.contentRevision
        });
        return;
      }
      return maybeEnqueueCompile(
        project.id,
        project.currentPlanId,
        recovery.policy,
        { contentRevision: project.contentRevision, ...(project.status === "COMPLETE" ? { requireContentRevisionMatch: true } : {}) }
      );
    })
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("Stranded generation reconciliation failed for a project", result.reason);
    }
  }
  return projects.length;
}

export async function maybeCompileAfterCompletedJob(job: WorkerRuntimeJob) {
  if (job.name !== "generate-page" && job.name !== "generate-image") {
    return;
  }
  const { projectId, planId } = job.data;
  if (!projectId || !planId) {
    return;
  }
  await compileOutsidePurchase(job, () => maybeEnqueueCompile(projectId, planId));
}

/**
 * The failure twin of `maybeCompileAfterCompletedJob`, for the one job whose
 * failure leaves a compile waiting on it: a revision-owned cover. `markFailed`
 * settles that row alone (`coverSettlement.ts`) and never the book, but the
 * compile its revision queued stood down while the cover was open — or is still
 * queued behind it — and until now only the cover's *completion* re-queued it,
 * so a failed cover left the book EDITING with nothing coming. Released here, it
 * publishes the revision with the cover the book already has, or coverless
 * (`revisionCoverSettledWithoutPicture`), and ends COMPLETE or REVIEW_REQUIRED.
 *
 * Only while the book is still the revision and status the cover was queued
 * for: a newer revision's own jobs fan in for it, and a settled book must not be
 * handed a recompile nobody asked for.
 */
export async function maybeCompileAfterFailedJob(job: WorkerRuntimeJob): Promise<CompileDispatchOutcome | null> {
  if (job.name !== "generate-image" || !isRevisionOwnedCoverPayload(job.data)) {
    return null;
  }
  const { projectId, planId, contentRevision } = job.data;
  if (!projectId || !planId || contentRevision === undefined) {
    return null;
  }
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { status: true, contentRevision: true, currentPlanId: true }
  });
  if (
    !project ||
    project.status !== exportPublicationProjectStatusFromPayload(job.data) ||
    project.contentRevision !== contentRevision ||
    project.currentPlanId !== planId
  ) {
    return "settled";
  }
  return compileOutsidePurchase(job, () =>
    maybeEnqueueCompile(projectId, planId, undefined, { contentRevision, requireContentRevisionMatch: true })
  );
}

/**
 * A purchased cover's attempt is the purchase alone, settled by its own job;
 * the compile after it is free presentation work that must never carry it, or
 * a refunded purchase would stand that compile down as stale and a failed
 * reprint could never settle a delivered one. Fan-in otherwise inherits the
 * delivery's attempt from context, so it is run outside it here.
 */
function compileOutsidePurchase<T>(job: WorkerRuntimeJob, fanIn: () => Promise<T>): Promise<T> {
  return isCoverPurchasePayload(job.data) ? runWithGenerationAttempt(null, fanIn) : fanIn();
}

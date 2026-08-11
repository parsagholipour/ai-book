import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import {
  BOOK_GENERATION_CHARGE_LOOKBACK,
  STOPPED_JOB_ERROR,
  STOPPED_JOB_MESSAGE,
  bookGenerationChargeFromPayloads,
  dispatchBackoffMs,
  generationJobOwnsFailureLifecycle,
  isPresentationOnlyRecompile,
  jobNames,
  payloadOwnsProjectOutcome,
  jobOwnsQualityVerdict,
  jsonPayloadToRecord,
  loadConfig,
  presentationRecompileFallbackStatus,
  retryJobOptions,
  type GenerationJobType
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import {
  failGenerationAttempt,
  refundCreditLedgerEntry,
  refundLatestProjectOperationCredits
} from "@book-maker/db/billing";

// The job-name table, retry budgets, backoff, and stop constants are shared
// with the worker through @book-maker/core/jobDispatch — one definition on
// both sides of the queue.
export { jobNames, type GenerationJobType };

export const BOOK_QUEUE_NAME = "book-maker";

const config = loadConfig();

export const redisConnection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null
});

export const bookQueue = new Queue(BOOK_QUEUE_NAME, {
  connection: redisConnection
});

type RequeueableGenerationJob = {
  id: string;
  projectId: string;
  type: GenerationJobType;
  payload: Prisma.JsonValue | Record<string, unknown>;
};

export async function enqueueGenerationJob(options: {
  projectId: string;
  type: GenerationJobType;
  payload: Record<string, unknown>;
  dedupeKey?: string | undefined;
  contentRevision?: number | undefined;
  attemptId?: string | undefined;
  transaction?: Prisma.TransactionClient | undefined;
  dispatch?: boolean | undefined;
}) {
  const db = options.transaction ?? prisma;
  if (options.dedupeKey) {
    const existing = await db.generationJob.findUnique({ where: { dedupeKey: options.dedupeKey } });
    if (existing) {
      if (options.dispatch !== false && existing.status === "QUEUED" && !existing.bullJobId) {
        return (await dispatchGenerationJob(existing.id)) ?? existing;
      }
      return existing;
    }
  }
  let generationJob;
  try {
    generationJob = await db.generationJob.create({
      data: {
        projectId: options.projectId,
        type: options.type,
        payload: options.payload as Prisma.InputJsonValue,
        // Promoted out of the payload here for the same reason
        // `contentRevision` is: the read side has to be able to ask for the
        // compile whose verdict is the book's, and a payload flag cannot be
        // negated in SQL without dropping every row that never carried it.
        ownsQualityVerdict: jobOwnsQualityVerdict(options.type, options.payload),
        ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
        ...(options.contentRevision !== undefined ? { contentRevision: options.contentRevision } : {}),
        ...(options.attemptId ? { attemptId: options.attemptId } : {}),
        status: "QUEUED",
        progress: 0,
        message: "Queued"
      }
    });
  } catch (error) {
    if (!(options.dedupeKey && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
      throw error;
    }
    generationJob = await db.generationJob.findUnique({ where: { dedupeKey: options.dedupeKey } });
    if (!generationJob) {
      throw error;
    }
  }
  if (options.dispatch === false) {
    return generationJob;
  }
  return (await dispatchGenerationJob(generationJob.id)) ?? generationJob;
}

/**
 * Publishes a durable database job to BullMQ. A Redis outage deliberately
 * leaves the row QUEUED so reconciliation can publish it later; callers can
 * safely return the durable job instead of rolling domain state back.
 */
export async function dispatchGenerationJob(generationJobId: string) {
  const generationJob = await prisma.generationJob.findUnique({ where: { id: generationJobId } });
  if (!generationJob || generationJob.status !== "QUEUED") {
    return generationJob;
  }
  if (generationJob.bullJobId) {
    return generationJob;
  }
  const payload = jsonPayloadToRecord(generationJob.payload);
  const jobName = jobNames[generationJob.type as GenerationJobType];
  if (!jobName) {
    console.error("Generation job has no worker job name; leaving it undispatched", {
      generationJobId: generationJob.id,
      type: generationJob.type
    });
    return generationJob;
  }
  try {
    const bullJob = await bookQueue.add(
      jobName,
      {
        ...payload,
        projectId: generationJob.projectId,
        generationJobId: generationJob.id,
        ...(generationJob.attemptId ? { attemptId: generationJob.attemptId } : {})
      },
      { ...jobOptionsForType(generationJob.type as GenerationJobType), jobId: generationJob.id }
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
      error: error instanceof Error ? error.message : "Unknown error"
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
 * Compensation for a charged enqueue that failed after its transaction
 * committed. A QUEUED row without a bullJobId is exactly what the reconcilers
 * re-publish, so a refund taken while the row survives pays back work that
 * still runs. Flipping it to CANCELED atomically takes it away from both
 * reconcilers; the conditional match is what makes "provably dead" true even
 * when a reconciler races this call. Returns false when the row was already
 * dispatched or claimed — then the work will run and the charge must stand.
 */
export async function cancelUndispatchedGenerationJob(generationJobId: string, reason: string): Promise<boolean> {
  const result = await prisma.generationJob.updateMany({
    where: { id: generationJobId, status: "QUEUED", bullJobId: null },
    data: { status: "CANCELED", finishedAt: new Date(), message: "Canceled", error: reason }
  });
  return result.count === 1;
}

export async function reconcileUndispatchedGenerationJobs(limit = 50): Promise<number> {
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
  const results = await Promise.allSettled(jobs.map((job) => dispatchGenerationJob(job.id)));
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("Generation job reconciliation failed for a row", result.reason);
    }
  }
  return jobs.length;
}

export async function requeueGenerationJob(job: RequeueableGenerationJob) {
  const payload = jsonPayloadToRecord(job.payload);

  const existingBullId = await prisma.generationJob.findUnique({
    where: { id: job.id },
    select: { bullJobId: true }
  });
  if (existingBullId?.bullJobId) {
    const existingBullJob = await bookQueue.getJob(existingBullId.bullJobId);
    if (existingBullJob && (await existingBullJob.getState()) !== "active") {
      await existingBullJob.remove().catch(() => undefined);
    }
  }

  await prisma.generationJob.update({
    where: { id: job.id },
    data: {
      status: "QUEUED",
      progress: 0,
      message: "Queued for resume",
      error: null,
      startedAt: null,
      finishedAt: null,
      bullJobId: null,
      dispatchedAt: null,
      nextDispatchAt: null,
      steps: Prisma.JsonNull,
      payload: payload as Prisma.InputJsonValue
    }
  });

  const durableJob = await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } });
  return (await dispatchGenerationJob(job.id)) ?? durableJob;
}

/**
 * The statuses a stop may not move a project out of.
 *
 * A finished book is finished whatever is stopped alongside it, and work is
 * queued against a COMPLETE or REVIEW_REQUIRED project all the time: an export
 * repair the status poll asked for, a narration, an edit that has not started
 * yet. None of that is the book's own outcome — the worker refuses to fail the
 * project for any of it (`jobOwnsProjectLifecycle`, and `ownsProjectStatus` on
 * the success side) — but a stop cancels a QUEUED job without the worker ever
 * seeing it, so the same decision has to be made a third time, here.
 *
 * Getting it wrong is terminal rather than cosmetic. A delivered, paid book
 * marked FAILED reads as trouble on every surface (`failureMessage` feeds the
 * app's `hasFailure`, i.e. `BookStage.needsAttention`) and nothing can move it
 * back: `ensureExportRepairQueued` only queues for these two statuses, so the
 * self-repair lane is shut off, and `canRecoverGenerationJob` refuses detached
 * rows, so neither resume route will requeue one either. The operator console
 * offers Stop whenever any job is QUEUED or ACTIVE, which a repair is, so one
 * click on a book whose PDF had gone missing was enough.
 *
 * The guard is on the *status* rather than on what was stopped, because that is
 * the property worth holding: the two settled statuses are exactly the ones a
 * book reaches by being finished. Real in-flight work is never in one — a
 * generation is GENERATING, an edit that has started is EDITING — so anything
 * whose stop genuinely fails a book still fails it.
 */
const SETTLED_PROJECT_STATUSES = ["COMPLETE", "REVIEW_REQUIRED"] as const;

export async function stopProjectGenerationJobs(projectId: string) {
  // Publication takes the project row and then its durable job row. Stop uses
  // the same lock order and terminalizes both in one transaction, so exactly
  // one outcome wins: a committed publication owns COMPLETED and cannot be
  // refunded, while a committed stop owns FAILED and cannot publish.
  const openJobs = await prisma.$transaction(async (tx) => {
    const project = await tx.project.update({
      where: { id: projectId },
      data: { contentRevision: { increment: 0 } },
      select: { status: true }
    });
    const candidates = await tx.generationJob.findMany({
      where: { projectId, status: { in: ["QUEUED", "ACTIVE"] } },
      select: { id: true, bullJobId: true, status: true, type: true, payload: true, attemptId: true }
    });
    const stopped = [] as typeof candidates;
    for (const candidate of candidates) {
      const claimed = await tx.generationJob.updateMany({
        where: { id: candidate.id, status: { in: ["QUEUED", "ACTIVE"] } },
        data: {
          status: "FAILED",
          message: STOPPED_JOB_MESSAGE,
          error: STOPPED_JOB_ERROR,
          finishedAt: new Date()
        }
      });
      if (claimed.count === 1) {
        stopped.push(candidate);
      }
    }

    // The status write is guarded on the *status*, never on what was stopped
    // (see SETTLED_PROJECT_STATUSES above): a stop that claims zero rows is
    // routinely a stranded project — GENERATING with its jobs long gone — and
    // Stop is the one lever the user has to move it back to a retryable
    // FAILED. The single exception is a free presentation reprint caught
    // mid-flight with nothing owning stopped alongside it: its EDITING belongs
    // to a settled book, so it goes back to the settled status it was born
    // under rather than to FAILED.
    const owningStopped = stopped.some((job) => generationJobOwnsFailureLifecycle(job.type, job.payload));
    const presentation = stopped.find((job) => isPresentationOnlyRecompile(job.payload));
    if (!owningStopped && presentation && project.status === "EDITING") {
      await tx.project.updateMany({
        where: { id: projectId, status: "EDITING" },
        data: { status: presentationRecompileFallbackStatus(presentation.payload) }
      });
    } else {
      await tx.project.updateMany({
        where: { id: projectId, status: { notIn: [...SETTLED_PROJECT_STATUSES] } },
        data: { status: "FAILED" }
      });
    }
    return stopped;
  });
  let removedQueueJobs = 0;

  await Promise.all(
    openJobs.map(async (job) => {
      if (!job.bullJobId) {
        return;
      }
      const bullJob = await bookQueue.getJob(job.bullJobId);
      if (!bullJob) {
        return;
      }
      const state = await bullJob.getState();
      if (state === "active") {
        return;
      }
      try {
        await bullJob.remove();
        removedQueueJobs += 1;
      } catch {
        // A worker may have claimed the job between the state check and remove.
      }
    })
  );

  // Every stopped job that belongs to a paid attempt settles through the
  // attempt state machine: terminalizing the attempt refunds its own ledger
  // entry (plan, edit, audiobook or book — whichever paid for it) exactly once,
  // and marks the attempt CANCELED so its rows can never be resumed for free.
  // This is idempotent against the worker noticing the stop on an active job
  // and settling the same attempt itself.
  const attemptIds = [
    ...new Set(
      openJobs.flatMap((job) =>
        job.attemptId && payloadOwnsProjectOutcome(job.payload) ? [job.attemptId] : []
      )
    )
  ];
  for (const attemptId of attemptIds) {
    await failGenerationAttempt(attemptId, STOPPED_JOB_ERROR, "CANCELED").catch((error) => {
      // failGenerationAttempt left refundPending set; the worker's refund
      // reconciler finishes the settlement.
      console.error(`Failed to settle stopped generation attempt ${attemptId}`, error);
    });
  }

  // Only rows enqueued before the attempt ledger existed still resolve through
  // the legacy paths — and only when such rows were actually stopped. Running
  // the fallback unconditionally refunded the latest full-book charge for
  // stops that cancelled nothing but attempt-tracked work.
  //
  // A detached row is excluded for exactly the reason the worker excludes it
  // from `markFailed`, and this is the second place that decision has to be
  // made: an export repair is attempt-less, is typed `COMPILE_EXPORT`, and
  // carries the finished book's own `planId` — so the book-run walk below finds
  // that book's `GENERATE_BOOK` charge and hands it back because a rebuild of a
  // missing file was cancelled. Deleting a finished book is enough to trigger
  // it: the status poll queues a repair the moment the PDF is missing, and both
  // delete routes stop the project's open jobs first. It is not legacy work —
  // nothing was charged for it, so nothing settles.
  const legacyJobs = openJobs.filter((job) => !job.attemptId && payloadOwnsProjectOutcome(job.payload));
  if (legacyJobs.length > 0) {
    await settleLegacyStoppedJobs(projectId, legacyJobs);
  }
  await closeDerivativeRowsForStoppedJobs(openJobs);

  return {
    stoppedJobs: openJobs.length,
    activeJobs: openJobs.filter((job) => job.status === "ACTIVE").length,
    removedQueueJobs
  };
}

const BOOK_RUN_JOB_TYPES = new Set(["GENERATE_BOOK", "GENERATE_PAGE", "GENERATE_IMAGE", "COMPILE_EXPORT"]);

/**
 * Legacy (attempt-less) rows settle the way the worker settles them: each job
 * type against its own charge. Only book-run rows may walk to the project's
 * full-book entry — routing a stopped audiobook or edit there refunds a charge
 * that paid for a book the user keeps.
 */
async function settleLegacyStoppedJobs(
  projectId: string,
  legacyJobs: ReadonlyArray<{ id: string; type: string; payload: unknown }>
): Promise<void> {
  const refundedEntryIds = new Set<string>();
  const refundOnce = async (entryId: string) => {
    if (!refundedEntryIds.has(entryId)) {
      refundedEntryIds.add(entryId);
      await refundCreditLedgerEntry(entryId, STOPPED_JOB_ERROR);
    }
  };
  const bookRunJobs: Array<{ type: string; payload: unknown }> = [];
  for (const job of legacyJobs) {
    const payload = jsonPayloadToRecord(job.payload);
    const ownEntryId =
      typeof payload.billingLedgerEntryId === "string" && payload.billingLedgerEntryId
        ? payload.billingLedgerEntryId
        : null;
    if (BOOK_RUN_JOB_TYPES.has(job.type)) {
      bookRunJobs.push(job);
      continue;
    }
    if (job.type === "PLAN_BOOK") {
      if (ownEntryId) {
        await refundOnce(ownEntryId);
      } else {
        await refundLatestProjectOperationCredits({ projectId, operation: "PLAN_GENERATION", reason: STOPPED_JOB_ERROR });
      }
      continue;
    }
    // Audiobooks, edits, continuations, replans: their own stamped entry, or
    // their operation's. Unpriced derivative work (characters, research)
    // stamps nothing and refunds nothing.
    if (ownEntryId) {
      await refundOnce(ownEntryId);
      continue;
    }
    const operationId = legacyOperationId(payload);
    if (operationId) {
      const operation = await prisma.bookEditOperation.findUnique({
        where: { id: operationId },
        select: { ledgerEntryId: true }
      });
      if (operation?.ledgerEntryId) {
        await refundOnce(operation.ledgerEntryId);
      }
    }
  }
  if (bookRunJobs.length > 0) {
    const chargedEntryId = await stoppedRunLedgerEntryId(projectId, bookRunJobs);
    if (chargedEntryId) {
      await refundOnce(chargedEntryId);
    } else {
      await refundLatestProjectOperationCredits({
        projectId,
        operation: "FULL_BOOK_GENERATION",
        reason: STOPPED_JOB_ERROR
      });
    }
  }
}

/**
 * A stopped QUEUED job never reaches the worker, so the rows it would have
 * closed on failure must be closed here: an Audiobook left GENERATING blocks
 * every future narration, and an open BookEditOperation blocks every future
 * edit through the one-open-per-project index.
 */
async function closeDerivativeRowsForStoppedJobs(
  openJobs: ReadonlyArray<{ id: string; type: string; payload: unknown }>
): Promise<void> {
  const audiobookJobIds = openJobs.filter((job) => job.type === "GENERATE_AUDIOBOOK").map((job) => job.id);
  if (audiobookJobIds.length > 0) {
    await prisma.audiobook.updateMany({
      where: { generationJobId: { in: audiobookJobIds }, status: "GENERATING" },
      data: { status: "FAILED", error: STOPPED_JOB_ERROR }
    });
  }
  const operationIds = [
    ...new Set(openJobs.flatMap((job) => {
      const operationId = legacyOperationId(jsonPayloadToRecord(job.payload));
      return operationId ? [operationId] : [];
    }))
  ];
  if (operationIds.length > 0) {
    await prisma.bookEditOperation.updateMany({
      where: { id: { in: operationIds }, status: { in: ["QUEUED", "ACTIVE"] } },
      data: { status: "CANCELED", error: STOPPED_JOB_ERROR }
    });
  }
}

function legacyOperationId(payload: Record<string, unknown>): string | null {
  const value = payload.operationId ?? payload.editOperationId ?? payload.replanOperationId;
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The charge that paid for the run being stopped, resolved the same way the
 * worker settles a failed run (its runtime/jobLifecycle.ts): the GENERATE_BOOK
 * payload's own ledger entry first, then the plan walk shared through
 * `bookGenerationChargeFromPayloads`. Null falls back to the latest
 * FULL_BOOK_GENERATION charge, which keeps runs enqueued before the payload
 * stamp refundable.
 */
async function stoppedRunLedgerEntryId(
  projectId: string,
  openJobs: ReadonlyArray<{ type: string; payload: unknown }>
): Promise<string | null> {
  let planId: string | null = null;
  for (const job of openJobs) {
    const payload = jsonPayloadToRecord(job.payload);
    if (job.type === "GENERATE_BOOK" && typeof payload.billingLedgerEntryId === "string" && payload.billingLedgerEntryId) {
      return payload.billingLedgerEntryId;
    }
    if (!planId && typeof payload.planId === "string" && payload.planId) {
      planId = payload.planId;
    }
  }
  if (!planId) {
    return null;
  }
  const rows = await prisma.generationJob.findMany({
    where: { projectId, type: "GENERATE_BOOK" },
    orderBy: { createdAt: "desc" },
    take: BOOK_GENERATION_CHARGE_LOOKBACK,
    select: { payload: true }
  });
  return bookGenerationChargeFromPayloads(rows, planId);
}

export async function isBullJobActive(bullJobId: string | null): Promise<boolean> {
  if (!bullJobId) {
    return false;
  }
  const bullJob = await bookQueue.getJob(bullJobId);
  if (!bullJob) {
    return false;
  }
  return (await bullJob.getState()) === "active";
}

export async function closeQueue() {
  await bookQueue.close();
  redisConnection.disconnect();
}

function jobOptionsForType(type: GenerationJobType): JobsOptions | undefined {
  return retryJobOptions(jobNames[type]);
}

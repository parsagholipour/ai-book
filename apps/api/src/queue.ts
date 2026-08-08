import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import {
  BOOK_GENERATION_CHARGE_LOOKBACK,
  STOPPED_JOB_ERROR,
  STOPPED_JOB_MESSAGE,
  bookGenerationChargeFromPayloads,
  dispatchBackoffMs,
  jobNames,
  jsonPayloadToRecord,
  loadConfig,
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

export async function stopProjectGenerationJobs(projectId: string) {
  await prisma.project.update({ where: { id: projectId }, data: { status: "FAILED" } });

  const openJobs = await prisma.generationJob.findMany({
    where: { projectId, status: { in: ["QUEUED", "ACTIVE"] } },
    select: { id: true, bullJobId: true, status: true, type: true, payload: true, attemptId: true }
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

  const finishedAt = new Date();
  const stoppedJobs = await prisma.generationJob.updateMany({
    where: { projectId, status: { in: ["QUEUED", "ACTIVE"] } },
    data: {
      status: "FAILED",
      message: STOPPED_JOB_MESSAGE,
      error: STOPPED_JOB_ERROR,
      finishedAt
    }
  });
  // Every stopped job that belongs to a paid attempt settles through the
  // attempt state machine: terminalizing the attempt refunds its own ledger
  // entry (plan, edit, audiobook or book — whichever paid for it) exactly once,
  // and marks the attempt CANCELED so its rows can never be resumed for free.
  // This is idempotent against the worker noticing the stop on an active job
  // and settling the same attempt itself.
  const attemptIds = [...new Set(openJobs.flatMap((job) => (job.attemptId ? [job.attemptId] : [])))];
  for (const attemptId of attemptIds) {
    await failGenerationAttempt(attemptId, STOPPED_JOB_ERROR, "CANCELED").catch((error) => {
      // failGenerationAttempt left refundPending set; the worker's refund
      // reconciler finishes the settlement.
      console.error(`Failed to settle stopped generation attempt ${attemptId}`, error);
    });
  }

  // Only rows enqueued before the attempt ledger existed still resolve through
  // the legacy charge walk — and only when such rows were actually stopped.
  // Running the fallback unconditionally refunded the latest full-book charge
  // for stops that cancelled nothing but attempt-tracked work.
  const legacyJobs = openJobs.filter((job) => !job.attemptId);
  if (legacyJobs.length > 0) {
    const chargedEntryId = await stoppedRunLedgerEntryId(projectId, legacyJobs);
    if (chargedEntryId) {
      await refundCreditLedgerEntry(chargedEntryId, STOPPED_JOB_ERROR);
    } else {
      await refundLatestProjectOperationCredits({
        projectId,
        operation: "FULL_BOOK_GENERATION",
        reason: STOPPED_JOB_ERROR
      });
    }
  }

  return {
    stoppedJobs: stoppedJobs.count,
    activeJobs: openJobs.filter((job) => job.status === "ACTIVE").length,
    removedQueueJobs
  };
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

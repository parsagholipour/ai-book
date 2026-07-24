import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import { loadConfig } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { refundLatestProjectOperationCredits } from "@book-maker/db/billing";

export const BOOK_QUEUE_NAME = "book-maker";

const config = loadConfig();

export const redisConnection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null
});

export const bookQueue = new Queue(BOOK_QUEUE_NAME, {
  connection: redisConnection
});

const GENERATE_PAGE_RECOVERY_ATTEMPTS = 4;
// generate-book jobs resume from settled pages on retry (see the worker's
// directGenerationResume.ts), so one automatic retry recovers a network blip
// without regenerating finished work. Keep in sync with the worker's
// jobRetryPolicy.ts.
const GENERATE_BOOK_RECOVERY_ATTEMPTS = 2;
const GENERATE_PAGE_RECOVERY_BACKOFF_MS = 15_000;
const DISPATCH_BACKOFF_BASE_MS = 5_000;
const DISPATCH_BACKOFF_MAX_MS = 5 * 60_000;
const STOPPED_JOB_MESSAGE = "Stopped";
const STOPPED_JOB_ERROR = "Stopped by user";

export const jobNames = {
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
  RESEARCH: "research",
  IMPORT_BOOK: "import-book",
  CONTINUE_BOOK: "continue-book"
} as const;

export type GenerationJobType = keyof typeof jobNames;

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
  try {
    const bullJob = await bookQueue.add(
      jobNames[generationJob.type as GenerationJobType],
      {
        ...payload,
        projectId: generationJob.projectId,
        generationJobId: generationJob.id
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
  await Promise.all(jobs.map((job) => dispatchGenerationJob(job.id)));
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
    select: { id: true, bullJobId: true, status: true }
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
  await refundLatestProjectOperationCredits({
    projectId,
    operation: "FULL_BOOK_GENERATION",
    reason: STOPPED_JOB_ERROR
  });

  return {
    stoppedJobs: stoppedJobs.count,
    activeJobs: openJobs.filter((job) => job.status === "ACTIVE").length,
    removedQueueJobs
  };
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

function jsonPayloadToRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  return payload as Record<string, unknown>;
}

function jobOptionsForType(type: GenerationJobType): JobsOptions | undefined {
  const attempts =
    type === "GENERATE_PAGE"
      ? GENERATE_PAGE_RECOVERY_ATTEMPTS
      : type === "GENERATE_BOOK"
        ? GENERATE_BOOK_RECOVERY_ATTEMPTS
        : undefined;
  if (attempts === undefined) {
    return undefined;
  }
  return {
    attempts,
    backoff: {
      type: "exponential",
      delay: GENERATE_PAGE_RECOVERY_BACKOFF_MS
    }
  };
}

function dispatchBackoffMs(attempt: number): number {
  return Math.min(DISPATCH_BACKOFF_MAX_MS, DISPATCH_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

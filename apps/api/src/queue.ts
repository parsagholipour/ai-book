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
const GENERATE_PAGE_RECOVERY_BACKOFF_MS = 15_000;
const STOPPED_JOB_MESSAGE = "Stopped";
const STOPPED_JOB_ERROR = "Stopped by user";

const jobNames = {
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
  RESEARCH: "research"
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
}) {
  const generationJob = await prisma.generationJob.create({
    data: {
      projectId: options.projectId,
      type: options.type,
      payload: options.payload as Prisma.InputJsonValue,
      status: "QUEUED",
      progress: 0,
      message: "Queued"
    }
  });

  const bullJob = await bookQueue.add(
    jobNames[options.type],
    {
      ...options.payload,
      projectId: options.projectId,
      generationJobId: generationJob.id
    },
    jobOptionsForType(options.type)
  );

  return prisma.generationJob.update({
    where: { id: generationJob.id },
    data: { bullJobId: bullJob.id ?? null }
  });
}

export async function requeueGenerationJob(job: RequeueableGenerationJob) {
  const payload = jsonPayloadToRecord(job.payload);

  await prisma.generationJob.update({
    where: { id: job.id },
    data: {
      status: "QUEUED",
      progress: 0,
      message: "Queued for resume",
      error: null,
      startedAt: null,
      finishedAt: null,
      steps: Prisma.JsonNull,
      payload: payload as Prisma.InputJsonValue
    }
  });

  const bullJob = await bookQueue.add(
    jobNames[job.type],
    {
      ...payload,
      projectId: job.projectId,
      generationJobId: job.id
    },
    jobOptionsForType(job.type)
  );

  return prisma.generationJob.update({
    where: { id: job.id },
    data: { bullJobId: bullJob.id ?? null }
  });
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
  if (type !== "GENERATE_PAGE") {
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

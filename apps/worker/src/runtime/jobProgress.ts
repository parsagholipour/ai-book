import { generationJobTypeForWorkerName, JOB_STEP_TEMPLATES, type JobStep } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { StopRequestedError, isStoppedGenerationJob } from "./jobTypes.js";

/**
 * Progress reporting for `GenerationJob` rows. The status transitions that
 * consume these live in jobLifecycle.ts; handlers report movement through here.
 *
 * The step templates themselves are `JOB_STEP_TEMPLATES` in
 * `packages/core/src/jobSteps.ts` — exhaustive over `GenerationJobType`, so a
 * new job type cannot ship without them, and shared with the operator console
 * rather than hand-mirrored into it.
 */

export function buildStepTemplate(jobName: string): JobStep[] {
  // The table is keyed by `GenerationJobType`; a running BullMQ job only knows
  // its kebab name. An unrecognised name yields no steps, exactly as before.
  const type = generationJobTypeForWorkerName(jobName);
  const template = type ? JOB_STEP_TEMPLATES[type] : undefined;
  if (!template) {
    return [];
  }
  return template.map((step, index) => ({
    ...step,
    status: index === 0 ? "active" : "pending"
  }));
}

export function parseJobSteps(value: unknown): JobStep[] {
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

export async function updateJobProgress(
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
      // The single write site for progress, so the clamp lives here: handlers
      // derive percentages from counters that can legitimately overshoot (a
      // resumed audiobook whose old partition had more chapters than the
      // current one) and the app renders whatever number lands in the row.
      ...(update.progress !== undefined ? { progress: Math.min(100, update.progress) } : {}),
      ...(update.message !== undefined ? { message: update.message } : {}),
      ...(update.steps !== undefined ? { steps: update.steps as Prisma.InputJsonValue } : {})
    }
  });
}

/**
 * Countable facts about the step being worked on, for the API to narrate.
 *
 * Deliberately numbers and tokens rather than sentences: `GenerationJob.message`
 * is internal text the mobile serializers must never forward, so anything the
 * reader is meant to see has to arrive as data they can phrase themselves.
 */
export type JobStepCounters = {
  done?: number;
  total?: number;
  phase?: string;
  pageIndex?: number;
};

function withCounters(step: JobStep, counters: JobStepCounters | undefined): JobStep {
  if (!counters) {
    return step;
  }
  return {
    ...step,
    ...(typeof counters.done === "number" ? { done: counters.done } : {}),
    ...(typeof counters.total === "number" ? { total: counters.total } : {}),
    ...(counters.phase ? { phase: counters.phase } : {}),
    ...(typeof counters.pageIndex === "number" ? { pageIndex: counters.pageIndex } : {})
  };
}

/**
 * Marks `activeKey` as the step being worked on, optionally with counters.
 *
 * Re-calling it for the step that is already active is the supported way to
 * report movement inside a long step — which page of an edit is being rewritten
 * and what is being done to it — because it is the same single write either way.
 */
export async function advanceJobStep(
  generationJobId: string | undefined,
  activeKey: string,
  progress?: number,
  message?: string,
  counters?: JobStepCounters
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
      return withCounters({ ...step, status: "active" as const }, counters);
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

export async function completeAllJobSteps(generationJobId: string | undefined) {
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

export async function failActiveJobStep(
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

export async function assertJobNotStopped(generationJobId: string | undefined) {
  if (await hasStoppedGenerationJob(generationJobId)) {
    throw new StopRequestedError();
  }
}

export async function hasStoppedGenerationJob(generationJobId: string | undefined): Promise<boolean> {
  if (!generationJobId) {
    return false;
  }
  const job = await prisma.generationJob.findUnique({
    where: { id: generationJobId },
    select: { status: true, message: true, error: true }
  });
  return isStoppedGenerationJob(job);
}

import type { Job } from "bullmq";
import { isRecoverableNetworkError, type JobStep } from "@book-maker/core";
import { Prisma, planRevisionRetryDelayMs, prisma } from "@book-maker/db";
import { refundCreditLedgerEntry, refundLatestProjectOperationCredits } from "@book-maker/db/billing";
import { restoreProjectAfterFailedPlanRevision } from "./failureRecovery.js";
import {
  shouldBypassConfiguredRetries as retryPolicyShouldBypass,
  shouldRecoverJobAttempt as retryPolicyShouldRecover
} from "./jobRetryPolicy.js";
import { staleGenerationTargetReason } from "./staleJobGuard.js";
import {
  STOPPED_JOB_ERROR,
  STOPPED_JOB_MESSAGE,
  StopRequestedError,
  isStoppedGenerationJob
} from "./jobTypes.js";
import { errorMessage, jsonPayloadToRecord } from "./serialization.js";

/**
 * GenerationJob lifecycle: per-job step templates, progress reporting, and the
 * status transitions (active / completed / failed / stopped / recovering) that
 * keep the database in sync with BullMQ. Job handlers report progress through
 * here; the worker entry point drives the transitions.
 */


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
    { key: "pdf", label: "Generate PDF" },
    { key: "epub", label: "Generate EPUB" }
  ],
  "apply-book-edit": [
    { key: "prepare", label: "Prepare edit" },
    { key: "snapshot", label: "Snapshot pages" },
    { key: "apply", label: "Apply edits" },
    { key: "export", label: "Refresh exports" }
  ],
  "replan-book": [
    { key: "revise", label: "Revise plan" },
    { key: "save", label: "Save approved plan" },
    { key: "generate", label: "Queue regeneration" }
  ],
  "prepare-character-candidates": [
    { key: "detect", label: "Detect characters" },
    { key: "save", label: "Save candidates" }
  ],
  "build-character-persona": [
    { key: "persona", label: "Build persona" },
    { key: "portrait", label: "Create profile picture" },
    { key: "save", label: "Save character" }
  ],
  "import-book": [
    { key: "read", label: "Read manuscript" },
    { key: "segment", label: "Split into chapters" },
    { key: "analyze", label: "Learn writing style" },
    { key: "save", label: "Save your book" }
  ],
  "continue-book": [
    { key: "outline", label: "Outline new chapters" },
    { key: "draft", label: "Write new pages" },
    { key: "save", label: "Save chapters" },
    { key: "export", label: "Refresh exports" }
  ]
};

export function buildStepTemplate(jobName: string): JobStep[] {
  const template = JOB_STEP_TEMPLATES[jobName];
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
      ...(update.progress !== undefined ? { progress: update.progress } : {}),
      ...(update.message !== undefined ? { message: update.message } : {}),
      ...(update.steps !== undefined ? { steps: update.steps as Prisma.InputJsonValue } : {})
    }
  });
}

export async function advanceJobStep(
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

export async function markActive(job: Job) {
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
  await markEditOperationActive(job);
}

export async function staleGenerationJobReason(job: Job): Promise<string | null> {
  const generationJobId = job.data.generationJobId as string | undefined;
  const payloadProjectId = job.data.projectId as string | undefined;
  if (!generationJobId || !payloadProjectId) {
    return null;
  }
  const generationJob = await prisma.generationJob.findUnique({
    where: { id: generationJobId },
    select: { projectId: true, type: true, contentRevision: true }
  });
  if (!generationJob) {
    return "The durable generation job no longer exists.";
  }
  const project = await prisma.project.findUnique({
    where: { id: payloadProjectId },
    select: { currentPlanId: true, contentRevision: true }
  });
  if (!project) {
    return "The target project no longer exists.";
  }

  const planId = typeof job.data.planId === "string" ? job.data.planId : null;
  const pageId = typeof job.data.pageId === "string" ? job.data.pageId : null;
  const page = pageId
    ? await prisma.page.findUnique({ where: { id: pageId }, select: { projectId: true } })
    : null;
  return staleGenerationTargetReason({
    durableProjectId: generationJob.projectId,
    payloadProjectId,
    type: generationJob.type,
    planId,
    currentPlanId: project.currentPlanId,
    pageId,
    pageProjectId: page?.projectId ?? null,
    contentRevision: generationJob.contentRevision,
    projectContentRevision: project.contentRevision
  });
}

export async function cancelStaleGenerationJob(job: Job, reason: string): Promise<void> {
  const generationJobId = job.data.generationJobId as string | undefined;
  if (generationJobId) {
    await prisma.generationJob.update({
      where: { id: generationJobId },
      data: {
        status: "CANCELED",
        finishedAt: new Date(),
        message: "Canceled because newer book state exists",
        error: reason
      }
    });
  }
  const operationId = editOperationIdFromJob(job);
  if (!operationId) {
    return;
  }
  const operation = await prisma.bookEditOperation.findUnique({
    where: { id: operationId },
    select: { ledgerEntryId: true }
  });
  if (operation?.ledgerEntryId) {
    await refundCreditLedgerEntry(operation.ledgerEntryId, reason).catch((error) => {
      console.error(`Failed to refund canceled edit operation ${operationId}`, error);
    });
  }
  await prisma.bookEditOperation.updateMany({
    where: { id: operationId, status: { in: ["QUEUED", "ACTIVE"] } },
    data: { status: "CANCELED", error: reason }
  });
}

export async function markCompleted(job: Job) {
  const generationJobId = job.data.generationJobId as string | undefined;
  if (!generationJobId) {
    return;
  }
  await assertJobNotStopped(generationJobId);
  await completeAllJobSteps(generationJobId);
  const existing = await prisma.generationJob.findUnique({
    where: { id: generationJobId },
    select: { qualityReport: true, message: true }
  });
  const qualityState = jsonPayloadToRecord(existing?.qualityReport).state;
  const completionMessage =
    qualityState === "blocked"
      ? existing?.message ?? "Review required before export"
      : qualityState === "review_recommended"
        ? "Export complete; review recommended. See the saved quality report for affected pages."
        : qualityState === "passed"
          ? "Export complete. Quality checks passed."
          : "Completed";
  await prisma.generationJob.update({
    where: { id: generationJobId },
    data: { status: "COMPLETED", finishedAt: new Date(), message: completionMessage, progress: 100 }
  });
  await markEditOperationCompleted(job);
}

export async function markFailed(job: Job, error: unknown) {
  const generationJobId = job.data.generationJobId as string | undefined;
  const projectId = job.data.projectId as string | undefined;
  const editOperationId = editOperationIdFromJob(job);
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
  const recoverablePlanRevision = job.name === "revise-plan" && isRecoverableNetworkError(error) && Boolean(editOperationId);
  if (editOperationId) {
    if (recoverablePlanRevision) {
      const operation = await prisma.bookEditOperation.findUnique({
        where: { id: editOperationId },
        select: { automaticRetryCount: true, automaticRetryLimit: true }
      });
      const nextRetryNumber = (operation?.automaticRetryCount ?? 0) + 1;
      const retryAvailable = Boolean(operation && nextRetryNumber <= operation.automaticRetryLimit);
      if (retryAvailable) {
        await prisma.bookEditOperation
          .update({
            where: { id: editOperationId },
            data: {
              status: "FAILED",
              error: errorMessage(error),
              nextRetryAt: new Date(Date.now() + planRevisionRetryDelayMs(nextRetryNumber)),
              lastRetryReason: errorMessage(error)
            }
          })
          .catch(() => undefined);
      } else {
        await failEditOperation(editOperationId, errorMessage(error));
      }
      console.warn("Plan revision durable retry decision", {
        event: "plan_revision.retry_scheduled",
        operationId: editOperationId,
        projectId,
        generationJobId,
        retryNumber: nextRetryNumber,
        retryAvailable
      });
    } else {
      await failEditOperation(editOperationId, errorMessage(error));
    }
    if (projectId && job.name === "revise-plan") {
      if (await restoreProjectAfterFailedPlanRevision(prisma, projectId)) {
        return;
      }
    }
    if (projectId) {
      await prisma.project
        .updateMany({ where: { id: projectId, status: "EDITING" }, data: { status: "COMPLETE" } })
        .catch(() => ({ count: 0 }));
    }
    return;
  }
  if (projectId && job.name === "revise-plan") {
    if (await restoreProjectAfterFailedPlanRevision(prisma, projectId)) {
      return;
    }
  }
  if (projectId && shouldFailProjectForJob(job.name)) {
    await refundFailedProjectCredits(projectId, errorMessage(error));
    await prisma.project.update({ where: { id: projectId }, data: { status: "FAILED" } }).catch(() => undefined);
  }
}

export function shouldFailProjectForJob(jobName: string): boolean {
  return !["prepare-character-candidates", "build-character-persona"].includes(jobName);
}

export async function markEditOperationActive(job: Job): Promise<void> {
  const editOperationId = editOperationIdFromJob(job);
  if (!editOperationId) {
    return;
  }
  await prisma.bookEditOperation
    .updateMany({ where: { id: editOperationId, status: "QUEUED" }, data: { status: "ACTIVE" } })
    .catch(() => ({ count: 0 }));
}

export async function markEditOperationCompleted(job: Job): Promise<void> {
  const editOperationId = editOperationIdFromJob(job);
  if (!editOperationId) {
    return;
  }
  if (job.name === "apply-book-edit" || job.name === "replan-book") {
    return;
  }
  await prisma.bookEditOperation
    .updateMany({
      where: { id: editOperationId, status: { in: ["QUEUED", "ACTIVE"] } },
      data: { status: "APPLIED", appliedAt: new Date() }
    })
    .catch(() => ({ count: 0 }));
}

export async function failEditOperation(operationId: string, reason: string): Promise<void> {
  const operation = await prisma.bookEditOperation.findUnique({
    where: { id: operationId },
    select: { ledgerEntryId: true }
  });
  if (operation?.ledgerEntryId) {
    await refundCreditLedgerEntry(operation.ledgerEntryId, reason).catch((error) => {
      console.error(`Failed to refund edit operation ${operationId}`, error);
    });
  }
  await prisma.bookEditOperation
    .update({
      where: { id: operationId },
      data: { status: "FAILED", error: reason }
    })
    .catch(() => undefined);
}

export function editOperationIdFromJob(job: Job): string | null {
  const value = job.data.operationId ?? job.data.editOperationId ?? job.data.replanOperationId;
  return typeof value === "string" && value.trim() ? value : null;
}

export async function markStopped(job: Job) {
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
    await refundFailedProjectCredits(projectId, STOPPED_JOB_ERROR);
    await prisma.project.update({ where: { id: projectId }, data: { status: "FAILED" } }).catch(() => undefined);
  }
}

export async function refundFailedProjectCredits(projectId: string, reason: string): Promise<void> {
  await refundLatestProjectOperationCredits({
    projectId,
    operation: "FULL_BOOK_GENERATION",
    reason
  }).catch((error) => {
    console.error(`Failed to refund credits for project ${projectId}`, error);
  });
}

export async function markRecovering(job: Job, error: unknown) {
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

export function shouldRecoverJobAttempt(job: Job, error: unknown): boolean {
  return retryPolicyShouldRecover({
    jobName: job.name,
    attemptsMade: job.attemptsMade,
    maxAttempts: jobMaxAttempts(job),
    recoverableNetworkError: isRecoverableNetworkError(error)
  });
}

export function shouldBypassConfiguredRetries(job: Job, error: unknown): boolean {
  return retryPolicyShouldBypass({
    jobName: job.name,
    attemptsMade: job.attemptsMade,
    maxAttempts: jobMaxAttempts(job),
    recoverableNetworkError: isRecoverableNetworkError(error)
  });
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
export function jobMaxAttempts(job: Job): number {
  const attempts = job.opts.attempts;
  return typeof attempts === "number" && Number.isFinite(attempts) && attempts > 0 ? attempts : 1;
}

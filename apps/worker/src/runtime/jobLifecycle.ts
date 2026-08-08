import type { Job } from "bullmq";
import {
  isRecoverableNetworkError,
  shouldBypassConfiguredRetries as retryPolicyShouldBypass,
  shouldRecoverJobAttempt as retryPolicyShouldRecover,
  workerJobControlsProjectStatus,
  type JobStep
} from "@book-maker/core";
import { Prisma, planRevisionRetryDelayMs, prisma } from "@book-maker/db";
import {
  refundCreditLedgerEntry,
  refundLatestProjectOperationCredits,
  releaseManuscriptImportUse
} from "@book-maker/db/billing";
import { restoreProjectAfterFailedPlanRevision } from "./failureRecovery.js";
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
  ],
  "generate-audiobook": [
    { key: "prepare", label: "Prepare narration" },
    { key: "synthesize", label: "Narrate chapters" },
    { key: "finalize", label: "Finish audiobook" }
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
    select: { projectId: true, type: true, contentRevision: true, status: true }
  });
  if (!generationJob) {
    return "The durable generation job no longer exists.";
  }
  // Strictly CANCELED, never FAILED: a compensation path cancels a row it
  // refunded, and a Bull job that slipped out anyway must not run refunded
  // work — while FAILED rows are legitimately re-run by BullMQ attempt retries.
  if (generationJob.status === "CANCELED") {
    return "The durable job was canceled before it could run.";
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
  // Only the run's root job: a stale-cancelled GENERATE_BOOK means the run it
  // was charged for is never going to finish, so its own payload entry comes
  // back (idempotent). A stale *child* proves nothing — a completed run can
  // leave a straggler behind — so children never touch the charge.
  if (job.name === "generate-book" && typeof job.data.billingLedgerEntryId === "string") {
    await refundCreditLedgerEntry(job.data.billingLedgerEntryId, reason).catch((error) => {
      console.error(`Failed to refund stale-cancelled generation for job ${generationJobId ?? "?"}`, error);
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
  if (job.name === "generate-audiobook") {
    await failAudiobookForJob(job, errorMessage(error));
    return;
  }
  if (job.name === "plan-book") {
    await refundPlanGenerationForJob(job, errorMessage(error));
    if (projectId) {
      await prisma.project.update({ where: { id: projectId }, data: { status: "FAILED" } }).catch(() => undefined);
    }
    return;
  }
  if (job.name === "import-book") {
    await releaseImportQuotaForJob(job);
  }
  if (projectId && workerJobControlsProjectStatus(job.name)) {
    await refundFailedProjectCredits(job, projectId, errorMessage(error));
    await prisma.project.update({ where: { id: projectId }, data: { status: "FAILED" } }).catch(() => undefined);
  }
}

/**
 * A failed or stopped import hands back the free tier's monthly slot the
 * upload claimed. The claim rides the job payload (`importQuota`) precisely so
 * this needs no lookup — and it is absent for subscribers, whose imports
 * claim nothing.
 */
async function releaseImportQuotaForJob(job: Job): Promise<void> {
  const quota = job.data.importQuota as { userId?: unknown; periodKey?: unknown } | undefined;
  if (!quota || typeof quota.userId !== "string" || typeof quota.periodKey !== "string") {
    return;
  }
  await releaseManuscriptImportUse(quota.userId, quota.periodKey).catch((error: unknown) => {
    console.error(`Failed to release import slot for user ${quota.userId}`, error);
  });
}

/**
 * An audiobook is made *from* a finished book, so a failed narration must not
 * touch the project: the book is still complete and still readable. It refunds
 * against the entry the start route stamped on the payload rather than the
 * project's latest charge, which would otherwise claw back an unrelated
 * generation.
 */
async function failAudiobookForJob(job: Job, reason: string): Promise<void> {
  const audiobookId = typeof job.data.audiobookId === "string" ? job.data.audiobookId : undefined;
  const ledgerEntryId = typeof job.data.billingLedgerEntryId === "string" ? job.data.billingLedgerEntryId : undefined;
  const projectId = job.data.projectId as string | undefined;

  if (ledgerEntryId) {
    await refundCreditLedgerEntry(ledgerEntryId, reason).catch((error) => {
      console.error(`Failed to refund audiobook ${audiobookId ?? "?"}`, error);
    });
  } else if (projectId) {
    await refundLatestProjectOperationCredits({ projectId, operation: "AUDIOBOOK_GENERATION", reason }).catch((error) => {
      console.error(`Failed to refund audiobook credits for project ${projectId}`, error);
    });
  }

  if (audiobookId) {
    await prisma.audiobook
      .updateMany({ where: { id: audiobookId, status: "GENERATING" }, data: { status: "FAILED", error: reason } })
      .catch(() => ({ count: 0 }));
  }
}

/**
 * A failed plan refunds its own charge. `PLAN_GENERATION` is stamped on the
 * payload by both queue sites; the project-level fallback below refunds only
 * `FULL_BOOK_GENERATION`, which a plan-only project has never paid, so without
 * this branch a dead plan kept the money.
 */
async function refundPlanGenerationForJob(job: Job, reason: string): Promise<void> {
  const projectId = job.data.projectId as string | undefined;
  const ledgerEntryId = typeof job.data.billingLedgerEntryId === "string" ? job.data.billingLedgerEntryId : undefined;
  if (ledgerEntryId) {
    await refundCreditLedgerEntry(ledgerEntryId, reason).catch((error) => {
      console.error(`Failed to refund plan generation for project ${projectId ?? "?"}`, error);
    });
  } else if (projectId) {
    await refundLatestProjectOperationCredits({ projectId, operation: "PLAN_GENERATION", reason }).catch((error) => {
      console.error(`Failed to refund plan credits for project ${projectId}`, error);
    });
  }
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
  if (job.name === "generate-audiobook") {
    await failAudiobookForJob(job, STOPPED_JOB_ERROR);
    return;
  }
  // A stopped edit settles like a failed one: refund the operation's own
  // ledger entry, never the project's book charge — the book is still there.
  const editOperationId = editOperationIdFromJob(job);
  if (editOperationId) {
    await failEditOperation(editOperationId, STOPPED_JOB_ERROR);
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
  if (job.name === "plan-book") {
    await refundPlanGenerationForJob(job, STOPPED_JOB_ERROR);
    if (projectId) {
      await prisma.project.update({ where: { id: projectId }, data: { status: "FAILED" } }).catch(() => undefined);
    }
    return;
  }
  if (job.name === "import-book") {
    await releaseImportQuotaForJob(job);
  }
  if (projectId && workerJobControlsProjectStatus(job.name)) {
    await refundFailedProjectCredits(job, projectId, STOPPED_JOB_ERROR);
    await prisma.project.update({ where: { id: projectId }, data: { status: "FAILED" } }).catch(() => undefined);
  }
}

export async function refundFailedProjectCredits(job: Job, projectId: string, reason: string): Promise<void> {
  try {
    const entryId = await bookGenerationLedgerEntryId(job, projectId);
    if (entryId) {
      await refundCreditLedgerEntry(entryId, reason);
      return;
    }
    await refundLatestProjectOperationCredits({
      projectId,
      operation: "FULL_BOOK_GENERATION",
      reason
    });
  } catch (error) {
    console.error(`Failed to refund credits for project ${projectId}`, error);
  }
}

/**
 * The charge that paid for the run this job belongs to. GENERATE_BOOK carries
 * the ledger entry on its own payload; fan-out children carry only the planId,
 * so resolve it through the GENERATE_BOOK row for that plan. The latest-charge
 * fallback keeps rows enqueued before the stamp refundable, but it can claw
 * back a *newer* run's charge — a straggler page job from a replaced run used
 * to refund the replacement — which is why resolution comes first.
 */
async function bookGenerationLedgerEntryId(job: Job, projectId: string): Promise<string | null> {
  const own = job.data.billingLedgerEntryId;
  if (typeof own === "string" && own) {
    return own;
  }
  const planId = job.data.planId;
  if (typeof planId !== "string" || !planId) {
    return null;
  }
  const rows = await prisma.generationJob.findMany({
    where: { projectId, type: "GENERATE_BOOK" },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { payload: true }
  });
  for (const row of rows) {
    const payload = jsonPayloadToRecord(row.payload);
    if (payload.planId === planId && typeof payload.billingLedgerEntryId === "string" && payload.billingLedgerEntryId) {
      return payload.billingLedgerEntryId;
    }
  }
  return null;
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
  if (projectId && workerJobControlsProjectStatus(job.name)) {
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

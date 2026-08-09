import type { Job } from "bullmq";
import {
  BOOK_GENERATION_CHARGE_LOOKBACK,
  bookGenerationChargeFromPayloads,
  isRecoverableNetworkError,
  shouldBypassConfiguredRetries as retryPolicyShouldBypass,
  shouldRecoverJobAttempt as retryPolicyShouldRecover,
  workerJobControlsProjectStatus
} from "@book-maker/core";
import { Prisma, planRevisionRetryDelayMs, prisma } from "@book-maker/db";
import {
  failGenerationAttempt,
  markGenerationAttemptActive,
  markGenerationAttemptSucceeded,
  refundCreditLedgerEntry,
  refundLatestProjectOperationCredits,
  releaseManuscriptImportUse
} from "@book-maker/db/billing";
import { restoreProjectAfterFailedPlanRevision } from "./failureRecovery.js";
import {
  assertJobNotStopped,
  buildStepTemplate,
  completeAllJobSteps,
  failActiveJobStep
} from "./jobProgress.js";
import { staleGenerationTargetReason } from "./staleJobGuard.js";
import { STOPPED_JOB_ERROR, STOPPED_JOB_MESSAGE } from "./jobTypes.js";
import { errorMessage, jsonPayloadToRecord } from "./serialization.js";

/**
 * GenerationJob lifecycle: the status transitions (active / completed / failed
 * / stopped / recovering) that keep the database in sync with BullMQ, and the
 * settlement each one owes. Step templates and progress reporting live in
 * jobProgress.ts and are re-exported here for their historical import path.
 */

export {
  advanceJobStep,
  assertJobNotStopped,
  buildStepTemplate,
  completeAllJobSteps,
  failActiveJobStep,
  hasStoppedGenerationJob,
  parseJobSteps,
  updateJobProgress,
  type JobStepCounters
} from "./jobProgress.js";

/**
 * Claims the durable row for this delivery. QUEUED is the normal case, FAILED
 * is a BullMQ attempt retry legitimately re-running its own row, and ACTIVE is
 * a stalled delivery reclaimed mid-flight. COMPLETED and CANCELED are settled
 * verdicts — one delivered and paid for, one refunded — that a redelivered
 * Bull job must never resurrect, so the claim refuses them and returns false.
 */
export async function markActive(job: Job): Promise<boolean> {
  const generationJobId = job.data.generationJobId as string | undefined;
  if (!generationJobId) {
    return true;
  }
  await assertJobNotStopped(generationJobId);
  const steps = buildStepTemplate(job.name);
  const claimed = await prisma.generationJob.updateMany({
    where: { id: generationJobId, status: { in: ["QUEUED", "ACTIVE", "FAILED"] } },
    data: {
      status: "ACTIVE",
      startedAt: new Date(),
      message: steps[0]?.label ?? `Running ${job.name}`,
      progress: 10,
      ...(steps.length ? { steps: steps as Prisma.InputJsonValue } : {})
    }
  });
  if (claimed.count !== 1) {
    return false;
  }
  const attemptId = generationAttemptIdFromJob(job);
  if (attemptId) {
    await markGenerationAttemptActive(attemptId);
  }
  await markEditOperationActive(job);
  return true;
}

export async function staleGenerationJobReason(job: Job): Promise<string | null> {
  const generationJobId = job.data.generationJobId as string | undefined;
  const payloadProjectId = job.data.projectId as string | undefined;
  if (!generationJobId || !payloadProjectId) {
    return null;
  }
  const generationJob = await prisma.generationJob.findUnique({
    where: { id: generationJobId },
    select: { projectId: true, type: true, contentRevision: true, status: true, attemptId: true }
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
  // A terminal attempt has already been refunded. Whatever route brought this
  // job back — a shared resume endpoint requeueing the failed row, a sibling
  // still queued when one child failure settled the whole attempt, a Bull
  // retry racing the settlement — running it now would deliver work the user
  // was paid back for. A paid retry replays these payloads under a *new*
  // attempt on new rows, so this never blocks legitimate recovery.
  const attemptId = generationJob.attemptId ?? generationAttemptIdFromJob(job);
  if (attemptId) {
    const attempt = await prisma.generationAttempt.findUnique({
      where: { id: attemptId },
      select: { status: true }
    });
    if (attempt && (attempt.status === "FAILED" || attempt.status === "CANCELED")) {
      return "The paid attempt behind this job was already settled and refunded.";
    }
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
    // Only an open row takes the CANCELED verdict. A row that is already
    // FAILED keeps its own story — a user stop's markers must survive this —
    // while the attempt settlement below is idempotent either way.
    await prisma.generationJob.updateMany({
      where: { id: generationJobId, status: { in: ["QUEUED", "ACTIVE"] } },
      data: {
        status: "CANCELED",
        finishedAt: new Date(),
        message: "Canceled because newer book state exists",
        error: reason
      }
    });
  }
  const attemptId = generationAttemptIdFromJob(job);
  if (attemptId) {
    await failGenerationAttempt(attemptId, reason, "CANCELED").catch((error) => {
      console.error(`Failed to settle stale-canceled attempt ${attemptId}`, error);
    });
  }
  // Only the run's root job: a stale-cancelled GENERATE_BOOK means the run it
  // was charged for is never going to finish, so its own payload entry comes
  // back (idempotent). A stale *child* proves nothing — a completed run can
  // leave a straggler behind — so children never touch the charge.
  if (!attemptId && job.name === "generate-book" && typeof job.data.billingLedgerEntryId === "string") {
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
  if (!attemptId && operation?.ledgerEntryId) {
    await refundCreditLedgerEntry(operation.ledgerEntryId, reason).catch((error) => {
      console.error(`Failed to refund canceled edit operation ${operationId}`, error);
    });
  }
  await prisma.bookEditOperation.updateMany({
    where: { id: operationId, status: { in: ["QUEUED", "ACTIVE"] } },
    data: { status: "CANCELED", error: reason }
  });
}

export async function markCompleted(job: Job): Promise<boolean> {
  const generationJobId = job.data.generationJobId as string | undefined;
  if (!generationJobId) {
    return true;
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
  // Conditional: a stop or settlement that reached the row between the
  // assertJobNotStopped read above and this write wins. Claiming success over
  // it would deliver a run whose charge was just refunded.
  const completed = await prisma.generationJob.updateMany({
    where: { id: generationJobId, status: { in: ["QUEUED", "ACTIVE"] } },
    data: { status: "COMPLETED", finishedAt: new Date(), message: completionMessage, progress: 100 }
  });
  if (completed.count !== 1) {
    return false;
  }
  const attemptId = generationAttemptIdFromJob(job);
  if (attemptId && attemptCompletesWithJob(job.name)) {
    await markGenerationAttemptSucceeded(attemptId);
  }
  await markEditOperationCompleted(job);
  return true;
}

export async function markFailed(job: Job, error: unknown) {
  const generationJobId = job.data.generationJobId as string | undefined;
  const projectId = job.data.projectId as string | undefined;
  const editOperationId = editOperationIdFromJob(job);
  const attemptId = generationAttemptIdFromJob(job);
  if (generationJobId) {
    // Conditional: COMPLETED means the work was delivered and paid for,
    // CANCELED means a compensation path already settled and refunded it.
    // Failing over either verdict would refund a finished run or settle the
    // same charge twice, so when the claim misses no settlement runs at all.
    const failed = await prisma.generationJob.updateMany({
      where: { id: generationJobId, status: { notIn: ["COMPLETED", "CANCELED"] } },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        message: "Failed",
        error: error instanceof Error ? error.message : "Unknown error"
      }
    });
    if (failed.count !== 1) {
      console.warn(`Skipped failing generation job ${generationJobId}: the row already holds a settled verdict.`);
      return;
    }
    await failActiveJobStep(generationJobId);
  }
  if (attemptId) {
    await failGenerationAttempt(attemptId, errorMessage(error)).catch((settlementError) => {
      console.error(`Failed to settle generation attempt ${attemptId}`, settlementError);
    });
    await stopSiblingJobsForSettledAttempt(attemptId);
  }
  const recoverablePlanRevision =
    !attemptId && job.name === "revise-plan" && isRecoverableNetworkError(error) && Boolean(editOperationId);
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
        await failEditOperation(editOperationId, errorMessage(error), { refund: !attemptId });
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
      await failEditOperation(editOperationId, errorMessage(error), { refund: !attemptId });
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

  const attemptId = generationAttemptIdFromJob(job);
  if (attemptId) {
    // The attempt boundary already refunded its immutable ledger link.
  } else if (ledgerEntryId) {
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
  if (generationAttemptIdFromJob(job)) {
    return;
  }
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

export async function failEditOperation(
  operationId: string,
  reason: string,
  options: { refund?: boolean } = {}
): Promise<void> {
  // Claim before refunding, like markEditOperationCompleted: an operation that
  // is already APPLIED (or FAILED/CANCELED and settled with it) must not have
  // its charge clawed back by a straggling failure path.
  const claimed = await prisma.bookEditOperation
    .updateMany({
      where: { id: operationId, status: { in: ["QUEUED", "ACTIVE"] } },
      data: { status: "FAILED", error: reason }
    })
    .catch(() => ({ count: 0 }));
  if (claimed.count !== 1 || options.refund === false) {
    return;
  }
  const operation = await prisma.bookEditOperation.findUnique({
    where: { id: operationId },
    select: { ledgerEntryId: true }
  });
  if (operation?.ledgerEntryId) {
    await refundCreditLedgerEntry(operation.ledgerEntryId, reason).catch((error) => {
      console.error(`Failed to refund edit operation ${operationId}`, error);
    });
  }
}

export function editOperationIdFromJob(job: Job): string | null {
  const value = job.data.operationId ?? job.data.editOperationId ?? job.data.replanOperationId;
  return typeof value === "string" && value.trim() ? value : null;
}

export async function markStopped(job: Job) {
  const generationJobId = job.data.generationJobId as string | undefined;
  const projectId = job.data.projectId as string | undefined;
  const attemptId = generationAttemptIdFromJob(job);
  if (generationJobId) {
    // Conditional for the same reason as markFailed: a COMPLETED row is a run
    // that was delivered before the stop reached it, and a CANCELED row was
    // already settled — a late stop must not refund either.
    const stopped = await prisma.generationJob.updateMany({
      where: { id: generationJobId, status: { notIn: ["COMPLETED", "CANCELED"] } },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        message: STOPPED_JOB_MESSAGE,
        error: STOPPED_JOB_ERROR
      }
    });
    if (stopped.count !== 1) {
      console.warn(`Skipped stopping generation job ${generationJobId}: the row already holds a settled verdict.`);
      return;
    }
    await failActiveJobStep(generationJobId, { allowStopped: true });
  }
  if (attemptId) {
    await failGenerationAttempt(attemptId, STOPPED_JOB_ERROR, "CANCELED").catch((settlementError) => {
      console.error(`Failed to settle stopped generation attempt ${attemptId}`, settlementError);
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
    await failEditOperation(editOperationId, STOPPED_JOB_ERROR, { refund: !attemptId });
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
  if (generationAttemptIdFromJob(job)) {
    return;
  }
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

function generationAttemptIdFromJob(job: Job): string | null {
  const attemptId = job.data.attemptId;
  return typeof attemptId === "string" && attemptId ? attemptId : null;
}

/**
 * One terminal child failure settles — and refunds — the whole attempt, so the
 * attempt's other open jobs must not keep delivering it: active siblings would
 * spend provider money on a book nobody is paying for, and a queued sibling
 * the stale guard later CANCELs is invisible to the paid retry, which copies
 * FAILED rows only. Marking them FAILED with the stop markers makes running
 * handlers bail at their next stop check and keeps every sibling
 * retry-copyable. The failing row itself is already FAILED and unaffected.
 */
async function stopSiblingJobsForSettledAttempt(attemptId: string): Promise<void> {
  await prisma.generationJob
    .updateMany({
      where: { attemptId, status: { in: ["QUEUED", "ACTIVE"] } },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        message: STOPPED_JOB_MESSAGE,
        error: STOPPED_JOB_ERROR
      }
    })
    .catch((error) => {
      console.error(`Failed to stop sibling jobs for settled attempt ${attemptId}`, error);
    });
}

function attemptCompletesWithJob(jobName: string): boolean {
  return [
    "plan-book",
    "revise-plan",
    "compile-export",
    "apply-book-edit",
    "continue-book",
    "generate-audiobook"
  ].includes(jobName);
}

/**
 * The charge that paid for the run this job belongs to — the shared resolution
 * order lives with `bookGenerationChargeFromPayloads` in @book-maker/core.
 * A straggler page job from a replaced run used to refund the *replacement's*
 * charge through the latest-charge fallback, which is why resolution comes
 * first.
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
    take: BOOK_GENERATION_CHARGE_LOOKBACK,
    select: { payload: true }
  });
  return bookGenerationChargeFromPayloads(rows, planId);
}

export async function markRecovering(job: Job, error: unknown) {
  const generationJobId = job.data.generationJobId as string | undefined;
  const projectId = job.data.projectId as string | undefined;
  const nextAttempt = job.attemptsMade + 2;
  const maxAttempts = jobMaxAttempts(job);
  const message = `Network interruption during ${job.name}; retrying (${nextAttempt}/${maxAttempts}). ${errorMessage(error)}`;

  if (generationJobId) {
    // Only an ACTIVE row goes back to QUEUED. A stop that landed mid-flight
    // wrote FAILED with the stop markers; re-queueing over it would erase the
    // marker and let the retry run a stopped job — left alone, the retry's own
    // assertJobNotStopped sees it and settles through markStopped instead.
    const requeued = await prisma.generationJob.updateMany({
      where: { id: generationJobId, status: "ACTIVE" },
      data: {
        status: "QUEUED",
        finishedAt: null,
        message,
        error: null
      }
    });
    if (requeued.count !== 1) {
      return;
    }
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

export function jobMaxAttempts(job: Job): number {
  const attempts = job.opts.attempts;
  return typeof attempts === "number" && Number.isFinite(attempts) && attempts > 0 ? attempts : 1;
}

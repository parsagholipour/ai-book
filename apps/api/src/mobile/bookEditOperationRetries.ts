import { PRE_EDIT_PROJECT_STATUS } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { startGenerationAttempt } from "@book-maker/db/billing";
import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import { type MobileBookEditOperationRecord } from "./dto.js";
import { settledStatusBeforeEdit } from "./editProjectStatus.js";
import { isValidGenerationRetryToken } from "./generationRetryQuote.js";
import { hasCompetingOpenBookEditOperation, retryPlanRevisionOperation } from "./planRevisionRetries.js";
import { fingerprintGenerationRequest, isPrismaUniqueConflict, jsonRecord } from "./support.js";

type RetryOptions = {
  userId: string;
  projectId?: string;
  operationId: string;
  requestId: string;
  retryToken: string;
  automatic: boolean;
  log?: { info(bindings: object, message: string): void; warn(bindings: object, message: string): void };
};

type RetryResult =
  | { kind: "queued"; operation: MobileBookEditOperationRecord }
  | { kind: "not_found" }
  | { kind: "conflict"; reason: string; terminal: boolean };

/** Routes a confirmed operation retry to the implementation for its kind. */
export async function retryBookEditOperation(options: RetryOptions): Promise<RetryResult> {
  const operation = await prisma.bookEditOperation.findFirst({
    where: {
      id: options.operationId,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      project: { userId: options.userId }
    },
    select: { kind: true }
  });
  if (!operation) return { kind: "not_found" };
  if (operation.kind === "PLAN_REVISION") {
    return retryPlanRevisionOperation(options);
  }
  if (operation.kind === "PAGE_REWRITE") {
    return retryPageRewriteOperation(options);
  }
  return {
    kind: "conflict",
    reason: "This type of book update cannot be retried yet. Edit and send the original request instead.",
    terminal: true
  };
}

/**
 * Replays the original APPLY_BOOK_EDIT payload as a fresh paid attempt.
 *
 * The failed attempt was refunded. retryOfAttemptId makes concurrent taps
 * converge on one new charge, while the current-plan and settled-project
 * checks prevent an old card from taking ownership of unrelated live work.
 */
async function retryPageRewriteOperation(options: RetryOptions): Promise<RetryResult> {
  if (options.automatic) {
    return {
      kind: "conflict",
      reason: "Paid generation retries require explicit confirmation.",
      terminal: true
    };
  }

  const operation = await prisma.bookEditOperation.findFirst({
    where: {
      id: options.operationId,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      project: { userId: options.userId },
      kind: "PAGE_REWRITE"
    },
    include: {
      generationJob: { select: { id: true, type: true, status: true, payload: true } },
      generationAttempts: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          commandKey: true,
          status: true,
          operation: true,
          quotedCredits: true,
          refundPending: true
        }
      }
    }
  });
  if (!operation) return { kind: "not_found" };
  if (
    operation.retryRequestId === options.requestId &&
    operation.generationJob &&
    ["QUEUED", "ACTIVE"].includes(operation.status)
  ) {
    return { kind: "queued", operation: operation as MobileBookEditOperationRecord };
  }
  if (!["FAILED", "CANCELED"].includes(operation.status)) {
    return { kind: "conflict", reason: "Only failed page rewrite operations can be retried.", terminal: false };
  }

  const sourceAttempt = operation.generationAttempts[0];
  if (
    !sourceAttempt ||
    !["FAILED", "CANCELED"].includes(sourceAttempt.status) ||
    sourceAttempt.operation !== "PAGE_REGENERATION" ||
    sourceAttempt.refundPending ||
    !isValidGenerationRetryToken(sourceAttempt, options.retryToken)
  ) {
    return {
      kind: "conflict",
      reason: "Refresh the project and confirm the current retry price before retrying.",
      terminal: false
    };
  }

  const payload = jsonRecord(operation.generationJob?.payload);
  const planId = typeof payload.planId === "string" ? payload.planId : null;
  if (operation.generationJob?.type !== "APPLY_BOOK_EDIT" || !planId) {
    options.log?.warn(
      {
        event: "page_rewrite.consistency_warning",
        operationId: operation.id,
        projectId: operation.projectId,
        warning: "missing_apply_job_or_plan"
      },
      "Page rewrite retry rejected because the original target is unavailable"
    );
    return { kind: "conflict", reason: "The original page rewrite target is unavailable.", terminal: true };
  }

  const project = await prisma.project.findFirst({
    where: { id: operation.projectId, userId: options.userId },
    select: { currentPlanId: true, status: true }
  });
  if (!project || project.currentPlanId !== planId) {
    return {
      kind: "conflict",
      reason: "A newer plan exists, so this page rewrite can no longer be retried.",
      terminal: true
    };
  }
  if (!["COMPLETE", "REVIEW_REQUIRED"].includes(project.status)) {
    return {
      kind: "conflict",
      reason: "Another book update is already in progress. Retry this update when it finishes.",
      terminal: false
    };
  }
  if (await hasCompetingOpenBookEditOperation(operation.projectId, operation.id)) {
    return {
      kind: "conflict",
      reason: "Another book update is already in progress. Retry this update when it finishes.",
      terminal: false
    };
  }

  const retryPayload = {
    ...payload,
    operationId: operation.id,
    retryOfGenerationJobId: operation.generationJobId,
    [PRE_EDIT_PROJECT_STATUS]: settledStatusBeforeEdit(project.status)
  };
  delete retryPayload.billingLedgerEntryId;

  const started = await startGenerationAttempt({
    userId: options.userId,
    commandKey: `mobile:page-rewrite-retry:${sourceAttempt.id}:${options.requestId}`,
    requestFingerprint: fingerprintGenerationRequest({
      sourceAttemptId: sourceAttempt.id,
      operationId: operation.id,
      projectId: operation.projectId,
      planId,
      request: payload.request,
      editInstruction: payload.editInstruction
    }),
    projectId: operation.projectId,
    retryOfAttemptId: sourceAttempt.id,
    operation: sourceAttempt.operation,
    quotedCredits: sourceAttempt.quotedCredits,
    description: "Mobile page rewrite retry",
    metadata: { operationId: operation.id, planId, retryOfAttemptId: sourceAttempt.id },
    create: async (tx, { attemptId, ledgerEntry }) => {
      const job = await enqueueGenerationJob({
        projectId: operation.projectId,
        type: "APPLY_BOOK_EDIT",
        dedupeKey: `page-rewrite-retry:${attemptId}`,
        transaction: tx,
        dispatch: false,
        attemptId,
        payload: {
          ...retryPayload,
          ...(ledgerEntry ? { billingLedgerEntryId: ledgerEntry.id } : {})
        }
      });
      await tx.bookEditOperation.update({
        where: { id: operation.id },
        data: {
          status: "QUEUED",
          automaticRetryCount: { increment: 1 },
          lastRetryAt: new Date(),
          lastRetryReason: operation.error ?? "failed page rewrite",
          retryRequestId: options.requestId,
          nextRetryAt: null,
          error: null,
          adherenceAudit: null,
          generationJobId: job.id,
          ledgerEntryId: ledgerEntry?.id ?? null,
          creditsCharged: sourceAttempt.quotedCredits
        }
      });
      await tx.project.update({ where: { id: operation.projectId }, data: { status: "EDITING" } });
      return { projectId: operation.projectId, primaryJobId: job.id, editOperationId: operation.id };
    }
  }).catch((error) => {
    if (isPrismaUniqueConflict(error)) {
      return null;
    }
    throw error;
  });
  if (!started) {
    return {
      kind: "conflict",
      reason: "Another book update is already in progress. Retry this update when it finishes.",
      terminal: false
    };
  }
  if (!started.attempt.primaryJobId) {
    throw new Error("The paid page rewrite retry attempt has no generation job.");
  }

  await dispatchGenerationJob(started.attempt.primaryJobId);
  const updated = await prisma.bookEditOperation.findUniqueOrThrow({
    where: { id: operation.id },
    include: {
      generationJob: { select: { id: true, status: true } },
      generationAttempts: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          commandKey: true,
          status: true,
          operation: true,
          quotedCredits: true,
          refundPending: true
        }
      }
    }
  });
  options.log?.info(
    {
      event: "page_rewrite.retry_queued",
      operationId: operation.id,
      projectId: operation.projectId,
      generationJobId: started.attempt.primaryJobId,
      attemptId: started.attempt.id,
      replayed: started.replayed
    },
    "Paid page rewrite retry queued"
  );
  return { kind: "queued", operation: updated as MobileBookEditOperationRecord };
}

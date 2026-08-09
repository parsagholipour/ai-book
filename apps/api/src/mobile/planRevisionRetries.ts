import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import { type MobileBookEditOperationRecord } from "./dto.js";
import { isValidGenerationRetryToken } from "./generationRetryQuote.js";
import { fingerprintGenerationRequest, isPrismaUniqueConflict, jsonRecord } from "./support.js";
import { prisma } from "@book-maker/db";
import { startGenerationAttempt } from "@book-maker/db/billing";

/**
 * Paid recovery for a failed plan revision. The failed attempt has already
 * been refunded, so a retry is a new explicitly quoted attempt with its own
 * ledger entry and job. retryOfAttemptId is the concurrency boundary: two
 * requests, even with different request IDs, converge on one new charge.
 */
export async function retryPlanRevisionOperation(options: {
  userId: string;
  projectId?: string;
  operationId: string;
  requestId: string;
  retryToken: string;
  automatic: boolean;
  log?: { info(bindings: object, message: string): void; warn(bindings: object, message: string): void };
}): Promise<
  | { kind: "queued"; operation: MobileBookEditOperationRecord }
  | { kind: "not_found" }
  | { kind: "conflict"; reason: string; terminal: boolean }
> {
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
      kind: "PLAN_REVISION"
    },
    include: {
      generationJob: { select: { id: true, status: true, payload: true } },
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
  if (operation.retryRequestId === options.requestId && operation.generationJob) {
    return { kind: "queued", operation: operation as MobileBookEditOperationRecord };
  }
  if (!["FAILED", "CANCELED"].includes(operation.status)) {
    return { kind: "conflict", reason: "Only failed plan revision operations can be retried.", terminal: false };
  }

  const sourceAttempt = operation.generationAttempts[0];
  if (
    !sourceAttempt ||
    !["FAILED", "CANCELED"].includes(sourceAttempt.status) ||
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
  if (!planId) {
    options.log?.warn(
      {
        event: "plan_revision.consistency_warning",
        operationId: operation.id,
        projectId: operation.projectId,
        warning: "missing_plan_id"
      },
      "Plan revision retry rejected because the job payload names no plan"
    );
    return { kind: "conflict", reason: "The original revision target is unavailable.", terminal: true };
  }

  const project = await prisma.project.findFirst({
    where: { id: operation.projectId, userId: options.userId },
    select: { currentPlanId: true }
  });
  if (!project || project.currentPlanId !== planId) {
    return {
      kind: "conflict",
      reason: "A newer plan exists, so this revision can no longer be retried.",
      terminal: true
    };
  }
  if (await hasCompetingOpenBookEditOperation(operation.projectId, operation.id)) {
    return {
      kind: "conflict",
      reason: "Another book update is already in progress. Retry this revision when it finishes.",
      terminal: false
    };
  }

  const retryPayload = { ...payload };
  delete retryPayload.billingLedgerEntryId;
  const started = await startGenerationAttempt({
    userId: options.userId,
    commandKey: `mobile:plan-revision-retry:${sourceAttempt.id}:${options.requestId}`,
    requestFingerprint: fingerprintGenerationRequest({
      sourceAttemptId: sourceAttempt.id,
      operationId: operation.id,
      projectId: operation.projectId,
      planId,
      message: payload.message
    }),
    projectId: operation.projectId,
    retryOfAttemptId: sourceAttempt.id,
    operation: sourceAttempt.operation,
    quotedCredits: sourceAttempt.quotedCredits,
    description: "Mobile plan revision retry",
    metadata: { operationId: operation.id, planId, retryOfAttemptId: sourceAttempt.id },
    create: async (tx, { attemptId, ledgerEntry }) => {
      const job = await enqueueGenerationJob({
        projectId: operation.projectId,
        type: "REVISE_PLAN",
        dedupeKey: `plan-revision-retry:${attemptId}`,
        transaction: tx,
        dispatch: false,
        attemptId,
        payload: {
          ...retryPayload,
          editOperationId: operation.id,
          retryOfGenerationJobId: operation.generationJobId,
          ...(ledgerEntry ? { billingLedgerEntryId: ledgerEntry.id } : {})
        }
      });
      await tx.bookEditOperation.update({
        where: { id: operation.id },
        data: {
          status: "QUEUED",
          automaticRetryCount: { increment: 1 },
          lastRetryAt: new Date(),
          lastRetryReason: operation.error ?? "failed plan revision",
          retryRequestId: options.requestId,
          nextRetryAt: null,
          error: null,
          generationJobId: job.id,
          ledgerEntryId: ledgerEntry?.id ?? null,
          creditsCharged: sourceAttempt.quotedCredits
        }
      });
      await tx.project.update({ where: { id: operation.projectId }, data: { status: "PLANNING" } });
      return { projectId: operation.projectId, primaryJobId: job.id, editOperationId: operation.id };
    }
  }).catch((error) => {
    // The competing-operation read above is only advisory: an edit claiming
    // the one-open-per-project slot between that read and the QUEUED flip in
    // the transaction surfaces here as a unique conflict, and the attempt row
    // it raced was rolled back, so there is no winner to replay. That is a
    // retryable conflict, not a server failure.
    if (isPrismaUniqueConflict(error)) {
      return null;
    }
    throw error;
  });
  if (!started) {
    return {
      kind: "conflict",
      reason: "Another book update is already in progress. Retry this revision when it finishes.",
      terminal: false
    };
  }

  if (!started.attempt.primaryJobId) {
    throw new Error("The paid retry attempt has no generation job.");
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
      event: "plan_revision.retry_queued",
      operationId: operation.id,
      projectId: operation.projectId,
      generationJobId: started.attempt.primaryJobId,
      attemptId: started.attempt.id,
      replayed: started.replayed
    },
    "Paid plan revision retry queued"
  );
  return { kind: "queued", operation: updated as MobileBookEditOperationRecord };
}

export async function reconcileRetryablePlanRevisionOperations(options: {
  limit?: number;
  now?: Date;
  log?: { info(bindings: object, message: string): void; warn(bindings: object, message: string): void };
} = {}): Promise<number> {
  // Paid failures are refunded. Starting another charge requires a fresh quote
  // and user confirmation, so the former automatic retry sweep is disabled.
  void options;
  return 0;
}

export async function hasCompetingOpenBookEditOperation(projectId: string, operationId: string): Promise<boolean> {
  const competing = await prisma.bookEditOperation.findFirst({
    where: {
      projectId,
      id: { not: operationId },
      status: { in: ["QUEUED", "ACTIVE"] }
    },
    select: { id: true }
  });
  return Boolean(competing);
}

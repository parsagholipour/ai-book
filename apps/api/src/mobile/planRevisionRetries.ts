import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import { type MobileBookEditOperationRecord } from "./dto.js";
import { errorMessage, isPrismaUniqueConflict, jsonRecord } from "./support.js";
import {
  PLAN_REVISION_AUTOMATIC_RETRY_LIMIT,
  canClaimPlanRevisionRetry,
  planRevisionRetryDelayMs,
  prisma,
  retryRequestKey
} from "@book-maker/db";

/**
 * Recovery for plan revisions that failed: the manual retry behind
 * POST /operations/:id/retry, and the automatic sweep server.ts runs every few
 * seconds. Both go through retryPlanRevisionOperation, which is deliberately
 * free — the worker has already refunded the failed attempt.
 */

export async function retryPlanRevisionOperation(options: {
  userId: string;
  projectId?: string;
  operationId: string;
  requestId: string;
  automatic: boolean;
  log?: { info(bindings: object, message: string): void; warn(bindings: object, message: string): void };
}): Promise<
  | { kind: "queued"; operation: MobileBookEditOperationRecord }
  | { kind: "not_found" }
  | { kind: "conflict"; reason: string; terminal: boolean }
> {
  const operation = await prisma.bookEditOperation.findFirst({
    where: {
      id: options.operationId,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      project: { userId: options.userId },
      kind: "PLAN_REVISION"
    },
    include: {
      generationJob: { select: { id: true, status: true, payload: true, startedAt: true, updatedAt: true } },
      ledgerEntry: { select: { id: true, status: true, entryType: true } }
    }
  });
  if (!operation) return { kind: "not_found" };
  if (operation.retryRequestId === options.requestId && operation.generationJob) {
    return { kind: "queued", operation: operation as MobileBookEditOperationRecord };
  }
  // The consistency checks run before the eligibility gates because they are
  // the terminal ones: a revision whose plan has been superseded, or whose
  // billing linkage is gone, can never become retryable however long it waits.
  // Ordering them first also keeps the rejection a caller sees specific rather
  // than the generic budget message the reconciler retires the row with.
  const payload = jsonRecord(operation.generationJob?.payload);
  const planId = typeof payload.planId === "string" ? payload.planId : null;
  if (!planId) {
    options.log?.warn(
      { event: "plan_revision.consistency_warning", operationId: operation.id, projectId: operation.projectId, warning: "missing_plan_id" },
      "Plan revision retry rejected because the job payload names no plan"
    );
    return { kind: "conflict", reason: "The original revision target is unavailable.", terminal: true };
  }
  const classifier = jsonRecord(operation.classifier);
  const isUnbilledWebRevision = classifier.source === "web";
  if ((!operation.ledgerEntryId || !operation.ledgerEntry) && !isUnbilledWebRevision) {
    options.log?.warn(
      { event: "plan_revision.consistency_warning", operationId: operation.id, projectId: operation.projectId, warning: "missing_ledger" },
      "Paid mobile plan revision retry rejected because billing linkage is missing"
    );
    return {
      kind: "conflict",
      reason: "Billing state for this revision is incomplete. Credits were not charged again.",
      terminal: true
    };
  }
  const project = await prisma.project.findFirst({
    where: { id: operation.projectId, userId: options.userId },
    select: { currentPlanId: true }
  });
  if (!project || project.currentPlanId !== planId) {
    options.log?.warn(
      { event: "plan_revision.consistency_warning", operationId: operation.id, projectId: operation.projectId, warning: "stale_plan", planId, currentPlanId: project?.currentPlanId },
      "Plan revision retry rejected because its plan is stale"
    );
    return {
      kind: "conflict",
      reason: "A newer plan exists, so this revision can no longer be retried.",
      terminal: true
    };
  }

  const eligibility = canClaimPlanRevisionRetry(operation);
  if (!eligibility.eligible && options.automatic) {
    return { kind: "conflict", reason: eligibility.reason ?? "Retry is not available.", terminal: eligibility.terminal };
  }
  if (!options.automatic && !["FAILED", "CANCELED"].includes(operation.status)) {
    return { kind: "conflict", reason: "Only failed plan revision operations can be retried.", terminal: false };
  }
  if (operation.automaticRetryCount >= operation.automaticRetryLimit) {
    return { kind: "conflict", reason: "This plan revision has exhausted its retry budget.", terminal: true };
  }
  if (await hasCompetingOpenBookEditOperation(operation.projectId, operation.id)) {
    return {
      kind: "conflict",
      reason: "Another book update is already in progress. Retry this revision when it finishes.",
      terminal: false
    };
  }

  const priorRetryState = {
    status: operation.status,
    automaticRetryCount: operation.automaticRetryCount,
    lastRetryAt: operation.lastRetryAt,
    lastRetryReason: operation.lastRetryReason,
    retryRequestId: operation.retryRequestId,
    nextRetryAt: operation.nextRetryAt,
    error: operation.error,
    generationJobId: operation.generationJobId
  };
  // Recovery is intentionally free: the original failed paid attempt has
  // already been refunded by the worker. The retry key plus one database
  // transaction grants exactly one recovery job without reserving credits.
  // retryRequestId is the last command that succeeded; accepting that value in
  // the CAS is what permits the next numbered retry while preserving replay
  // idempotency for the current command.
  const retryNumber = operation.automaticRetryCount + 1;
  const retryKey = retryRequestKey(operation.id, retryNumber);
  const now = new Date();
  let transactionResult:
    | { claimed: true; newJob: Awaited<ReturnType<typeof enqueueGenerationJob>>; updated: MobileBookEditOperationRecord }
    | { claimed: false };
  try {
    transactionResult = await prisma.$transaction(async (tx) => {
      const claimed = await tx.bookEditOperation.updateMany({
        where: {
          id: operation.id,
          automaticRetryCount: operation.automaticRetryCount,
          status: operation.status,
          retryRequestId: operation.retryRequestId
        },
        data: {
          status: "QUEUED",
          automaticRetryCount: { increment: 1 },
          lastRetryAt: now,
          lastRetryReason: operation.error ?? "failed plan revision",
          retryRequestId: options.requestId,
          nextRetryAt: new Date(now.getTime() + planRevisionRetryDelayMs(retryNumber)),
          error: null
        }
      });
      if (claimed.count !== 1) return { claimed: false as const };

      const newJob = await enqueueGenerationJob({
        projectId: operation.projectId,
        type: "REVISE_PLAN",
        dedupeKey: retryKey,
        dispatch: false,
        transaction: tx,
        payload: {
          ...payload,
          editOperationId: operation.id,
          ...(operation.ledgerEntryId ? { billingLedgerEntryId: operation.ledgerEntryId } : {}),
          retryOfGenerationJobId: operation.generationJobId,
          retryNumber
        }
      });
      const updated = (await tx.bookEditOperation.update({
        where: { id: operation.id },
        data: { generationJobId: newJob.id },
        include: { generationJob: { select: { id: true, status: true } } }
      })) as MobileBookEditOperationRecord;
      await tx.project.update({ where: { id: operation.projectId }, data: { status: "PLANNING" } });
      return { claimed: true as const, newJob, updated };
    });
  } catch (error) {
    // Real Prisma transactions roll all four writes back. This best-effort
    // restore also protects lightweight transaction doubles and databases that
    // abort after the callback has partially run.
    await prisma.bookEditOperation.updateMany({
      where: { id: operation.id, retryRequestId: options.requestId },
      data: priorRetryState
    }).catch(() => ({ count: 0 }));
    // The partial one-open-operation index can still win a race after the
    // preflight check. Treat that contention as a normal retry conflict while
    // preserving unexpected uniqueness failures for investigation.
    if (
      isPrismaUniqueConflict(error) &&
      (await hasCompetingOpenBookEditOperation(operation.projectId, operation.id).catch(() => false))
    ) {
      return {
        kind: "conflict",
        reason: "Another book update is already in progress. Retry this revision when it finishes.",
        terminal: false
      };
    }
    throw error;
  }
  if (!transactionResult.claimed) {
    const concurrent = await prisma.bookEditOperation.findUnique({
      where: { id: operation.id },
      include: { generationJob: { select: { id: true, status: true } } }
    });
    if (concurrent?.retryRequestId === options.requestId && concurrent.generationJob) {
      return { kind: "queued", operation: concurrent as MobileBookEditOperationRecord };
    }
    return { kind: "conflict", reason: "This retry was already claimed by another request.", terminal: false };
  }
  await dispatchGenerationJob(transactionResult.newJob.id);
  options.log?.info(
    { event: "plan_revision.retry_queued", operationId: operation.id, projectId: operation.projectId, generationJobId: transactionResult.newJob.id, retryNumber, automatic: options.automatic, staleActive: false },
    "Plan revision retry queued"
  );
  return { kind: "queued", operation: transactionResult.updated };
}

/**
 * Persists the outcome of a rejected automatic retry so the five-second sweep
 * stops re-deriving it. A terminal rejection retires the operation by spending
 * its retry budget — clamped to the sweep's own threshold, so the row leaves
 * the selection for good — while anything transient is merely deferred by one
 * backoff interval. Without this, an operation the sweep can never claim (a
 * superseded plan, most often) is re-read and re-rejected on every tick
 * forever, and its untouched updatedAt keeps it at the head of the batch.
 */
async function recordPlanRevisionRetryRejection(
  operation: { id: string; automaticRetryCount: number; automaticRetryLimit: number },
  conflict: { reason: string; terminal: boolean },
  now: Date
): Promise<void> {
  await prisma.bookEditOperation.updateMany({
    where: { id: operation.id, status: "FAILED", automaticRetryCount: operation.automaticRetryCount },
    data: conflict.terminal
      ? {
          automaticRetryCount: Math.max(operation.automaticRetryLimit, PLAN_REVISION_AUTOMATIC_RETRY_LIMIT),
          nextRetryAt: null,
          lastRetryReason: conflict.reason
        }
      : {
          nextRetryAt: new Date(now.getTime() + planRevisionRetryDelayMs(operation.automaticRetryCount + 1)),
          lastRetryReason: conflict.reason
        }
  });
}

export async function reconcileRetryablePlanRevisionOperations(options: {
  limit?: number;
  now?: Date;
  log?: { info(bindings: object, message: string): void; warn(bindings: object, message: string): void };
} = {}): Promise<number> {
  const now = options.now ?? new Date();
  const operations = await prisma.bookEditOperation.findMany({
    where: {
      kind: "PLAN_REVISION",
      automaticRetryCount: { lt: PLAN_REVISION_AUTOMATIC_RETRY_LIMIT },
      OR: [
        { status: "FAILED", nextRetryAt: { lte: now } },
        { status: "FAILED", nextRetryAt: null }
      ]
    },
    orderBy: { updatedAt: "asc" },
    take: options.limit ?? 20,
    select: {
      id: true,
      project: { select: { userId: true } },
      automaticRetryCount: true,
      automaticRetryLimit: true
    }
  });
  let queued = 0;
  for (const operation of operations) {
    try {
      const result = await retryPlanRevisionOperation({
        userId: operation.project.userId,
        operationId: operation.id,
        requestId: retryRequestKey(operation.id, operation.automaticRetryCount + 1),
        automatic: true,
        ...(options.log ? { log: options.log } : {})
      });
      if (result.kind === "queued") queued += 1;
      if (result.kind === "conflict") {
        await recordPlanRevisionRetryRejection(operation, result, now);
        if (result.terminal) {
          options.log?.info(
            {
              event: "plan_revision.retry_retired",
              operationId: operation.id,
              reason: result.reason
            },
            "Plan revision retired from automatic retry"
          );
        }
      }
    } catch (error) {
      options.log?.warn(
        {
          event: "plan_revision.consistency_warning",
          warning: "retry_reconciliation_failed",
          operationId: operation.id,
          error: errorMessage(error)
        },
        "Plan revision retry reconciliation skipped one operation"
      );
    }
  }
  return queued;
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

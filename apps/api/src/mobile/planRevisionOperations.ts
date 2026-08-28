import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import { createOpenBookEditOperation } from "./editOperationClaims.js";
import { classifyEditFailure } from "@book-maker/core/editFailure";
import { type MobileBookEditOperationRecord } from "./dto.js";
import { fingerprintGenerationRequest, hashString, jsonInputValue, jsonRecord } from "./support.js";
import { creditCostForOperation } from "@book-maker/core";
import { PLAN_REVISION_AUTOMATIC_RETRY_LIMIT, Prisma, prisma } from "@book-maker/db";
import {
  GenerationAttemptConflictError,
  startGenerationAttempt,
  type CreditLedgerEntryRecord
} from "@book-maker/db/billing";

/**
 * The direct (non-chat) plan revision path: `POST /api/mobile/plans/:id/revise`
 * and the retry plumbing behind it. Split from editOperations.ts along the
 * chat/direct seam — the chat path (`queueChatPlanRevision`) stays there with
 * the rest of the chat machinery and calls `queueChargedPlanRevision` here.
 */

export async function queueDirectPlanRevision(options: {
  userId: string;
  projectId: string;
  planId: string;
  message: string;
  requestId: string;
  respondedQuestionPrompts?: string[] | undefined;
}): Promise<{
  operation: MobileBookEditOperationRecord;
  job: Awaited<ReturnType<typeof enqueueGenerationJob>>;
}> {
  const existing = await prisma.bookEditOperation.findFirst({
    where: { projectId: options.projectId, requestId: options.requestId },
    include: { generationJob: { select: { id: true, status: true, payload: true } } }
  });
  if (existing?.generationJob) {
    assertMatchingDirectPlanRevision(existing, options);
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: existing.generationJob.id } });
    return { operation: existing as MobileBookEditOperationRecord, job };
  }
  const operation = await createOpenBookEditOperation({
    projectId: options.projectId,
    requestId: options.requestId,
    kind: "PLAN_REVISION",
    status: "QUEUED",
    request: options.message,
    classifier: jsonInputValue({ kind: "plan_revision", source: "direct" }),
    affectedPageIndexes: [],
    creditsCharged: 0,
    automaticRetryLimit: PLAN_REVISION_AUTOMATIC_RETRY_LIMIT
  });
  if (!operation) {
    const winner = await waitForDirectPlanRevision(options.projectId, options.requestId);
    if (winner?.generationJob) {
      assertMatchingDirectPlanRevision(winner, options);
      const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: winner.generationJob.id } });
      return { operation: winner as MobileBookEditOperationRecord, job };
    }
    // Either an unrelated edit holds the open-operation slot or a same-request
    // winner has not committed inside the poll budget. Both are conflicts the
    // client can retry, not server failures.
    throw new GenerationAttemptConflictError("Another book edit operation is already in progress.");
  }
  let queued;
  try {
    queued = await queueChargedPlanRevision({
      userId: options.userId,
      projectId: options.projectId,
      planId: options.planId,
      message: options.message,
      operationId: operation.id,
      idempotencyKey: `mobile:plan:${options.planId}:revision:${options.requestId}`,
      ...(options.respondedQuestionPrompts?.length
        ? { respondedQuestionPrompts: options.respondedQuestionPrompts }
        : {})
    });
  } catch (error) {
    // Same job-linkage guard as the chat paths: only a row whose attempt never
    // committed may be failed here. And the same reader/log split — the column
    // reaches the app, so the cause goes to the log instead.
    const failure = classifyEditFailure(error, "start");
    if (failure.internal) {
      console.error(`Direct plan revision could not start for edit operation ${operation.id}`, error);
    }
    await prisma.bookEditOperation.updateMany({
      where: { id: operation.id, generationJobId: null },
      data: { status: "FAILED", error: failure.message }
    });
    throw error;
  }
  // Committed past this point: bookkeeping failures must not flip the
  // operation to FAILED while its queued revision still runs.
  const updated = await prisma.bookEditOperation.update({
    where: { id: operation.id },
    data: {
      generationJobId: queued.job.id,
      ledgerEntryId: queued.ledgerEntry?.id ?? null,
      creditsCharged: creditCostForOperation("PLAN_REVISION")
    },
    include: { generationJob: { select: { id: true, status: true } } }
  });
  return { operation: updated, job: queued.job };
}

async function waitForDirectPlanRevision(projectId: string, requestId: string) {
  for (let read = 0; read < 5; read += 1) {
    const winner = await prisma.bookEditOperation.findFirst({
      where: { projectId, requestId },
      include: { generationJob: { select: { id: true, status: true, payload: true } } }
    });
    if (winner?.generationJob) {
      return winner;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

function assertMatchingDirectPlanRevision(
  operation: { request: string; generationJob: { payload: Prisma.JsonValue } | null },
  options: { message: string; planId: string }
): void {
  const payload = jsonRecord(operation.generationJob?.payload);
  if (operation.request !== options.message || payload.planId !== options.planId) {
    throw new GenerationAttemptConflictError();
  }
}

export async function queueChargedPlanRevision(options: {
  userId: string;
  projectId: string;
  planId: string;
  message: string;
  idempotencyKey: string;
  operationId?: string | undefined;
  /** Plan question prompts this revision answers; the reviser won't re-ask them. */
  respondedQuestionPrompts?: string[] | undefined;
}): Promise<{ job: Awaited<ReturnType<typeof enqueueGenerationJob>>; ledgerEntry: CreditLedgerEntryRecord | null }> {
  const amountCredits = creditCostForOperation("PLAN_REVISION");
  const started = await startGenerationAttempt({
    userId: options.userId,
    commandKey: options.operationId
      ? `mobile:edit-operation:${options.operationId}`
      : `mobile:plan-revision:${hashString(options.idempotencyKey)}`,
    requestFingerprint: fingerprintGenerationRequest({
      projectId: options.projectId,
      planId: options.planId,
      message: options.message,
      ...(options.respondedQuestionPrompts?.length
        ? { respondedQuestionPrompts: options.respondedQuestionPrompts }
        : {})
    }),
    projectId: options.projectId,
    operation: "PLAN_REVISION",
    quotedCredits: amountCredits,
    description: "Mobile plan revision",
    metadata: {
      planId: options.planId,
      ...(options.operationId ? { operationId: options.operationId } : {})
    },
    create: async (tx, { attemptId, ledgerEntry }) => {
        const job = await enqueueGenerationJob({
          projectId: options.projectId,
          type: "REVISE_PLAN",
          dedupeKey: `revise-plan:${options.projectId}:${options.planId}:${hashString(options.idempotencyKey)}`,
          transaction: tx,
          dispatch: false,
          attemptId,
          payload: {
            planId: options.planId,
            message: options.message,
            ...(options.respondedQuestionPrompts?.length
              ? { respondedQuestionPrompts: options.respondedQuestionPrompts }
              : {}),
            ...(ledgerEntry ? { billingLedgerEntryId: ledgerEntry.id } : {}),
            ...(options.operationId ? { editOperationId: options.operationId } : {})
          }
        });
        if (options.operationId) {
          await tx.bookEditOperation.update({
            where: { id: options.operationId },
            data: {
              generationJobId: job.id,
              ledgerEntryId: ledgerEntry?.id ?? null,
              creditsCharged: amountCredits
            }
          });
        }
        await tx.project.update({ where: { id: options.projectId }, data: { status: "PLANNING" } });
        return {
          projectId: options.projectId,
          primaryJobId: job.id,
          ...(options.operationId ? { editOperationId: options.operationId } : {})
        };
    }
  });
  if (!started.attempt.primaryJobId) {
    throw new Error("Plan revision attempt has no primary job.");
  }
  // The attempt is committed: a dispatch hiccup leaves a QUEUED row the
  // reconcilers re-publish, so it must not bubble up and get the operation
  // marked FAILED over work that is still coming.
  let job = await dispatchGenerationJob(started.attempt.primaryJobId).catch((error) => {
    console.error(`Deferred dispatch of plan revision job ${started.attempt.primaryJobId}`, error);
    return null;
  });
  job ??= await prisma.generationJob.findUnique({ where: { id: started.attempt.primaryJobId } });
  if (!job) {
    throw new Error("Plan revision job could not be loaded.");
  }
  const ledgerEntry: CreditLedgerEntryRecord | null = started.attempt.ledgerEntryId
    ? {
        id: started.attempt.ledgerEntryId,
        userId: options.userId,
        projectId: options.projectId,
        operation: "PLAN_REVISION",
        amountCredits: -amountCredits,
        planCreditsDelta: 0,
        entryType: "SPEND",
        status: "SETTLED",
        idempotencyKey: `generation-attempt:${started.attempt.id}`
      }
    : null;
  return {
    job,
    ledgerEntry
  };
}

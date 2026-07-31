import { type BookEditIntent } from "../bookEditIntent.js";
import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import {
  affectedPagesForIntent,
  busyEditReply,
  continuationNewPageCount,
  exactReplacementFromMessage,
  operationQueuedMessage
} from "./bookEditIntents.js";
import { billingOperationForIntent, bookEditCreditCost, operationKindForIntent } from "./bookEditPricing.js";
import {
  type MobileBookEditOperationRecord,
  type MobileProjectChatMessageRecord,
  type MobileProjectRecord
} from "./dto.js";
import { createAssistantChatMessage, insufficientCreditsChatMessage, type ProjectForChat } from "./projectChat.js";
import { createReplanProjectCopy } from "./projectRecords.js";
import {
  cleanTargetLanguage,
  errorMessage,
  hashString,
  isPrismaUniqueConflict,
  jsonInputValue,
  jsonRecord,
  languageDisplayName
} from "./support.js";
import { creditCostForOperation } from "@book-maker/core";
import {
  PLAN_REVISION_AUTOMATIC_RETRY_LIMIT,
  Prisma,
  canClaimPlanRevisionRetry,
  planRevisionRetryDelayMs,
  prisma,
  retryRequestKey
} from "@book-maker/db";
import {
  InsufficientCreditsError,
  commitReservedCredits,
  refundCreditLedgerEntry,
  reserveCredits,
  type CreditLedgerEntryRecord
} from "@book-maker/db/billing";

/**
 * Queues the generation jobs behind an approved edit (plan revision, replan,
 * book edit, continuation) and reconciles retryable ones.
 */

/**
 * Creates the QUEUED operation row for a chat edit, or null when the partial
 * unique index ("BookEditOperation_one_open_per_project", migration 000026)
 * reports another open operation won the race. hasOpenProjectWork() is only a
 * fast-path check; this is the authoritative one-open-edit-at-a-time guard.
 */
export async function createOpenBookEditOperation(
  data: Prisma.BookEditOperationUncheckedCreateInput
): Promise<MobileBookEditOperationRecord | null> {
  try {
    return await prisma.bookEditOperation.create({ data });
  } catch (error) {
    if (isPrismaUniqueConflict(error)) {
      return null;
    }
    throw error;
  }
}

export async function queueChatPlanRevision(options: {
  userId: string;
  project: ProjectForChat;
  userMessageId: string;
  message: string;
  intent: BookEditIntent;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  const { userId, project, userMessageId, message, intent } = options;
  const planId = project.currentPlan!.id;
  const credits = creditCostForOperation("PLAN_REVISION");
  const operation = await createOpenBookEditOperation({
    projectId: project.id,
    userMessageId,
    kind: "PLAN_REVISION",
    status: "QUEUED",
    request: message,
    classifier: jsonInputValue(intent),
    affectedPageIndexes: [],
    creditsCharged: 0
  });
  if (!operation) {
    const reply = await busyEditReply({ projectId: project.id, parentMessageId: userMessageId, intent, request: message });
    return { reply, operation: null };
  }
  try {
    const { job, ledgerEntry } = await queueChargedPlanRevision({
      userId,
      projectId: project.id,
      planId,
      message,
      operationId: operation.id,
      idempotencyKey: `mobile:project-chat:${project.id}:${operation.id}:plan-revision`
    });
    const updated = await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: {
        generationJobId: job.id,
        ledgerEntryId: ledgerEntry?.id ?? null,
        creditsCharged: credits
      },
      include: { generationJob: { select: { id: true, status: true } } }
    });
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      operationId: operation.id,
      content:
        project.currentPlan?.status === "APPROVED"
          ? `I’ll revise the approved plan and reopen it for review. This uses ${credits} credits.`
          : `I’ll revise the plan now. This uses ${credits} credits.`,
      metadata: { intent, charged: true, creditsCharged: credits }
    });
    await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: { assistantMessageId: reply.id }
    });
    return { reply, operation: updated };
  } catch (error) {
    await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: { status: "FAILED", error: errorMessage(error) }
    });
    if (error instanceof InsufficientCreditsError) {
      const reply = await insufficientCreditsChatMessage(project.id, userMessageId, intent, error);
      return { reply, operation: null };
    }
    throw error;
  }
}

export async function queueChatBookReplanCopy(options: {
  userId: string;
  project: ProjectForChat;
  userMessageId: string;
  message: string;
  intent: BookEditIntent;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  const { userId, project, userMessageId, message, intent } = options;
  const cost = bookEditCreditCost(intent.kind, 0, project);
  const targetLanguage = cleanTargetLanguage(intent.targetLanguage);
  const operation = await createOpenBookEditOperation({
    projectId: project.id,
    userMessageId,
    kind: "BOOK_REPLAN",
    status: "QUEUED",
    request: message,
    classifier: jsonInputValue(intent),
    affectedPageIndexes: [],
    creditsCharged: 0
  });
  if (!operation) {
    const reply = await busyEditReply({ projectId: project.id, parentMessageId: userMessageId, intent, request: message });
    return { reply, operation: null };
  }

  let reservation: CreditLedgerEntryRecord | null = null;
  let spend: CreditLedgerEntryRecord | null = null;
  let copy: MobileProjectRecord | null = null;
  try {
    reservation = await reserveCredits({
      userId,
      projectId: project.id,
      operation: "BOOK_REPLAN",
      amountCredits: cost,
      idempotencyKey: `mobile:project-chat:${project.id}:${operation.id}:book-replan`,
      description: "Mobile book replan copy",
      metadata: {
        intent,
        sourceProjectId: project.id,
        operationId: operation.id,
        ...(targetLanguage ? { targetLanguage } : {})
      }
    });
    copy = await createReplanProjectCopy({
      userId,
      sourceProject: project,
      request: message,
      operationId: operation.id,
      targetLanguage
    });
    spend = reservation ? await commitReservedCredits(reservation.id) : null;
    const job = await enqueueGenerationJob({
      projectId: copy.id,
      type: "REPLAN_BOOK",
      dedupeKey: `replan-book:${copy.id}:${operation.id}`,
      payload: {
        operationId: operation.id,
        sourceProjectId: project.id,
        sourcePlanId: project.currentPlanId,
        request: message,
        affectedPageIndexes: [],
        intentKind: intent.kind,
        ...(targetLanguage ? { targetLanguage } : {}),
        ...(spend ? { billingLedgerEntryId: spend.id } : {})
      }
    });
    const updated = await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: {
        generationJobId: job.id,
        ledgerEntryId: spend?.id ?? null,
        creditsCharged: cost,
        classifier: jsonInputValue({
          ...intent,
          replanCopy: { sourceProjectId: project.id, targetProjectId: copy.id, ...(targetLanguage ? { targetLanguage } : {}) }
        })
      },
      include: { generationJob: { select: { id: true, status: true } } }
    });
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      operationId: operation.id,
      content: `I created a new${targetLanguage ? ` ${languageDisplayName(targetLanguage)}` : ""} copy and I’ll rebuild the plan and book there. This book stays unchanged. This uses ${cost} credits.`,
      metadata: {
        intent,
        charged: true,
        creditsCharged: cost,
        replanCopy: { sourceProjectId: project.id, targetProjectId: copy.id, ...(targetLanguage ? { targetLanguage } : {}) }
      }
    });
    await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: { assistantMessageId: reply.id }
    });
    return { reply, operation: updated };
  } catch (error) {
    const entryToRefund = spend ?? reservation;
    if (entryToRefund) {
      await refundCreditLedgerEntry(entryToRefund.id, "Book replan copy could not be queued.");
    }
    await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: { status: "FAILED", error: errorMessage(error) }
    });
    if (copy) {
      await prisma.project.update({ where: { id: copy.id }, data: { status: "FAILED" } }).catch(() => undefined);
    }
    if (error instanceof InsufficientCreditsError) {
      const reply = await insufficientCreditsChatMessage(project.id, userMessageId, intent, error);
      return { reply, operation: null };
    }
    throw error;
  }
}

export async function queueChatBookEdit(options: {
  userId: string;
  project: ProjectForChat;
  userMessageId: string;
  message: string;
  intent: BookEditIntent;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  const { userId, project, userMessageId, message, intent } = options;
  if (intent.kind === "book_replan") {
    return queueChatBookReplanCopy({ userId, project, userMessageId, message, intent });
  }
  if (intent.kind === "continue_book") {
    return queueChatContinueBook({ userId, project, userMessageId, message, intent });
  }

  const affectedPageIndexes = await affectedPagesForIntent(intent, message, project);
  if (affectedPageIndexes.length === 0) {
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      content:
        intent.kind === "chapter_regenerate"
          ? `I couldn’t find chapter ${intent.affectedChapterIndex ?? ""} in this book. Which chapter or pages should I rewrite?`.replace("  ", " ")
          : "Which page or exact phrase should I edit?",
      metadata: {
        intent: { ...intent, kind: "clarify", affectedPageIndexes, clarification: "scope" },
        pendingEdit: { request: message, clarification: "scope" },
        charged: false
      }
    });
    return { reply, operation: null };
  }

  const cost = bookEditCreditCost(intent.kind, affectedPageIndexes.length, project);
  const operationKind = operationKindForIntent(intent.kind);
  const billingOperation = billingOperationForIntent(intent.kind);
  const operation = await createOpenBookEditOperation({
    projectId: project.id,
    userMessageId,
    kind: operationKind,
    status: "QUEUED",
    request: message,
    classifier: jsonInputValue(intent),
    affectedPageIndexes,
    creditsCharged: 0
  });
  if (!operation) {
    const reply = await busyEditReply({ projectId: project.id, parentMessageId: userMessageId, intent, request: message });
    return { reply, operation: null };
  }

  let reservation: CreditLedgerEntryRecord | null = null;
  let spend: CreditLedgerEntryRecord | null = null;
  try {
    reservation = await reserveCredits({
      userId,
      projectId: project.id,
      operation: billingOperation,
      amountCredits: cost,
      idempotencyKey: `mobile:project-chat:${project.id}:${operation.id}:charge`,
      description: `Mobile ${operationKind.toLowerCase().replaceAll("_", " ")} edit`,
      metadata: { intent, affectedPageIndexes }
    });
    spend = reservation ? await commitReservedCredits(reservation.id) : null;
    await prisma.project.update({ where: { id: project.id }, data: { status: "EDITING" } });
    const job = await enqueueGenerationJob({
      projectId: project.id,
      type: "APPLY_BOOK_EDIT",
      dedupeKey: `apply-book-edit:${project.id}:${operation.id}`,
      payload: {
        operationId: operation.id,
        request: message,
        affectedPageIndexes,
        intentKind: intent.kind,
        ...(project.currentPlanId ? { planId: project.currentPlanId } : {}),
        ...(spend ? { billingLedgerEntryId: spend.id } : {}),
        ...(exactReplacementFromMessage(message) ? { exactReplacement: exactReplacementFromMessage(message) } : {})
      }
    });
    const updated = await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: {
        generationJobId: job.id,
        ledgerEntryId: spend?.id ?? null,
        creditsCharged: cost
      },
      include: { generationJob: { select: { id: true, status: true } } }
    });
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      operationId: operation.id,
      content: operationQueuedMessage(intent.kind, affectedPageIndexes, cost, intent),
      metadata: { intent, charged: true, creditsCharged: cost }
    });
    await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: { assistantMessageId: reply.id }
    });
    return { reply, operation: updated };
  } catch (error) {
    const entryToRefund = spend ?? reservation;
    if (entryToRefund) {
      await refundCreditLedgerEntry(entryToRefund.id, "Book edit could not be queued.");
    }
    await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: { status: "FAILED", error: errorMessage(error) }
    });
    await prisma.project.update({ where: { id: project.id }, data: { status: "COMPLETE" } }).catch(() => undefined);
    if (error instanceof InsufficientCreditsError) {
      const reply = await insufficientCreditsChatMessage(project.id, userMessageId, intent, error);
      return { reply, operation: null };
    }
    throw error;
  }
}

/**
 * Charges and queues a continuation: new chapters written in the book's own
 * voice and appended after the last page. Zero existing pages are affected —
 * the credited page count is the number of pages the continuation will add.
 */
export async function queueChatContinueBook(options: {
  userId: string;
  project: ProjectForChat;
  userMessageId: string;
  message: string;
  intent: BookEditIntent;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  const { userId, project, userMessageId, message, intent } = options;
  const chapterCount = Math.min(8, Math.max(1, intent.continuation?.chapterCount ?? 1));
  const newPageCount = continuationNewPageCount(intent, project);
  const cost = bookEditCreditCost(intent.kind, newPageCount, project);
  const operation = await createOpenBookEditOperation({
    projectId: project.id,
    userMessageId,
    kind: "CONTINUE_BOOK",
    status: "QUEUED",
    request: message,
    classifier: jsonInputValue(intent),
    affectedPageIndexes: [],
    creditsCharged: 0
  });
  if (!operation) {
    const reply = await busyEditReply({ projectId: project.id, parentMessageId: userMessageId, intent, request: message });
    return { reply, operation: null };
  }

  let reservation: CreditLedgerEntryRecord | null = null;
  let spend: CreditLedgerEntryRecord | null = null;
  try {
    reservation = await reserveCredits({
      userId,
      projectId: project.id,
      operation: "PAGE_REGENERATION",
      amountCredits: cost,
      idempotencyKey: `mobile:project-chat:${project.id}:${operation.id}:charge`,
      description: "Mobile book continuation",
      metadata: { intent, chapterCount, newPageCount }
    });
    spend = reservation ? await commitReservedCredits(reservation.id) : null;
    await prisma.project.update({ where: { id: project.id }, data: { status: "EDITING" } });
    const job = await enqueueGenerationJob({
      projectId: project.id,
      type: "CONTINUE_BOOK",
      dedupeKey: `continue-book:${project.id}:${operation.id}`,
      payload: {
        operationId: operation.id,
        request: message,
        chapterCount,
        newPageCount,
        ...(project.currentPlanId ? { planId: project.currentPlanId } : {}),
        ...(spend ? { billingLedgerEntryId: spend.id } : {})
      }
    });
    const updated = await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: {
        generationJobId: job.id,
        ledgerEntryId: spend?.id ?? null,
        creditsCharged: cost
      },
      include: { generationJob: { select: { id: true, status: true } } }
    });
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      operationId: operation.id,
      content: operationQueuedMessage(intent.kind, [], cost, intent),
      metadata: { intent, charged: true, creditsCharged: cost }
    });
    await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: { assistantMessageId: reply.id }
    });
    return { reply, operation: updated };
  } catch (error) {
    const entryToRefund = spend ?? reservation;
    if (entryToRefund) {
      await refundCreditLedgerEntry(entryToRefund.id, "Book continuation could not be queued.");
    }
    await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: { status: "FAILED", error: errorMessage(error) }
    });
    await prisma.project.update({ where: { id: project.id }, data: { status: "COMPLETE" } }).catch(() => undefined);
    if (error instanceof InsufficientCreditsError) {
      const reply = await insufficientCreditsChatMessage(project.id, userMessageId, intent, error);
      return { reply, operation: null };
    }
    throw error;
  }
}

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
  | { kind: "conflict"; reason: string }
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
  const eligibility = canClaimPlanRevisionRetry(operation);
  if (!eligibility.eligible && options.automatic) {
    return { kind: "conflict", reason: eligibility.reason ?? "Retry is not available." };
  }
  if (!options.automatic && !["FAILED", "CANCELED"].includes(operation.status)) {
    return { kind: "conflict", reason: "Only failed plan revision operations can be retried." };
  }
  if (operation.automaticRetryCount >= operation.automaticRetryLimit) {
    return { kind: "conflict", reason: "This plan revision has exhausted its retry budget." };
  }
  if (await hasCompetingOpenBookEditOperation(operation.projectId, operation.id)) {
    return {
      kind: "conflict",
      reason: "Another book update is already in progress. Retry this revision when it finishes."
    };
  }
  const classifier = jsonRecord(operation.classifier);
  const isUnbilledWebRevision = classifier.source === "web";
  if ((!operation.ledgerEntryId || !operation.ledgerEntry) && !isUnbilledWebRevision) {
    options.log?.warn(
      { event: "plan_revision.consistency_warning", operationId: operation.id, projectId: operation.projectId, warning: "missing_ledger" },
      "Paid mobile plan revision retry rejected because billing linkage is missing"
    );
    return { kind: "conflict", reason: "Billing state for this revision is incomplete. Credits were not charged again." };
  }
  const payload = jsonRecord(operation.generationJob?.payload);
  const planId = typeof payload.planId === "string" ? payload.planId : null;
  if (!planId) {
    return { kind: "conflict", reason: "The original revision target is unavailable." };
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
    return { kind: "conflict", reason: "A newer plan exists, so this revision can no longer be retried." };
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
        reason: "Another book update is already in progress. Retry this revision when it finishes."
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
    return { kind: "conflict", reason: "This retry was already claimed by another request." };
  }
  await dispatchGenerationJob(transactionResult.newJob.id);
  options.log?.info(
    { event: "plan_revision.retry_queued", operationId: operation.id, projectId: operation.projectId, generationJobId: transactionResult.newJob.id, retryNumber, automatic: options.automatic, staleActive: false },
    "Plan revision retry queued"
  );
  return { kind: "queued", operation: transactionResult.updated };
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
    select: { id: true, project: { select: { userId: true } }, automaticRetryCount: true }
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

export async function queueDirectPlanRevision(options: {
  userId: string;
  projectId: string;
  planId: string;
  message: string;
  requestId: string;
}): Promise<{
  operation: MobileBookEditOperationRecord;
  job: Awaited<ReturnType<typeof enqueueGenerationJob>>;
}> {
  const existing = await prisma.bookEditOperation.findFirst({
    where: { projectId: options.projectId, requestId: options.requestId },
    include: { generationJob: { select: { id: true, status: true } } }
  });
  if (existing?.generationJob) {
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
    throw new Error("Another book edit operation is already in progress.");
  }
  try {
    const { job, ledgerEntry } = await queueChargedPlanRevision({
      userId: options.userId,
      projectId: options.projectId,
      planId: options.planId,
      message: options.message,
      operationId: operation.id,
      idempotencyKey: `mobile:plan:${options.planId}:revision:${options.requestId}`
    });
    const updated = await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: {
        generationJobId: job.id,
        ledgerEntryId: ledgerEntry?.id ?? null,
        creditsCharged: creditCostForOperation("PLAN_REVISION")
      },
      include: { generationJob: { select: { id: true, status: true } } }
    });
    return { operation: updated, job };
  } catch (error) {
    await prisma.bookEditOperation.update({
      where: { id: operation.id },
      data: { status: "FAILED", error: errorMessage(error) }
    });
    throw error;
  }
}

export async function queueChargedPlanRevision(options: {
  userId: string;
  projectId: string;
  planId: string;
  message: string;
  idempotencyKey: string;
  operationId?: string | undefined;
}): Promise<{ job: Awaited<ReturnType<typeof enqueueGenerationJob>>; ledgerEntry: CreditLedgerEntryRecord | null }> {
  const amountCredits = creditCostForOperation("PLAN_REVISION");
  let reservation: CreditLedgerEntryRecord | null = null;
  let spend: CreditLedgerEntryRecord | null = null;
  try {
    reservation = await reserveCredits({
      userId: options.userId,
      projectId: options.projectId,
      operation: "PLAN_REVISION",
      amountCredits,
      idempotencyKey: options.idempotencyKey,
      description: "Mobile plan revision",
      metadata: {
        planId: options.planId,
        ...(options.operationId ? { operationId: options.operationId } : {})
      }
    });
    spend = reservation ? await commitReservedCredits(reservation.id) : null;
    const transactionResult = await prisma.$transaction(async (tx) => {
      const job = await enqueueGenerationJob({
        projectId: options.projectId,
        type: "REVISE_PLAN",
        dedupeKey: `revise-plan:${options.projectId}:${options.planId}:${hashString(options.idempotencyKey)}`,
        transaction: tx,
        dispatch: false,
        payload: {
          planId: options.planId,
          message: options.message,
          ...(spend ? { billingLedgerEntryId: spend.id } : {}),
          ...(options.operationId ? { editOperationId: options.operationId } : {})
        }
      });
      if (spend) {
        await tx.creditLedgerEntry.update({
          where: { id: spend.id },
          data: { projectId: options.projectId, generationJobId: job.id }
        });
      }
      if (options.operationId) {
        await tx.bookEditOperation.update({
          where: { id: options.operationId },
          data: {
            generationJobId: job.id,
            ledgerEntryId: spend?.id ?? null,
            creditsCharged: amountCredits
          }
        });
      }
      await tx.project.update({ where: { id: options.projectId }, data: { status: "PLANNING" } });
      return { job };
    });
    await dispatchGenerationJob(transactionResult.job.id);
    return { job: transactionResult.job, ledgerEntry: spend };
  } catch (error) {
    const entryToRefund = spend ?? reservation;
    if (entryToRefund) {
      await refundCreditLedgerEntry(entryToRefund.id, "Plan revision could not be queued.");
    }
    throw error;
  }
}

export async function hasOpenProjectWork(projectId: string): Promise<boolean> {
  const count = await prisma.generationJob.count({
    where: {
      projectId,
      status: { in: ["QUEUED", "ACTIVE"] },
      type: { notIn: ["PREPARE_CHARACTER_CANDIDATES", "BUILD_CHARACTER_PERSONA", "RESEARCH"] }
    }
  });
  return count > 0;
}

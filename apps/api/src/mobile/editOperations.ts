import { type BookEditIntent } from "../bookEditIntent.js";
import { cancelUndispatchedGenerationJob, dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import { createOpenBookEditOperation, replayClaimedChatOperation } from "./editOperationClaims.js";
import {
  affectedPagesForIntent,
  busyEditReply,
  continuationNewPageCount,
  exactReplacementFromMessage,
  operationQueuedMessage
} from "./bookEditIntents.js";
import { billingOperationForIntent, bookEditCreditCost, operationKindForIntent } from "./bookEditPricing.js";
import { planExactReplacement } from "./exactReplacementPreview.js";
import {
  type MobileBookEditOperationRecord,
  type MobileProjectChatMessageRecord,
  type MobileProjectRecord
} from "./dto.js";
import { createAssistantChatMessage, insufficientCreditsChatMessage, type ProjectForChat } from "./projectChat.js";
import { attachReplanCopyToCreationSession, createReplanProjectCopy } from "./projectRecords.js";
import {
  cleanTargetLanguage,
  errorMessage,
  fingerprintGenerationRequest,
  hashString,
  jsonInputValue,
  jsonRecord,
  languageDisplayName
} from "./support.js";
import { creditCostForOperation } from "@book-maker/core";
import { PLAN_REVISION_AUTOMATIC_RETRY_LIMIT, Prisma, prisma } from "@book-maker/db";
import {
  GenerationAttemptConflictError,
  InsufficientCreditsError,
  commitReservedCredits,
  refundCreditLedgerEntry,
  startGenerationAttempt,
  type CreditLedgerEntryRecord
} from "@book-maker/db/billing";

/**
 * Queues the generation jobs behind an approved edit (plan revision, replan,
 * book edit, continuation) and reconciles retryable ones.
 */

// The durable claim/replay pair lives in editOperationClaims.ts; re-exported
// because callers and tests historically import it from this module.
export { createOpenBookEditOperation } from "./editOperationClaims.js";

/**
 * The one reserve → commit → enqueue → compensate skeleton every charged edit
 * runs through, so "every failure path refunds" is enforced by the shape of
 * the code rather than by reviewers noticing.
 *
 * The compensation ordering is the safety property, taken from the plan
 * revision path: once a GenerationJob row exists, it is reachable by both
 * reconcilers, so a refund is only safe after `cancelUndispatchedGenerationJob`
 * provably claimed the row. A job that was already dispatched (or that a
 * reconciler claimed first) will run, and the charge must stand — the failure
 * is logged instead of refunded. `run` must call `registerQueuedJob` the
 * moment a durable job row exists so this catch can reach it.
 */
export async function withChargedEnqueue<T>(options: {
  reserve: () => Promise<CreditLedgerEntryRecord | null>;
  refundReason: string;
  run: (context: {
    spend: CreditLedgerEntryRecord | null;
    registerQueuedJob: (jobId: string) => void;
  }) => Promise<T>;
  /**
   * Domain compensation beyond the refund (restore a project status, fail a
   * replan copy). Runs only when the queued work is provably dead — when the
   * job survived, the work is still coming and the domain state it needs must
   * stay put.
   */
  onFailureWhenDead?: ((context: { jobWasQueued: boolean }) => Promise<void>) | undefined;
}): Promise<T> {
  let reservation: CreditLedgerEntryRecord | null = null;
  let spend: CreditLedgerEntryRecord | null = null;
  let queuedJobId: string | null = null;
  try {
    reservation = await options.reserve();
    spend = reservation ? await commitReservedCredits(reservation.id) : null;
    return await options.run({
      spend,
      registerQueuedJob: (jobId) => {
        queuedJobId = jobId;
      }
    });
  } catch (error) {
    const jobProvablyDead = queuedJobId
      ? await cancelUndispatchedGenerationJob(queuedJobId, options.refundReason).catch(() => false)
      : true;
    if (jobProvablyDead && options.onFailureWhenDead) {
      try {
        await options.onFailureWhenDead({ jobWasQueued: queuedJobId !== null });
      } catch {
        // Compensation is best-effort; the refund decision below still runs.
      }
    }
    const entryToRefund = spend ?? reservation;
    if (entryToRefund && jobProvablyDead) {
      await refundCreditLedgerEntry(entryToRefund.id, options.refundReason);
    } else if (entryToRefund) {
      console.error("Charged enqueue compensation kept the charge: the queued job could not be canceled", {
        generationJobId: queuedJobId,
        ledgerEntryId: entryToRefund.id,
        reason: options.refundReason
      });
    }
    throw error;
  }
}

async function queueAttemptChatOperation(options: {
  userId: string;
  project: ProjectForChat;
  userMessageId: string;
  intent: BookEditIntent;
  operation: MobileBookEditOperationRecord;
  cost: number;
  billingOperation: "BOOK_TEXT_EDIT" | "PAGE_REGENERATION" | "BOOK_REPLAN";
  description: string;
  metadata: Record<string, unknown>;
  enqueue: (
    tx: Prisma.TransactionClient,
    context: { attemptId: string; ledgerEntry: CreditLedgerEntryRecord | null }
  ) => Promise<{ id: string; projectId?: string | undefined }>;
  operationData?: Prisma.BookEditOperationUncheckedUpdateInput | undefined;
  replyContent: string;
  replyMetadata: Record<string, unknown>;
  afterCommit?: (() => Promise<void>) | undefined;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  let started;
  try {
    started = await startGenerationAttempt({
      userId: options.userId,
      commandKey: `mobile:edit-command:${options.project.id}:${options.operation.requestId ?? options.operation.id}`,
      requestFingerprint: fingerprintGenerationRequest({
        projectId: options.project.id,
        requestId: options.operation.requestId,
        request: options.operation.request,
        intent: options.intent
      }),
      projectId: options.project.id,
      operation: options.billingOperation,
      quotedCredits: options.cost,
      description: options.description,
      metadata: options.metadata,
      create: async (tx, context) => {
        const job = await options.enqueue(tx, context);
        await tx.bookEditOperation.update({
          where: { id: options.operation.id },
          data: {
            generationJobId: job.id,
            ledgerEntryId: context.ledgerEntry?.id ?? null,
            creditsCharged: options.cost,
            ...options.operationData
          }
        });
        return {
          projectId: job.projectId ?? options.project.id,
          primaryJobId: job.id,
          editOperationId: options.operation.id
        };
      }
    });
  } catch (error) {
    // Nothing committed: the attempt transaction rolled the charge, the job
    // and the operation update back together, so FAILED is the truth here.
    // Conditional on the job linkage, because a rare failure *after* the
    // commit (the replay read, a serialization retry read) reaches this catch
    // too — and then the row carries its committed generationJobId and must
    // not be failed over work that still runs.
    await prisma.bookEditOperation.updateMany({
      where: { id: options.operation.id, generationJobId: null },
      data: { status: "FAILED", error: errorMessage(error) }
    });
    if (error instanceof InsufficientCreditsError) {
      const reply = await insufficientCreditsChatMessage(
        options.project.id,
        options.userMessageId,
        options.intent,
        error
      );
      return { reply, operation: null };
    }
    throw error;
  }
  if (!started.attempt.primaryJobId) {
    throw new Error("Edit generation attempt has no primary job.");
  }
  // From here the charge and the durable job are committed and the work is
  // coming: no failure below may mark the operation FAILED — that verdict
  // belongs to the worker. A FAILED write here would invite a second paid
  // submission for an edit that still runs (or already applied).
  await dispatchGenerationJob(started.attempt.primaryJobId).catch((error) => {
    // The QUEUED row without a bullJobId is exactly what the dispatch
    // reconcilers re-publish; the job is late, not lost.
    console.error(`Deferred dispatch of edit generation job ${started.attempt.primaryJobId}`, error);
  });
  if (options.afterCommit) {
    try {
      await options.afterCommit();
    } catch (error) {
      console.error(`Post-commit bookkeeping failed for edit operation ${options.operation.id}`, error);
    }
  }
  const updated = await prisma.bookEditOperation.findUnique({
    where: { id: options.operation.id },
    include: { generationJob: { select: { id: true, status: true } } }
  });
  if (!updated) {
    throw new Error("Queued edit operation could not be loaded.");
  }
  const reply = await createAssistantChatMessage({
    projectId: options.project.id,
    parentId: options.userMessageId,
    operationId: options.operation.id,
    content: options.replyContent,
    metadata: options.replyMetadata
  });
  await prisma.bookEditOperation.update({
    where: { id: options.operation.id },
    data: { assistantMessageId: reply.id }
  });
  return { reply, operation: updated as MobileBookEditOperationRecord };
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
    requestId: userMessageId,
    userMessageId,
    kind: "PLAN_REVISION",
    status: "QUEUED",
    request: message,
    classifier: jsonInputValue(intent),
    affectedPageIndexes: [],
    creditsCharged: 0
  });
  if (!operation) {
    const replay = await replayClaimedChatOperation({
      projectId: project.id,
      requestId: userMessageId,
      parentMessageId: userMessageId,
      intent
    });
    if (replay) return replay;
    const reply = await busyEditReply({ projectId: project.id, parentMessageId: userMessageId, intent, request: message });
    return { reply, operation: null };
  }
  let queued;
  try {
    queued = await queueChargedPlanRevision({
      userId,
      projectId: project.id,
      planId,
      message,
      operationId: operation.id,
      idempotencyKey: `mobile:project-chat:${project.id}:${operation.id}:plan-revision`
    });
  } catch (error) {
    // Conditional on the job linkage: a post-commit read failure inside
    // queueChargedPlanRevision lands here too, and the committed row already
    // carries its generationJobId — failing it would disown a charged job.
    await prisma.bookEditOperation.updateMany({
      where: { id: operation.id, generationJobId: null },
      data: { status: "FAILED", error: errorMessage(error) }
    });
    if (error instanceof InsufficientCreditsError) {
      const reply = await insufficientCreditsChatMessage(project.id, userMessageId, intent, error);
      return { reply, operation: null };
    }
    throw error;
  }
  // The charge and the durable job are committed: from here a failure is chat
  // bookkeeping, and marking the operation FAILED would invite a second paid
  // submission for a revision that still runs.
  const updated = await prisma.bookEditOperation.update({
    where: { id: operation.id },
    data: {
      generationJobId: queued.job.id,
      ledgerEntryId: queued.ledgerEntry?.id ?? null,
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
        ? "I’ll revise the approved plan and reopen it for review."
        : "I’ll revise the plan now.",
    metadata: { intent, charged: true, creditsCharged: credits }
  });
  await prisma.bookEditOperation.update({
    where: { id: operation.id },
    data: { assistantMessageId: reply.id }
  });
  return { reply, operation: updated };
}

export async function queueChatBookReplanCopy(options: {
  userId: string;
  project: ProjectForChat;
  userMessageId: string;
  message: string;
  intent: BookEditIntent;
  executionCommandId?: string | undefined;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  const { userId, project, userMessageId, message, intent } = options;
  // Same settings the proposal was quoted from, or the user approves one price
  // and is charged another.
  const replanSettings = intent.replanSettings ?? null;
  const cost = bookEditCreditCost(intent.kind, 0, project, { replanSettings });
  const targetLanguage = cleanTargetLanguage(intent.targetLanguage);
  const commandRequestId = options.executionCommandId ?? userMessageId;
  const operation = await createOpenBookEditOperation({
    projectId: project.id,
    requestId: commandRequestId,
    userMessageId,
    kind: "BOOK_REPLAN",
    status: "QUEUED",
    request: message,
    classifier: jsonInputValue(intent),
    affectedPageIndexes: [],
    creditsCharged: 0
  });
  if (!operation) {
    const replay = await replayClaimedChatOperation({
      projectId: project.id,
      requestId: commandRequestId,
      parentMessageId: userMessageId,
      intent
    });
    if (replay) return replay;
    const reply = await busyEditReply({ projectId: project.id, parentMessageId: userMessageId, intent, request: message });
    return { reply, operation: null };
  }

  const replanCopy = (copyId: string) => ({
    sourceProjectId: project.id,
    targetProjectId: copyId,
    ...(targetLanguage ? { targetLanguage } : {})
  });
  let copy: MobileProjectRecord | null = null;
  return queueAttemptChatOperation({
    userId,
    project,
    userMessageId,
    intent,
    operation,
    cost,
    billingOperation: "BOOK_REPLAN",
    description: "Mobile book replan copy",
    metadata: {
      intent,
      sourceProjectId: project.id,
      operationId: operation.id,
      ...(targetLanguage ? { targetLanguage } : {})
    },
    enqueue: async (tx, { attemptId, ledgerEntry }) => {
      copy = await createReplanProjectCopy({
        userId,
        sourceProject: project,
        request: message,
        operationId: operation.id,
        targetLanguage,
        settings: replanSettings,
        transaction: tx,
        attachToCreationSession: false
      });
      return enqueueGenerationJob({
        projectId: copy.id,
        type: "REPLAN_BOOK",
        dedupeKey: `replan-book:${copy.id}:${operation.id}`,
        transaction: tx,
        dispatch: false,
        attemptId,
        payload: {
          operationId: operation.id,
          sourceProjectId: project.id,
          sourcePlanId: project.currentPlanId,
          request: message,
          affectedPageIndexes: [],
          intentKind: intent.kind,
          ...(targetLanguage ? { targetLanguage } : {}),
          // Explicit, because the worker plans from the *source* plan's input
          // snapshot: without a number here it would size the rebuilt book to the
          // book being replaced, whatever the copy row says.
          ...(replanSettings?.targetPages === undefined ? {} : { targetPages: replanSettings.targetPages }),
          ...(ledgerEntry ? { billingLedgerEntryId: ledgerEntry.id } : {})
        }
      });
    },
    replyContent: `I created a new${targetLanguage ? ` ${languageDisplayName(targetLanguage)}` : ""} copy and I’ll rebuild the plan and book there. This book stays unchanged.`,
    // Getters, because both depend on the copy that `enqueue` creates: the
    // wrapper reads them only after the job is queued.
    get operationData() {
      return copy ? { classifier: jsonInputValue({ ...intent, replanCopy: replanCopy(copy.id) }) } : undefined;
    },
    get replyMetadata() {
      return {
        intent,
        charged: true,
        creditsCharged: cost,
        ...(copy ? { replanCopy: replanCopy(copy.id) } : {})
      };
    },
    afterCommit: async () => {
      if (copy) {
        await attachReplanCopyToCreationSession({
          sourceProjectId: project.id,
          copyProjectId: copy.id,
          copyTitle: copy.title
        });
      }
    }
  });
}

export async function queueChatBookEdit(options: {
  userId: string;
  project: ProjectForChat;
  userMessageId: string;
  message: string;
  intent: BookEditIntent;
  executionCommandId?: string | undefined;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  const { userId, project, userMessageId, message, intent } = options;
  if (intent.kind === "book_replan") {
    return queueChatBookReplanCopy({
      userId,
      project,
      userMessageId,
      message,
      intent,
      ...(options.executionCommandId ? { executionCommandId: options.executionCommandId } : {})
    });
  }
  if (intent.kind === "continue_book") {
    return queueChatContinueBook({
      userId,
      project,
      userMessageId,
      message,
      intent,
      ...(options.executionCommandId ? { executionCommandId: options.executionCommandId } : {})
    });
  }

  let affectedPageIndexes = await affectedPagesForIntent(intent, message, project);
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

  // Recomputed rather than read off the proposal: this is the number that gets
  // charged, so it has to be derived from the pages as they are now, and the
  // same scoping the quote used has to be applied or the two disagree.
  const patch =
    intent.kind === "local_patch"
      ? await planExactReplacement(project.id, exactReplacementFromMessage(message), affectedPageIndexes)
      : null;
  if (patch) {
    affectedPageIndexes = patch.pageIndexes;
  }
  const cost = bookEditCreditCost(intent.kind, affectedPageIndexes.length, project, {
    deterministic: Boolean(patch)
  });
  const operationKind = operationKindForIntent(intent.kind);
  const billingOperation = billingOperationForIntent(intent.kind);
  const commandRequestId = options.executionCommandId ?? userMessageId;
  const operation = await createOpenBookEditOperation({
    projectId: project.id,
    requestId: commandRequestId,
    userMessageId,
    kind: operationKind,
    status: "QUEUED",
    request: message,
    classifier: jsonInputValue(intent),
    affectedPageIndexes,
    creditsCharged: 0
  });
  if (!operation) {
    const replay = await replayClaimedChatOperation({
      projectId: project.id,
      requestId: commandRequestId,
      parentMessageId: userMessageId,
      intent
    });
    if (replay) return replay;
    const reply = await busyEditReply({ projectId: project.id, parentMessageId: userMessageId, intent, request: message });
    return { reply, operation: null };
  }

  return queueAttemptChatOperation({
    userId,
    project,
    userMessageId,
    intent,
    operation,
    cost,
    billingOperation,
    description: `Mobile ${operationKind.toLowerCase().replaceAll("_", " ")} edit`,
    metadata: { intent, affectedPageIndexes },
    enqueue: async (tx, { attemptId, ledgerEntry }) => {
      await tx.project.update({ where: { id: project.id }, data: { status: "EDITING" } });
      return enqueueGenerationJob({
        projectId: project.id,
        type: "APPLY_BOOK_EDIT",
        dedupeKey: `apply-book-edit:${project.id}:${operation.id}`,
        transaction: tx,
        dispatch: false,
        attemptId,
        payload: {
          operationId: operation.id,
          request: message,
          affectedPageIndexes,
          intentKind: intent.kind,
          ...(project.currentPlanId ? { planId: project.currentPlanId } : {}),
          ...(ledgerEntry ? { billingLedgerEntryId: ledgerEntry.id } : {}),
          // `mode: "exact"` is a promise, not a hint: every page here was verified
          // to contain the literal text, so the worker must not fall back to a
          // model rewrite for any of them. That fallback is what silently turned
          // a patch-priced edit into a per-page regeneration.
          ...(patch
            ? { exactReplacement: patch.replacement, mode: "exact" as const }
            : exactReplacementFromMessage(message)
              ? { exactReplacement: exactReplacementFromMessage(message) }
              : {})
        }
      });
    },
    replyContent: operationQueuedMessage(intent.kind, affectedPageIndexes, intent),
    replyMetadata: { intent, charged: true, creditsCharged: cost }
  });
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
  executionCommandId?: string | undefined;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  const { userId, project, userMessageId, message, intent } = options;
  const chapterCount = Math.min(8, Math.max(1, intent.continuation?.chapterCount ?? 1));
  const newPageCount = continuationNewPageCount(intent, project);
  const cost = bookEditCreditCost(intent.kind, newPageCount, project);
  const commandRequestId = options.executionCommandId ?? userMessageId;
  const operation = await createOpenBookEditOperation({
    projectId: project.id,
    requestId: commandRequestId,
    userMessageId,
    kind: "CONTINUE_BOOK",
    status: "QUEUED",
    request: message,
    classifier: jsonInputValue(intent),
    affectedPageIndexes: [],
    creditsCharged: 0
  });
  if (!operation) {
    const replay = await replayClaimedChatOperation({
      projectId: project.id,
      requestId: commandRequestId,
      parentMessageId: userMessageId,
      intent
    });
    if (replay) return replay;
    const reply = await busyEditReply({ projectId: project.id, parentMessageId: userMessageId, intent, request: message });
    return { reply, operation: null };
  }

  return queueAttemptChatOperation({
    userId,
    project,
    userMessageId,
    intent,
    operation,
    cost,
    billingOperation: "PAGE_REGENERATION",
    description: "Mobile book continuation",
    metadata: { intent, chapterCount, newPageCount },
    enqueue: async (tx, { attemptId, ledgerEntry }) => {
      await tx.project.update({ where: { id: project.id }, data: { status: "EDITING" } });
      return enqueueGenerationJob({
        projectId: project.id,
        type: "CONTINUE_BOOK",
        dedupeKey: `continue-book:${project.id}:${operation.id}`,
        transaction: tx,
        dispatch: false,
        attemptId,
        payload: {
          operationId: operation.id,
          request: message,
          chapterCount,
          newPageCount,
          ...(project.currentPlanId ? { planId: project.currentPlanId } : {}),
          ...(ledgerEntry ? { billingLedgerEntryId: ledgerEntry.id } : {})
        }
      });
    },
    replyContent: operationQueuedMessage(intent.kind, [], intent),
    replyMetadata: { intent, charged: true, creditsCharged: cost }
  });
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
      idempotencyKey: `mobile:plan:${options.planId}:revision:${options.requestId}`
    });
  } catch (error) {
    // Same job-linkage guard as the chat paths: only a row whose attempt never
    // committed may be failed here.
    await prisma.bookEditOperation.updateMany({
      where: { id: operation.id, generationJobId: null },
      data: { status: "FAILED", error: errorMessage(error) }
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
      message: options.message
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

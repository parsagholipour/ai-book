import { type BookEditIntent } from "../bookEditIntent.js";
import { cancelUndispatchedGenerationJob, dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
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
import { createReplanProjectCopy } from "./projectRecords.js";
import {
  cleanTargetLanguage,
  errorMessage,
  hashString,
  isPrismaUniqueConflict,
  jsonInputValue,
  languageDisplayName
} from "./support.js";
import { creditCostForOperation } from "@book-maker/core";
import { PLAN_REVISION_AUTOMATIC_RETRY_LIMIT, Prisma, prisma } from "@book-maker/db";
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

/**
 * The chat layer over withChargedEnqueue: stamps the operation row with the
 * job and charge, writes the assistant reply, and turns failures into the
 * operation's FAILED state (with the insufficient-credits reply when that is
 * what happened).
 */
async function queueChargedChatOperation(options: {
  project: ProjectForChat;
  userMessageId: string;
  intent: BookEditIntent;
  operation: MobileBookEditOperationRecord;
  cost: number;
  refundReason: string;
  reserve: () => Promise<CreditLedgerEntryRecord | null>;
  /** Domain setup plus the job enqueue; runs after the charge is committed. */
  enqueue: (spend: CreditLedgerEntryRecord | null) => Promise<{ id: string }>;
  /** Extra fields for the operation row beyond the job/charge linkage. */
  operationData?: Prisma.BookEditOperationUncheckedUpdateInput | undefined;
  replyContent: string;
  replyMetadata: Record<string, unknown>;
  onFailureWhenDead?: ((context: { jobWasQueued: boolean }) => Promise<void>) | undefined;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  try {
    return await withChargedEnqueue({
      reserve: options.reserve,
      refundReason: options.refundReason,
      onFailureWhenDead: options.onFailureWhenDead,
      run: async ({ spend, registerQueuedJob }) => {
        const job = await options.enqueue(spend);
        registerQueuedJob(job.id);
        const updated = await prisma.bookEditOperation.update({
          where: { id: options.operation.id },
          data: {
            generationJobId: job.id,
            ledgerEntryId: spend?.id ?? null,
            creditsCharged: options.cost,
            ...options.operationData
          },
          include: { generationJob: { select: { id: true, status: true } } }
        });
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
        return { reply, operation: updated };
      }
    });
  } catch (error) {
    await prisma.bookEditOperation.update({
      where: { id: options.operation.id },
      data: { status: "FAILED", error: errorMessage(error) }
    });
    if (error instanceof InsufficientCreditsError) {
      const reply = await insufficientCreditsChatMessage(options.project.id, options.userMessageId, options.intent, error);
      return { reply, operation: null };
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
          ? "I’ll revise the approved plan and reopen it for review."
          : "I’ll revise the plan now.",
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
  // Same settings the proposal was quoted from, or the user approves one price
  // and is charged another.
  const replanSettings = intent.replanSettings ?? null;
  const cost = bookEditCreditCost(intent.kind, 0, project, { replanSettings });
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

  const replanCopy = (copyId: string) => ({
    sourceProjectId: project.id,
    targetProjectId: copyId,
    ...(targetLanguage ? { targetLanguage } : {})
  });
  let copy: MobileProjectRecord | null = null;
  return queueChargedChatOperation({
    project,
    userMessageId,
    intent,
    operation,
    cost,
    refundReason: "Book replan copy could not be queued.",
    reserve: () =>
      reserveCredits({
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
      }),
    enqueue: async (spend) => {
      copy = await createReplanProjectCopy({
        userId,
        sourceProject: project,
        request: message,
        operationId: operation.id,
        targetLanguage,
        settings: replanSettings
      });
      return enqueueGenerationJob({
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
          // Explicit, because the worker plans from the *source* plan's input
          // snapshot: without a number here it would size the rebuilt book to the
          // book being replaced, whatever the copy row says.
          ...(replanSettings?.targetPages === undefined ? {} : { targetPages: replanSettings.targetPages }),
          ...(spend ? { billingLedgerEntryId: spend.id } : {})
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
    onFailureWhenDead: async () => {
      if (copy) {
        await prisma.project.update({ where: { id: copy.id }, data: { status: "FAILED" } }).catch(() => undefined);
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
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  const { userId, project, userMessageId, message, intent } = options;
  if (intent.kind === "book_replan") {
    return queueChatBookReplanCopy({ userId, project, userMessageId, message, intent });
  }
  if (intent.kind === "continue_book") {
    return queueChatContinueBook({ userId, project, userMessageId, message, intent });
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

  return queueChargedChatOperation({
    project,
    userMessageId,
    intent,
    operation,
    cost,
    refundReason: "Book edit could not be queued.",
    reserve: () =>
      reserveCredits({
        userId,
        projectId: project.id,
        operation: billingOperation,
        amountCredits: cost,
        idempotencyKey: `mobile:project-chat:${project.id}:${operation.id}:charge`,
        description: `Mobile ${operationKind.toLowerCase().replaceAll("_", " ")} edit`,
        metadata: { intent, affectedPageIndexes }
      }),
    enqueue: async (spend) => {
      await prisma.project.update({ where: { id: project.id }, data: { status: "EDITING" } });
      return enqueueGenerationJob({
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
    replyMetadata: { intent, charged: true, creditsCharged: cost },
    onFailureWhenDead: async () => {
      await prisma.project.update({ where: { id: project.id }, data: { status: "COMPLETE" } }).catch(() => undefined);
    }
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

  return queueChargedChatOperation({
    project,
    userMessageId,
    intent,
    operation,
    cost,
    refundReason: "Book continuation could not be queued.",
    reserve: () =>
      reserveCredits({
        userId,
        projectId: project.id,
        operation: "PAGE_REGENERATION",
        amountCredits: cost,
        idempotencyKey: `mobile:project-chat:${project.id}:${operation.id}:charge`,
        description: "Mobile book continuation",
        metadata: { intent, chapterCount, newPageCount }
      }),
    enqueue: async (spend) => {
      await prisma.project.update({ where: { id: project.id }, data: { status: "EDITING" } });
      return enqueueGenerationJob({
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
    },
    replyContent: operationQueuedMessage(intent.kind, [], intent),
    replyMetadata: { intent, charged: true, creditsCharged: cost },
    onFailureWhenDead: async () => {
      await prisma.project.update({ where: { id: project.id }, data: { status: "COMPLETE" } }).catch(() => undefined);
    }
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
  return withChargedEnqueue({
    refundReason: "Plan revision could not be queued.",
    reserve: () =>
      reserveCredits({
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
      }),
    run: async ({ spend, registerQueuedJob }) => {
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
      registerQueuedJob(transactionResult.job.id);
      await dispatchGenerationJob(transactionResult.job.id);
      return { job: transactionResult.job, ledgerEntry: spend };
    },
    onFailureWhenDead: async ({ jobWasQueued }) => {
      if (!jobWasQueued) {
        return;
      }
      // The committed transaction moved the project to PLANNING for a revision
      // that is now not coming; put it back the same way the worker's failure
      // path does (restoreProjectAfterFailedPlanRevision).
      await prisma.project
        .updateMany({
          where: { id: options.projectId, status: "PLANNING", currentPlanId: { not: null } },
          data: { status: "PLAN_READY" }
        })
        .catch(() => ({ count: 0 }));
    }
  });
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

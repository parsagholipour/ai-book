import { type BookEditIntent } from "../bookEditIntent.js";
import { cancelUndispatchedGenerationJob, dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import { createOpenBookEditOperation, replayClaimedChatOperation } from "./editOperationClaims.js";
import {
  affectedPagesForIntent,
  busyEditReply,
  continuationNewPageCount,
  editProposalCardFromState,
  exactReplacementFromMessage,
  operationQueuedMessage,
  pendingEditMetadataFromState,
  proposeBookEdit
} from "./bookEditIntents.js";
import { type PendingEditState } from "./pendingEditState.js";
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
  jsonInputValue,
  languageDisplayName
} from "./support.js";
import { bookPlanSchema, creditCostForOperation, isDetachedFromProjectLifecycle } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { randomUUID } from "node:crypto";
import {
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

// The direct plan-revision path moved to its own module along the chat/direct
// seam; re-exported because routes and tests import it from here.
export { queueChargedPlanRevision, queueDirectPlanRevision } from "./planRevisionOperations.js";
import { queueChargedPlanRevision } from "./planRevisionOperations.js";

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
 * The request as the worker's prompts should see it: the reader's own words
 * plus the mentioned characters' sheets. Only ever applied where the string is
 * handed to a model — job payloads and the plan-revision message — because the
 * bare `message` is what page targeting and exact-replacement parsing read.
 */
function requestWithCharacterContext(message: string, characterContext: string | undefined): string {
  return characterContext ? `${message}\n\n${characterContext}` : message;
}

/**
 * The resume payload for a credits-blocked edit: the same pendingEdit +
 * editProposal pair `proposeBookEdit` writes, under a **fresh** proposalId.
 * The failed Apply's own id is spent — its USER row settled it and its FAILED
 * operation row holds the [projectId, requestId] claim forever — so only a
 * re-proposal turns "add credits, then start over" into an Apply that works.
 * The quoted credits ride along and stay the ceiling on the eventual charge.
 */
function creditsBlockedResume(
  state: Omit<PendingEditState, "clarification" | "proposalId">
): { pendingEdit: Record<string, unknown>; editProposal?: Record<string, unknown> } {
  const resumable: PendingEditState = { ...state, clarification: "confirm", proposalId: randomUUID() };
  const card = editProposalCardFromState(resumable);
  return {
    pendingEdit: pendingEditMetadataFromState(resumable),
    ...(card ? { editProposal: card } : {})
  };
}

async function queueAttemptChatOperation(options: {
  userId: string;
  project: ProjectForChat;
  userMessageId: string;
  /** The edit request as the reader typed it; resumes the edit if the charge is refused. */
  request: string;
  intent: BookEditIntent;
  operation: MobileBookEditOperationRecord;
  cost: number;
  billingOperation: "BOOK_TEXT_EDIT" | "PAGE_REGENERATION" | "BOOK_REPLAN";
  description: string;
  metadata: Record<string, unknown>;
  /** Rides the credits-blocked resume so a later Apply keeps the sheets. */
  characterContext?: string | undefined;
  enqueue: (
    tx: Prisma.TransactionClient,
    context: { attemptId: string; ledgerEntry: CreditLedgerEntryRecord | null }
  ) => Promise<{ id: string; projectId?: string | null | undefined }>;
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
        error,
        creditsBlockedResume({
          request: options.request,
          scope: options.intent.scope,
          intent: options.intent,
          affectedPageIndexes: options.operation.affectedPageIndexes,
          credits: options.cost,
          ...(options.characterContext ? { characterContext: options.characterContext } : {})
        })
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

/** The current plan's question prompts that appear verbatim in the message. */
function planQuestionPromptsInMessage(project: ProjectForChat, message: string): string[] {
  const parsed = bookPlanSchema.safeParse(project.currentPlan?.planningPackage);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.questions
    .map((question) => question.prompt)
    .filter((prompt) => prompt.trim().length > 0 && message.includes(prompt));
}

export async function queueChatPlanRevision(options: {
  userId: string;
  project: ProjectForChat;
  userMessageId: string;
  message: string;
  intent: BookEditIntent;
  characterContext?: string | undefined;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  const { userId, project, userMessageId, message, intent } = options;
  const planId = project.currentPlan!.id;
  const credits = creditCostForOperation("PLAN_REVISION");
  // Both plan-question surfaces answer through chat by embedding each
  // question's prompt verbatim ("- {prompt}: {answer}"), so the answered
  // prompts are recovered from the message itself — this is what lets the
  // reviser drop them instead of re-asking, without a new chat field.
  const respondedQuestionPrompts = planQuestionPromptsInMessage(project, message);
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
    const reply = await busyEditReply({
      projectId: project.id,
      parentMessageId: userMessageId,
      intent,
      request: message,
      ...("characterContext" in options && options.characterContext
        ? { characterContext: options.characterContext }
        : {})
    });
    return { reply, operation: null };
  }
  let queued;
  try {
    queued = await queueChargedPlanRevision({
      userId,
      projectId: project.id,
      planId,
      message: requestWithCharacterContext(message, options.characterContext),
      operationId: operation.id,
      idempotencyKey: `mobile:project-chat:${project.id}:${operation.id}:plan-revision`,
      ...(respondedQuestionPrompts.length ? { respondedQuestionPrompts } : {})
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
      const reply = await insufficientCreditsChatMessage(
        project.id,
        userMessageId,
        intent,
        error,
        creditsBlockedResume({
          request: message,
          scope: intent.scope,
          intent,
          affectedPageIndexes: [],
          credits,
          ...(options.characterContext ? { characterContext: options.characterContext } : {})
        })
      );
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
  /** What the proposal card showed; the recomputed cost may never exceed it. */
  quotedCredits?: number | undefined;
  characterContext?: string | undefined;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  const { userId, project, userMessageId, message, intent } = options;
  // Same settings the proposal was quoted from, or the user approves one price
  // and is charged another.
  const replanSettings = intent.replanSettings ?? null;
  const cost = bookEditCreditCost(intent.kind, 0, project, { replanSettings });
  if (options.quotedCredits !== undefined && cost > options.quotedCredits) {
    // The same ceiling the other charged kinds enforce: the book changed
    // between the card and Apply (a continuation landed, the page count
    // moved), so re-propose at the current price rather than silently
    // charging past the number the user confirmed.
    return proposeBookEdit({
      project,
      userMessageId,
      message,
      intent,
      ...(options.characterContext ? { characterContext: options.characterContext } : {})
    });
  }
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
    const reply = await busyEditReply({
      projectId: project.id,
      parentMessageId: userMessageId,
      intent,
      request: message,
      ...("characterContext" in options && options.characterContext
        ? { characterContext: options.characterContext }
        : {})
    });
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
    request: message,
    intent,
    operation,
    cost,
    billingOperation: "BOOK_REPLAN",
    description: "Mobile book replan copy",
    ...(options.characterContext ? { characterContext: options.characterContext } : {}),
    metadata: {
      intent,
      sourceProjectId: project.id,
      operationId: operation.id,
      ...(targetLanguage ? { targetLanguage } : {})
    },
    enqueue: async (tx, { attemptId, ledgerEntry }) => {
      // The copy's `request` becomes the user-visible "Rebuilt from" header on
      // the book screen, so it stays as typed; the model-facing sheets ride
      // only the job payload below.
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
          request: requestWithCharacterContext(message, options.characterContext),
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
  /**
   * What the proposal card showed. The recomputed cost may never exceed it: a
   * changed book re-proposes at the new price instead of silently charging
   * more than the user confirmed.
   */
  quotedCredits?: number | undefined;
  characterContext?: string | undefined;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  const { userId, project, userMessageId, message, intent } = options;
  if (intent.kind === "book_replan") {
    return queueChatBookReplanCopy({
      userId,
      project,
      userMessageId,
      message,
      intent,
      ...(options.executionCommandId ? { executionCommandId: options.executionCommandId } : {}),
      ...(options.quotedCredits !== undefined ? { quotedCredits: options.quotedCredits } : {}),
      ...(options.characterContext ? { characterContext: options.characterContext } : {})
    });
  }
  if (intent.kind === "continue_book") {
    return queueChatContinueBook({
      userId,
      project,
      userMessageId,
      message,
      intent,
      ...(options.executionCommandId ? { executionCommandId: options.executionCommandId } : {}),
      ...(options.quotedCredits !== undefined ? { quotedCredits: options.quotedCredits } : {}),
      ...(options.characterContext ? { characterContext: options.characterContext } : {})
    });
  }

  let affectedPageIndexes = await affectedPagesForIntent(intent, message, project);
  // Recomputed rather than read off the proposal: this is the number that gets
  // charged, so it has to be derived from the pages as they are now, and the
  // same scoping the quote used has to be applied or the two disagree.
  const patch =
    intent.kind === "local_patch" && affectedPageIndexes.length > 0
      ? await planExactReplacement(project.id, exactReplacementFromMessage(message), affectedPageIndexes)
      : null;
  // A proposal quoted at 0 was a verified find/replace — the user approved a
  // known diff at no charge, never a model rewrite. When the book changed and
  // the literal text is gone, settle the proposal as obsolete: falling through
  // would price it as a rewrite of pages nobody agreed to pay for.
  if (intent.kind === "local_patch" && options.quotedCredits === 0 && !patch) {
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      content: "That text no longer appears in the book, so there’s nothing to change. Nothing was changed or charged.",
      metadata: {
        intent,
        charged: false,
        pendingEditCancelled: true,
        ...(options.executionCommandId ? { proposalId: options.executionCommandId } : {})
      }
    });
    return { reply, operation: null };
  }
  if (affectedPageIndexes.length === 0) {
    // Only confirmed proposals reach this function, so a question here would
    // be the second one the one-question rule forbids — and it would arrive
    // *after* Apply. The book changed since the card: settle the proposal as
    // obsolete for free instead.
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      content:
        intent.kind === "chapter_regenerate"
          ? `I couldn’t find chapter ${intent.affectedChapterIndex ?? ""} in this book any more, so nothing was changed or charged.`.replace("  ", " ")
          : "I couldn’t find the pages that edit targeted any more, so nothing was changed or charged.",
      metadata: {
        intent,
        charged: false,
        pendingEditCancelled: true,
        ...(options.executionCommandId ? { proposalId: options.executionCommandId } : {})
      }
    });
    return { reply, operation: null };
  }

  if (patch) {
    affectedPageIndexes = patch.pageIndexes;
  }
  const cost = bookEditCreditCost(intent.kind, affectedPageIndexes.length, project, {
    deterministic: Boolean(patch)
  });
  if (options.quotedCredits !== undefined && cost > options.quotedCredits) {
    // The book changed between the quote and Apply and the edit now costs
    // more than the card showed. Never charge past the shown number — put a
    // fresh card up at the current price instead.
    return proposeBookEdit({
      project,
      userMessageId,
      message,
      intent,
      ...(options.characterContext ? { characterContext: options.characterContext } : {})
    });
  }
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
    const reply = await busyEditReply({
      projectId: project.id,
      parentMessageId: userMessageId,
      intent,
      request: message,
      ...("characterContext" in options && options.characterContext
        ? { characterContext: options.characterContext }
        : {})
    });
    return { reply, operation: null };
  }

  return queueAttemptChatOperation({
    userId,
    project,
    userMessageId,
    request: message,
    intent,
    operation,
    cost,
    billingOperation,
    description: `Mobile ${operationKind.toLowerCase().replaceAll("_", " ")} edit`,
    ...(options.characterContext ? { characterContext: options.characterContext } : {}),
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
          request: requestWithCharacterContext(message, options.characterContext),
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
  quotedCredits?: number | undefined;
  characterContext?: string | undefined;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  const { userId, project, userMessageId, message, intent } = options;
  const chapterCount = Math.min(8, Math.max(1, intent.continuation?.chapterCount ?? 1));
  const newPageCount = continuationNewPageCount(intent, project);
  const cost = bookEditCreditCost(intent.kind, newPageCount, project);
  if (options.quotedCredits !== undefined && cost > options.quotedCredits) {
    // Same contract as queueChatBookEdit: the shown quote is a ceiling, so a
    // book that grew since the card re-proposes at the current price.
    return proposeBookEdit({
      project,
      userMessageId,
      message,
      intent,
      ...(options.characterContext ? { characterContext: options.characterContext } : {})
    });
  }
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
    const reply = await busyEditReply({
      projectId: project.id,
      parentMessageId: userMessageId,
      intent,
      request: message,
      ...("characterContext" in options && options.characterContext
        ? { characterContext: options.characterContext }
        : {})
    });
    return { reply, operation: null };
  }

  return queueAttemptChatOperation({
    userId,
    project,
    userMessageId,
    request: message,
    intent,
    operation,
    cost,
    billingOperation: "PAGE_REGENERATION",
    description: "Mobile book continuation",
    ...(options.characterContext ? { characterContext: options.characterContext } : {}),
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
          request: requestWithCharacterContext(message, options.characterContext),
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

/**
 * Whether something is being done to the *book* right now.
 *
 * Every edit entry point asks this before it writes: manual saves and undo
 * answer 409 `PROJECT_BUSY`, and the chat deflects the request into the
 * project's one pending edit. So anything counted here is something the reader
 * is told to wait for.
 *
 * Detached jobs are not that. An export repair rebuilds a file that went
 * missing on a book that is already finished and already paid for, and merely
 * *looking* at a settled project queues one — every status read gates the
 * download surfaces on `export.available` and calls `ensureExportRepairQueued`
 * when the PDF or EPUB is gone. Counting it made opening the book the thing
 * that blocked editing it: the app drew a COMPLETE project with nothing in
 * flight, and every save came back "still being worked on" for as long as the
 * compile ran — then the next poll queued another repair, in a window the four
 * second saved-export refresh reopens indefinitely while a compile keeps
 * failing.
 *
 * Letting the edit through is safe because a repair owns nothing the edit
 * touches. It writes no project status (`ownsProjectStatus`), and it publishes
 * only by compare-and-setting the `contentRevision` it compiled — so once the
 * edit bumps that revision the repair stands down with its render on a scratch
 * name, and `maybeEnqueueCompile`'s revision-aware count already refuses to let
 * such a compile stand in for the edit's own recompile.
 *
 * The flag lives in the payload, and it cannot be negated in the `where`:
 * `NOT (payload->>flag = true)` in SQL is null for every row that never carried
 * the key, which is all of them but the repairs, so a real compile would be
 * filtered out along with the repairs. The exclusion is therefore made in
 * JavaScript, over the rows themselves, through the same
 * `isDetachedFromProjectLifecycle` predicate every other reader of these rows
 * uses — `queue.ts`, `projectSerializers.ts`, `generationProgress.ts`,
 * `generationRecovery.ts`.
 *
 * **One query, because the answer is about one moment.** This used to count the
 * open rows, then count the detached ones, and subtract. Under the connection's
 * actual isolation level — Read Committed — each statement takes its own
 * snapshot, so the two counts described two different instants and a repair that
 * crossed the gap broke the subtraction in both directions. A repair *queued*
 * between them was absent from the total and present in the subtrahend, so a
 * project with one real edit job open answered `1 > 1` — not busy — and let a
 * second edit through the guard. A repair that *completed* between them was
 * present in the total and gone from the subtrahend, so a settled book with
 * nothing but a repair in flight answered `1 > 0` — busy — and a manual save or
 * an undo got 409 `PROJECT_BUSY` for exactly the reason this exclusion exists.
 * A single `findMany` cannot be torn that way: one statement is one snapshot at
 * any isolation level, so every row is judged as of the same instant and no
 * transaction is needed to say so. It selects only `payload`, and the open rows
 * of one project are bounded by the fan-out waves that create them —
 * `countOpenCoverJobs` and `enqueueNextPageIfReady` in the worker read the same
 * rows the same way.
 *
 * What no snapshot can promise is that the answer is still true when the caller
 * acts on it, which is why this is only the fast path: the authoritative
 * one-open-edit-at-a-time guard is the partial unique index behind
 * `createOpenBookEditOperation`.
 */
export async function hasOpenProjectWork(projectId: string): Promise<boolean> {
  const openWork = {
    projectId,
    status: { in: ["QUEUED", "ACTIVE"] },
    type: { notIn: ["PREPARE_CHARACTER_CANDIDATES", "BUILD_CHARACTER_PERSONA", "RESEARCH"] }
  } satisfies Prisma.GenerationJobWhereInput;
  const openJobs = await prisma.generationJob.findMany({ where: openWork, select: { payload: true } });
  return openJobs.some((job) => !isDetachedFromProjectLifecycle(job.payload));
}

import { MODEL_PAGE_NUMBERING, numberingForProject, type ReaderPageNumbering } from "../bookPageNumbering.js";
import { pageInstructionsWithCharacterContext, requestWithCharacterContext } from "./bookEditCopy.js";
import { type BookEditIntent } from "../bookEditIntent.js";
import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import { createOpenBookEditOperation, replayClaimedChatOperation } from "./editOperationClaims.js";
import { classifyEditFailure } from "@book-maker/core/editFailure";
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
import { type PendingEditState, type StructuralCardPlan } from "./pendingEditState.js";
import { billingOperationForIntent, bookEditCreditCost, operationKindForIntent } from "./bookEditPricing.js";
import { planExactReplacement } from "./exactReplacementPreview.js";
import { type MobileBookEditOperationRecord, type MobileProjectChatMessageRecord } from "./dto.js";
import { settledStatusBeforeEdit } from "./editProjectStatus.js";
import { createAssistantChatMessage, insufficientCreditsChatMessage, type ProjectForChat } from "./projectChat.js";
import { type QueuedChatEdit } from "./chatEditOptions.js";
import { fingerprintGenerationRequest, jsonInputValue } from "./support.js";
import {
  bookPlanSchema,
  creditCostForOperation,
  isDetachedFromProjectLifecycle,
  PRE_EDIT_PROJECT_STATUS
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { randomUUID } from "node:crypto";
import {
  InsufficientCreditsError,
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
// The add_image queue branch lives beside this module for the same reason the
// direct plan revision does: this file is at its size budget, and the quota
// predicate is a seam of its own.
import { queueChatAddImage } from "./addImageOperations.js";
import { queueChatImageLayout } from "./imageLayoutOperations.js";
// The structural branch lives beside this module for the same reason the image
// ones do: it forks before the page resolver, and this file is at its budget.
import { queueChatRestructurePages } from "./restructurePageOperations.js";
// A book_replan forks a second project rather than editing this one, so its
// queue function lives next door too.
import { queueChatBookReplanCopy } from "./replanCopyOperations.js";

/**
 * The resume payload for a credits-blocked edit: the same pendingEdit +
 * editProposal pair `proposeBookEdit` writes, under a **fresh** proposalId.
 * The failed Apply's own id is spent — its USER row settled it and its FAILED
 * operation row holds the [projectId, requestId] claim forever — so only a
 * re-proposal turns "add credits, then start over" into an Apply that works.
 * The quoted credits ride along and stay the ceiling on the eventual charge.
 */
export function creditsBlockedResume(
  state: Omit<PendingEditState, "clarification" | "proposalId">,
  numbering: ReaderPageNumbering = MODEL_PAGE_NUMBERING
): { pendingEdit: Record<string, unknown>; editProposal?: Record<string, unknown> } {
  const resumable: PendingEditState = { ...state, clarification: "confirm", proposalId: randomUUID() };
  const card = editProposalCardFromState(resumable, numbering);
  return {
    pendingEdit: pendingEditMetadataFromState(resumable),
    ...(card ? { editProposal: card } : {})
  };
}

export async function queueAttemptChatOperation(options: {
  userId: string;
  project: ProjectForChat;
  userMessageId: string;
  /** The edit request as the reader typed it; resumes the edit if the charge is refused. */
  request: string;
  intent: BookEditIntent;
  operation: MobileBookEditOperationRecord;
  cost: number;
  billingOperation: "BOOK_TEXT_EDIT" | "PAGE_REGENERATION" | "BOOK_REPLAN" | "IMAGE_GENERATION";
  description: string;
  metadata: Record<string, unknown>;
  /** Free-tier illustrated-book slot to claim inside the attempt tx; null claims nothing. */
  imageQuotaLimit?: number | null | undefined;
  /** Rides the credits-blocked resume so a later Apply keeps the sheets. */
  characterContext?: string | undefined;
  /**
   * A structural edit's card numbers, for the same reason: the resume writes a
   * fresh card, and only the caller still has the resolved plan those come
   * from. Without them the re-proposal's chip has no pages to name.
   */
  structuralPlan?: StructuralCardPlan | undefined;
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
      imageQuotaLimit: options.imageQuotaLimit ?? null,
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
    const failure = classifyEditFailure(error, "start");
    if (failure.internal) {
      console.error(`Edit generation attempt could not start for edit operation ${options.operation.id}`, error);
    }
    await prisma.bookEditOperation.updateMany({
      where: { id: options.operation.id, generationJobId: null },
      data: { status: "FAILED", error: failure.message }
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
          ...(options.structuralPlan ? { structuralPlan: options.structuralPlan } : {}),
          ...(options.characterContext ? { characterContext: options.characterContext } : {})
        }, numberingForProject(options.project))
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
  // Folded in rather than re-read: `updated` predates the reply, so its anchor
  // would place the card above the reply announcing it — and a second read would
  // widen the window in which the worker flips this row to APPLIED.
  return { reply, operation: { ...updated, assistantMessageId: reply.id } as MobileBookEditOperationRecord };
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
    const failure = classifyEditFailure(error, "start");
    if (failure.internal) {
      console.error(`Plan revision attempt could not start for edit operation ${operation.id}`, error);
    }
    await prisma.bookEditOperation.updateMany({
      where: { id: operation.id, generationJobId: null },
      data: { status: "FAILED", error: failure.message }
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
        }, numberingForProject(project))
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
  // See `queueAttemptChatOperation`: `updated` predates this reply.
  return { reply, operation: { ...updated, assistantMessageId: reply.id } };
}

export async function queueChatBookEdit(options: QueuedChatEdit): Promise<{
  reply: MobileProjectChatMessageRecord;
  operation: MobileBookEditOperationRecord | null;
}> {
  const { userId, project, userMessageId, message, intent } = options;
  if (intent.kind === "book_replan") {
    return queueChatBookReplanCopy(options);
  }
  if (intent.kind === "continue_book") {
    return queueChatContinueBook(options);
  }
  if (intent.kind === "add_image") {
    return queueChatAddImage(options);
  }
  if (intent.kind === "move_image" || intent.kind === "remove_image") {
    return queueChatImageLayout(options);
  }
  if (intent.kind === "restructure_pages") {
    return queueChatRestructurePages(options);
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
  // Re-scoped against the pages that survived: a per-page instruction for a
  // page the edit no longer covers is applied by nothing, and the worker reads
  // this list by index.
  const perPageInstructions = (intent.perPageInstructions ?? []).filter((entry) =>
    affectedPageIndexes.includes(entry.pageIndex)
  );
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
          // The enqueue transaction takes the project out of this settled
          // state before the worker can read it. Every apply fork carries the
          // value it must restore if no compile accepts the handoff.
          [PRE_EDIT_PROJECT_STATUS]: settledStatusBeforeEdit(project.status),
          // Absent means what it has always meant: the whole request covers
          // every page. Present, it only narrows what a named page is told,
          // and a page with no entry still gets the request. The sheets are
          // composed onto each entry as well as onto `request`, because the
          // worker substitutes one for the other rather than adding to it.
          ...(perPageInstructions.length > 0
            ? { perPageInstructions: pageInstructionsWithCharacterContext(perPageInstructions, options.characterContext) }
            : {}),
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
    replyContent: operationQueuedMessage(intent.kind, affectedPageIndexes, intent, numberingForProject(project)),
    replyMetadata: { intent, charged: true, creditsCharged: cost }
  });
}

/**
 * Charges and queues a continuation: new chapters written in the book's own
 * voice and appended after the last page. Zero existing pages are affected —
 * the credited page count is the number of pages the continuation will add.
 */
export async function queueChatContinueBook(options: QueuedChatEdit): Promise<{
  reply: MobileProjectChatMessageRecord;
  operation: MobileBookEditOperationRecord | null;
}> {
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
          [PRE_EDIT_PROJECT_STATUS]: settledStatusBeforeEdit(project.status),
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
 * uses — `queue.ts`, `projectStatusSerializers.ts`, `generationProgress.ts`,
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

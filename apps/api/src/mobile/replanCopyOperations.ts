import { type BookEditIntent } from "../bookEditIntent.js";
import { requestWithCharacterContext } from "./bookEditCopy.js";
import { busyEditReply, proposeBookEdit } from "./bookEditIntents.js";
import { bookEditCreditCost } from "./bookEditPricing.js";
import { type MobileBookEditOperationRecord, type MobileProjectChatMessageRecord, type MobileProjectRecord } from "./dto.js";
import { createOpenBookEditOperation, replayClaimedChatOperation } from "./editOperationClaims.js";
import { queueAttemptChatOperation } from "./editOperations.js";
import { type ProjectForChat } from "./projectChat.js";
import { attachReplanCopyToCreationSession, createReplanProjectCopy } from "./projectRecords.js";
import { cleanTargetLanguage, jsonInputValue, languageDisplayName } from "./support.js";
import { enqueueGenerationJob } from "../queue.js";

/**
 * The one edit that does not touch the book it was asked about.
 *
 * A `book_replan` rebuilds the plan and regenerates the manuscript, which is
 * not something a finished book can survive in place — so it forks a second
 * `Project` row and works there, leaving the original exactly as the reader
 * left it. That is why this lives beside `editOperations.ts` rather than in it:
 * every other queue function in that file edits the project it was given.
 */

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

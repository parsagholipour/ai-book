import { type BookEditIntent } from "../bookEditIntent.js";
import { numberingForProject } from "../bookPageNumbering.js";
import { requestWithCharacterContext } from "./bookEditCopy.js";
import { busyEditReply, operationQueuedMessage, proposeBookEdit } from "./bookEditIntents.js";
import { bookEditCreditCost } from "./bookEditPricing.js";
import { type MobileBookEditOperationRecord, type MobileProjectChatMessageRecord } from "./dto.js";
import { settledStatusBeforeEdit } from "./editProjectStatus.js";
import { createOpenBookEditOperation, replayClaimedChatOperation } from "./editOperationClaims.js";
import { queueAttemptChatOperation } from "./editOperations.js";
import { createAssistantChatMessage, type ProjectForChat } from "./projectChat.js";
import { structuralCardPlanOf, structuralPagesOf, structuralRefusalMessage } from "./structuralPageEdits.js";
import { jsonInputValue } from "./support.js";
import { enqueueGenerationJob } from "../queue.js";
import { PRE_EDIT_PROJECT_STATUS, resolveStructuralPageEdit } from "@book-maker/core";

/**
 * Charging and queueing an insert, delete or reorder of pages.
 *
 * Forked out of `queueChatBookEdit` before `affectedPagesForIntent`, and that
 * placement is the whole point: that resolver filters against pages which
 * *currently exist*, so a structural edit reaching it comes back with an empty
 * set and is settled as "I couldn't find the pages that edit targeted any more"
 * — for pages it was about to create.
 */
export async function queueChatRestructurePages(options: {
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
  // **The stored edit is the confirmation, so an Apply without one has nothing
  // to execute.** `structuralEditFromMetadata` drops a stored edit it cannot
  // parse rather than half-reading it, on the stated grounds that the Apply
  // then proposes again — but this path read the missing field through
  // `structuralEditForProposal`, whose default belongs to the *proposal* side,
  // where nothing is charged and the card is one Cancel away. Read here it
  // turned a confirmed "Remove page 2" into a priced one-page append: below the
  // quote ceiling whenever the card quoted more than one page, so the reader
  // was charged for pages appended at the end of a book they asked to shorten.
  const edit = intent.structuralEdit;
  if (!edit) {
    return settleStructuralProposal({
      ...options,
      content:
        "I couldn’t tell what that page change was any more, so nothing was changed or charged. Tell me again what to add, remove or move and I’ll set it up."
    });
  }
  // Resolved again here rather than read off the card: this is the number that
  // gets charged, so it has to come from the book as it is now.
  const resolved = resolveStructuralPageEdit(edit, structuralPagesOf(project));
  if (!resolved.ok) {
    // The book moved between the card and the tap. Settle the proposal for
    // free — the same answer `queueChatBookEdit` gives when its pages are gone.
    return settleStructuralProposal({
      ...options,
      content: structuralRefusalMessage(resolved.reason, intent, numberingForProject(project))
    });
  }

  const cost = bookEditCreditCost(intent.kind, resolved.plan.pagesBilled, project);
  if (options.quotedCredits !== undefined && cost > options.quotedCredits) {
    // The shown quote is a ceiling. A book that grew since the card re-proposes
    // at the current price rather than charging past the number the reader saw.
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
    kind: "RESTRUCTURE_PAGES",
    status: "QUEUED",
    request: message,
    // The request rides the classifier as well as the payload, and `kind` below
    // is what routes the job to the fork that reads either: `applyBookEdit`
    // gates on the column rather than on the payload's `structuralEdit`, so a
    // delivery whose job data no longer carries the field reads it back from
    // here. The worker's stamp is written onto this same column.
    classifier: jsonInputValue({ ...intent, structuralEdit: edit }),
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
      ...(options.characterContext ? { characterContext: options.characterContext } : {})
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
    description: "Mobile page restructure",
    // A charge this book cannot afford re-proposes, and the fresh card is built
    // from state rather than from the book. These are the numbers that state
    // cannot recompute — without them the resume's chip names no pages at all.
    structuralPlan: structuralCardPlanOf(intent, resolved.plan),
    ...(options.characterContext ? { characterContext: options.characterContext } : {}),
    metadata: { intent, structuralEdit: edit, pagesBilled: resolved.plan.pagesBilled },
    enqueue: async (tx, { attemptId, ledgerEntry }) => {
      await tx.project.update({ where: { id: project.id }, data: { status: "EDITING" } });
      return enqueueGenerationJob({
        projectId: project.id,
        // The structural fork of apply-book-edit, not a job type of its own:
        // everything a new type would buy already covers APPLY_BOOK_EDIT.
        type: "APPLY_BOOK_EDIT",
        dedupeKey: `apply-book-edit:${project.id}:${operation.id}`,
        transaction: tx,
        dispatch: false,
        attemptId,
        payload: {
          operationId: operation.id,
          request: requestWithCharacterContext(message, options.characterContext),
          affectedPageIndexes: [],
          intentKind: intent.kind,
          structuralEdit: edit,
          // Stamped from the row this transaction is about to move: the worker
          // settles the book itself on a delivered no-op and on a recompile it
          // could not queue, and by then nothing on the project still says
          // whether the reader had quality findings open.
          [PRE_EDIT_PROJECT_STATUS]: settledStatusBeforeEdit(project.status),
          ...(project.currentPlanId ? { planId: project.currentPlanId } : {}),
          ...(ledgerEntry ? { billingLedgerEntryId: ledgerEntry.id } : {})
        }
      });
    },
    replyContent: operationQueuedMessage(intent.kind, [], intent, numberingForProject(project)),
    replyMetadata: { intent, charged: true, creditsCharged: cost }
  });
}

/**
 * A confirmed proposal that ends without a charge: no operation row, nothing
 * reserved, and `pendingEditCancelled` so the spent card cannot be tapped
 * again. Both free settlements answer through it — the book moved under the
 * card, and the card's own edit could not be read back — because the second
 * one is only safe while it settles the proposal as thoroughly as the first.
 */
async function settleStructuralProposal(options: {
  project: ProjectForChat;
  userMessageId: string;
  intent: BookEditIntent;
  executionCommandId?: string | undefined;
  content: string;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: null }> {
  const reply = await createAssistantChatMessage({
    projectId: options.project.id,
    parentId: options.userMessageId,
    content: options.content,
    metadata: {
      intent: options.intent,
      charged: false,
      pendingEditCancelled: true,
      ...(options.executionCommandId ? { proposalId: options.executionCommandId } : {})
    }
  });
  return { reply, operation: null };
}

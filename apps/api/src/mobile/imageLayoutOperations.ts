import { type BookEditIntent } from "../bookEditIntent.js";
import { resolveImageLayoutDest, type ImageLayoutEdit, type ImageLayoutTarget } from "../bookEditImage.js";
import { layoutTargetFromReplaceable } from "./addImageTargets.js";
import {
  layoutScopeMissReply,
  reresolveLayoutTargets,
  resolveLayoutTargetImages,
  type QueuedLayoutImage
} from "./imageLayoutTargets.js";
import { enqueueGenerationJob } from "../queue.js";
import { createOpenBookEditOperation, replayClaimedChatOperation } from "./editOperationClaims.js";
import { queueAttemptChatOperation, requestWithCharacterContext } from "./editOperations.js";
import {
  busyEditReply,
  editProposalMessage,
  editProposalSummary,
  operationQueuedMessage,
  pendingEditMetadataFromState,
  proposeBookEdit
} from "./bookEditIntents.js";
import { bookEditCreditCost, operationKindForIntent } from "./bookEditPricing.js";
import { type MobileBookEditOperationRecord, type MobileProjectChatMessageRecord } from "./dto.js";
import { chatPagesForProject, createAssistantChatMessage, type ProjectForChat } from "./projectChat.js";
import { jsonInputValue } from "./support.js";

/**
 * proposeBookEdit's move_image / remove_image branch. The pictures are resolved
 * the same way a replacement's one picture is — named page, else newest
 * chat-added, else first in reading order — widened by `selection` for a bulk
 * remove. Nothing is generated or charged; the card is the confirm, and for a
 * bulk remove the *count* on that card is the confirmation that matters.
 */
export async function proposeImageLayoutEdit(options: {
  project: ProjectForChat;
  userMessageId: string;
  message: string;
  intent: BookEditIntent;
  proposalId: string;
  characterContext?: string | undefined;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: null }> {
  const { project, userMessageId, message, intent, proposalId } = options;
  const action = intent.kind === "move_image" ? ("move" as const) : ("remove" as const);
  const layout = intent.imageLayout ?? { action };
  const { images, miss } = await resolveLayoutTargetImages({ project, layout });
  if (miss || images.length === 0) {
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      content: layoutScopeMissReply(miss ?? "no_images", action, layout.selection),
      metadata: { intent, charged: false, pendingEditCancelled: true }
    });
    return { reply, operation: null };
  }

  // A move is always about one picture: nobody asks to move seven pictures to
  // one place, and a card could not honestly summarise it if they did.
  const targets: ImageLayoutTarget[] = (action === "move" ? images.slice(0, 1) : images).map(layoutTargetFromReplaceable);
  const sourcePageIndex = targets[0]?.pageIndex;

  let dest: { destPageIndex: number; destPlacement: "end_of_book" | "page" } | undefined;
  if (action === "move") {
    const resolvedDest = resolveImageLayoutDest(layout, chatPagesForProject(project), sourcePageIndex);
    if (!resolvedDest) {
      const reply = await createAssistantChatMessage({
        projectId: project.id,
        parentId: userMessageId,
        content:
          layout.destPlacement === "page"
            ? "That page is no longer in this book, so there’s nowhere to move the picture. Nothing was changed or charged."
            : "This book has no pages to hold an illustration yet, so nothing was changed or charged.",
        metadata: { intent, charged: false, pendingEditCancelled: true }
      });
      return { reply, operation: null };
    }
    // A same-page move is a no-op only when no position was named — with one,
    // moving the picture within its own page is the whole request.
    if (resolvedDest.destPageIndex === sourcePageIndex && !layout.destPosition) {
      const reply = await createAssistantChatMessage({
        projectId: project.id,
        parentId: userMessageId,
        content: `That picture is already on page ${sourcePageIndex}, so nothing was changed or charged.`,
        metadata: { intent, charged: false, pendingEditCancelled: true }
      });
      return { reply, operation: null };
    }
    dest = resolvedDest;
  }

  const resolvedLayout = layoutWithResolution(layout, action, targets, dest);
  const affected = affectedPagesForLayout(targets, dest);
  const cost = bookEditCreditCost(intent.kind, affected.length, project);
  const proposalIntent: BookEditIntent = {
    ...intent,
    kind: action === "move" ? "move_image" : "remove_image",
    affectedPageIndexes: affected,
    scope: "explicit_pages",
    clarification: "none",
    imageLayout: resolvedLayout
  };
  const reply = await createAssistantChatMessage({
    projectId: project.id,
    parentId: userMessageId,
    content: editProposalMessage(proposalIntent.kind, affected, proposalIntent),
    metadata: {
      intent: proposalIntent,
      charged: false,
      pendingEdit: pendingEditMetadataFromState({
        request: message,
        scope: "explicit_pages",
        clarification: "confirm",
        intent: proposalIntent,
        affectedPageIndexes: affected,
        credits: cost,
        proposalId,
        ...(options.characterContext ? { characterContext: options.characterContext } : {})
      }),
      editProposal: {
        id: proposalId,
        kind: proposalIntent.kind,
        scope: "explicit_pages",
        affectedPageIndexes: affected,
        credits: cost,
        summary: editProposalSummary(proposalIntent.kind, affected, proposalIntent)
      }
    }
  });
  return { reply, operation: null };
}

export async function queueChatImageLayout(options: {
  userId: string;
  project: ProjectForChat;
  userMessageId: string;
  message: string;
  intent: BookEditIntent;
  executionCommandId?: string | undefined;
  characterContext?: string | undefined;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  const { userId, project, userMessageId, message, intent } = options;
  const action = intent.kind === "move_image" ? ("move" as const) : ("remove" as const);
  const layout = intent.imageLayout ?? { action };
  const reproposal = { project, userMessageId, message, intent, ...(options.characterContext ? { characterContext: options.characterContext } : {}) };

  // The card's own pictures, re-read one by one. Never the bulk query again:
  // Apply removes what the reader confirmed, not what the book holds now.
  const stored = layout.targets ?? [];
  const { live } = stored.length > 0
    ? await reresolveLayoutTargets(project.id, stored)
    : await resolveUnproposedTargets(project, layout, action);
  if (live.length === 0) {
    return proposeBookEdit(reproposal);
  }

  let dest: { destPageIndex: number; destPlacement: "end_of_book" | "page" } | undefined;
  if (action === "move") {
    const resolvedDest = resolveImageLayoutDest(layout, chatPagesForProject(project), live[0]?.pageIndex);
    if (!resolvedDest) {
      return proposeBookEdit(reproposal);
    }
    if (resolvedDest.destPageIndex === live[0]?.pageIndex && !layout.destPosition) {
      const reply = await createAssistantChatMessage({
        projectId: project.id,
        parentId: userMessageId,
        content: `That picture is already on page ${live[0]?.pageIndex}, so nothing was changed or charged.`,
        metadata: {
          intent,
          charged: false,
          pendingEditCancelled: true,
          ...(options.executionCommandId ? { proposalId: options.executionCommandId } : {})
        }
      });
      return { reply, operation: null };
    }
    dest = resolvedDest;
  }

  const targets = live.map((entry) => layoutTargetFromReplaceable(entry.image));
  const resolvedLayout = layoutWithResolution(layout, action, targets, dest);
  const affected = affectedPagesForLayout(targets, dest);
  const resolvedIntent: BookEditIntent = {
    ...intent,
    kind: action === "move" ? "move_image" : "remove_image",
    affectedPageIndexes: affected,
    scope: "explicit_pages",
    clarification: "none",
    imageLayout: resolvedLayout
  };
  const cost = bookEditCreditCost(resolvedIntent.kind, affected.length, project);
  const commandRequestId = options.executionCommandId ?? userMessageId;
  const operationKind = operationKindForIntent(resolvedIntent.kind);
  const operation = await createOpenBookEditOperation({
    projectId: project.id,
    requestId: commandRequestId,
    userMessageId,
    kind: operationKind,
    status: "QUEUED",
    request: message,
    classifier: jsonInputValue(resolvedIntent),
    affectedPageIndexes: affected,
    creditsCharged: 0
  });
  if (!operation) {
    const replay = await replayClaimedChatOperation({
      projectId: project.id,
      requestId: commandRequestId,
      parentMessageId: userMessageId,
      intent: resolvedIntent
    });
    if (replay) return replay;
    const reply = await busyEditReply({
      projectId: project.id,
      parentMessageId: userMessageId,
      intent: resolvedIntent,
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
    intent: resolvedIntent,
    operation,
    cost,
    billingOperation: "BOOK_TEXT_EDIT",
    description: `Mobile ${operationKind.toLowerCase().replaceAll("_", " ")} edit`,
    ...(options.characterContext ? { characterContext: options.characterContext } : {}),
    metadata: { intent: resolvedIntent, affectedPageIndexes: affected },
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
          affectedPageIndexes: affected,
          intentKind: resolvedIntent.kind,
          imageLayout: {
            action,
            sources: live.map((entry) => ({
              pageIndex: entry.pageIndex,
              ...(entry.kind === "markdown" ? { replaceMarker: entry.marker } : {}),
              ...(entry.kind === "asset" ? { replaceAssetId: entry.assetId } : {})
            })),
            ...(dest
              ? {
                  dest: {
                    placement: dest.destPlacement,
                    pageIndex: dest.destPageIndex,
                    ...(layout.destPosition ? { position: layout.destPosition } : {})
                  }
                }
              : {})
          },
          ...(project.currentPlanId ? { planId: project.currentPlanId } : {}),
          ...(ledgerEntry ? { billingLedgerEntryId: ledgerEntry.id } : {})
        }
      });
    },
    replyContent: operationQueuedMessage(resolvedIntent.kind, affected, resolvedIntent),
    replyMetadata: { intent: resolvedIntent, charged: true, creditsCharged: cost }
  });
}

/**
 * An Apply whose stored card carried no resolved pictures — a pendingEdit
 * written before bulk removal existed, or one whose targets all failed to
 * sanitize. Resolving from scratch is the honest fallback: the alternative is
 * telling the reader their confirmed edit found nothing.
 */
async function resolveUnproposedTargets(
  project: ProjectForChat,
  layout: ImageLayoutEdit,
  action: "move" | "remove"
): Promise<{ live: QueuedLayoutImage[] }> {
  const { images } = await resolveLayoutTargetImages({ project, layout });
  const chosen = action === "move" ? images.slice(0, 1) : images;
  const { live } = await reresolveLayoutTargets(project.id, chosen.map(layoutTargetFromReplaceable));
  return { live };
}

/** The layout blob as the card and the job both see it, with its pictures pinned. */
function layoutWithResolution(
  layout: ImageLayoutEdit,
  action: "move" | "remove",
  targets: ImageLayoutTarget[],
  dest: { destPageIndex: number; destPlacement: "end_of_book" | "page" } | undefined
): ImageLayoutEdit {
  return {
    action,
    ...(targets[0] ? { pageIndex: targets[0].pageIndex } : {}),
    ...(layout.selection ? { selection: layout.selection } : {}),
    targets,
    ...(dest
      ? {
          destPlacement: dest.destPlacement,
          ...(dest.destPlacement === "page" ? { destPageIndex: dest.destPageIndex } : {}),
          ...(layout.destPosition ? { destPosition: layout.destPosition } : {})
        }
      : {})
  };
}

/** Every page the edit writes: each picture's own, plus a move's destination. */
function affectedPagesForLayout(
  targets: ImageLayoutTarget[],
  dest: { destPageIndex: number } | undefined
): number[] {
  const pages = new Set(targets.map((target) => target.pageIndex));
  if (dest) {
    pages.add(dest.destPageIndex);
  }
  return [...pages].sort((a, b) => a - b);
}

import { type BookEditIntent } from "../bookEditIntent.js";
import { resolveImageLayoutDest, type ImageLayoutEdit } from "../bookEditImage.js";
import { layoutTargetFromReplaceable, resolveReplaceableImage } from "./addImageTargets.js";
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
import { prisma } from "@book-maker/db";

/**
 * proposeBookEdit's move_image / remove_image branch. The picture is resolved
 * the same way a replacement is — named page, else newest chat-added, else
 * first in reading order — and a move's destination is the named page or the
 * end of the book. Nothing is generated or charged; the card is the confirm.
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
  const targetImage = await resolveLiveLayoutImage(project.id, layout);
  if (!targetImage) {
    const verb = action === "move" ? "move" : "remove";
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      content: `I couldn’t find an illustration in this book to ${verb}. Nothing was changed or charged.`,
      metadata: { intent, charged: false, pendingEditCancelled: true }
    });
    return { reply, operation: null };
  }

  let dest: { destPageIndex: number; destPlacement: "end_of_book" | "page" } | undefined;
  if (action === "move") {
    const pages = chatPagesForProject(project);
    const resolvedDest = resolveImageLayoutDest(layout, pages);
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
    if (resolvedDest.destPageIndex === targetImage.pageIndex) {
      const reply = await createAssistantChatMessage({
        projectId: project.id,
        parentId: userMessageId,
        content: `That picture is already on page ${targetImage.pageIndex}, so nothing was changed or charged.`,
        metadata: { intent, charged: false, pendingEditCancelled: true }
      });
      return { reply, operation: null };
    }
    dest = resolvedDest;
  }

  const resolvedLayout: ImageLayoutEdit = {
    action,
    pageIndex: targetImage.pageIndex,
    target: layoutTargetFromReplaceable(targetImage),
    ...(dest
      ? {
          destPlacement: dest.destPlacement,
          ...(dest.destPlacement === "page" ? { destPageIndex: dest.destPageIndex } : {})
        }
      : {})
  };
  const affected =
    dest && dest.destPageIndex !== targetImage.pageIndex
      ? [targetImage.pageIndex, dest.destPageIndex]
      : [targetImage.pageIndex];
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
  quotedCredits?: number | undefined;
  characterContext?: string | undefined;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  const { userId, project, userMessageId, message, intent } = options;
  const action = intent.kind === "move_image" ? ("move" as const) : ("remove" as const);
  const layout = intent.imageLayout ?? { action };
  const live = await resolveQueuedLayoutImage(project.id, layout);
  if (!live) {
    return proposeBookEdit({
      project,
      userMessageId,
      message,
      intent,
      ...(options.characterContext ? { characterContext: options.characterContext } : {})
    });
  }

  let dest: { destPageIndex: number; destPlacement: "end_of_book" | "page" } | undefined;
  if (action === "move") {
    const resolvedDest = resolveImageLayoutDest(layout, chatPagesForProject(project));
    if (!resolvedDest) {
      return proposeBookEdit({
        project,
        userMessageId,
        message,
        intent,
        ...(options.characterContext ? { characterContext: options.characterContext } : {})
      });
    }
    if (resolvedDest.destPageIndex === live.pageIndex) {
      const reply = await createAssistantChatMessage({
        projectId: project.id,
        parentId: userMessageId,
        content: `That picture is already on page ${live.pageIndex}, so nothing was changed or charged.`,
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

  const resolvedLayout: ImageLayoutEdit = {
    action,
    pageIndex: live.pageIndex,
    target: layout.target ?? layoutTargetFromReplaceable(live.image),
    ...(dest
      ? {
          destPlacement: dest.destPlacement,
          ...(dest.destPlacement === "page" ? { destPageIndex: dest.destPageIndex } : {})
        }
      : {})
  };
  const affected =
    dest && dest.destPageIndex !== live.pageIndex
      ? [live.pageIndex, dest.destPageIndex]
      : [live.pageIndex];
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

  const replaceMarker = live.kind === "markdown" ? live.marker : undefined;
  const replaceAssetId = live.kind === "asset" ? live.assetId : undefined;
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
            source: {
              pageIndex: live.pageIndex,
              ...(replaceMarker ? { replaceMarker } : {}),
              ...(replaceAssetId ? { replaceAssetId } : {})
            },
            ...(dest ? { dest: { placement: dest.destPlacement, pageIndex: dest.destPageIndex } } : {})
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

async function resolveLiveLayoutImage(projectId: string, layout: ImageLayoutEdit) {
  if (layout.target) {
    const queued = await resolveQueuedLayoutImage(projectId, layout);
    return queued?.image ?? null;
  }
  return resolveReplaceableImage(projectId, layout.pageIndex);
}

type QueuedLayoutImage = {
  pageIndex: number;
  image: NonNullable<Awaited<ReturnType<typeof resolveReplaceableImage>>>;
} & (
  | { kind: "asset"; assetId: string; marker?: undefined }
  | { kind: "markdown"; marker: string; assetId?: undefined }
);

async function resolveQueuedLayoutImage(
  projectId: string,
  layout: ImageLayoutEdit
): Promise<QueuedLayoutImage | null> {
  const target = layout.target;
  if (target?.assetId) {
    const asset = await prisma.imageAsset.findFirst({
      where: {
        id: target.assetId,
        projectId,
        type: { in: ["SCENE_ILLUSTRATION", "DIAGRAM"] }
      },
      select: { id: true, page: { select: { index: true } } }
    });
    if (!asset?.page) {
      return null;
    }
    return {
      kind: "asset",
      assetId: asset.id,
      pageIndex: asset.page.index,
      image: {
        kind: "asset",
        assetId: asset.id,
        pageIndex: asset.page.index,
        ...(target.oldSubject ? { oldSubject: target.oldSubject } : {})
      }
    };
  }
  const marker = target?.marker
    ? target.marker
    : target?.operationId
      ? `chat-image-${target.operationId}`
      : undefined;
  if (marker) {
    const page = await prisma.page.findFirst({
      where: { projectId, markdown: { contains: marker } },
      select: { index: true }
    });
    if (!page) {
      return null;
    }
    return {
      kind: "markdown",
      marker,
      pageIndex: page.index,
      image: {
        kind: "markdown",
        marker,
        operationId: target?.operationId ?? "",
        pageIndex: page.index,
        ...(target?.oldSubject ? { oldSubject: target.oldSubject } : {})
      }
    };
  }
  const resolved = await resolveReplaceableImage(projectId, layout.pageIndex);
  if (!resolved) {
    return null;
  }
  if (resolved.kind === "asset") {
    return { kind: "asset", assetId: resolved.assetId, pageIndex: resolved.pageIndex, image: resolved };
  }
  return { kind: "markdown", marker: resolved.marker, pageIndex: resolved.pageIndex, image: resolved };
}

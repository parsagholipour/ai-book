import { type BookEditIntent } from "../bookEditIntent.js";
import { resolveImageInsertionTarget, type ImageInsertionEdit } from "../bookEditImage.js";
import { replaceEditFromTarget, resolveReplaceableImage } from "./addImageTargets.js";
import { enqueueGenerationJob } from "../queue.js";
import { createOpenBookEditOperation, replayClaimedChatOperation } from "./editOperationClaims.js";
import {
  creditsBlockedResume,
  queueAttemptChatOperation,
  requestWithCharacterContext
} from "./editOperations.js";
import {
  busyEditReply,
  editProposalMessage,
  editProposalSummary,
  operationQueuedMessage,
  pendingEditMetadataFromState,
  proposeBookEdit
} from "./bookEditIntents.js";
import { bookEditCreditCost } from "./bookEditPricing.js";
import { type MobileBookEditOperationRecord, type MobileProjectChatMessageRecord } from "./dto.js";
import {
  chatPagesForProject,
  createAssistantChatMessage,
  imageLimitChatMessage,
  type ProjectForChat
} from "./projectChat.js";
import { jsonInputValue } from "./support.js";
import { imageMarkdownRe, resolveBookImageAsset } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { GenerationQuotaExceededError, getImageQuota } from "@book-maker/db/billing";

/**
 * The Apply side of a chat-requested illustration ("add a photo of X at the
 * end of the book"): re-resolve the target, re-price, claim the free-tier
 * illustrated-book slot only when this edit is what makes the book
 * illustrated, and queue the APPLY_BOOK_EDIT job carrying `imageInsertion`.
 * A sibling of editOperations.ts for the same reason planRevisionOperations.ts
 * is — that file is at its size budget, and the quota policy is a seam of its
 * own.
 */

/**
 * The free-tier slot to claim for this image edit, or null to claim nothing.
 *
 * The limit counts illustrated *books* per month, and only the edit that turns
 * a text-only book illustrated may claim one:
 *   - a zero-priced image writes no ledger entry, so a claim would have no
 *     `metadata.imageQuota` to ride the refund funnel — a failure would leak
 *     the slot for the rest of the month;
 *   - paid tiers have no limit (`getImageQuota` returns null);
 *   - an already-illustrated book consumed its slot at plan approval, so a
 *     second claim would double-count it.
 */
export async function addImageQuotaLimit(userId: string, projectId: string, cost: number): Promise<number | null> {
  if (cost <= 0) {
    return null;
  }
  const quota = await getImageQuota(userId);
  if (!quota) {
    return null;
  }
  return (await projectAlreadyIllustrated(projectId)) ? null : quota.limit;
}

/**
 * Whether the book already holds (or was already billed as holding) interior
 * illustrations. Four cheap checks, any of which settles it:
 * interior ImageAsset rows; an inline image ref in any page's markdown; a page
 * whose illustration failed to render (that book's slot was consumed at
 * approval); or a prior applied ADD_IMAGE edit (covers add → undo → add).
 */
async function projectAlreadyIllustrated(projectId: string): Promise<boolean> {
  const interiorAsset = await prisma.imageAsset.findFirst({
    where: { projectId, type: { in: ["SCENE_ILLUSTRATION", "DIAGRAM"] } },
    select: { id: true }
  });
  if (interiorAsset) {
    return true;
  }
  const failedIllustration = await prisma.page.findFirst({
    where: { projectId, imageFailureReason: { not: null } },
    select: { id: true }
  });
  if (failedIllustration) {
    return true;
  }
  const priorAddImage = await prisma.bookEditOperation.findFirst({
    where: { projectId, kind: "ADD_IMAGE", status: "APPLIED" },
    select: { id: true }
  });
  if (priorAddImage) {
    return true;
  }
  // SQL LIKE prefilter, then the exporters' own regex and resolver: a page
  // that merely mentions the path in prose is not an illustrated page, and an
  // image ref must be scoped to THIS project — resolveBookImageAsset demands
  // exactly `/assets/images/<projectId>/<filename>` after decoding (`%2F..%2F`
  // is a separator), so a pasted ref under another project's id no longer
  // marks this book illustrated. The root passed is synthetic: only the shape
  // verdict matters here, nothing touches the filesystem.
  // Residual, accepted: a pasted ref that is correctly scoped to this project
  // still counts without checking the file exists — the same blind spot the
  // approve door's estimate has.
  const candidates = await prisma.page.findMany({
    where: { projectId, markdown: { contains: "/assets/images/" } },
    select: { markdown: true },
    take: 50
  });
  return candidates.some((page) => {
    const re = imageMarkdownRe();
    for (let match = re.exec(page.markdown); match; match = re.exec(page.markdown)) {
      const resolved = resolveBookImageAsset(match[2] ?? "", {
        imageStorageDir: "/image-store",
        publicApiBase: "",
        projectId
      });
      if (resolved) {
        return true;
      }
    }
    return false;
  });
}

/**
 * proposeBookEdit's add_image branch. The target is resolved from the
 * placement (or the subject-anchored default), and the card names the page —
 * placement never clarifies, because a wrong guess is one Cancel away. The
 * ceiling and vanished-page re-propose paths flow back through here, so the
 * imageEdit fields survive re-proposal. A replacement request resolves to the
 * live illustration it swaps out — built-in or chat-added — or, with nothing
 * to swap, answers rather than proposing.
 */
export async function proposeAddImageEdit(options: {
  project: ProjectForChat;
  userMessageId: string;
  message: string;
  intent: BookEditIntent;
  proposalId: string;
  characterContext?: string | undefined;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: null }> {
  const { project, userMessageId, message, intent, proposalId } = options;
  const imageEdit = intent.imageEdit ?? { subject: "a scene from this book" };
  const pages = chatPagesForProject(project);
  let replace: NonNullable<ImageInsertionEdit["replace"]> | undefined;
  let resolved: { targetPageIndex: number; placement: "end_of_book" | "page" } | null;
  if (imageEdit.replace) {
    // A replacement keeps the old picture's spot: the target IS the page
    // holding that illustration, never the subject-anchored default.
    const target = await resolveReplaceableImage(project.id, imageEdit.pageIndex);
    if (!target) {
      const reply = await createAssistantChatMessage({
        projectId: project.id,
        parentId: userMessageId,
        content:
          "I couldn’t find an illustration in this book to replace. Say “add a photo of …” and I’ll add a new picture instead.",
        metadata: { intent, charged: false, pendingEditCancelled: true }
      });
      return { reply, operation: null };
    }
    replace = replaceEditFromTarget(target);
    resolved = { targetPageIndex: target.pageIndex, placement: "page" };
  } else {
    resolved =
      resolveImageInsertionTarget(imageEdit, pages) ??
      // An explicit page that is not in the book falls back to the default
      // resolution rather than a question.
      resolveImageInsertionTarget({ subject: imageEdit.subject }, pages);
  }
  if (!resolved) {
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      content: "This book has no pages to hold an illustration yet, so nothing was changed or charged.",
      metadata: { intent, charged: false, pendingEditCancelled: true }
    });
    return { reply, operation: null };
  }
  const resolvedEdit: ImageInsertionEdit = {
    subject: imageEdit.subject,
    placement: resolved.placement,
    ...(resolved.placement === "page" ? { pageIndex: resolved.targetPageIndex } : {}),
    ...(replace ? { replace } : {})
  };
  const affected = [resolved.targetPageIndex];
  const cost = bookEditCreditCost(intent.kind, 1, project);
  const proposalIntent: BookEditIntent = {
    ...intent,
    affectedPageIndexes: affected,
    scope: "explicit_pages",
    clarification: "none",
    imageEdit: resolvedEdit
  };
  const reply = await createAssistantChatMessage({
    projectId: project.id,
    parentId: userMessageId,
    content: editProposalMessage(intent.kind, affected, proposalIntent),
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
        kind: intent.kind,
        scope: "explicit_pages",
        affectedPageIndexes: affected,
        credits: cost,
        summary: editProposalSummary(intent.kind, affected, proposalIntent)
      }
    }
  });
  return { reply, operation: null };
}

export async function queueChatAddImage(options: {
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
  const imageEdit = intent.imageEdit ?? { subject: "a scene from this book" };
  // Re-resolved from the live book, never read off the card: an edit or an
  // undo can move pages between the quote and Apply. A replacement re-checks
  // the card's own target — the marker the user approved swapping, not
  // whatever is newest now — and re-proposes when it vanished (undone, or
  // deleted in Edit Mode) rather than silently appending.
  let resolved: { targetPageIndex: number; placement: "end_of_book" | "page" } | null;
  let replaceMarker: string | undefined;
  let replaceAssetId: string | undefined;
  if (imageEdit.replace?.assetId) {
    const asset = await prisma.imageAsset.findFirst({
      where: {
        id: imageEdit.replace.assetId,
        projectId: project.id,
        type: { in: ["SCENE_ILLUSTRATION", "DIAGRAM"] }
      },
      select: { id: true, page: { select: { index: true } } }
    });
    resolved = asset?.page ? { targetPageIndex: asset.page.index, placement: "page" } : null;
    replaceAssetId = asset?.page ? asset.id : undefined;
  } else if (imageEdit.replace) {
    const marker = imageEdit.replace.marker
      ? imageEdit.replace.marker
      : imageEdit.replace.operationId
        ? `chat-image-${imageEdit.replace.operationId}`
        : undefined;
    const markerPage = marker
      ? await prisma.page.findFirst({
          where: { projectId: project.id, markdown: { contains: marker } },
          select: { index: true }
        })
      : null;
    resolved = markerPage ? { targetPageIndex: markerPage.index, placement: "page" } : null;
    replaceMarker = markerPage && marker ? marker : undefined;
  } else {
    resolved = resolveImageInsertionTarget(imageEdit, chatPagesForProject(project));
  }
  if (!resolved) {
    // The explicit page (or the image being replaced) vanished, or the book
    // lost its pages: put a fresh, re-resolved card up rather than inserting
    // somewhere the user never named.
    return proposeBookEdit({
      project,
      userMessageId,
      message,
      intent,
      ...(options.characterContext ? { characterContext: options.characterContext } : {})
    });
  }
  const cost = bookEditCreditCost("add_image", 1, project);
  if (options.quotedCredits !== undefined && cost > options.quotedCredits) {
    // Same ceiling as every charged kind: never charge past the shown number.
    return proposeBookEdit({
      project,
      userMessageId,
      message,
      intent,
      ...(options.characterContext ? { characterContext: options.characterContext } : {})
    });
  }
  const target = resolved.targetPageIndex;
  const resolvedEdit: ImageInsertionEdit = {
    subject: imageEdit.subject,
    placement: resolved.placement,
    ...(resolved.placement === "page" ? { pageIndex: target } : {}),
    ...(imageEdit.replace ? { replace: imageEdit.replace } : {})
  };
  const resolvedIntent: BookEditIntent = {
    ...intent,
    affectedPageIndexes: [target],
    scope: "explicit_pages",
    clarification: "none",
    imageEdit: resolvedEdit
  };
  // A replacement never claims a free-tier slot: the book was illustrated by
  // the image being swapped out (the predicate would say so anyway — this is
  // the explicit statement of intent).
  const imageQuotaLimit = replaceMarker || replaceAssetId ? null : await addImageQuotaLimit(userId, project.id, cost);
  const commandRequestId = options.executionCommandId ?? userMessageId;
  const operation = await createOpenBookEditOperation({
    projectId: project.id,
    requestId: commandRequestId,
    userMessageId,
    kind: "ADD_IMAGE",
    status: "QUEUED",
    request: message,
    classifier: jsonInputValue(resolvedIntent),
    affectedPageIndexes: [target],
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

  try {
    return await queueAttemptChatOperation({
      userId,
      project,
      userMessageId,
      request: message,
      intent: resolvedIntent,
      operation,
      cost,
      billingOperation: "IMAGE_GENERATION",
      description: "Mobile add image edit",
      imageQuotaLimit,
      ...(options.characterContext ? { characterContext: options.characterContext } : {}),
      metadata: { intent: resolvedIntent, affectedPageIndexes: [target] },
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
            affectedPageIndexes: [target],
            intentKind: "add_image",
            imageInsertion: {
              subject: resolvedEdit.subject,
              placement: resolved.placement,
              targetPageIndex: target,
              ...(replaceMarker ? { replaceMarker } : {}),
              ...(replaceAssetId ? { replaceAssetId } : {})
            },
            ...(project.currentPlanId ? { planId: project.currentPlanId } : {}),
            ...(ledgerEntry ? { billingLedgerEntryId: ledgerEntry.id } : {})
          }
        });
      },
      replyContent: operationQueuedMessage("add_image", [target], resolvedIntent),
      replyMetadata: { intent: resolvedIntent, charged: true, creditsCharged: cost }
    });
  } catch (error) {
    if (!(error instanceof GenerationQuotaExceededError)) {
      throw error;
    }
    // The attempt transaction rolled everything back and queueAttemptChatOperation
    // already failed the operation row — which spent this proposalId's
    // [projectId, requestId] claim forever. The resume pair below rides a
    // FRESH proposalId, so after an upgrade (or next month) its Apply works
    // instead of answering "already being handled".
    const reply = await imageLimitChatMessage(
      project.id,
      userMessageId,
      resolvedIntent,
      error.claim,
      creditsBlockedResume({
        request: message,
        scope: resolvedIntent.scope,
        intent: resolvedIntent,
        affectedPageIndexes: [target],
        credits: cost,
        ...(options.characterContext ? { characterContext: options.characterContext } : {})
      })
    );
    return { reply, operation: null };
  }
}

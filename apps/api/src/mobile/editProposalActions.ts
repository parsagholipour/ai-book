import { type FastifyReply } from "fastify";
import { numberingForProject } from "../bookPageNumbering.js";
import { busyEditReply, handleProjectChatIntent } from "./bookEditIntents.js";
import { operationKindForIntent } from "./bookEditPricing.js";
import { type MobileProjectChatMessageRecord, type MobileProjectChatMessageResponseDto } from "./dto.js";
import { createOpenBookEditOperation, hasOpenProjectWork } from "./editOperations.js";
import { sendMobileError, sendProjectNotFound } from "./httpErrors.js";
import { findPendingProposalById } from "./pendingEditState.js";
import {
  activeProjectChatLeafId,
  createAssistantChatMessage,
  createUserProjectChatMessage,
  loadActiveProjectChatMessages,
  loadProjectChatResponse,
  loadProjectForChat,
  replayProjectChatRequest,
  serializeBookEditOperation,
  serializeProjectChatMessage
} from "./projectChat.js";
import { replayClaimedProposal } from "./proposalExecutionClaims.js";
import { isPrismaUniqueConflict, jsonInputValue } from "./support.js";
import type { TextModelAdapter } from "@book-maker/core";

/**
 * The Apply and Cancel buttons on a priced edit card. Split out of
 * `bookEditIntents.ts`, which proposes the card and runs the confirmed edit;
 * this module only claims the proposal and hands the Apply back to it.
 */
export async function applyOrCancelEditProposal(options: {
  reply: FastifyReply;
  userId: string;
  projectId: string;
  proposalId: string;
  requestId?: string | undefined;
  action: "apply" | "cancel";
  textModel?: TextModelAdapter | undefined;
}): Promise<MobileProjectChatMessageResponseDto | void> {
  const { reply, userId, projectId, proposalId, requestId, action, textModel } = options;
  // Ownership before replay, matching the messages route: a replay answers
  // with the project's whole chat response, so replaying for a caller who does
  // not own the project would hand them another reader's transcript.
  const project = await loadProjectForChat(userId, projectId);
  if (!project) {
    return sendProjectNotFound(reply);
  }
  if (requestId) {
    const replay = await replayProjectChatRequest(projectId, requestId);
    if (replay) {
      return replay;
    }
  }

  if (action === "apply") {
    const claimed = await replayClaimedProposal(projectId, proposalId);
    if (claimed) return claimed;
  }

  // Loaded once for both the proposal lookup and the leaf resolution below.
  const activeMessages = await loadActiveProjectChatMessages(projectId);
  const pending = findPendingProposalById(activeMessages, proposalId);
  if (!pending?.intent || pending.clarification !== "confirm") {
    return sendMobileError(reply, 404, "PROPOSAL_NOT_FOUND", "That edit proposal is no longer available.");
  }
  let userMessage: MobileProjectChatMessageRecord;
  try {
    userMessage = await createUserProjectChatMessage({
      projectId,
      parentId: activeProjectChatLeafId(activeMessages),
      content: action === "apply" ? "Apply" : "Cancel",
      requestId,
      metadata: { proposalAction: action, proposalId }
    });
  } catch (error) {
    if (requestId && isPrismaUniqueConflict(error)) {
      const replay = await replayProjectChatRequest(projectId, requestId);
      if (replay) {
        return replay;
      }
      // The user row exists but its reply does not yet: the same requestId is
      // still being processed. A retry with the same id replays it once the
      // first request finishes — a conflict, not a server failure.
      return sendMobileError(reply, 409, "REQUEST_IN_PROGRESS", "That request is still being processed. Try again in a moment.");
    }
    throw error;
  }

  if (action === "cancel") {
    // Cancelling claims the proposal id durably, through the same unique
    // [projectId, requestId] index Apply's operation insert uses. Whichever
    // settlement lands first owns the proposal; a Cancel that only wrote chat
    // messages could "succeed" while a concurrent Apply charged anyway.
    const cancelClaim = await createOpenBookEditOperation({
      projectId,
      requestId: proposalId,
      userMessageId: userMessage.id,
      kind: operationKindForIntent(pending.intent.kind),
      status: "CANCELED",
      request: pending.request,
      editInstruction: pending.intent.editInstruction?.trim() || pending.request,
      classifier: jsonInputValue({ ...pending.intent, cancelledProposal: true }),
      affectedPageIndexes: [],
      creditsCharged: 0
    });
    if (!cancelClaim) {
      // Apply won the settlement: hand back the executed operation instead of
      // pretending the proposal was dropped.
      const claimed = await replayClaimedProposal(projectId, proposalId);
      if (claimed) return claimed;
    }
    const replyMessage = await createAssistantChatMessage({
      projectId,
      parentId: userMessage.id,
      ...(cancelClaim ? { operationId: cancelClaim.id } : {}),
      content: "Okay, I dropped that request. No edit was applied.",
      metadata: { pendingEditCancelled: true, charged: false, proposalId }
    });
    return {
      ...(await loadProjectChatResponse(projectId)),
      reply: serializeProjectChatMessage(replyMessage),
      operation: null
    } satisfies MobileProjectChatMessageResponseDto;
  }

  const openEditBlocked = await hasOpenProjectWork(projectId);
  if (openEditBlocked) {
    // The busyness may be the winner itself: a concurrent Apply that committed
    // its operation and job after our claim check above. Saving the request as
    // a pending edit here would let a later confirmation rebuild the proposal
    // and charge the same edit twice — replay the claim instead.
    const claimed = await replayClaimedProposal(projectId, proposalId);
    if (claimed) return claimed;
    const replyMessage = await busyEditReply({
      projectId,
      parentMessageId: userMessage.id,
      intent: pending.intent,
      request: pending.request,
      pendingState: pending
    });
    return {
      ...(await loadProjectChatResponse(projectId)),
      reply: serializeProjectChatMessage(replyMessage),
      operation: null
    } satisfies MobileProjectChatMessageResponseDto;
  }

  const outcome = await handleProjectChatIntent({
    userId,
    project,
    userMessageId: userMessage.id,
    message: pending.request,
    intent: pending.intent,
    textModel,
    executeProposal: true,
    executionCommandId: proposalId,
    ...(pending.credits !== undefined ? { quotedCredits: pending.credits } : {}),
    ...(pending.characterContext ? { characterContext: pending.characterContext } : {})
  });

  return {
    ...(await loadProjectChatResponse(projectId)),
    reply: serializeProjectChatMessage(outcome.reply),
    operation: outcome.operation
      ? serializeBookEditOperation(outcome.operation, { pageNumbering: numberingForProject(project) })
      : null
  } satisfies MobileProjectChatMessageResponseDto;
}

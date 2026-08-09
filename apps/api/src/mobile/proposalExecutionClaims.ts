import { type MobileProjectChatMessageResponseDto } from "./dto.js";
import {
  activeProjectChatLeafId,
  createAssistantChatMessage,
  loadActiveProjectChatMessages,
  loadProjectChatResponse,
  serializeBookEditOperation,
  serializeProjectChatMessage
} from "./projectChat.js";
import { prisma } from "@book-maker/db";

/**
 * Proposal IDs are permanent execution claims, not just transient card IDs.
 * A delayed button/typed-confirmation loser therefore returns the operation
 * that won instead of re-executing it or pretending the proposal disappeared.
 */
export async function replayClaimedProposal(
  projectId: string,
  proposalId: string
): Promise<MobileProjectChatMessageResponseDto | null> {
  const operation = await prisma.bookEditOperation.findFirst({
    where: { projectId, requestId: proposalId },
    include: { generationJob: { select: { id: true, status: true } } }
  });
  if (!operation) return null;

  const existingReply = await prisma.projectChatMessage.findFirst({
    where: { projectId, operationId: operation.id, role: "ASSISTANT" },
    orderBy: { createdAt: "desc" }
  });
  const replyMessage =
    existingReply ??
    (await createAssistantChatMessage({
      projectId,
      parentId: activeProjectChatLeafId(await loadActiveProjectChatMessages(projectId))!,
      operationId: operation.id,
      // A cancel settlement also claims the proposal id; replaying it must
      // read as the cancellation it was, not as running work.
      content:
        operation.status === "CANCELED"
          ? "That request was cancelled before it ran. Nothing was changed or charged."
          : "This edit request is already being handled.",
      metadata: { replayedOperation: true, charged: false, proposalId }
    }));
  return {
    ...(await loadProjectChatResponse(projectId)),
    reply: serializeProjectChatMessage(replyMessage),
    operation: serializeBookEditOperation(operation)
  };
}

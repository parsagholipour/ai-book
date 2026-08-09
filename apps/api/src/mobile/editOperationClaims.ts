import { type BookEditIntent } from "../bookEditIntent.js";
import { type MobileBookEditOperationRecord, type MobileProjectChatMessageRecord } from "./dto.js";
import { createAssistantChatMessage } from "./projectChat.js";
import { isPrismaUniqueConflict } from "./support.js";
import { Prisma, prisma } from "@book-maker/db";

/**
 * The durable claim under every chat edit: one BookEditOperation row per
 * command, held by production's unique [projectId, requestId] index and the
 * one-open-per-project partial index. Whoever inserts first owns the command;
 * everyone else replays the winner.
 */

/**
 * A claim this old with no generation job behind it is a crash artifact: the
 * process died between inserting the operation row and committing its paid
 * attempt (which is what stamps `generationJobId`). The attempt transaction
 * itself takes seconds.
 */
const ABANDONED_EDIT_CLAIM_MS = 10 * 60_000;

/**
 * Creates the QUEUED operation row for a chat edit, or null when the partial
 * unique index ("BookEditOperation_one_open_per_project", migration 000026)
 * reports another open operation won the race. hasOpenProjectWork() is only a
 * fast-path check; this is the authoritative one-open-edit-at-a-time guard.
 */
export async function createOpenBookEditOperation(
  data: Prisma.BookEditOperationUncheckedCreateInput,
  options: { retried?: boolean } = {}
): Promise<MobileBookEditOperationRecord | null> {
  try {
    return await prisma.bookEditOperation.create({ data });
  } catch (error) {
    if (!isPrismaUniqueConflict(error)) {
      throw error;
    }
    if (options.retried) {
      return null;
    }
    // An abandoned jobless claim would otherwise hold the one-open-edit slot
    // forever, dead-ending every future edit on this project. Expire it and
    // take the slot; a live claim is younger than the cutoff and stays.
    const expired = await prisma.bookEditOperation
      .updateMany({
        where: {
          projectId: data.projectId,
          status: "QUEUED",
          generationJobId: null,
          createdAt: { lt: new Date(Date.now() - ABANDONED_EDIT_CLAIM_MS) }
        },
        data: { status: "FAILED", error: "Abandoned before its generation job was created." }
      })
      .catch(() => ({ count: 0 }));
    if (expired.count === 0) {
      return null;
    }
    return createOpenBookEditOperation(data, { retried: true });
  }
}

export async function replayClaimedChatOperation(options: {
  projectId: string;
  requestId: string;
  parentMessageId: string;
  intent: BookEditIntent;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null } | null> {
  const operation = await prisma.bookEditOperation.findFirst({
    where: { projectId: options.projectId, requestId: options.requestId },
    include: { generationJob: { select: { id: true, status: true } } }
  });
  if (!operation) {
    return null;
  }
  const reply = await createAssistantChatMessage({
    projectId: options.projectId,
    parentId: options.parentMessageId,
    operationId: operation.id,
    content:
      operation.status === "CANCELED"
        ? "That request was cancelled before it ran. Nothing was changed or charged."
        : "This edit request is already being handled.",
    metadata: {
      intent: options.intent,
      charged: false,
      replayedOperation: true,
      creditsCharged: operation.creditsCharged
    }
  });
  return { reply, operation: operation as MobileBookEditOperationRecord };
}

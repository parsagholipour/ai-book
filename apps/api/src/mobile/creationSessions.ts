import { linearizeCreationMessages, normalizeCreationMessageIds } from "../creationChatTree.js";
import { normalizeCreationQuestion } from "../creationQuestion.js";
import {
  deterministicCreationTurn,
  greetingCreationTurn,
  mobileBookAdvisorResponseSchema,
  mobileCreationDraftPayloadSchema,
  mobileCreationTurnSchema,
  type MobileCreationDraftPayload,
  type MobileCreationMessage,
  type MobileCreationTurn,
  type MobileCreationTurnRequest
} from "../mobileCreation.js";
import {
  type MobileCreationAttachmentDto,
  type MobileCreationDraftDto,
  type MobileCreationMessageDto,
  type MobileCreationOutputDto,
  type MobileCreationOutputRecord,
  type MobileCreationSessionDto
} from "./dto.js";
import { sendMobileError } from "./httpErrors.js";
import { jsonRecord } from "./support.js";
import { type CreationAttachment } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { type FastifyReply } from "fastify";

/**
 * Creation-draft persistence and serialization for the pre-generation chat.
 */

export function _chatTitleForPayload(payload: MobileCreationDraftPayload): string {
  // Deliberately not payload.recipe?.title: a stated title always reaches
  // optionalDetails (the rename route and the update_settings capture both
  // write it there), while recipes stored before titles became explicit-only
  // carry a mangled echo of the first message ("Make A About Flies And
  // Their"). The user's own first words are the honest chat label.
  if (payload.optionalDetails?.title?.trim()) return payload.optionalDetails.title.trim();
  if (payload.brief?.topic?.trim()) return payload.brief.topic.trim();
  const firstUser = payload.messages?.length
    ? conversationMessagesFromPayload(payload).find((m) => m.role === "user")
    : undefined;
  if (firstUser?.content?.trim()) return firstUser.content.trim().slice(0, 60);
  return "New book";
}

export function mobileCreationDraftOutputsInclude() {
  return {
    outputs: {
      orderBy: { sequence: "asc" },
      include: { project: { select: { title: true, updatedAt: true } } }
    }
  } as const;
}

export function creationOutputsForDraft(
  draft: { id: string; createdProjectId: string | null; updatedAt: Date; outputs?: MobileCreationOutputRecord[] },
  payload: MobileCreationDraftPayload
): MobileCreationOutputDto[] {
  const outputs = (draft.outputs ?? []).map((output) => serializeCreationOutput(output));
  if (outputs.length > 0 || !draft.createdProjectId) {
    return outputs;
  }
  return [
    {
      id: `legacy:${draft.id}:${draft.createdProjectId}`,
      draftId: draft.id,
      projectId: draft.createdProjectId,
      title: _chatTitleForPayload(payload),
      sequence: 1,
      createdAt: draft.updatedAt.toISOString(),
      updatedAt: draft.updatedAt.toISOString()
    }
  ];
}

export function activeProjectIdForDraft(
  draft: { createdProjectId: string | null },
  outputs: MobileCreationOutputDto[]
): string | null {
  return outputs.at(-1)?.projectId ?? draft.createdProjectId;
}

export function serializeCreationOutput(output: MobileCreationOutputRecord): MobileCreationOutputDto {
  return {
    id: output.id,
    draftId: output.draftId,
    projectId: output.projectId,
    requestId: output.requestId ?? null,
    title: output.project?.title ?? output.title,
    sequence: output.sequence,
    createdAt: output.createdAt.toISOString(),
    updatedAt: (output.project?.updatedAt ?? output.updatedAt).toISOString()
  };
}

export async function createCreationOutputForProject(options: {
  draftId: string;
  projectId: string;
  requestId?: string | undefined;
  title: string;
  existingOutputs: MobileCreationOutputDto[];
  transaction?: Prisma.TransactionClient | undefined;
}): Promise<MobileCreationOutputRecord> {
  const nextSequence =
    options.existingOutputs.reduce((max, output) => Math.max(max, output.sequence), 0) + 1;
  const db = options.transaction ?? prisma;
  return db.mobileCreationOutput.create({
    data: {
      draftId: options.draftId,
      projectId: options.projectId,
      ...(options.requestId ? { requestId: options.requestId } : {}),
      title: options.title,
      sequence: nextSequence
    },
    include: { project: { select: { title: true, updatedAt: true } } }
  });
}

export function serializeCreationDraft(draft: {
  id: string;
  requestId?: string | null;
  payload: unknown;
  advisorSnapshot: unknown;
  createdProjectId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  revision?: number;
} | null): MobileCreationDraftDto | null {
  if (!draft) {
    return null;
  }
  const payload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
  if (!payload.success) {
    return null;
  }
  // Newer snapshots are wrapped with the revision stamp they were computed
  // at; older rows stored the advisor bare. The legacy DTO wants the advisor
  // either way.
  const snapshotRecord = jsonRecord(draft.advisorSnapshot);
  const advisor = mobileBookAdvisorResponseSchema.safeParse(
    snapshotRecord.advisor !== undefined ? snapshotRecord.advisor : draft.advisorSnapshot
  );
  return {
    id: draft.id,
    revision: draft.revision ?? 1,
    requestId: draft.requestId ?? null,
    status: draft.status,
    payload: payload.data,
    advisorSnapshot: advisor.success ? advisor.data : null,
    createdProjectId: draft.createdProjectId,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString()
  };
}

export function serializeCreationMessages(tree: MobileCreationMessage[]): MobileCreationMessageDto[] {
  const { active, branches } = linearizeCreationMessages(tree);
  return active.map((message) => ({
    id: message.id ?? "",
    parentId: message.parentId ?? null,
    role: message.role,
    content: message.content,
    ...(message.attachments && message.attachments.length > 0 ? { attachments: message.attachments } : {}),
    ...(message.characters && message.characters.length > 0 ? { characters: message.characters } : {}),
    ...(message.research ? { research: message.research } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    branch: branches.get(message.id ?? "") ?? null
  }));
}

export function serializeCreationSession(
  draft: {
    id: string;
    status: string;
    payload: unknown;
    createdProjectId: string | null;
    updatedAt: Date;
    revision?: number;
    outputs?: MobileCreationOutputRecord[];
  },
  // The full message tree; only the active branch is exposed to clients.
  messages: MobileCreationMessage[]
): MobileCreationSessionDto {
  const payload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
  const outputs = payload.success ? creationOutputsForDraft(draft, payload.data) : [];
  return {
    draftId: draft.id,
    revision: draft.revision ?? 1,
    title: payload.success ? _chatTitleForPayload(payload.data) : "New book",
    status: draft.status,
    messages: serializeCreationMessages(messages),
    createdProjectId: draft.createdProjectId,
    activeProjectId: activeProjectIdForDraft(draft, outputs),
    outputs,
    attachments: payload.success
      ? (payload.data.attachments ?? []).map((attachment) => serializeCreationAttachment(attachment, draft.id))
      : [],
    updatedAt: draft.updatedAt.toISOString()
  };
}

export function creationTurnForStoredDraft(
  draft: { lastTurn?: unknown },
  payload: MobileCreationDraftPayload,
  messages = conversationMessagesFromPayload(payload)
): MobileCreationTurn {
  return withStoredCreationMetadata(storedDraftTurn(draft, payload, messages), payload);
}

/**
 * `optionalDetails` is not part of the session DTO, so a cold app start has no
 * other way back to the byline and title the Advanced sheet was showing.
 * Echoing them onto the restored turn refills those fields, and it is safe to
 * do unconditionally: this is exactly what the client last sent us.
 *
 * The restored brief's title is pinned to the stated one for the same reason
 * the live turn pins it: a turn persisted before recipe titles became
 * explicit-only carries a title derived from the first message, and replaying
 * it verbatim would put that text back in the app as the book's working name.
 * A mismatched brief title is the signature of such a turn, so its stored
 * title suggestions — built by mangling the same message — go with it.
 */
function withStoredCreationMetadata(
  turn: MobileCreationTurn,
  payload: MobileCreationDraftPayload
): MobileCreationTurn {
  const { authorName, title } = payload.optionalDetails;
  const statedTitle = title || payload.brief?.title || "";
  const staleTitle = turn.brief.title !== statedTitle;
  return {
    ...turn,
    ...(staleTitle ? { brief: { ...turn.brief, title: statedTitle }, titleSuggestions: [] } : {}),
    ...(authorName ? { authorName } : {}),
    ...(title ? { title } : {})
  };
}

function storedDraftTurn(
  draft: { lastTurn?: unknown },
  payload: MobileCreationDraftPayload,
  messages: MobileCreationMessage[]
): MobileCreationTurn {
  const persisted = mobileCreationTurnSchema.safeParse(draft.lastTurn);
  if (persisted.success && persisted.data.assistantMessage.trim()) {
    return persisted.data;
  }
  if (persisted.success && messages.some((message) => message.role === "user")) {
    return creationBranchTurn(payload, messages);
  }
  return messages.some((message) => message.role === "user")
    ? runCreationTurnSync(turnRequestFromPayload(payload, messages))
    : greetingCreationTurn();
}

export function creationAssistantMessage(turn: MobileCreationTurn): MobileCreationMessage {
  return {
    role: "assistant",
    content: turn.assistantMessage,
    ...(turn.research ? { research: turn.research } : {}),
    turnUi: {
      question: turn.question,
      quickReplies: turn.quickReplies
    }
  };
}

/**
 * Branch switches are read-like navigation and should stay instant. Restore
 * the localized question/options captured with that branch's last assistant
 * message; legacy branches without a snapshot show no controls rather than a
 * misleading English fallback.
 */
export function creationBranchTurn(
  payload: MobileCreationDraftPayload,
  messages: MobileCreationMessage[]
): MobileCreationTurn {
  const derived = runCreationTurnSync(turnRequestFromPayload(payload, messages));
  const turnUi = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.turnUi)?.turnUi;
  // Through the normalizer even though the snapshot was normalized when it was
  // written: a legacy snapshot with one option would otherwise come back as a
  // one-button "choice".
  const question = normalizeCreationQuestion(turnUi?.question ?? null);
  return {
    ...derived,
    assistantMessage: "",
    question,
    quickReplies: turnUi?.quickReplies ?? [],
    readiness: {
      ...derived.readiness,
      missing: question ? [question.prompt.replace(/[.!?]+$/g, "")] : []
    }
  };
}

export function runCreationTurnSync(request: MobileCreationTurnRequest): MobileCreationTurn {
  return deterministicCreationTurn(request);
}

export async function updateCreationDraftCas(options: {
  draft: { id: string; userId: string; revision?: number };
  expectedRevision?: number | undefined;
  data: Prisma.MobileCreationDraftUpdateInput;
  transaction?: Prisma.TransactionClient | undefined;
}) {
  const currentRevision = options.draft.revision ?? 1;
  if (options.expectedRevision !== undefined && options.expectedRevision !== currentRevision) {
    return null;
  }
  try {
    const db = options.transaction ?? prisma;
    return await db.mobileCreationDraft.update({
      where: {
        id: options.draft.id,
        userId: options.draft.userId,
        revision: currentRevision
      },
      data: {
        ...options.data,
        revision: { increment: 1 }
      }
    });
  } catch (error) {
    if (jsonRecord(error).code === "P2025") {
      return null;
    }
    throw error;
  }
}

export async function sendCreationSessionConflict(
  reply: FastifyReply,
  userId: string,
  draftId: string
): Promise<FastifyReply> {
  const current = await prisma.mobileCreationDraft.findFirst({
    where: { id: draftId, userId },
    include: mobileCreationDraftOutputsInclude()
  });
  if (!current) {
    return sendMobileError(reply, 404, "SESSION_NOT_FOUND", "This book chat was not found.");
  }
  const payload = mobileCreationDraftPayloadSchema.safeParse(current.payload);
  if (!payload.success) {
    return sendMobileError(reply, 409, "SESSION_CONFLICT", "This chat changed elsewhere. Reload it and try again.");
  }
  const messages = conversationMessagesFromPayload(payload.data);
  return reply.code(409).send({
    error: {
      code: "SESSION_CONFLICT",
      message: "This chat changed elsewhere. Your latest version has been reloaded."
    },
    session: serializeCreationSession(current, creationTreeFromPayload(payload.data)),
    turn: creationTurnForStoredDraft(current, payload.data, messages)
  });
}

export function serializeCreationAttachment(
  attachment: CreationAttachment,
  draftId: string
): MobileCreationAttachmentDto {
  return {
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    summary: attachment.summary,
    pages: attachment.pages ?? null,
    truncated: attachment.truncated,
    createdAt: attachment.createdAt,
    url: `/api/mobile/creation-sessions/${draftId}/attachments/${attachment.id}/file`
  };
}

/** The full message tree for a draft, with legacy messages normalized. */
export function creationTreeFromPayload(payload: MobileCreationDraftPayload): MobileCreationMessage[] {
  if (payload.messages && payload.messages.length > 0) {
    return normalizeCreationMessageIds(payload.messages);
  }
  // Migrate an in-progress wizard draft (V2) into the chat by seeding the idea as the first message.
  const idea = payload.rawIdea.trim();
  return idea ? normalizeCreationMessageIds([{ role: "user" as const, content: idea.slice(0, 4000) }]) : [];
}

/** The active-branch thread — what turns consume and clients display. */
export function conversationMessagesFromPayload(payload: MobileCreationDraftPayload): MobileCreationMessage[] {
  return linearizeCreationMessages(creationTreeFromPayload(payload)).active;
}

export function turnRequestFromPayload(
  payload: MobileCreationDraftPayload,
  messages: MobileCreationMessage[]
): MobileCreationTurnRequest {
  return {
    messages,
    brief: payload.recipe,
    presets: persistedPresetsForTurn(payload),
    sourceNotes: payload.sourceNotes,
    optionalDetails: payload.optionalDetails,
    attachments: payload.attachments,
    language: payload.language,
    conversationSummary: payload.conversationSummary
  };
}

export function persistedPresetsForTurn(payload: MobileCreationDraftPayload): MobileCreationDraftPayload["selectedPresets"] {
  return payload.selectedPresets;
}

export function userTextFromMessages(messages: MobileCreationMessage[]): string {
  return messages
    // A question-skip tap is a UI action, not book intent: unmarked it landed
    // in rawIdea and from there in the composed book prompt as "Original
    // idea: … Skip this for now." The literal check covers messages written
    // by clients shipped before the marker existed.
    .filter(
      (message) =>
        message.role === "user" && message.skippedQuestion !== true && message.content.trim() !== "Skip this for now."
    )
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 2000);
}

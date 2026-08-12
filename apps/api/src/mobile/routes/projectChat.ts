import { bookEditScopeFromMessage, classifyProjectChatMessage, type BookEditIntent } from "../../bookEditIntent.js";
import { chatReplyQuoteFor } from "../../chatReplyQuote.js";
import { libraryCharacterPromptBlock } from "@book-maker/core";
import { fieldsFromJson as characterFieldsFromJson } from "../characterSerializer.js";
import {
  applyOrCancelEditProposal,
  busyEditReply,
  editProposalCardFromState,
  findPendingScopeClarification,
  handleProjectChatIntent,
  isPendingEditCancellationMessage,
  isPendingEditNudgeMessage,
  pendingEditMetadataFromState,
  pendingScopeRecoveryMessage,
  planSummaryForClassifier
} from "../bookEditIntents.js";
import { type MobileProjectChatMessageRecord, type MobileProjectChatMessageResponseDto } from "../dto.js";
import { hasOpenProjectWork } from "../editOperations.js";
import { resolvePendingEditTurn } from "../pendingEditTurn.js";
import { hitAuthenticatedLimit, requireMobileAuth, sendMobileError } from "../httpErrors.js";
import { undoLastBookEdit } from "../manualEdits.js";
import {
  activeProjectChatLeafId,
  chatChaptersForProject,
  chatPagesForProject,
  chatStageForProject,
  createAssistantChatMessage,
  createUserProjectChatMessage,
  loadActiveProjectChatMessages,
  loadChatPageBodies,
  loadProjectChatResponse,
  loadProjectForChat,
  replayProjectChatRequest,
  serializeBookEditOperation,
  serializeProjectChatMessage,
  switchProjectChatBranch
} from "../projectChat.js";
import {
  idParamsSchema,
  mobileAuthError,
  mobileChatUndoBodySchema,
  mobileChatUndoOpenApiBody,
  mobileEditProposalActionBodySchema,
  mobileEditProposalActionOpenApiBody,
  mobileProjectChatBranchBodySchema,
  mobileProjectChatBranchOpenApiBody,
  mobileProjectChatMessageBodySchema,
  mobileProjectChatMessageOpenApiBody,
  projectChatQuerySchema
} from "../schemas.js";
import { replayClaimedProposal } from "../proposalExecutionClaims.js";
import { isPrismaUniqueConflict } from "../support.js";
import { prisma } from "@book-maker/db";
import type { FastifyInstance } from "fastify";
import type { MobileRouteContext } from "../routeContext.js";
import { enforceContentRestrictions } from "../../contentRestrictions.js";

/**
 * Post-generation chat: messages, edit proposals, undo and branch switching.
 */

export async function registerMobileProjectChatRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { safeFastRoutingTextModel, draftLimiter } = context;

  fastify.get(
    "/api/mobile/projects/:id/chat",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const project = await prisma.project.findFirst({ where: { id, userId: auth.user.id }, select: { id: true } });
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }
      const query = projectChatQuerySchema.parse(request.query);
      return loadProjectChatResponse(id, query);
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/chat/messages",
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: mobileProjectChatMessageOpenApiBody,
        response: { 401: mobileAuthError, 404: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(draftLimiter, request, reply, auth.user.id, "project-chat")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsed = mobileProjectChatMessageBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send a chat message.");
      }
      if (!(await enforceContentRestrictions(reply, parsed.data.message))) {
        return;
      }

      const project = await loadProjectForChat(auth.user.id, id);
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }

      if (parsed.data.requestId) {
        const replay = await replayProjectChatRequest(id, parsed.data.requestId);
        if (replay) {
          return replay;
        }
      }

      const editMessageId = parsed.data.editMessageId;
      const editedMessage = editMessageId
        ? await prisma.projectChatMessage.findFirst({
            where: { id: editMessageId, projectId: id, role: "USER" }
          })
        : null;
      if (editMessageId && !editedMessage) {
        return sendMobileError(reply, 404, "MESSAGE_NOT_FOUND", "That chat message was not found.");
      }

      // Unlike an edit, a reply targets any role: pointing at the assistant's
      // answer is the common case, and pointing at your own earlier request is
      // how a narrowing follow-up reads.
      const replyToMessageId = parsed.data.replyToMessageId;
      const repliedToMessage = replyToMessageId
        ? await prisma.projectChatMessage.findFirst({ where: { id: replyToMessageId, projectId: id } })
        : null;
      if (replyToMessageId && !repliedToMessage) {
        return sendMobileError(reply, 404, "MESSAGE_NOT_FOUND", "That chat message was not found.");
      }
      const replyTo = repliedToMessage ? chatReplyQuoteFor(repliedToMessage) : null;

      // @-mentioned library characters. Their sheets become a bounded context
      // block that rides the *stored* edit request (pendingEdit states and job
      // payloads) — never the routed text, whose words drive page targeting
      // and exact-replacement parsing, and never the visible transcript.
      const mentionedIds = [...new Set(parsed.data.mentionedCharacterIds ?? [])];
      const mentionedCharacters = mentionedIds.length
        ? await prisma.libraryCharacter.findMany({ where: { id: { in: mentionedIds }, userId: auth.user.id } })
        : [];
      if (mentionedCharacters.length !== mentionedIds.length) {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "A mentioned character is no longer in your library.");
      }
      const characterRefs = mentionedCharacters.map((character) => ({ id: character.id, name: character.name }));
      const mentionContext = mentionedCharacters.length
        ? [
            "Mentioned character profiles (the user's own library characters; treat as authoritative canon):",
            libraryCharacterPromptBlock(
              mentionedCharacters.map((character) => ({
                id: character.id,
                name: character.name,
                description: character.description,
                fields: characterFieldsFromJson(character.fields)
              }))
            )
          ].join("\n")
        : undefined;

      const activeMessages = await loadActiveProjectChatMessages(id);
      const activeEditedMessage = editedMessage
        ? activeMessages.find((message) => message.id === editedMessage.id)
        : null;
      const parentId = editedMessage
        ? activeEditedMessage?.parentId ?? editedMessage.parentId ?? null
        : activeProjectChatLeafId(activeMessages);
      const currentScope = bookEditScopeFromMessage(parsed.data.message);
      const pendingScope = editMessageId
        ? null
        : await findPendingScopeClarification(id, parsed.data.message, currentScope, activeMessages);
      // The one-question rule's whole turn resolution lives in
      // resolvePendingEditTurn; this handler only consumes the verdict.
      const { resolvedPendingEdit, clarifyExhausted, resolvedMessage, confirmedPendingEdit, pendingScopeIsRecoverable, resolvesPendingScope } =
        resolvePendingEditTurn(pendingScope, parsed.data.message, { currentScope });

      let userMessage: MobileProjectChatMessageRecord;
      try {
        userMessage = await createUserProjectChatMessage({
          projectId: id,
          parentId,
          content: parsed.data.message,
          requestId: parsed.data.requestId,
          metadata: {
            ...(resolvedPendingEdit
              ? { resolvedPendingEdit }
              : editedMessage
                ? { editedFromMessageId: editedMessage.id }
                : {}),
            ...(replyTo ? { replyTo } : {}),
            ...(characterRefs.length > 0 ? { characters: characterRefs } : {})
          },
          selectSibling: Boolean(editedMessage)
        });
      } catch (error) {
        if (parsed.data.requestId && isPrismaUniqueConflict(error)) {
          const replay = await replayProjectChatRequest(id, parsed.data.requestId);
          if (replay) {
            return replay;
          }
          // The user row exists but its reply does not yet: the same requestId
          // is still in flight, so answer with a retryable conflict rather
          // than rethrowing the unique violation as a 500.
          return sendMobileError(reply, 409, "REQUEST_IN_PROGRESS", "That request is still being processed. Try again in a moment.");
        }
        throw error;
      }

      if (pendingScope && isPendingEditCancellationMessage(parsed.data.message)) {
        const replyMessage = await createAssistantChatMessage({
          projectId: id,
          parentId: userMessage.id,
          content: "Okay, I dropped that request. Nothing was changed or charged.",
          metadata: { pendingEditCancelled: true, charged: false }
        });
        return {
          ...(await loadProjectChatResponse(id)),
          reply: serializeProjectChatMessage(replyMessage),
          operation: null
        } satisfies MobileProjectChatMessageResponseDto;
      }

      // Only short-circuit to the recovery reply when there is something to
      // recover — a stranded scope or a priced proposal. For a bare scope
      // clarification that message is itself another question, so an insistent
      // follow-up falls through to the forced decision below instead.
      if (
        pendingScope &&
        pendingScopeIsRecoverable &&
        !resolvesPendingScope &&
        isPendingEditNudgeMessage(parsed.data.message)
      ) {
        const replyMessage = await createAssistantChatMessage({
          projectId: id,
          parentId: userMessage.id,
          content: pendingScopeRecoveryMessage(pendingScope),
          metadata: {
            pendingEdit: pendingEditMetadataFromState(pendingScope),
            ...(editProposalCardFromState(pendingScope)
              ? { editProposal: editProposalCardFromState(pendingScope) }
              : {}),
            recoveredPendingScope: pendingScope.scope,
            charged: false
          }
        });
        return {
          ...(await loadProjectChatResponse(id)),
          reply: serializeProjectChatMessage(replyMessage),
          operation: null
        } satisfies MobileProjectChatMessageResponseDto;
      }

      const pages = chatPagesForProject(project);
      const stage = chatStageForProject(project.status, project.currentPlan);
      const routingTextModel = safeFastRoutingTextModel();

      // A pure confirmation of a priced proposal skips re-routing so the
      // already-quoted credit cost and page targets stay authoritative.
      const confirmedProposal =
        confirmedPendingEdit && pendingScope?.intent
          ? pendingScope
          : null;
      const intent = confirmedProposal?.intent
        ? confirmedProposal.intent
        : await classifyProjectChatMessage({
            message: resolvedMessage,
            stage,
            pages,
            chapters: chatChaptersForProject(project),
            planSummary: project.currentPlan ? planSummaryForClassifier(project.currentPlan) : undefined,
            recentMessages: activeMessages.slice(-12).map((message) => ({
              role: message.role === "USER" ? "user" : "assistant",
              content: message.content
            })),
            textModel: routingTextModel,
            loadPageBody: async (index) => (await loadChatPageBodies(id, [index])).get(index) ?? null,
            clarifyExhausted,
            // Given to the router, not merged into the message: without a
            // referent "make that shorter" falls to the heuristics' catch-all
            // clarify, and a second unresolved turn is forced into a whole-book
            // rewrite. The heuristics and page targeting never see it.
            ...(replyTo ? { replyTo } : {})
          });

      // Answering questions and reading content are always allowed while a job
      // runs; edit requests get saved as the project's one pending edit and can
      // be applied with a quick confirmation once the work settles. The free
      // presentation toggles ride along: they only write a mediaSettings field
      // and queue a deduped recompile, so deflecting them into the pending-edit
      // machinery would make a zero-cost, idempotent switch wait on a job it
      // does not race.
      // This turn's mentions win; a resumed pending edit otherwise keeps the
      // sheets it was created with. Computed before the busy gate so a
      // deflected mention edit saves its sheets for the resume.
      const characterContext = mentionContext ?? pendingScope?.characterContext;
      const openEditBlocked = await hasOpenProjectWork(id);
      const alwaysAllowedWhileBusy = ["answer", "clarify", "show_content", "back_matter", "chapter_heading"];
      if (openEditBlocked && !alwaysAllowedWhileBusy.includes(intent.kind)) {
        // A typed confirmation racing the Apply button: when the "busy" job is
        // the button's own execution of this very proposal, saving the request
        // as a pending edit would let a later nudge rebuild and re-charge it.
        if (confirmedProposal?.proposalId) {
          const claimed = await replayClaimedProposal(id, confirmedProposal.proposalId);
          if (claimed) return claimed;
        }
        const replyMessage = await busyEditReply({
          projectId: id,
          parentMessageId: userMessage.id,
          intent,
          request: resolvedMessage,
          // A deflected confirmation keeps its priced proposal, so the resume
          // after the job settles executes it instead of re-proposing.
          ...(confirmedProposal ? { pendingState: confirmedProposal } : {}),
          ...(characterContext ? { characterContext } : {})
        });
        return {
          ...(await loadProjectChatResponse(id)),
          reply: serializeProjectChatMessage(replyMessage),
          operation: null
        } satisfies MobileProjectChatMessageResponseDto;
      }

      const outcome = await handleProjectChatIntent({
        userId: auth.user.id,
        project,
        userMessageId: userMessage.id,
        message: resolvedMessage,
        intent,
        textModel: routingTextModel,
        executeProposal: Boolean(confirmedProposal),
        ...(confirmedProposal?.proposalId ? { executionCommandId: confirmedProposal.proposalId } : {}),
        ...(confirmedProposal?.credits !== undefined ? { quotedCredits: confirmedProposal.credits } : {}),
        ...(clarifyExhausted && pendingScope ? { pendingRequest: pendingScope.request } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(characterContext ? { characterContext } : {}),
        activeMessages
      });

      return {
        ...(await loadProjectChatResponse(id)),
        reply: serializeProjectChatMessage(outcome.reply),
        operation: outcome.operation ? serializeBookEditOperation(outcome.operation) : null
      } satisfies MobileProjectChatMessageResponseDto;
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/chat/proposals/apply",
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: mobileEditProposalActionOpenApiBody,
        response: { 401: mobileAuthError, 404: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(draftLimiter, request, reply, auth.user.id, "project-chat")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsed = mobileEditProposalActionBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Choose a proposal to apply.");
      }
      return applyOrCancelEditProposal({
        reply,
        userId: auth.user.id,
        projectId: id,
        proposalId: parsed.data.proposalId,
        requestId: parsed.data.requestId,
        action: "apply",
        textModel: safeFastRoutingTextModel()
      });
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/chat/proposals/cancel",
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: mobileEditProposalActionOpenApiBody,
        response: { 401: mobileAuthError, 404: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(draftLimiter, request, reply, auth.user.id, "project-chat")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsed = mobileEditProposalActionBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Choose a proposal to cancel.");
      }
      return applyOrCancelEditProposal({
        reply,
        userId: auth.user.id,
        projectId: id,
        proposalId: parsed.data.proposalId,
        requestId: parsed.data.requestId,
        action: "cancel",
        textModel: safeFastRoutingTextModel()
      });
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/chat/edits/undo",
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: mobileChatUndoOpenApiBody,
        response: { 401: mobileAuthError, 404: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(draftLimiter, request, reply, auth.user.id, "project-chat")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsed = mobileChatUndoBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Undo request was invalid.");
      }
      // Ownership before replay, matching the messages route: a replay answers
      // with the project's whole chat response, so replaying for a caller who
      // does not own the project would hand them another reader's transcript.
      const project = await loadProjectForChat(auth.user.id, id);
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }
      if (parsed.data.requestId) {
        const replay = await replayProjectChatRequest(id, parsed.data.requestId);
        if (replay) {
          return replay;
        }
      }

      // Same gate as typing "undo" in chat: the undo rewrite and recompile
      // must not race a running edit over the same pages.
      if (await hasOpenProjectWork(id)) {
        return sendMobileError(
          reply,
          409,
          "PROJECT_BUSY",
          "This book is still being worked on. Try the undo again once the current job finishes."
        );
      }

      const activeMessages = await loadActiveProjectChatMessages(id);
      let userMessage: MobileProjectChatMessageRecord;
      try {
        userMessage = await createUserProjectChatMessage({
          projectId: id,
          parentId: activeProjectChatLeafId(activeMessages),
          content: "Undo",
          requestId: parsed.data.requestId,
          metadata: { undoAction: true }
        });
      } catch (error) {
        if (parsed.data.requestId && isPrismaUniqueConflict(error)) {
          const replay = await replayProjectChatRequest(id, parsed.data.requestId);
          if (replay) {
            return replay;
          }
          // Same in-flight duplicate as the message route: conflict, not 500.
          return sendMobileError(reply, 409, "REQUEST_IN_PROGRESS", "That request is still being processed. Try again in a moment.");
        }
        throw error;
      }

      const intent: BookEditIntent = {
        kind: "undo_last_edit",
        confidence: 1,
        reasoning: "Explicit undo API.",
        affectedPageIndexes: [],
        assistantMessage: "I’ll undo the last edit.",
        scope: "none",
        impact: "small_text",
        clarification: "none"
      };
      const replyMessage = await undoLastBookEdit(project, intent, userMessage.id);
      return {
        ...(await loadProjectChatResponse(id)),
        reply: serializeProjectChatMessage(replyMessage),
        operation: null
      } satisfies MobileProjectChatMessageResponseDto;
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/chat/branches",
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: mobileProjectChatBranchOpenApiBody,
        response: { 401: mobileAuthError, 404: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsed = mobileProjectChatBranchBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Choose a chat branch.");
      }
      const project = await prisma.project.findFirst({ where: { id, userId: auth.user.id }, select: { id: true } });
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }

      const switched = await switchProjectChatBranch({
        projectId: id,
        messageId: parsed.data.messageId,
        direction: parsed.data.direction
      });
      if (!switched) {
        return sendMobileError(reply, 404, "MESSAGE_NOT_FOUND", "That chat branch was not found.");
      }
      return loadProjectChatResponse(id);
    }
  );
}

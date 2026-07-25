import { bookEditScopeFromMessage, classifyProjectChatMessage, messageWithScope, type BookEditIntent } from "../../bookEditIntent.js";
import {
  applyOrCancelEditProposal,
  busyEditReply,
  editProposalCardFromState,
  findPendingScopeClarification,
  handleProjectChatIntent,
  isPendingEditCancellationMessage,
  isPendingEditConfirmationMessage,
  isPendingEditNudgeMessage,
  pendingEditMetadataFromState,
  pendingScopeRecoveryMessage,
  planSummaryForClassifier
} from "../bookEditIntents.js";
import { type MobileProjectChatMessageRecord, type MobileProjectChatMessageResponseDto } from "../dto.js";
import { hasOpenProjectWork } from "../editOperations.js";
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
import { isPrismaUniqueConflict } from "../support.js";
import { prisma } from "@book-maker/db";
import type { FastifyInstance } from "fastify";
import type { MobileRouteContext } from "../routeContext.js";

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

      const activeMessages = await loadActiveProjectChatMessages(id);
      const activeEditedMessage = editedMessage
        ? activeMessages.find((message) => message.id === editedMessage.id)
        : null;
      const parentId = editedMessage
        ? activeEditedMessage?.parentId ?? editedMessage.parentId ?? null
        : activeProjectChatLeafId(activeMessages);
      const pendingScope = editMessageId ? null : await findPendingScopeClarification(id, parsed.data.message);
      const currentScope = bookEditScopeFromMessage(parsed.data.message);
      const pendingResolutionScope = currentScope !== "none" ? currentScope : pendingScope?.scope ?? "none";
      // Busy-queued edits and priced proposals carry their full target
      // already; a bare confirmation ("apply it") is enough to resume them.
      // Scope clarifications still need an actual scope answer.
      const pendingCarriesFullRequest =
        pendingScope?.clarification === "busy" || pendingScope?.clarification === "confirm";
      const resolvesPendingScope = Boolean(
        pendingScope &&
          (pendingCarriesFullRequest
            ? isPendingEditConfirmationMessage(parsed.data.message) || currentScope !== "none"
            : currentScope !== "none" ||
              (pendingResolutionScope !== "none" && isPendingEditConfirmationMessage(parsed.data.message)))
      );
      const resolvedPendingEdit =
        pendingScope && resolvesPendingScope
          ? {
              request: pendingScope.request,
              scope: pendingResolutionScope,
              scopeMessage: parsed.data.message
            }
          : null;
      const resolvedMessage = resolvedPendingEdit
        ? pendingCarriesFullRequest && resolvedPendingEdit.scope === "none"
          ? resolvedPendingEdit.request
          : messageWithScope(resolvedPendingEdit.request, resolvedPendingEdit.scope)
        : parsed.data.message;
      // A pure confirmation of a priced proposal executes it; any other reply
      // (new scope, refined request) goes back through routing and re-pricing.
      const confirmedPendingEdit = Boolean(
        resolvedPendingEdit &&
          pendingScope?.clarification === "confirm" &&
          isPendingEditConfirmationMessage(parsed.data.message)
      );

      let userMessage: MobileProjectChatMessageRecord;
      try {
        userMessage = await createUserProjectChatMessage({
          projectId: id,
          parentId,
          content: parsed.data.message,
          requestId: parsed.data.requestId,
          metadata: resolvedPendingEdit
            ? { resolvedPendingEdit }
            : editedMessage
              ? { editedFromMessageId: editedMessage.id }
              : {},
          selectSibling: Boolean(editedMessage)
        });
      } catch (error) {
        if (parsed.data.requestId && isPrismaUniqueConflict(error)) {
          const replay = await replayProjectChatRequest(id, parsed.data.requestId);
          if (replay) {
            return replay;
          }
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

      if (pendingScope && !resolvesPendingScope && isPendingEditNudgeMessage(parsed.data.message)) {
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
            loadPageBody: async (index) => (await loadChatPageBodies(id, [index])).get(index) ?? null
          });

      // Answering questions and reading content are always allowed while a job
      // runs; edit requests get saved as the project's one pending edit and can
      // be applied with a quick confirmation once the work settles.
      const openEditBlocked = await hasOpenProjectWork(id);
      const alwaysAllowedWhileBusy = ["answer", "clarify", "show_content"];
      if (openEditBlocked && !alwaysAllowedWhileBusy.includes(intent.kind)) {
        const replyMessage = await busyEditReply({
          projectId: id,
          parentMessageId: userMessage.id,
          intent,
          request: resolvedMessage
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
        executeProposal: Boolean(confirmedProposal)
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
      if (parsed.data.requestId) {
        const replay = await replayProjectChatRequest(id, parsed.data.requestId);
        if (replay) {
          return replay;
        }
      }

      const project = await loadProjectForChat(auth.user.id, id);
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
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

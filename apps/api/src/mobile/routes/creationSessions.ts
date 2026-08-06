import {
  deleteCreationAttachmentDraftDir,
  deleteCreationAttachmentFile,
  readCreationAttachmentFile,
  saveCreationAttachmentFile
} from "../../attachmentStorage.js";
import { chatReplyQuoteFor } from "../../chatReplyQuote.js";
import {
  appendCreationMessage,
  foldCreationTranscriptTree,
  forkCreationSiblingMessage,
  linearizeCreationMessages,
  normalizeCreationMessageIds,
  switchCreationBranch
} from "../../creationChatTree.js";
import {
  greetingCreationTurn,
  mergeMobileCreationPresets,
  mobileCreationDraftPayloadSchema,
  mobileCreationPresetsSchema,
  runCreationTurn,
  type MobileCreationDraftPayload,
  type MobileCreationMessage,
  type MobileCreationTurnRequest
} from "../../mobileCreation.js";
import {
  _chatTitleForPayload,
  activeProjectIdForDraft,
  conversationMessagesFromPayload,
  creationAssistantMessage,
  creationBranchTurn,
  creationOutputsForDraft,
  creationTreeFromPayload,
  creationTurnForStoredDraft,
  mobileCreationDraftOutputsInclude,
  persistedPresetsForTurn,
  sendCreationSessionConflict,
  serializeCreationAttachment,
  serializeCreationSession,
  updateCreationDraftCas,
  userTextFromMessages
} from "../creationSessions.js";
import {
  type MobileCreationBuildPreflightResponseDto,
  type MobileCreationConversationResponseDto,
} from "../dto.js";
import { hitAuthenticatedLimit, requireMobileAuth, sendMobileError } from "../httpErrors.js";
import {
  DEFAULT_CREATION_TURN_TIMEOUT_MS,
  attachmentParamsSchema,
  attachmentUploadQuerySchema,
  creationMutationQuerySchema,
  idParamsSchema,
  mobileAuthError,
  mobileCreationBranchBodySchema,
  mobileCreationBuildBodySchema,
  mobileCreationMessageBodySchema,
  mobileCreationSessionStartBodySchema,
  mobileProjectChatBranchOpenApiBody
} from "../schemas.js";
import { jsonInputValue } from "../support.js";
import {
  CREATION_ATTACHMENT_MAX_BYTES,
  CREATION_ATTACHMENT_MAX_COUNT,
  CreationAttachmentError,
  type CreationAttachment
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { createCreationBuildHelpers, sendFinalizeOutcome } from "../creationBuild.js";
import type { MobileRouteContext } from "../routeContext.js";

/**
 * Branching creation chat: sessions, messages, attachments, preflight and build.
 */

export async function registerMobileCreationSessionRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { appConfig, generationLimiter, advisorLimiter, draftLimiter, attachmentLimiter, attachmentIngestion, creationEnrichment, options } = context;
  const { finalizeMobileCreationDraft, pageCountRecommendationsForPreflight, prepareMobileCreationBuild } = createCreationBuildHelpers(context);

  fastify.get(
    "/api/mobile/creation-sessions",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const drafts = await prisma.mobileCreationDraft.findMany({
        where: { userId: auth.user.id },
        orderBy: { updatedAt: "desc" },
        take: 100,
        include: mobileCreationDraftOutputsInclude()
      });
      const sessions = drafts.flatMap((draft) => {
        const parsed = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
        if (!parsed.success) return [];
        const payload = parsed.data;
        const messages = payload.messages && payload.messages.length > 0 ? conversationMessagesFromPayload(payload) : [];
        const title = _chatTitleForPayload(payload);
        const lastMsg = messages.length > 0 ? messages[messages.length - 1] : undefined;
        const preview = lastMsg ? lastMsg.content.trim().slice(0, 100) : "";
        const outputs = creationOutputsForDraft(draft, payload);
        return [{
          draftId: draft.id,
          title,
          preview,
          messageCount: messages.length,
          status: draft.status,
          createdProjectId: draft.createdProjectId,
          activeProjectId: activeProjectIdForDraft(draft, outputs),
          outputs,
          createdAt: draft.createdAt.toISOString(),
          updatedAt: draft.updatedAt.toISOString(),
          // Drafts from before lastMessageAt existed fall back to updatedAt.
          lastMessageAt: payload.lastMessageAt ?? draft.updatedAt.toISOString()
        }];
      });
      // Order by conversation activity: builds, copies, and other background
      // updates bump the row's updatedAt without any new message and would
      // otherwise push stale chats above newer ones.
      sessions.sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : a.lastMessageAt > b.lastMessageAt ? -1 : 0));
      return { sessions };
    }
  );

  fastify.get(
    "/api/mobile/creation-sessions/active",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const draft = await prisma.mobileCreationDraft.findFirst({
        where: { userId: auth.user.id, status: "ACTIVE" },
        orderBy: { updatedAt: "desc" },
        include: mobileCreationDraftOutputsInclude()
      });
      if (!draft) {
        return { session: null, turn: greetingCreationTurn() } satisfies MobileCreationConversationResponseDto;
      }
      const parsed = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
      if (!parsed.success) {
        return { session: null, turn: greetingCreationTurn() } satisfies MobileCreationConversationResponseDto;
      }
      const messages = conversationMessagesFromPayload(parsed.data);
      const turn = creationTurnForStoredDraft(draft, parsed.data, messages);
      return {
        session: serializeCreationSession(draft, creationTreeFromPayload(parsed.data)),
        turn
      } satisfies MobileCreationConversationResponseDto;
    }
  );

  fastify.get(
    "/api/mobile/creation-sessions/:id",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const draft = await prisma.mobileCreationDraft.findFirst({
        where: { id, userId: auth.user.id },
        include: mobileCreationDraftOutputsInclude()
      });
      if (!draft) {
        return sendMobileError(reply, 404, "NOT_FOUND", "Chat session not found.");
      }
      const parsed = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
      if (!parsed.success) {
        return sendMobileError(reply, 404, "NOT_FOUND", "Chat session could not be loaded.");
      }
      const messages = conversationMessagesFromPayload(parsed.data);
      const turn = creationTurnForStoredDraft(draft, parsed.data, messages);
      return {
        session: serializeCreationSession(draft, creationTreeFromPayload(parsed.data)),
        turn
      } satisfies MobileCreationConversationResponseDto;
    }
  );

  fastify.post(
    "/api/mobile/creation-sessions",
    { attachValidation: true, schema: { tags: ["mobile"], response: { 201: {}, 401: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(draftLimiter, request, reply, auth.user.id, "creation-session-start")) {
        return;
      }
      const parsedBody = mobileCreationSessionStartBodySchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send a short message to start the chat.");
      }
      if (parsedBody.data.requestId) {
        const existing = await prisma.mobileCreationDraft.findFirst({
          where: { userId: auth.user.id, requestId: parsedBody.data.requestId },
          include: mobileCreationDraftOutputsInclude()
        });
        if (existing) {
          const existingPayload = mobileCreationDraftPayloadSchema.safeParse(existing.payload);
          if (existingPayload.success) {
            const existingMessages = conversationMessagesFromPayload(existingPayload.data);
            return reply.code(201).send({
              session: serializeCreationSession(existing, creationTreeFromPayload(existingPayload.data)),
              turn: creationTurnForStoredDraft(existing, existingPayload.data, existingMessages)
            } satisfies MobileCreationConversationResponseDto);
          }
        }
      }
      const greeting = greetingCreationTurn();
      const greetingMessages: MobileCreationMessage[] = [
        creationAssistantMessage(greeting)
      ];
      const firstMessage = parsedBody.data.message;
      let turn = greeting;
      let messages = normalizeCreationMessageIds(greetingMessages);
      let payload: MobileCreationDraftPayload;
      if (firstMessage) {
        const nextMessages: MobileCreationMessage[] = [
          ...greetingMessages,
          { role: "user" as const, content: firstMessage }
        ].slice(-60);
        const turnRequest: MobileCreationTurnRequest = {
          messages: nextMessages,
          presets: parsedBody.data.presets ? mobileCreationPresetsSchema.parse(parsedBody.data.presets) : undefined,
          sourceNotes: parsedBody.data.sourceNotes,
          optionalDetails: parsedBody.data.optionalDetails
        };
        turn = await runCreationTurn(turnRequest, {
          enrich: creationEnrichment,
          timeoutMs: options.creationTurnTimeoutMs ?? DEFAULT_CREATION_TURN_TIMEOUT_MS,
          onEnrichError: (error) =>
            request.log.warn({ err: error }, "creation turn enrichment failed; using safe fallback")
        });
        messages = normalizeCreationMessageIds(
          [...nextMessages, creationAssistantMessage(turn)].slice(-60)
        );
        payload = mobileCreationDraftPayloadSchema.parse({
          payloadVersion: 3,
          rawIdea: userTextFromMessages(messages),
          optionalDetails: turnRequest.optionalDetails ?? { mustInclude: "", tone: "" },
          sourceNotes: turnRequest.sourceNotes ?? "",
          detectedLane: turn.brief.lane,
          recipe: turn.brief,
          selectedPresets: turn.presets,
          ...(turn.language ? { language: turn.language } : {}),
          messages
        });
      } else {
        payload = mobileCreationDraftPayloadSchema.parse({
          payloadVersion: 3,
          messages,
          ...(parsedBody.data.presets
            ? { selectedPresets: mobileCreationPresetsSchema.parse(parsedBody.data.presets) }
            : {})
        });
      }
      payload = { ...payload, lastMessageAt: new Date().toISOString() };
      const draft = await prisma.mobileCreationDraft.create({
        data: {
          ...(parsedBody.data.requestId ? { requestId: parsedBody.data.requestId } : {}),
          userId: auth.user.id,
          status: "ACTIVE",
          payload: jsonInputValue(payload),
          lastTurn: jsonInputValue(turn)
        }
      });
      return reply.code(201).send({
        session: serializeCreationSession(draft, messages),
        turn
      } satisfies MobileCreationConversationResponseDto);
    }
  );

  fastify.post(
    "/api/mobile/creation-sessions/:id/messages",
    { attachValidation: true, schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(advisorLimiter, request, reply, auth.user.id, "creation-session-message")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsedBody = mobileCreationMessageBodySchema.safeParse(request.body);
      if (!parsedBody.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send a short message to continue the chat.");
      }
      const draft = await prisma.mobileCreationDraft.findFirst({
        where: { id, userId: auth.user.id },
        include: mobileCreationDraftOutputsInclude()
      });
      if (!draft) {
        return sendMobileError(reply, 404, "SESSION_NOT_FOUND", "This book chat was not found.");
      }
      const parsedPayload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
      if (!parsedPayload.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "This book chat needs to be restarted.");
      }

      if (parsedBody.data.requestId) {
        const replayed = creationTreeFromPayload(parsedPayload.data).some(
          (message) => message.role === "user" && message.requestId === parsedBody.data.requestId
        );
        if (replayed) {
          const replayMessages = conversationMessagesFromPayload(parsedPayload.data);
          return {
            session: serializeCreationSession(draft, creationTreeFromPayload(parsedPayload.data)),
            turn: creationTurnForStoredDraft(draft, parsedPayload.data, replayMessages)
          } satisfies MobileCreationConversationResponseDto;
        }
      }

      const attachmentPool = parsedPayload.data.attachments ?? [];
      const requestedAttachmentIds = parsedBody.data.attachmentIds ?? [];
      const attachedNow = requestedAttachmentIds.map((attachmentId) =>
        attachmentPool.find((attachment) => attachment.id === attachmentId)
      );
      if (attachedNow.some((attachment) => attachment === undefined)) {
        return sendMobileError(reply, 404, "ATTACHMENT_NOT_FOUND", "That attachment was not found. Re-attach the file and try again.");
      }
      const attachmentRefs = attachedNow.map((attachment) => ({
        id: attachment!.id,
        kind: attachment!.kind,
        name: attachment!.name
      }));

      const priorTree = creationTreeFromPayload(parsedPayload.data);
      // A reply can quote either role, and it is resolved against the whole
      // stored tree rather than the active branch: the quote is a snapshot, so
      // it stays readable even if the branch it came from is switched away.
      const replyToMessageId = parsedBody.data.replyToMessageId;
      const repliedTo = replyToMessageId ? priorTree.find((message) => message.id === replyToMessageId) : undefined;
      if (replyToMessageId && !repliedTo) {
        return sendMobileError(reply, 404, "MESSAGE_NOT_FOUND", "That message was not found in this chat.");
      }
      const replyTo = repliedTo?.id ? chatReplyQuoteFor({ id: repliedTo.id, role: repliedTo.role, content: repliedTo.content }) : null;
      const userMessage = {
        role: "user" as const,
        content: parsedBody.data.message,
        ...(parsedBody.data.requestId ? { requestId: parsedBody.data.requestId } : {}),
        ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {}),
        ...(replyTo ? { replyTo } : {})
      };
      let treeWithUser: MobileCreationMessage[];
      if (parsedBody.data.editMessageId) {
        const edited = priorTree.find((message) => message.id === parsedBody.data.editMessageId);
        if (!edited || edited.role !== "user") {
          return sendMobileError(reply, 404, "MESSAGE_NOT_FOUND", "That message was not found in this chat.");
        }
        treeWithUser = forkCreationSiblingMessage(priorTree, parsedBody.data.editMessageId, userMessage)!.messages;
      } else {
        treeWithUser = appendCreationMessage(priorTree, userMessage).messages;
      }
      const incoming = foldCreationTranscriptTree(treeWithUser, parsedPayload.data.conversationSummary);
      const turnRequest: MobileCreationTurnRequest = {
        messages: linearizeCreationMessages(incoming.messages).active,
        brief: parsedPayload.data.recipe,
        presets: parsedBody.data.presets
          ? mergeMobileCreationPresets(persistedPresetsForTurn(parsedPayload.data), parsedBody.data.presets)
          : persistedPresetsForTurn(parsedPayload.data),
        sourceNotes: parsedBody.data.sourceNotes ?? parsedPayload.data.sourceNotes,
        optionalDetails: parsedBody.data.optionalDetails ?? parsedPayload.data.optionalDetails,
        attachments: attachmentPool,
        language: parsedPayload.data.language,
        conversationSummary: incoming.conversationSummary
      };
      const turn = await runCreationTurn(turnRequest, {
        enrich: creationEnrichment,
        timeoutMs: options.creationTurnTimeoutMs ?? DEFAULT_CREATION_TURN_TIMEOUT_MS,
        onEnrichError: (error) =>
          request.log.warn({ err: error }, "creation turn enrichment failed; using safe fallback")
      });
      const persisted = foldCreationTranscriptTree(
        appendCreationMessage(incoming.messages, creationAssistantMessage(turn)).messages,
        incoming.conversationSummary
      );
      const language = turn.language ?? parsedPayload.data.language;
      const updatedPayload = mobileCreationDraftPayloadSchema.parse({
        payloadVersion: 3,
        rawIdea: userTextFromMessages(linearizeCreationMessages(persisted.messages).active),
        optionalDetails: turnRequest.optionalDetails ?? { mustInclude: "", tone: "" },
        sourceNotes: turnRequest.sourceNotes ?? "",
        detectedLane: turn.brief.lane,
        recipe: turn.brief,
        selectedPresets: turn.presets,
        ...(attachmentPool.length > 0 ? { attachments: attachmentPool } : {}),
        ...(language ? { language } : {}),
        ...(persisted.conversationSummary ? { conversationSummary: persisted.conversationSummary } : {}),
        lastMessageAt: new Date().toISOString(),
        messages: persisted.messages
      });
      const updated = await updateCreationDraftCas({
        draft,
        expectedRevision: parsedBody.data.expectedRevision,
        data: {
          payload: jsonInputValue(updatedPayload),
          status: "ACTIVE",
          lastTurn: jsonInputValue(turn)
        }
      });
      if (!updated) {
        return sendCreationSessionConflict(reply, auth.user.id, id);
      }
      return {
        session: serializeCreationSession({ ...updated, outputs: draft.outputs }, persisted.messages),
        turn
      } satisfies MobileCreationConversationResponseDto;
    }
  );

  fastify.post(
    "/api/mobile/creation-sessions/:id/branches",
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
      if (!hitAuthenticatedLimit(draftLimiter, request, reply, auth.user.id, "creation-branch-switch")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsedBody = mobileCreationBranchBodySchema.safeParse(request.body);
      if (!parsedBody.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Choose a chat branch.");
      }
      const draft = await prisma.mobileCreationDraft.findFirst({
        where: { id, userId: auth.user.id },
        include: mobileCreationDraftOutputsInclude()
      });
      if (!draft) {
        return sendMobileError(reply, 404, "SESSION_NOT_FOUND", "This book chat was not found.");
      }
      const parsedPayload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
      if (!parsedPayload.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "This book chat needs to be restarted.");
      }
      const switched = switchCreationBranch(
        creationTreeFromPayload(parsedPayload.data),
        parsedBody.data.messageId,
        parsedBody.data.direction
      );
      if (!switched) {
        return sendMobileError(reply, 404, "MESSAGE_NOT_FOUND", "That chat branch was not found.");
      }
      // Re-derive the advisor state from the newly active branch so an
      // immediate Build reflects it. The question controls are restored from
      // the assistant message that originally produced them, avoiding both a
      // new model call and the English deterministic fallback.
      const activeMessages = linearizeCreationMessages(switched).active;
      const turn = creationBranchTurn(parsedPayload.data, activeMessages);
      const updatedPayload = mobileCreationDraftPayloadSchema.parse({
        ...parsedPayload.data,
        payloadVersion: 3,
        rawIdea: userTextFromMessages(activeMessages),
        detectedLane: turn.brief.lane,
        recipe: turn.brief,
        selectedPresets: turn.presets,
        messages: switched
      });
      const updated = await updateCreationDraftCas({
        draft,
        expectedRevision: parsedBody.data.expectedRevision,
        data: { payload: jsonInputValue(updatedPayload), lastTurn: jsonInputValue(turn) }
      });
      if (!updated) {
        return sendCreationSessionConflict(reply, auth.user.id, id);
      }
      return {
        session: serializeCreationSession({ ...updated, outputs: draft.outputs }, switched),
        turn
      } satisfies MobileCreationConversationResponseDto;
    }
  );

  fastify.post(
    "/api/mobile/creation-sessions/:id/attachments",
    {
      bodyLimit: CREATION_ATTACHMENT_MAX_BYTES + 64 * 1024,
      schema: { tags: ["mobile"], response: { 201: {}, 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError, 422: mobileAuthError } }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(attachmentLimiter, request, reply, auth.user.id, "creation-attachment-upload")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const query = attachmentUploadQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send the file with a filename.");
      }
      const data = request.body;
      if (!Buffer.isBuffer(data) || data.length === 0) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send the file as the request body.");
      }
      const draft = await prisma.mobileCreationDraft.findFirst({
        where: { id, userId: auth.user.id }
      });
      if (!draft) {
        return sendMobileError(reply, 404, "SESSION_NOT_FOUND", "This book chat was not found.");
      }
      const parsedPayload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
      if (!parsedPayload.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "This book chat needs to be restarted.");
      }
      const existing = parsedPayload.data.attachments ?? [];
      if (existing.length >= CREATION_ATTACHMENT_MAX_COUNT) {
        return sendMobileError(
          reply,
          409,
          "ATTACHMENT_LIMIT",
          `This chat already has ${CREATION_ATTACHMENT_MAX_COUNT} files. Remove one before adding another.`
        );
      }

      let attachment: CreationAttachment;
      try {
        attachment = await attachmentIngestion({
          data,
          name: query.data.filename,
          mimeType: query.data.mimeType,
          language: parsedPayload.data.language
        });
      } catch (error) {
        if (error instanceof CreationAttachmentError) {
          return sendMobileError(reply, 422, error.code, error.message);
        }
        request.log.warn({ err: error, draftId: id }, "Creation attachment ingestion failed");
        return sendMobileError(
          reply,
          422,
          "ATTACHMENT_FAILED",
          "That file could not be read. Try a different file or paste the text instead."
        );
      }

      // Keep the original bytes server-side so the file follows the account
      // across devices; the retention sweep removes them after 6 months.
      try {
        await saveCreationAttachmentFile(appConfig.ATTACHMENT_STORAGE_DIR, id, attachment.id, data);
      } catch (error) {
        request.log.error({ err: error, draftId: id }, "Creation attachment file store failed");
        return sendMobileError(reply, 422, "ATTACHMENT_FAILED", "That file could not be saved. Try again.");
      }

      const updatedPayload = mobileCreationDraftPayloadSchema.parse({
        ...parsedPayload.data,
        attachments: [...existing, attachment]
      });
      let updatedRevision = (draft.revision ?? 1) + 1;
      try {
        const updated = await updateCreationDraftCas({
          draft,
          expectedRevision: query.data.expectedRevision,
          data: { payload: jsonInputValue(updatedPayload) }
        });
        if (!updated) {
          await deleteCreationAttachmentFile(appConfig.ATTACHMENT_STORAGE_DIR, id, attachment.id);
          return sendCreationSessionConflict(reply, auth.user.id, id);
        }
        updatedRevision = updated.revision;
      } catch (error) {
        await deleteCreationAttachmentFile(appConfig.ATTACHMENT_STORAGE_DIR, id, attachment.id);
        throw error;
      }
      return reply
        .code(201)
        .send({
          attachment: serializeCreationAttachment(attachment, id),
          revision: updatedRevision
        });
    }
  );

  fastify.delete(
    "/api/mobile/creation-sessions/:id/attachments/:attachmentId",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id, attachmentId } = attachmentParamsSchema.parse(request.params);
      const mutationQuery = creationMutationQuerySchema.safeParse(request.query ?? {});
      if (!mutationQuery.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "The chat revision is invalid.");
      }
      const draft = await prisma.mobileCreationDraft.findFirst({
        where: { id, userId: auth.user.id }
      });
      if (!draft) {
        return sendMobileError(reply, 404, "SESSION_NOT_FOUND", "This book chat was not found.");
      }
      const parsedPayload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
      if (!parsedPayload.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "This book chat needs to be restarted.");
      }
      const attachments = parsedPayload.data.attachments ?? [];
      if (!attachments.some((attachment) => attachment.id === attachmentId)) {
        return sendMobileError(reply, 404, "ATTACHMENT_NOT_FOUND", "That attachment was not found.");
      }
      const referenced = (parsedPayload.data.messages ?? []).some((message) =>
        (message.attachments ?? []).some((ref) => ref.id === attachmentId)
      );
      if (referenced) {
        return sendMobileError(
          reply,
          409,
          "ATTACHMENT_IN_USE",
          "That file is already part of the conversation and can't be removed."
        );
      }
      const updatedPayload = mobileCreationDraftPayloadSchema.parse({
        ...parsedPayload.data,
        attachments: attachments.filter((attachment) => attachment.id !== attachmentId)
      });
      const updated = await updateCreationDraftCas({
        draft,
        expectedRevision: mutationQuery.data.expectedRevision,
        data: { payload: jsonInputValue(updatedPayload) }
      });
      if (!updated) {
        return sendCreationSessionConflict(reply, auth.user.id, id);
      }
      await deleteCreationAttachmentFile(appConfig.ATTACHMENT_STORAGE_DIR, id, attachmentId);
      return { ok: true, revision: updated.revision };
    }
  );

  fastify.get(
    "/api/mobile/creation-sessions/:id/attachments/:attachmentId/file",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id, attachmentId } = attachmentParamsSchema.parse(request.params);
      const draft = await prisma.mobileCreationDraft.findFirst({
        where: { id, userId: auth.user.id },
        select: { payload: true }
      });
      if (!draft) {
        return sendMobileError(reply, 404, "SESSION_NOT_FOUND", "This book chat was not found.");
      }
      const parsedPayload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
      const attachment = parsedPayload.success
        ? (parsedPayload.data.attachments ?? []).find((entry) => entry.id === attachmentId)
        : undefined;
      if (!attachment) {
        return sendMobileError(reply, 404, "ATTACHMENT_NOT_FOUND", "That attachment was not found.");
      }
      const file = await readCreationAttachmentFile(appConfig.ATTACHMENT_STORAGE_DIR, id, attachmentId);
      if (!file) {
        // Uploaded before server-side storage existed, or past the 6-month retention window.
        return sendMobileError(reply, 404, "ATTACHMENT_FILE_EXPIRED", "This file is no longer stored.");
      }
      reply.header("Cache-Control", "private, max-age=300");
      reply.type(attachment.mimeType);
      return file;
    }
  );

  fastify.patch(
    "/api/mobile/creation-sessions/:id/title",
    { attachValidation: true, schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsed = z
        .object({
          title: z.string().trim().min(1).max(160),
          expectedRevision: z.number().int().positive().optional()
        })
        .strict()
        .safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Provide a title between 1 and 160 characters.");
      }
      const draft = await prisma.mobileCreationDraft.findFirst({
        where: { id, userId: auth.user.id }
      });
      if (!draft) {
        return sendMobileError(reply, 404, "NOT_FOUND", "Chat session not found.");
      }
      const parsedPayload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
      if (!parsedPayload.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "This chat session could not be updated.");
      }
      const updatedPayload = mobileCreationDraftPayloadSchema.parse({
        ...parsedPayload.data,
        optionalDetails: {
          ...parsedPayload.data.optionalDetails,
          title: parsed.data.title
        }
      });
      const updated = await updateCreationDraftCas({
        draft,
        expectedRevision: parsed.data.expectedRevision,
        data: { payload: jsonInputValue(updatedPayload) }
      });
      if (!updated) {
        return sendCreationSessionConflict(reply, auth.user.id, id);
      }
      return { ok: true, revision: updated.revision };
    }
  );

  fastify.delete(
    "/api/mobile/creation-sessions/:id",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const draft = await prisma.mobileCreationDraft.findFirst({
        where: { id, userId: auth.user.id },
        select: { id: true }
      });
      if (!draft) {
        return sendMobileError(reply, 404, "NOT_FOUND", "Chat session not found.");
      }
      await prisma.mobileCreationDraft.delete({ where: { id } });
      await deleteCreationAttachmentDraftDir(appConfig.ATTACHMENT_STORAGE_DIR, id);
      return { ok: true };
    }
  );

  fastify.post(
    "/api/mobile/creation-sessions/:id/preflight",
    { attachValidation: true, schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(advisorLimiter, request, reply, auth.user.id, "creation-session-preflight")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsedBody = mobileCreationBuildBodySchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "These book settings are not supported.");
      }
      const prepared = await prepareMobileCreationBuild(auth.user.id, id, parsedBody.data);
      if (!prepared.ok) {
        return sendMobileError(reply, prepared.status, prepared.code, prepared.message);
      }
      const recommendations = await pageCountRecommendationsForPreflight(prepared.finalPayload, prepared.finalAdvisor);
      return {
        requiresPageCount: !prepared.pageCount.resolved,
        detectedPageCount: prepared.pageCount.resolved
          ? { targetPages: prepared.pageCount.targetPages, source: prepared.pageCount.source }
          : null,
        recommendations
      } satisfies MobileCreationBuildPreflightResponseDto;
    }
  );

  fastify.post(
    "/api/mobile/creation-sessions/:id/build",
    { attachValidation: true, schema: { tags: ["mobile"], response: { 201: {}, 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(generationLimiter, request, reply, auth.user.id, "creation-session-build")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsedBody = mobileCreationBuildBodySchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "These book settings are not supported.");
      }
      return sendFinalizeOutcome(
        reply,
        await finalizeMobileCreationDraft(auth.user.id, id, parsedBody.data, { requireResolvedPageCount: true })
      );
    }
  );
}

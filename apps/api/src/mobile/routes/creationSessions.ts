import { deleteCreationAttachmentDraftDir } from "../../attachmentStorage.js";
import { registerMobileCreationAttachmentRoutes } from "./creationAttachments.js";
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
  mergeCreationOptionalDetails,
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
  serializeCreationSession,
  updateCreationDraftCas,
  userTextFromMessages
} from "../creationSessions.js";
import {
  type MobileCreationBuildPreflightResponseDto,
  type MobileCreationConversationResponseDto,
} from "../dto.js";
import { hitAuthenticatedLimit, hitTieredLimit, requireMobileAuth, sendMobileError } from "../httpErrors.js";
import {
  DEFAULT_CREATION_TURN_TIMEOUT_MS,
  idParamsSchema,
  mobileAuthError,
  mobileCreationBranchBodySchema,
  mobileCreationBranchOpenApiBody,
  mobileCreationBuildBodySchema,
  mobileCreationBuildOpenApiBody,
  mobileCreationMessageBodySchema,
  mobileCreationMessageOpenApiBody,
  mobileCreationSessionStartBodySchema,
  mobileCreationSessionStartOpenApiBody
} from "../schemas.js";
import { jsonInputValue } from "../support.js";
import { prisma } from "@book-maker/db";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { advisorSnapshotForStorage, createCreationBuildHelpers, sendFinalizeOutcome } from "../creationBuild.js";
import type { MobileRouteContext } from "../routeContext.js";
import { enforceContentRestrictions } from "../../contentRestrictions.js";
import { fieldsFromJson as characterFieldsFromJson } from "../characterSerializer.js";
import {
  expandLibraryCharacterGraph,
  generationDescription,
  orderedCharacterRefs
} from "../characterMentions.js";

/**
 * Branching creation chat: sessions, messages, attachments, preflight and build.
 */

export async function registerMobileCreationSessionRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { appConfig, generationLimiter, advisorLimiter, draftLimiter, creationEnrichment, options } = context;
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
    {
      attachValidation: true,
      schema: { tags: ["mobile"], body: mobileCreationSessionStartOpenApiBody, response: { 201: {}, 401: mobileAuthError } }
    },
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
      if (firstMessage && !(await enforceContentRestrictions(reply, firstMessage))) {
        return;
      }
      let turn = greeting;
      let messages = normalizeCreationMessageIds(greetingMessages);
      let payload: MobileCreationDraftPayload;
      if (firstMessage) {
        // Same resolution as the message route: mentions must work on a chat's
        // very first message, not only once a session exists.
        const startMentionIds = [...new Set(parsedBody.data.mentionedCharacterIds ?? [])];
        // One scoped read: the graph names the ids it could not find, so the
        // ownership check is not a second query over the same rows.
        const { characters: startContextCharacters, missingIds: startMissingIds } =
          await expandLibraryCharacterGraph(auth.user.id, startMentionIds);
        if (startMissingIds.length > 0) {
          return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "A mentioned character is no longer in your library.");
        }
        // The message records what the reader tapped; the linked characters
        // ride the turn only.
        const startCharacterRefs = orderedCharacterRefs(startMentionIds, startContextCharacters);
        const nextMessages: MobileCreationMessage[] = [
          ...greetingMessages,
          {
            role: "user" as const,
            content: firstMessage,
            ...(startCharacterRefs.length > 0 ? { characters: startCharacterRefs } : {})
          }
        ].slice(-60);
        const turnRequest: MobileCreationTurnRequest = {
          messages: nextMessages,
          presets: parsedBody.data.presets ? mobileCreationPresetsSchema.parse(parsedBody.data.presets) : undefined,
          sourceNotes: parsedBody.data.sourceNotes,
          optionalDetails: parsedBody.data.optionalDetails,
          ...(startContextCharacters.length > 0
            ? {
                characters: startContextCharacters.map((character) => ({
                  id: character.id,
                  name: character.name,
                  description: generationDescription(character),
                  ...(character.appearance ? { appearance: character.appearance } : {}),
                  fields: characterFieldsFromJson(character.fields)
                }))
              }
            : {})
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
          optionalDetails: mergeCreationOptionalDetails(turnRequest.optionalDetails, turn),
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
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: mobileCreationMessageOpenApiBody,
        response: { 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!(await hitTieredLimit(advisorLimiter, request, reply, auth.user.id, "creation-session-message"))) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsedBody = mobileCreationMessageBodySchema.safeParse(request.body);
      if (!parsedBody.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send a short message to continue the chat.");
      }
      if (!(await enforceContentRestrictions(reply, parsedBody.data.message))) {
        return;
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

      // The write-time CAS below still decides the race; this early compare —
      // after the replay branch, whose retries legitimately carry a stale
      // revision — refuses a request that has already lost *before* the model
      // turn runs, instead of discovering the conflict after up to 85 seconds
      // of enrichment whose result gets thrown away.
      if (parsedBody.data.expectedRevision !== undefined && parsedBody.data.expectedRevision !== draft.revision) {
        return sendCreationSessionConflict(reply, auth.user.id, id);
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

      // Mentions resolve against the live library — same pattern as the
      // attachment pool above, except the pool is the user's own table. Only
      // the id and the name are read: the transcript stores a light ref, and
      // the sheets the model sees are the branch union loaded below, which is
      // a superset of this message's picks.
      const mentionedIds = [...new Set(parsedBody.data.mentionedCharacterIds ?? [])];
      const mentionedCharacters = mentionedIds.length
        ? await prisma.libraryCharacter.findMany({
            where: { id: { in: mentionedIds }, userId: auth.user.id },
            select: { id: true, name: true }
          })
        : [];
      if (mentionedCharacters.length !== mentionedIds.length) {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "A mentioned character is no longer in your library.");
      }
      const characterRefs = orderedCharacterRefs(mentionedIds, mentionedCharacters);

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
        ...(characterRefs.length > 0 ? { characters: characterRefs } : {}),
        ...(parsedBody.data.skippedQuestion ? { skippedQuestion: true } : {}),
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
      const activeMessages = linearizeCreationMessages(incoming.messages).active;
      // Every character mentioned anywhere on the ACTIVE branch rides the turn
      // as fresh library rows — re-read each turn so edits propagate, and
      // branch-scoped so an edited-away mention stays out of this thread.
      //
      // **The union is not capped, and must not be.** Each message caps its own
      // picks at ten, but a chat is many messages, and the system prompt tells
      // the model every selected sheet arrives under `characters`. Only the
      // linked characters behind them are bounded. A character deleted since
      // being mentioned drops out silently — the reader is not editing it now,
      // so `missingIds` is not a 404 here.
      const activeCharacterIds = [
        ...new Set(activeMessages.flatMap((message) => (message.characters ?? []).map((ref) => ref.id)))
      ];
      const { characters: activeCharacters } = await expandLibraryCharacterGraph(
        auth.user.id,
        activeCharacterIds
      );
      const turnRequest: MobileCreationTurnRequest = {
        messages: activeMessages,
        ...(activeCharacters.length > 0
          ? {
              characters: activeCharacters.map((character) => ({
                id: character.id,
                name: character.name,
                description: generationDescription(character),
                ...(character.appearance ? { appearance: character.appearance } : {}),
                fields: characterFieldsFromJson(character.fields)
              }))
            }
          : {}),
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
        optionalDetails: mergeCreationOptionalDetails(turnRequest.optionalDetails, turn),
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
        body: mobileCreationBranchOpenApiBody,
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

  await registerMobileCreationAttachmentRoutes(fastify, context);

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
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: mobileCreationBuildOpenApiBody,
        response: { 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!(await hitTieredLimit(advisorLimiter, request, reply, auth.user.id, "creation-session-preflight"))) {
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
      // Persist the advisor stamped with the revision and preset context it
      // was computed from, so the build tap that follows reuses it instead of
      // paying for the same calls again. Conditioned on the revision so a
      // concurrent chat message wins; losing this write only costs a recompute.
      await prisma.mobileCreationDraft.updateMany({
        where: { id, revision: prepared.draft.revision },
        data: {
          advisorSnapshot: jsonInputValue(
            advisorSnapshotForStorage(prepared.finalAdvisor, prepared.draft.revision, prepared.advisorContextFingerprint)
          )
        }
      });
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
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: mobileCreationBuildOpenApiBody,
        response: { 201: {}, 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!(await hitTieredLimit(generationLimiter, request, reply, auth.user.id, "creation-session-build"))) {
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

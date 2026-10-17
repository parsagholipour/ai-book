import { withChatStreaming } from "../chatStreaming.js";
import { settleMessageUsage } from "@book-maker/db/billing";
import { messageRequestKey, withMessageUsage } from "../messageUsage.js";
import { createSourceService } from "@book-maker/db";
import { jsonRecord, createSourceEmbedding, sourceRefsFromInput, type TextModelAdapter } from "@book-maker/core";
import { withInlineProviderUsage } from "../../inlineProviderUsage.js";
import { bookEditScopeFromMessage, classifyProjectChatMessage, type BookEditIntent } from "../../bookEditIntent.js";
import { bookMatterForRouter } from "../../bookEditMatter.js";
import { establishedChatLanguage, matterChatLanguage } from "../bookMatterChatLanguage.js";
import { PROJECT_CHAT_REPLY_COPY } from "../projectChatReplyCopy.js";
import { chatCopy } from "../../chatReplyCopy.js";
import { modelPageForReaderContext, numberingForProject } from "../../bookPageNumbering.js";
import { chatReplyQuoteFor } from "../../chatReplyQuote.js";
import { libraryCharacterAppearanceRule, libraryCharacterPromptBlock } from "@book-maker/core";
import { fieldsFromJson as characterFieldsFromJson } from "../characterSerializer.js";
import { applyOrCancelEditProposal } from "../editProposalActions.js";
import {
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
import { hitAuthenticatedLimit, requireMobileAuth, sendMobileError, sendProjectNotFound } from "../httpErrors.js";
import { redoLastBookEdit } from "../bookEditRedoApply.js";
import { undoLastBookEdit } from "../manualEdits.js";
import {
  activeProjectChatLeafId,
  chatChaptersForProject,
  chatPagesForProject,
  loadChatPageFeatures,
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
  PROJECT_CHAT_MESSAGE_MAX,
  mobileProjectChatMessageOpenApiBody,
  projectChatQuerySchema
} from "../schemas.js";
import { replayClaimedProposal } from "../proposalExecutionClaims.js";
import { isPrismaUniqueConflict } from "../support.js";
import { prisma } from "@book-maker/db";
import type { FastifyInstance } from "fastify";
import type { MobileRouteContext } from "../routeContext.js";
import { enforceContentRestrictions } from "../../contentRestrictions.js";
import { requireRequestWithoutSexualContent } from "../contentSafetyDoors.js";
import { expandLibraryCharacterGraph, generationDescription } from "../libraryMentionGraph.js";
import { orderedCharacterRefs } from "../libraryMentionRows.js";
import { aiWorkKindForMediaSettings, proposalRunsModel, requireAiCapacity } from "../aiCapacity.js";
import { proposalStartsLongLaneWork, requireBooksInProgressCapacity } from "../booksInProgress.js";

/**
 * Post-generation chat: messages, edit proposals, undo, redo and branch switching.
 */

export async function registerMobileProjectChatRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { safeFastRoutingTextModel, draftLimiter } = context;
  // Every model call the chat makes inline — the router, the book-matter
  // composer, answers and proposal follow-ups — writes its cost row, priced from
  // the provider's own token counts (`inlineProviderUsage.ts`).
  const costedRoutingTextModel = (projectId: string, userId: string): TextModelAdapter | undefined => {
    const model = safeFastRoutingTextModel();
    return model ? withInlineProviderUsage(model, { projectId, userId }) : undefined;
  };

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
        return sendProjectNotFound(reply);
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
    withChatStreaming(async (request, reply, onAssistantText) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsed = mobileProjectChatMessageBodySchema.safeParse(request.body);
      if (!parsed.success) {
        // The book chat's composer sets no length cap, so a pasted passage
        // reaches this; "Send a chat message." read as if nothing had been sent.
        const message = (request.body as { message?: unknown } | undefined)?.message;
        const tooLong = typeof message === "string" && message.trim().length > PROJECT_CHAT_MESSAGE_MAX;
        return sendMobileError(
          reply,
          400,
          "VALIDATION_ERROR",
          tooLong
            ? `That message is too long. Keep it under ${PROJECT_CHAT_MESSAGE_MAX.toLocaleString("en-US")} characters, or send it in parts.`
            : "Send a chat message."
        );
      }
      if (!(await enforceContentRestrictions(reply, parsed.data.message))) {
        return;
      }

      const project = await loadProjectForChat(auth.user.id, id);
      if (!project) {
        return sendProjectNotFound(reply);
      }

      if (parsed.data.requestId) {
        const replay = await replayProjectChatRequest(id, parsed.data.requestId);
        if (replay) {
          await settleMessageUsage(auth.user.id, messageRequestKey(`project:${id}`, parsed.data.requestId), true);
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
      // One scoped read answers both questions: the graph names every id it
      // could not find, so the ownership check needs no second query over the
      // very rows it just fetched.
      const mentionedIds = [...new Set(parsed.data.mentionedCharacterIds ?? [])];
      const { characters: contextCharacters, missingIds } = await expandLibraryCharacterGraph(
        auth.user.id,
        mentionedIds
      );
      if (missingIds.length > 0) {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "A mentioned character is no longer in your library.");
      }
      // The transcript records what the reader tapped, never what the links
      // dragged in behind it, which is what keeps the visible chip list equal
      // to the composer's.
      const characterRefs = orderedCharacterRefs(mentionedIds, contextCharacters);
      // The appearance travels with the profile, and the rule travels with it.
      // An edit is where a saved character is most likely to be *redrawn* —
      // "put Natalia on the last page" — and a model given only a biography
      // invents a look, writes it into the illustration prompt, and the prompt
      // beats the reference image attached beside it.
      const mentionSnapshots = contextCharacters.map((character) => ({
        id: character.id,
        name: character.name,
        description: generationDescription(character),
        ...(character.appearance ? { appearance: character.appearance } : {}),
        fields: characterFieldsFromJson(character.fields)
      }));
      const mentionContext = contextCharacters.length
        ? [
            "Mentioned character profiles (the user's own library characters; treat as authoritative canon):",
            libraryCharacterPromptBlock(mentionSnapshots),
            libraryCharacterAppearanceRule(mentionSnapshots)
          ]
            .filter(Boolean)
            .join("\n")
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
        : findPendingScopeClarification(activeMessages, parsed.data.message, currentScope);
      // The one-question rule's whole turn resolution lives in
      // resolvePendingEditTurn; this handler only consumes the verdict.
      const { resolvedPendingEdit, clarifyExhausted, resolvedMessage, confirmedPendingEdit, pendingScopeIsRecoverable, resolvesPendingScope } =
        resolvePendingEditTurn(pendingScope, parsed.data.message, { currentScope });
      // After the replay above and before the message is charged: most turns
      // reach the router, and a typed confirmation applies the card it confirms,
      // so that one asks at the book's own tier, as the Apply button does. A
      // typed cancel is answered without a model and is never refused.
      const turnKind =
        confirmedPendingEdit && pendingScope && proposalRunsModel(pendingScope)
          ? aiWorkKindForMediaSettings(project.mediaSettings)
          : "standard";
      if (
        !(pendingScope && isPendingEditCancellationMessage(parsed.data.message)) &&
        !(await requireAiCapacity(request, reply, auth.user.id, turnKind))
      ) {
        return;
      }
      // A typed confirmation of a continuation, rebuild or whole-book rewrite card is that card's
      // Apply, so it meets the same books-in-progress limit the button does.
      if (
        confirmedPendingEdit &&
        pendingScope &&
        proposalStartsLongLaneWork(pendingScope) &&
        !(await requireBooksInProgressCapacity(reply, auth.user.id, { exceptProjectIds: [id] }))
      ) {
        return;
      }
      // The operator's sexual-content filter, on the reader's own words before
      // any edit is routed, proposed or held for — a typed cancel excepted,
      // which asks nothing of a model (`contentSafetyDoors.ts`).
      if (
        !(pendingScope && isPendingEditCancellationMessage(parsed.data.message)) &&
        !(await requireRequestWithoutSexualContent(context, reply, {
          userId: auth.user.id,
          projectId: id,
          text: parsed.data.message,
          door: "project_chat",
          log: request.log
        }))
      ) {
        return;
      }

      return withMessageUsage({ userId: auth.user.id, projectId: id, requestKey: messageRequestKey(`project:${id}`, parsed.data.requestId) }, reply, async () => {
        // Admission rejects in-flight replays before this turn-rate check.
        if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "project-chat")) return;
        let userMessage: MobileProjectChatMessageRecord;
        try {
          // A recovered attempt can have saved its USER row before dying.
          // Its exclusive message lease permits resuming that same turn.
          const abandoned = parsed.data.requestId ? await prisma.projectChatMessage.findUnique({
            where: { projectId_requestId: { projectId: id, requestId: parsed.data.requestId } }
          }) : null;
          userMessage = abandoned ?? await createUserProjectChatMessage({
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
          // No model reads a cancel word, so it is answered in the language the
          // conversation already speaks — a Persian matter question answered
          // "cancel" used to get its one English reply here.
          const replyLanguage = matterChatLanguage(undefined, activeMessages);
          const replyMessage = await createAssistantChatMessage({
            projectId: id,
            parentId: userMessage.id,
            content: chatCopy(PROJECT_CHAT_REPLY_COPY, replyLanguage).cancelled,
            metadata: { pendingEditCancelled: true, charged: false, replyLanguage }
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
              ...(editProposalCardFromState(pendingScope, numberingForProject(project))
                ? { editProposal: editProposalCardFromState(pendingScope, numberingForProject(project)) }
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

        // What each page carries, so a request about one kind of content can be
        // scoped to the pages that have it rather than quoted for the whole book.
        const pages = chatPagesForProject(project, await loadChatPageFeatures(project.id));
        const stage = chatStageForProject(project.status, project.currentPlan, project.mediaSettings);
        const routingTextModel = costedRoutingTextModel(project.id, auth.user.id);
        const sourceRefs = sourceRefsFromInput({ mediaSettings: jsonRecord(jsonRecord(project.currentPlan?.inputSnapshot).mediaSettings ?? project.mediaSettings) });
        // With a current page map, the numbers the user types are the printed PDF
        // pages they can see; without one everything stays in model indexes.
        const pageNumbering = numberingForProject(project);
        // The app's locator already resolved the selection to a model page; it is
        // authoritative over re-parsing the composed text. A selection the
        // locator could not place still names the printed page it came from,
        // which the map can resolve.
        const readerSelection = (() => {
          const context = parsed.data.readerContext;
          if (!context) {
            return undefined;
          }
          if (context.pageIndex !== undefined) {
            return { pageIndex: context.pageIndex };
          }
          // A physical PDF page is only meaningful against the exact file it was
          // read from, which is why the request carries that file's digest and
          // not just its revision: during EDITING the map in force is the
          // previous compile's, still on screen, and a repair can republish the
          // same revision over different bytes. A sheet that cannot be tied to
          // the map in force names no page — the message's own printed numbers
          // are re-read as they always were, rather than a sheet being resolved
          // through the wrong book.
          const resolved = modelPageForReaderContext(pageNumbering, context, project.contentRevision);
          return resolved !== undefined ? { pageIndex: resolved } : undefined;
        })();

        // A pure confirmation of a priced proposal skips re-routing so the
        // already-quoted credit cost and page targets stay authoritative.
        const confirmedProposal =
          confirmedPendingEdit && pendingScope?.intent
            ? pendingScope
            : null;
        // Only a language some turn recorded is "established"; English by
        // default would tell the router a pre-language Persian chat is English.
        const conversationLanguage = establishedChatLanguage(undefined, activeMessages);
        const intent = confirmedProposal?.intent
          ? confirmedProposal.intent
          : await classifyProjectChatMessage({
              ...(onAssistantText ? { onRoutingStart: () => onAssistantText("") } : {}),
              message: resolvedMessage,
              stage,
              pages,
              chapters: chatChaptersForProject(project),
              planSummary: project.currentPlan
                ? planSummaryForClassifier(project.currentPlan, project.language)
                : undefined,
              recentMessages: activeMessages.slice(-12).map((message) => ({
                role: message.role === "USER" ? "user" : "assistant",
                content: message.content
              })),
              ...(conversationLanguage ? { conversationLanguage } : {}),
              textModel: routingTextModel,
              ...(sourceRefs.length ? { sourceService: createSourceService(auth.user.id, sourceRefs, createSourceEmbedding(context.appConfig)) } : {}),
              loadPageBody: async (index) => (await loadChatPageBodies(id, [index])).get(index) ?? null,
              clarifyExhausted,
              pageNumbering,
              ...(project.language ? { language: project.language } : {}),
              bookMatter: bookMatterForRouter(project),
              ...(readerSelection ? { readerSelection } : {}),
              // Given to the router, not merged into the message: without a
              // referent "make that shorter" falls to the heuristics' catch-all
              // clarify, and a second unresolved turn is forced into a whole-book
              // rewrite. The heuristics and page targeting never see it.
              ...(replyTo ? { replyTo } : {})
            });

        // Answering questions and reading content are always allowed while a job
        // runs; every write, including a free presentation preference, is saved
        // as the project's one pending edit. A presentation recompile owns an
        // EDITING revision and its settled-status fallback, so it may not start
        // alongside an ordinary edit that already owns that lifecycle.
        // This turn's mentions win; a resumed pending edit otherwise keeps the
        // sheets it was created with. Computed before the busy gate so a
        // deflected mention edit saves its sheets for the resume.
        const characterContext = mentionContext ?? pendingScope?.characterContext;
        const openEditBlocked = await hasOpenProjectWork(id);
        const alwaysAllowedWhileBusy = ["answer", "clarify", "show_content"];
        // Listing the page designs is a reply, not a write.
        const listsDesigns = intent.kind === "page_design" && intent.pageDesign?.list === true;
        if (openEditBlocked && !alwaysAllowedWhileBusy.includes(intent.kind) && !listsDesigns) {
          // A typed confirmation racing the Apply button: when the "busy" job is
          // the button's own execution of this very proposal, saving the request
          // as a pending edit would let a later nudge rebuild and re-charge it.
          if (confirmedProposal?.proposalId) {
            const claimed = await replayClaimedProposal(id, confirmedProposal.proposalId);
            if (claimed) return claimed;
          }
          // Undo and redo name no edit to save for later: the Undo button's own
          // route answers a busy book this way, and a typed one used to become
          // the book's one pending edit — replacing the request the reader had
          // saved a moment earlier, and running an undo on "apply it" against
          // whatever had finished in between.
          if (intent.kind === "undo_last_edit" || intent.kind === "redo_last_edit") {
            const replyLanguage = matterChatLanguage(intent.responseLanguage, activeMessages);
            const copy = chatCopy(PROJECT_CHAT_REPLY_COPY, replyLanguage);
            const replyMessage = await createAssistantChatMessage({
              projectId: id,
              parentId: userMessage.id,
              content: intent.kind === "undo_last_edit" ? copy.undoBusy : copy.redoBusy,
              metadata: { intent, replyLanguage, blockedByActiveJob: true, charged: false }
            });
            return {
              ...(await loadProjectChatResponse(id)),
              reply: serializeProjectChatMessage(replyMessage),
              operation: null
            } satisfies MobileProjectChatMessageResponseDto;
          }
          const replyMessage = await busyEditReply({
            projectId: id,
            parentMessageId: userMessage.id,
            intent,
            request: resolvedMessage,
            activeMessages,
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
          onAssistantText,
          userId: auth.user.id,
          project,
          userMessageId: userMessage.id,
          message: resolvedMessage,
          intent,
          textModel: routingTextModel,
          ...(sourceRefs.length ? { sourceService: createSourceService(auth.user.id, sourceRefs, createSourceEmbedding(context.appConfig)) } : {}),
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
          operation: outcome.operation
            ? serializeBookEditOperation(outcome.operation, { pageNumbering })
            : null
        } satisfies MobileProjectChatMessageResponseDto;
      });
    })
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
      if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "project-chat")) {
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
        textModel: costedRoutingTextModel(id, auth.user.id)
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
      if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "project-chat")) {
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
        textModel: costedRoutingTextModel(id, auth.user.id)
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
      if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "project-chat")) {
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
        return sendProjectNotFound(reply);
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
    "/api/mobile/projects/:id/chat/edits/redo",
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
      if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "project-chat")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsed = mobileChatUndoBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Could not redo that edit.");
      }
      const project = await loadProjectForChat(auth.user.id, id);
      if (!project) {
        return sendProjectNotFound(reply);
      }
      if (parsed.data.requestId) {
        const replay = await replayProjectChatRequest(id, parsed.data.requestId);
        if (replay) {
          return replay;
        }
      }

      if (await hasOpenProjectWork(id)) {
        return sendMobileError(
          reply,
          409,
          "PROJECT_BUSY",
          "This book is still being worked on. Try the redo again once the current job finishes."
        );
      }

      const activeMessages = await loadActiveProjectChatMessages(id);
      let userMessage: MobileProjectChatMessageRecord;
      try {
        userMessage = await createUserProjectChatMessage({
          projectId: id,
          parentId: activeProjectChatLeafId(activeMessages),
          content: "Redo",
          requestId: parsed.data.requestId,
          metadata: { redoAction: true }
        });
      } catch (error) {
        if (parsed.data.requestId && isPrismaUniqueConflict(error)) {
          const replay = await replayProjectChatRequest(id, parsed.data.requestId);
          if (replay) {
            return replay;
          }
          return sendMobileError(reply, 409, "REQUEST_IN_PROGRESS", "That request is still being processed. Try again in a moment.");
        }
        throw error;
      }

      const intent: BookEditIntent = {
        kind: "redo_last_edit",
        confidence: 1,
        reasoning: "Explicit redo API.",
        affectedPageIndexes: [],
        assistantMessage: "I’ll put the last undone edit back.",
        scope: "none",
        impact: "small_text",
        clarification: "none"
      };
      const replyMessage = await redoLastBookEdit(project, intent, userMessage.id);
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
        return sendProjectNotFound(reply);
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

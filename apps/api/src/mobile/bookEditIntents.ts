import { type BookEditIntent, type BookEditIntentKind } from "../bookEditIntent.js";
import { editProposalMessage, editProposalSummary } from "./bookEditCopy.js";
import { numberingForProject, MODEL_PAGE_NUMBERING, type ReaderPageNumbering } from "../bookPageNumbering.js";
import { proposeAddImageEdit } from "./addImageOperations.js";
import { proposeImageLayoutEdit } from "./imageLayoutOperations.js";
import { type ChatReplyQuote } from "../chatReplyQuote.js";
import { applyBackMatterEdit } from "./backMatterEdits.js";
import { applyChapterHeadingEdit } from "./chapterHeadingEdits.js";
import { affectedPagesForIntent, continuationNewPageCount, exactReplacementFromMessage } from "./bookEditScope.js";
import { exactReplacementPreviewCard, planExactReplacement } from "./exactReplacementPreview.js";
import { type MobileBookEditOperationRecord, type MobileProjectChatMessageRecord, type MobileProjectChatMessageResponseDto } from "./dto.js";
import {
  createOpenBookEditOperation,
  hasOpenProjectWork,
  queueChatBookEdit,
  queueChatPlanRevision
} from "./editOperations.js";
import { sendMobileError, sendProjectNotFound } from "./httpErrors.js";
import { undoLastBookEdit } from "./manualEdits.js";
import {
  activeProjectChatLeafId,
  createAssistantChatMessage,
  createUserProjectChatMessage,
  loadActiveProjectChatMessages,
  loadChatPageBodies,
  loadProjectChatResponse,
  loadProjectForChat,
  replayProjectChatRequest,
  serializeBookEditOperation,
  serializeProjectChatMessage,
  type ProjectForChat
} from "./projectChat.js";
import { bookEditCreditCost, operationKindForIntent } from "./bookEditPricing.js";
import { generateGroundedProjectAnswer } from "./groundedAnswer.js";
import { replayClaimedProposal } from "./proposalExecutionClaims.js";
import { isPrismaUniqueConflict, jsonInputValue, languageDisplayName } from "./support.js";
import { findPendingProposalById, type PendingEditState } from "./pendingEditState.js";
import { bookPlanSchema, chapterDisplayHeading, resolveStructuralPageEdit, type TextModelAdapter } from "@book-maker/core";
import { type FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import {
  structuralCardBlock,
  structuralCardPlanOf,
  structuralEditForProposal,
  structuralPagesOf,
  structuralRefusalMessage
} from "./structuralPageEdits.js";

/** Classifies chat into a book-edit intent, price, and confirmation reply. */

// Reading pending-edit state back out of the transcript moved to its own leaf
// module; re-exported here because every consumer historically imported it
// from this file.
export * from "./pendingEditState.js";

// The proposal-card and queued-reply prose lives in bookEditCopy.ts; re-exported
// because every consumer historically imported it from this file.
export { editProposalMessage, editProposalSummary, operationQueuedMessage } from "./bookEditCopy.js";


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
      content: "Okay, I dropped that request. Nothing was changed or charged.",
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


export async function handleProjectChatIntent(options: {
  userId: string;
  project: ProjectForChat;
  userMessageId: string;
  message: string;
  intent: BookEditIntent;
  textModel?: TextModelAdapter | undefined;
  /** When true, a previously priced proposal is executed immediately. */
  executeProposal?: boolean | undefined;
  /** Stable claim shared by typed confirmation and the proposal Apply button. */
  executionCommandId?: string | undefined;
  /** The credits the executed proposal's card showed — a ceiling on the charge. */
  quotedCredits?: number | undefined;
  /**
   * What the user originally asked for, when `message` is that request merged
   * with a follow-up. Stored as the resumable request so a clarification chain
   * keeps pointing at the real ask instead of accumulating each follow-up.
   */
  pendingRequest?: string | undefined;
  /**
   * True when this request already spent its one clarifying question. The
   * proposal path then widens an unresolvable scope instead of asking again.
   */
  clarifyExhausted?: boolean | undefined;
  /**
   * The message this turn replies to. Only the grounded answer reads it — the
   * priced paths take their target from `message`, so a quote cannot change
   * what an edit costs or which pages it rewrites.
   */
  replyTo?: ChatReplyQuote | undefined;
  /**
   * The @-mentioned library characters' sheets, as a bounded prompt block.
   * Appended to the request only where it reaches the worker's prompts (the
   * job payload, the plan-revision message) — never to `message` itself, whose
   * text drives page targeting and exact-replacement parsing — and stored on
   * every pending state so a clarify → confirm → Apply chain keeps it.
   */
  characterContext?: string | undefined;
  /** The turn's already-loaded active messages; saves the grounded answer a re-read. */
  activeMessages?: MobileProjectChatMessageRecord[] | undefined;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  const { userId, project, userMessageId, message, intent } = options;
  const pendingRequest = options.pendingRequest?.trim() || message;
  const characterContext = options.characterContext?.trim() || undefined;
  if (intent.kind === "answer" || intent.kind === "clarify") {
    const answer =
      intent.kind === "answer"
        ? await generateGroundedProjectAnswer(
            project,
            message,
            intent.assistantMessage,
            options.textModel,
            options.replyTo,
            options.activeMessages
          )
        : intent.assistantMessage;
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      content: answer,
      metadata: {
        intent,
        charged: false,
        ...(intent.kind === "clarify" && intent.clarification === "scope"
          ? {
              pendingEdit: {
                request: pendingRequest,
                clarification: "scope",
                ...(characterContext ? { characterContext } : {})
              }
            }
          : {})
      }
    });
    return { reply, operation: null };
  }

  if (intent.kind === "show_content") {
    const reply = await replyWithContentCard(project, intent, userMessageId);
    return { reply, operation: null };
  }

  if (intent.kind === "undo_last_edit") {
    const reply = await undoLastBookEdit(project, intent, userMessageId);
    return { reply, operation: null };
  }

  if (intent.kind === "plan_revision") {
    if (!project.currentPlan) {
      const reply = await createAssistantChatMessage({
        projectId: project.id,
        parentId: userMessageId,
        content: "I need a saved book plan before I can revise it.",
        metadata: { intent, charged: false }
      });
      return { reply, operation: null };
    }
    return queueChatPlanRevision({
      userId,
      project,
      userMessageId,
      message,
      intent,
      ...(characterContext ? { characterContext } : {})
    });
  }

  if (intent.kind === "back_matter" && ["COMPLETE", "REVIEW_REQUIRED"].includes(project.status)) {
    const reply = await applyBackMatterEdit(project, intent, userMessageId);
    return { reply, operation: null };
  }

  if (intent.kind === "chapter_heading" && ["COMPLETE", "REVIEW_REQUIRED"].includes(project.status)) {
    const reply = await applyChapterHeadingEdit(project, intent, userMessageId);
    return { reply, operation: null };
  }

  if (!["COMPLETE", "REVIEW_REQUIRED"].includes(project.status)) {
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      content: "Book text edits are available after the latest book has finished generating.",
      metadata: { intent, charged: false }
    });
    return { reply, operation: null };
  }

  if (options.executeProposal) {
    return queueChatBookEdit({
      userId,
      project,
      userMessageId,
      message,
      intent,
      ...(options.executionCommandId ? { executionCommandId: options.executionCommandId } : {}),
      ...(options.quotedCredits !== undefined ? { quotedCredits: options.quotedCredits } : {}),
      ...(characterContext ? { characterContext } : {})
    });
  }
  return proposeBookEdit({
    project,
    userMessageId,
    message,
    intent,
    pendingRequest,
    ...(options.clarifyExhausted ? { clarifyExhausted: true } : {}),
    ...(characterContext ? { characterContext } : {})
  });
}

/**
 * Prices a charged book edit and asks the user to confirm before any credits
 * are reserved. The proposal is stored in message metadata so Apply (API or
 * chat confirmation) can execute it without re-routing.
 */
export async function proposeBookEdit(options: {
  project: ProjectForChat;
  userMessageId: string;
  message: string;
  intent: BookEditIntent;
  /** The originally requested change when `message` also carries a follow-up. */
  pendingRequest?: string | undefined;
  /** The one clarifying question was already asked; never ask a second. */
  clarifyExhausted?: boolean | undefined;
  /** Mentioned character sheets; stored on the pending state, never the card. */
  characterContext?: string | undefined;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: null }> {
  const { project, userMessageId, message } = options;
  let intent = options.intent;
  const numbering = numberingForProject(project);
  const pendingRequest = options.pendingRequest?.trim() || message;
  const characterContext = options.characterContext?.trim() || undefined;
  const proposalId = randomUUID();
  if (intent.kind === "restructure_pages") {
    // Forked ahead of everything else because `affectedPagesForIntent` filters
    // against pages that *currently exist*: a page about to be created is not
    // one of them, so an insert reaching it is answered "which page or exact
    // phrase should I edit?" and never gets a card at all.
    const resolved = resolveStructuralPageEdit(structuralEditForProposal(intent), structuralPagesOf(project));
    if (!resolved.ok) {
      const reply = await createAssistantChatMessage({
        projectId: project.id,
        parentId: userMessageId,
        content: structuralRefusalMessage(resolved.reason, intent, numbering),
        metadata: { intent, charged: false, pendingEditCancelled: true }
      });
      return { reply, operation: null };
    }
    const cost = bookEditCreditCost(intent.kind, resolved.plan.pagesBilled, project);
    const proposalIntent = { ...intent, clarification: "none" as const };
    // Stored beside the quote for the same reason the quote is stored: the
    // resolver worked both out against the book, and a card rebuilt from this
    // state — a recovery reply, a credits-blocked resume — has no pages to
    // resolve against. Without it that card loses its chip entirely.
    const structuralPlan = structuralCardPlanOf(intent, resolved.plan);
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      // Same numbering *and the same resolved plan* as the card's summary
      // below: this bubble is the only other place a structural edit prints
      // page numbers, and a model index here beside a printed one there — or
      // the request's unclamped anchor here beside the resolver's there — names
      // two different pages.
      content: editProposalMessage(intent.kind, [], intent, numbering, structuralPlan),
      metadata: {
        intent: proposalIntent,
        charged: false,
        pendingEdit: pendingEditMetadataFromState({
          request: message,
          scope: "none",
          clarification: "confirm",
          intent: proposalIntent,
          affectedPageIndexes: [],
          credits: cost,
          proposalId,
          structuralPlan,
          ...(characterContext ? { characterContext } : {})
        }),
        editProposal: {
          id: proposalId,
          kind: intent.kind,
          scope: "none",
          affectedPageIndexes: [],
          credits: cost,
          summary: editProposalSummary(intent.kind, [], intent, numbering, structuralPlan),
          // The card says how many pages and where, in printed numbering — the
          // wart the `continue_book` card still has, where "8 new chapters"
          // carries a four-figure quote with no page count anywhere on it.
          structural: structuralCardBlock(intent, structuralPlan, numbering)
        }
      }
    });
    return { reply, operation: null };
  }
  if (intent.kind === "continue_book") {
    const newPageCount = continuationNewPageCount(intent, project);
    const cost = bookEditCreditCost(intent.kind, newPageCount, project);
    const proposalIntent = { ...intent, clarification: "none" as const };
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      content: editProposalMessage(intent.kind, [], intent),
      metadata: {
        intent: proposalIntent,
        charged: false,
        pendingEdit: pendingEditMetadataFromState({
          request: message,
          scope: "none",
          clarification: "confirm",
          intent: proposalIntent,
          affectedPageIndexes: [],
          credits: cost,
          proposalId,
          ...(characterContext ? { characterContext } : {})
        }),
        editProposal: {
          id: proposalId,
          kind: intent.kind,
          scope: "none",
          affectedPageIndexes: [],
          credits: cost,
          summary: editProposalSummary(intent.kind, [], intent, numbering)
        }
      }
    });
    return { reply, operation: null };
  }
  if (intent.kind === "book_replan") {
    const cost = bookEditCreditCost(intent.kind, 0, project, { replanSettings: intent.replanSettings });
    const proposalIntent = { ...intent, clarification: "none" as const };
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      content: editProposalMessage(intent.kind, [], intent),
      metadata: {
        intent: proposalIntent,
        charged: false,
        pendingEdit: pendingEditMetadataFromState({
          request: message,
          scope: intent.scope === "none" ? "all_pages" : intent.scope,
          clarification: "confirm",
          intent: proposalIntent,
          affectedPageIndexes: [],
          credits: cost,
          proposalId,
          ...(characterContext ? { characterContext } : {})
        }),
        editProposal: {
          id: proposalId,
          kind: intent.kind,
          scope: intent.scope === "none" ? "all_pages" : intent.scope,
          affectedPageIndexes: [],
          ...(intent.affectedChapterIndex ? { affectedChapterIndex: intent.affectedChapterIndex } : {}),
          ...(intent.targetLanguage ? { targetLanguage: intent.targetLanguage } : {}),
          credits: cost,
          summary: editProposalSummary(intent.kind, [], intent, numbering)
        }
      }
    });
    return { reply, operation: null };
  }

  if (intent.kind === "add_image") {
    // Dedicated branch (implemented next door with the rest of the image
    // machinery): the target comes from the placement or the subject-anchored
    // default, never from affectedPagesForIntent, so an image request can
    // never reach the generic zero-page "which page?" question below.
    return proposeAddImageEdit({
      project,
      userMessageId,
      message,
      intent,
      proposalId,
      ...(characterContext ? { characterContext } : {})
    });
  }

  if (intent.kind === "move_image" || intent.kind === "remove_image") {
    return proposeImageLayoutEdit({
      project,
      userMessageId,
      message,
      intent,
      proposalId,
      ...(characterContext ? { characterContext } : {})
    });
  }

  let affectedPageIndexes = await affectedPagesForIntent(intent, message, project);
  if (affectedPageIndexes.length === 0 && options.clarifyExhausted && intent.kind !== "chapter_regenerate") {
    // The one clarifying question is spent, so an unresolvable scope widens to
    // the whole book — the same default forcedDecision applies — instead of
    // firing the question a second time. Safe for the same reason that default
    // is: nothing runs until the proposal card is applied.
    const widened: BookEditIntent = { ...intent, scope: "all_pages" };
    const widenedPages = await affectedPagesForIntent(widened, message, project);
    if (widenedPages.length > 0) {
      intent = widened;
      affectedPageIndexes = widenedPages;
    }
  }
  if (affectedPageIndexes.length === 0) {
    if (options.clarifyExhausted && intent.kind === "chapter_regenerate") {
      // No second question: name what exists, settle the stale pending edit so
      // it stops resurfacing, and invite a self-contained instruction.
      const reply = await createAssistantChatMessage({
        projectId: project.id,
        parentId: userMessageId,
        content: `I couldn’t find chapter ${intent.affectedChapterIndex ?? ""} in this book — it has ${project.chapters.length} chapter${project.chapters.length === 1 ? "" : "s"}. Nothing was changed or charged. To go ahead, tell me which one — for example “rewrite chapter 2”.`.replace("  ", " "),
        metadata: {
          intent: { ...intent, kind: "clarify", affectedPageIndexes, clarification: "none" },
          pendingEditCancelled: true,
          charged: false
        }
      });
      return { reply, operation: null };
    }
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      content:
        intent.kind === "chapter_regenerate"
          ? `I couldn’t find chapter ${intent.affectedChapterIndex ?? ""} in this book. Which chapter or pages should I rewrite?`.replace("  ", " ")
          : "Which page or exact phrase should I edit?",
      metadata: {
        intent: { ...intent, kind: "clarify", affectedPageIndexes, clarification: "scope" },
        pendingEdit: {
          request: pendingRequest,
          clarification: "scope",
          ...(characterContext ? { characterContext } : {})
        },
        charged: false
      }
    });
    return { reply, operation: null };
  }

  // A literal find/replace is computable here, so it is quoted as what it is:
  // a known diff at no charge, rather than a per-page estimate for a rewrite
  // the worker was never going to run.
  const patch =
    intent.kind === "local_patch"
      ? await planExactReplacement(project.id, exactReplacementFromMessage(message), affectedPageIndexes)
      : null;
  if (patch) {
    affectedPageIndexes = patch.pageIndexes;
  }
  const cost = bookEditCreditCost(intent.kind, affectedPageIndexes.length, project, {
    deterministic: Boolean(patch)
  });
  const proposalIntent: BookEditIntent = {
    ...intent,
    affectedPageIndexes,
    clarification: "none",
    scope:
      intent.scope === "all_pages" || intent.scope === "matching_pages"
        ? intent.scope
        : affectedPageIndexes.length > 0
          ? "explicit_pages"
          : intent.scope
  };
  const reply = await createAssistantChatMessage({
    projectId: project.id,
    parentId: userMessageId,
    content: editProposalMessage(intent.kind, affectedPageIndexes, proposalIntent, numbering),
    metadata: {
      intent: proposalIntent,
      charged: false,
      pendingEdit: pendingEditMetadataFromState({
        request: message,
        scope: proposalIntent.scope,
        clarification: "confirm",
        intent: proposalIntent,
        affectedPageIndexes,
        credits: cost,
        proposalId,
        ...(characterContext ? { characterContext } : {})
      }),
      editProposal: {
        id: proposalId,
        kind: intent.kind,
        scope: proposalIntent.scope,
        affectedPageIndexes,
        ...(numbering.pdfPageMap ? { readerPageNumbers: numbering.displayPages(affectedPageIndexes) } : {}),
        ...(proposalIntent.affectedChapterIndex ? { affectedChapterIndex: proposalIntent.affectedChapterIndex } : {}),
        ...(proposalIntent.targetLanguage ? { targetLanguage: proposalIntent.targetLanguage } : {}),
        credits: cost,
        summary: editProposalSummary(intent.kind, affectedPageIndexes, proposalIntent, numbering),
        ...(patch ? { preview: exactReplacementPreviewCard(patch) } : {})
      }
    }
  });
  return { reply, operation: null };
}

export function pendingEditMetadataFromState(state: PendingEditState): Record<string, unknown> {
  return {
    request: state.request,
    clarification: state.clarification,
    ...(state.intent ? { intent: state.intent } : {}),
    ...(state.affectedPageIndexes ? { affectedPageIndexes: state.affectedPageIndexes } : {}),
    ...(state.credits !== undefined ? { credits: state.credits } : {}),
    ...(state.proposalId ? { proposalId: state.proposalId } : {}),
    ...(state.structuralPlan ? { structuralPlan: state.structuralPlan } : {}),
    ...(state.characterContext ? { characterContext: state.characterContext } : {})
  };
}

export function editProposalCardFromState(
  state: PendingEditState,
  numbering: ReaderPageNumbering = MODEL_PAGE_NUMBERING
): Record<string, unknown> | null {
  if (!state.intent) {
    return null;
  }
  const affectedPageIndexes = state.affectedPageIndexes ?? state.intent.affectedPageIndexes;
  return {
    ...(state.proposalId ? { id: state.proposalId } : {}),
    kind: state.intent.kind,
    scope: state.intent.scope,
    affectedPageIndexes,
    ...(numbering.pdfPageMap ? { readerPageNumbers: numbering.displayPages(affectedPageIndexes) } : {}),
    ...(state.intent.affectedChapterIndex ? { affectedChapterIndex: state.intent.affectedChapterIndex } : {}),
    ...(state.intent.targetLanguage ? { targetLanguage: state.intent.targetLanguage } : {}),
    ...(state.credits !== undefined ? { credits: state.credits } : {}),
    // The chip a restructure card draws is this block and nothing else: its
    // `affectedPageIndexes` are deliberately empty, so a rebuilt card without
    // it falls through to "Matching pages" for an edit that named pages 3 and
    // 5 — or created pages that do not exist yet.
    ...(state.structuralPlan
      ? { structural: structuralCardBlock(state.intent, state.structuralPlan, numbering) }
      : {}),
    // The stored plan reaches the summary too: it is the resolver's clamped
    // anchor, and a sentence built from the request's own would contradict the
    // chip immediately above it.
    summary: editProposalSummary(
      state.intent.kind,
      affectedPageIndexes,
      state.intent,
      numbering,
      state.structuralPlan
    )
  };
}

/**
 * The saved-for-later reply used whenever a new edit cannot start because the
 * project already has open work. The request is preserved in metadata so a
 * later "apply it" can run it once the current job settles. When the deflected
 * turn was an already-confirmed proposal, the full priced state rides along —
 * without it the resume re-routed through the model and re-proposed the edit
 * the user had already approved.
 */
export async function busyEditReply(options: {
  projectId: string;
  parentMessageId: string;
  intent: BookEditIntent;
  request: string;
  /** The confirmed proposal this busy reply deflected, when there is one. */
  pendingState?: PendingEditState | undefined;
  /** Mentioned character sheets, kept on the saved pending edit for the resume. */
  characterContext?: string | undefined;
}): Promise<MobileProjectChatMessageRecord> {
  const pendingState: PendingEditState = {
    ...(options.pendingState ?? {
      request: options.request,
      scope: "none" as const,
      ...(options.characterContext ? { characterContext: options.characterContext } : {})
    }),
    clarification: "busy"
  };
  const resumesWithoutProposal =
    options.intent.kind === "back_matter" || options.intent.kind === "chapter_heading";
  return createAssistantChatMessage({
    projectId: options.projectId,
    parentId: options.parentMessageId,
    content: pendingState.proposalId || resumesWithoutProposal
      ? "This book is still being worked on, so I saved that request. Say “apply it” once the current job finishes and I’ll run it. You can keep asking questions in the meantime."
      : "This book is still being worked on, so I saved that request. Say “apply it” once the current job finishes and I’ll set it up for you to confirm. You can keep asking questions in the meantime.",
    metadata: {
      intent: options.intent,
      blockedByActiveJob: true,
      charged: false,
      pendingEdit: pendingEditMetadataFromState(pendingState)
    }
  });
}

export type MobileContentCard = {
  type: "outline" | "chapter" | "page";
  title: string;
  sections: Array<{ label: string; body: string }>;
};

/**
 * Free read-only replies: outline, chapter, or page content rendered by the
 * mobile app as a structured content card.
 */
export async function replyWithContentCard(
  project: ProjectForChat,
  intent: BookEditIntent,
  parentId: string
): Promise<MobileProjectChatMessageRecord> {
  const target = intent.contentTarget ?? { type: "outline" as const };
  const card = await contentCardForTarget(project, target);
  if (!card) {
    return createAssistantChatMessage({
      projectId: project.id,
      parentId,
      content:
        target.type === "page"
          ? "I couldn’t find that page yet. Pages appear here once they’re generated."
          : target.type === "chapter"
            ? "I couldn’t find that chapter yet."
            : "There’s no plan outline for this book yet.",
      metadata: { intent, charged: false }
    });
  }
  return createAssistantChatMessage({
    projectId: project.id,
    parentId,
    content: intent.assistantMessage,
    metadata: { intent, charged: false, contentCard: card }
  });
}

export async function contentCardForTarget(
  project: ProjectForChat,
  target: NonNullable<BookEditIntent["contentTarget"]>
): Promise<MobileContentCard | null> {
  const numbering = numberingForProject(project);
  // Every chapter label here is the book's own heading (`chapterDisplayHeading`,
  // packages/core/src/generation/markdown.ts) rather than the stored title: a
  // continuation whose outline call failed stores that title empty on purpose,
  // and interpolating it left rows reading "5. " and "Chapter 5: ".
  const chapterLabel = (chapter: { index: number; title: string }, style?: "number_title" | "title_only"): string =>
    chapterDisplayHeading(chapter, { language: project.language, ...(style ? { style } : {}) });
  if (target.type === "outline") {
    const plan = project.currentPlan ? bookPlanSchema.safeParse(project.currentPlan.planningPackage) : null;
    if (plan?.success) {
      return {
        type: "outline",
        title: plan.data.title || project.title,
        sections: plan.data.chapters.map((chapter) => ({
          label: chapterLabel(chapter, "number_title"),
          body: chapter.summary
        }))
      };
    }
    if (project.chapters.length > 0) {
      return {
        type: "outline",
        title: project.title,
        sections: project.chapters.map((chapter) => ({
          label: chapterLabel(chapter, "number_title"),
          body: chapter.summary
        }))
      };
    }
    return null;
  }
  if (target.type === "chapter") {
    const chapter = project.chapters.find((candidate) => candidate.index === target.index);
    const chapterPages = project.pages.filter((page) => page.chapter?.index === target.index);
    if (!chapter && chapterPages.length === 0) {
      return null;
    }
    // Bodies are only needed for pages whose summary is empty.
    const bodies = await loadChatPageBodies(
      project.id,
      chapterPages.filter((page) => !page.summary).map((page) => page.index)
    );
    return {
      type: "chapter",
      title: chapterLabel(chapter ?? { index: target.index, title: "" }),
      sections:
        chapterPages.length > 0
          ? chapterPages.map((page) => ({
              label: `Page ${numbering.displayPage(page.index)}${page.title ? ` — ${page.title}` : ""}`,
              body: page.summary || (bodies.get(page.index) ?? "").slice(0, 280)
            }))
          : [{ label: chapterLabel(chapter!, "title_only"), body: chapter!.summary }]
    };
  }
  const page = project.pages.find((candidate) => candidate.index === target.index);
  if (!page) {
    return null;
  }
  const bodies = await loadChatPageBodies(project.id, [page.index]);
  return {
    type: "page",
    title: `Page ${numbering.displayPage(page.index)}${page.title ? `: ${page.title}` : ""}`,
    sections: [
      {
        label: page.title || `Page ${numbering.displayPage(page.index)}`,
        body: (bodies.get(page.index) ?? page.summary).slice(0, 6000)
      }
    ]
  };
}

// Scope resolution lives in bookEditScope.ts. Re-exported here because these
// names are the module's public surface for routes, tests and the worker-facing
// helpers, and narrowing them would break callers that never move.
export {
  affectedPagesForIntent,
  continuationNewPageCount,
  exactReplacementFromMessage,
  pagesMatchingEditText,
  pagesMatchingNeedle,
  pagesMatchingQuotedText,
  planSummaryForClassifier
} from "./bookEditScope.js";

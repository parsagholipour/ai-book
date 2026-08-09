import { type BookEditIntent, type BookEditIntentKind } from "../bookEditIntent.js";
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
import { sendMobileError } from "./httpErrors.js";
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
import { bookPlanSchema, type TextModelAdapter } from "@book-maker/core";
import { type FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";

/** Classifies chat into a book-edit intent, price, and confirmation reply. */

// Reading pending-edit state back out of the transcript moved to its own leaf
// module; re-exported here because every consumer historically imported it
// from this file.
export * from "./pendingEditState.js";


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
  if (requestId) {
    const replay = await replayProjectChatRequest(projectId, requestId);
    if (replay) {
      return replay;
    }
  }

  const project = await loadProjectForChat(userId, projectId);
  if (!project) {
    return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
  }

  if (action === "apply") {
    const claimed = await replayClaimedProposal(projectId, proposalId);
    if (claimed) return claimed;
  }

  const pending = await findPendingProposalById(projectId, proposalId);
  if (!pending?.intent || pending.clarification !== "confirm") {
    return sendMobileError(reply, 404, "PROPOSAL_NOT_FOUND", "That edit proposal is no longer available.");
  }

  const activeMessages = await loadActiveProjectChatMessages(projectId);
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
      request: pending.request
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
    executionCommandId: proposalId
  });

  return {
    ...(await loadProjectChatResponse(projectId)),
    reply: serializeProjectChatMessage(outcome.reply),
    operation: outcome.operation ? serializeBookEditOperation(outcome.operation) : null
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
  /**
   * What the user originally asked for, when `message` is that request merged
   * with a follow-up. Stored as the resumable request so a clarification chain
   * keeps pointing at the real ask instead of accumulating each follow-up.
   */
  pendingRequest?: string | undefined;
  /**
   * The message this turn replies to. Only the grounded answer reads it — the
   * priced paths take their target from `message`, so a quote cannot change
   * what an edit costs or which pages it rewrites.
   */
  replyTo?: ChatReplyQuote | undefined;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: MobileBookEditOperationRecord | null }> {
  const { userId, project, userMessageId, message, intent } = options;
  const pendingRequest = options.pendingRequest?.trim() || message;
  if (intent.kind === "answer" || intent.kind === "clarify") {
    const answer =
      intent.kind === "answer"
        ? await generateGroundedProjectAnswer(project, message, intent.assistantMessage, options.textModel, options.replyTo)
        : intent.assistantMessage;
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      content: answer,
      metadata: {
        intent,
        charged: false,
        ...(intent.kind === "clarify" && intent.clarification === "scope"
          ? { pendingEdit: { request: pendingRequest, clarification: "scope" } }
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
    return queueChatPlanRevision({ userId, project, userMessageId, message, intent });
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
      ...(options.executionCommandId ? { executionCommandId: options.executionCommandId } : {})
    });
  }
  return proposeBookEdit({ project, userMessageId, message, intent, pendingRequest });
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
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: null }> {
  const { project, userMessageId, message, intent } = options;
  const pendingRequest = options.pendingRequest?.trim() || message;
  const proposalId = randomUUID();
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
          proposalId
        }),
        editProposal: {
          id: proposalId,
          kind: intent.kind,
          scope: "none",
          affectedPageIndexes: [],
          credits: cost,
          summary: editProposalSummary(intent.kind, [], intent)
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
          proposalId
        }),
        editProposal: {
          id: proposalId,
          kind: intent.kind,
          scope: intent.scope === "none" ? "all_pages" : intent.scope,
          affectedPageIndexes: [],
          ...(intent.affectedChapterIndex ? { affectedChapterIndex: intent.affectedChapterIndex } : {}),
          ...(intent.targetLanguage ? { targetLanguage: intent.targetLanguage } : {}),
          credits: cost,
          summary: editProposalSummary(intent.kind, [], intent)
        }
      }
    });
    return { reply, operation: null };
  }

  let affectedPageIndexes = await affectedPagesForIntent(intent, message, project);
  if (affectedPageIndexes.length === 0) {
    const reply = await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      content:
        intent.kind === "chapter_regenerate"
          ? `I couldn’t find chapter ${intent.affectedChapterIndex ?? ""} in this book. Which chapter or pages should I rewrite?`.replace("  ", " ")
          : "Which page or exact phrase should I edit?",
      metadata: {
        intent: { ...intent, kind: "clarify", affectedPageIndexes, clarification: "scope" },
        pendingEdit: { request: pendingRequest, clarification: "scope" },
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
    content: editProposalMessage(intent.kind, affectedPageIndexes, proposalIntent),
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
        proposalId
      }),
      editProposal: {
        id: proposalId,
        kind: intent.kind,
        scope: proposalIntent.scope,
        affectedPageIndexes,
        ...(proposalIntent.affectedChapterIndex ? { affectedChapterIndex: proposalIntent.affectedChapterIndex } : {}),
        ...(proposalIntent.targetLanguage ? { targetLanguage: proposalIntent.targetLanguage } : {}),
        credits: cost,
        summary: editProposalSummary(intent.kind, affectedPageIndexes, proposalIntent),
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
    ...(state.proposalId ? { proposalId: state.proposalId } : {})
  };
}

export function editProposalCardFromState(state: PendingEditState): Record<string, unknown> | null {
  if (!state.intent) {
    return null;
  }
  return {
    ...(state.proposalId ? { id: state.proposalId } : {}),
    kind: state.intent.kind,
    scope: state.intent.scope,
    affectedPageIndexes: state.affectedPageIndexes ?? state.intent.affectedPageIndexes,
    ...(state.intent.affectedChapterIndex ? { affectedChapterIndex: state.intent.affectedChapterIndex } : {}),
    ...(state.intent.targetLanguage ? { targetLanguage: state.intent.targetLanguage } : {}),
    ...(state.credits !== undefined ? { credits: state.credits } : {}),
    summary: editProposalSummary(
      state.intent.kind,
      state.affectedPageIndexes ?? state.intent.affectedPageIndexes,
      state.intent
    )
  };
}

export function editProposalSummary(kind: BookEditIntentKind, affectedPageIndexes: number[], intent: BookEditIntent): string {
  if (kind === "continue_book") {
    const chapterCount = intent.continuation?.chapterCount ?? 1;
    return chapterCount > 1
      ? `Write ${chapterCount} new chapters continuing your book`
      : "Write the next chapter of your book";
  }
  if (kind === "book_replan") {
    return replanProposalSummary(intent);
  }
  if (kind === "chapter_regenerate") {
    return intent.affectedChapterIndex
      ? `Rewrite chapter ${intent.affectedChapterIndex}`
      : "Rewrite that chapter";
  }
  if (intent.scope === "all_pages") {
    return kind === "page_rewrite" ? "Rewrite the whole book" : "Edit the whole book";
  }
  if (affectedPageIndexes.length === 1) {
    return kind === "page_rewrite"
      ? `Rewrite page ${affectedPageIndexes[0]}`
      : `Edit page ${affectedPageIndexes[0]}`;
  }
  if (affectedPageIndexes.length > 1) {
    return kind === "page_rewrite"
      ? `Rewrite pages ${affectedPageIndexes.join(", ")}`
      : `Edit pages ${affectedPageIndexes.join(", ")}`;
  }
  return kind === "page_rewrite" ? "Rewrite matching pages" : "Edit matching pages";
}

/**
 * Names the settings the rebuild will use, because the card is the last thing
 * shown before the charge. "Rebuild the plan and regenerate the book" reads the
 * same whether the request was understood or dropped — and when it was dropped,
 * the copy arrives at the old length with no sign anything was missed.
 */
function replanProposalSummary(intent: BookEditIntent): string {
  const language = intent.targetLanguage ? ` ${languageDisplayName(intent.targetLanguage)}` : "";
  const targetPages = intent.replanSettings?.targetPages;
  const length = targetPages === undefined ? "" : ` ${targetPages}-page`;
  const illustrations =
    intent.replanSettings?.fullIllustrations === false
      ? " without illustrations"
      : intent.replanSettings?.fullIllustrations === true
        ? " with illustrations"
        : "";
  // The cover moves the quote too (a designed cover replaces the AI one for
  // free), so a request that dropped it must say so here for the same reason
  // the other settings do.
  const cover = intent.replanSettings?.includeCover === false ? " with a designed cover" : "";
  if (!language && !length && !illustrations && !cover) {
    return "Rebuild the plan and regenerate the book as a new copy";
  }
  return `Rebuild as a new${language}${length} copy${illustrations}${cover}`;
}

/**
 * The confirmation prose. It deliberately never names a price: the credits live
 * in `editProposal.credits`, which the app renders as a tappable badge on the
 * proposal card, so the number is one glance away instead of buried in a
 * sentence the reader has to parse on every edit.
 */
export function editProposalMessage(
  kind: BookEditIntentKind,
  affectedPageIndexes: number[],
  intent: BookEditIntent
): string {
  const summary = editProposalSummary(kind, affectedPageIndexes, intent);
  return `${summary}. Tap Apply to confirm, or Cancel to drop it.`;
}

/**
 * The saved-for-later reply used whenever a new edit cannot start because the
 * project already has open work. The request is preserved in metadata so a
 * later "apply it" can run it once the current job settles.
 */
export async function busyEditReply(options: {
  projectId: string;
  parentMessageId: string;
  intent: BookEditIntent;
  request: string;
}): Promise<MobileProjectChatMessageRecord> {
  return createAssistantChatMessage({
    projectId: options.projectId,
    parentId: options.parentMessageId,
    content:
      "This book is still being worked on, so I saved that request. Say “apply it” once the current job finishes and I’ll run it. You can keep asking questions in the meantime.",
    metadata: {
      intent: options.intent,
      blockedByActiveJob: true,
      charged: false,
      pendingEdit: { request: options.request, clarification: "busy" }
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
  if (target.type === "outline") {
    const plan = project.currentPlan ? bookPlanSchema.safeParse(project.currentPlan.planningPackage) : null;
    if (plan?.success) {
      return {
        type: "outline",
        title: plan.data.title || project.title,
        sections: plan.data.chapters.map((chapter) => ({
          label: `${chapter.index}. ${chapter.title}`,
          body: chapter.summary
        }))
      };
    }
    if (project.chapters.length > 0) {
      return {
        type: "outline",
        title: project.title,
        sections: project.chapters.map((chapter) => ({
          label: `${chapter.index}. ${chapter.title}`,
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
      title: chapter ? `Chapter ${target.index}: ${chapter.title}` : `Chapter ${target.index}`,
      sections:
        chapterPages.length > 0
          ? chapterPages.map((page) => ({
              label: `Page ${page.index}${page.title ? ` — ${page.title}` : ""}`,
              body: page.summary || (bodies.get(page.index) ?? "").slice(0, 280)
            }))
          : [{ label: chapter!.title, body: chapter!.summary }]
    };
  }
  const page = project.pages.find((candidate) => candidate.index === target.index);
  if (!page) {
    return null;
  }
  const bodies = await loadChatPageBodies(project.id, [page.index]);
  return {
    type: "page",
    title: `Page ${page.index}${page.title ? `: ${page.title}` : ""}`,
    sections: [{ label: page.title || `Page ${page.index}`, body: (bodies.get(page.index) ?? page.summary).slice(0, 6000) }]
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

/**
 * The "work is queued" reply. Like {@link editProposalMessage} it stays silent
 * about the price — the charge is on the message as `metadata.creditsCharged`
 * and renders as the badge in the bubble's corner.
 */
export function operationQueuedMessage(kind: BookEditIntentKind, affectedPageIndexes: number[], intent: BookEditIntent): string {
  if (kind === "continue_book") {
    const chapterCount = intent.continuation?.chapterCount ?? 1;
    const chapterText = chapterCount > 1 ? `${chapterCount} new chapters` : "the next chapter";
    return `I’ll write ${chapterText} in your book’s voice and refresh the exports.`;
  }
  if (kind === "book_replan") {
    return "I’ll rebuild the plan and regenerate the book.";
  }
  if (kind === "chapter_regenerate") {
    const chapterText = intent.affectedChapterIndex ? `chapter ${intent.affectedChapterIndex}` : "that chapter";
    return `I’ll rewrite ${chapterText} (${affectedPageIndexes.length} page${affectedPageIndexes.length === 1 ? "" : "s"}) with that direction and refresh the exports.`;
  }
  const pageText =
    intent.scope === "all_pages"
      ? "the whole book"
      : intent.scope === "matching_pages"
        ? affectedPageIndexes.length === 1
          ? `the matching text on page ${affectedPageIndexes[0]}`
          : `matching text on pages ${affectedPageIndexes.join(", ")}`
        : affectedPageIndexes.length === 1
      ? `page ${affectedPageIndexes[0]}`
      : `pages ${affectedPageIndexes.join(", ")}`;
  return kind === "page_rewrite"
    ? `I’ll rewrite ${pageText} and refresh the exports.`
    : `I’ll edit ${pageText} and refresh the exports.`;
}

import {
  bookEditScopeFromMessage,
  isBookEditScopeOnlyMessage,
  PROPOSAL_GATED_EDIT_KINDS,
  type BookEditIntent,
  type BookEditScope
} from "../bookEditIntent.js";
import { type ImageInsertionEdit, type ImageLayoutEdit } from "../bookEditImage.js";
import { type MobileProjectChatMessageRecord } from "./dto.js";
import { jsonRecord } from "./support.js";
import { type ReplanSettings } from "@book-maker/core";

/**
 * Reading the project's one pending edit back out of the chat transcript: the
 * saved request, its scope, and — for priced proposals — the exact intent and
 * quote the confirmation must execute unchanged. A leaf module: the proposal
 * composition and settlement flows import from here, never the reverse.
 */

export type PendingEditClarification = "scope" | "busy" | "confirm";

/**
 * The kinds an "apply it" may resume: every proposal-gated edit kind, plus the
 * plan-stage revision, which rides the same card mechanics. Derived rather
 * than re-spelled so a new proposal-gated kind cannot be resumable in the
 * classifier and dead on resume.
 */
const RESUMABLE_PROPOSAL_KINDS: ReadonlySet<string> = new Set<string>([
  ...PROPOSAL_GATED_EDIT_KINDS,
  "plan_revision"
]);

/** A saved edit waiting on scope, busy clearance, or an explicit Apply confirmation. */
export type PendingEditState = {
  request: string;
  scope: BookEditScope;
  clarification: PendingEditClarification;
  /** Present for priced proposals (`clarification: "confirm"`). */
  intent?: BookEditIntent | undefined;
  affectedPageIndexes?: number[] | undefined;
  credits?: number | undefined;
  proposalId?: string | undefined;
  /**
   * True when the assistant has said something else since presenting this
   * edit. A bare "ok" typed after an unrelated answer is agreement with that
   * answer, not consent to a charge, so only an explicit confirmation
   * ("apply it") may execute the proposal then.
   */
  requiresExplicitConfirmation?: boolean | undefined;
  /**
   * The @-mentioned library characters' sheets, as a prompt block. Appended to
   * the request only where it reaches the worker's rewrite prompts — never to
   * the routed text, the page targeting, or the visible transcript — and
   * carried here so a clarify → confirm → Apply chain keeps it.
   */
  characterContext?: string | undefined;
};

/**
 * A message that settles the project's pending edit: the Apply/Cancel buttons
 * write `proposalAction` on their USER row, and both cancel paths write
 * `pendingEditCancelled` on the ASSISTANT reply. Settlement is detected from
 * these markers — already present on every production row — rather than by
 * changing what the writers store. Without a terminator, the confirm card
 * stayed "pending" forever: a later "ok" re-executed an already-applied
 * proposal (a second charge), and a bare "yes" resurrected a cancelled one.
 */
export function settlesPendingEdit(message: { role: string; metadata: unknown }): boolean {
  const metadata = jsonRecord(message.metadata);
  if (message.role === "USER") {
    return typeof metadata.proposalAction === "string";
  }
  return message.role === "ASSISTANT" && metadata.pendingEditCancelled === true;
}

export function findPendingProposalById(
  activeMessages: MobileProjectChatMessageRecord[],
  proposalId: string
): PendingEditState | null {
  return findOpenPendingProposal(activeMessages, proposalId);
}

/**
 * The one proposal a fresh Apply would still be accepted for, or null.
 *
 * The app reads this off the chat response to retire a spent card: Apply and
 * Cancel settle the proposal here, so a card still offering them afterwards
 * invites a tap this module can only replay or refuse — which reads as if the
 * Apply had not gone through.
 */
export function findOpenProposalId(activeMessages: MobileProjectChatMessageRecord[]): string | null {
  return findOpenPendingProposal(activeMessages)?.proposalId ?? null;
}

/**
 * The walk both proposal questions share, newest message first. Given a
 * `proposalId` it answers "is this proposal still applicable"; without one,
 * "which proposal is still open" — and there the *first* undeflected
 * settlement ends the walk, because a newer proposal is always reached before
 * an older one's Apply row.
 */
function findOpenPendingProposal(
  activeMessages: MobileProjectChatMessageRecord[],
  proposalId?: string | undefined
): PendingEditState | null {
  const messages = [...activeMessages].reverse().slice(0, 40);
  let newer: (typeof messages)[number] | null = null;
  for (const message of messages) {
    if (settlesPendingEdit(message)) {
      const settledId = jsonRecord(message.metadata).proposalId;
      if (proposalId === undefined || typeof settledId !== "string" || settledId === proposalId) {
        // An Apply the busy gate deflected never ran: its reply — the message
        // right after it — says so, and the proposal must stay retryable.
        const deflected =
          newer?.role === "ASSISTANT" && jsonRecord(newer.metadata).blockedByActiveJob === true;
        if (!deflected) {
          return null;
        }
      }
      newer = message;
      continue;
    }
    newer = message;
    if (message.role !== "ASSISTANT") {
      continue;
    }
    const metadata = jsonRecord(message.metadata);
    const pending = jsonRecord(metadata.pendingEdit);
    const request = typeof pending.request === "string" ? pending.request.trim() : "";
    if (pending.clarification !== "confirm" || request.length === 0) {
      continue;
    }
    const proposal = pendingEditProposalFromMetadata(metadata, pending, request);
    // With an id, only that proposal answers; without one, the newest proposal
    // that carries an id at all — a card with none has no Apply to offer.
    const resolvedId = proposalId ?? proposal.proposalId;
    if (resolvedId === undefined || proposal.proposalId !== resolvedId) {
      continue;
    }
    return {
      request,
      scope: proposal.intent?.scope ?? "none",
      clarification: "confirm",
      ...(proposal.intent ? { intent: proposal.intent } : {}),
      ...(proposal.affectedPageIndexes ? { affectedPageIndexes: proposal.affectedPageIndexes } : {}),
      ...(proposal.credits !== undefined ? { credits: proposal.credits } : {}),
      ...characterContextFromPending(pending),
      proposalId: resolvedId
    };
  }
  return null;
}

function characterContextFromPending(pending: Record<string, unknown>): { characterContext?: string } {
  return typeof pending.characterContext === "string" && pending.characterContext.trim()
    ? { characterContext: pending.characterContext }
    : {};
}

export function findPendingScopeClarification(
  /** The turn's already-loaded active messages. */
  activeMessages: MobileProjectChatMessageRecord[],
  currentMessage: string,
  currentScope: BookEditScope = bookEditScopeFromMessage(currentMessage)
): PendingEditState | null {
  const messages = [...activeMessages].reverse().slice(0, 24);
  // Set once the walk passes an assistant message that is *not* the pending
  // edit's own presentation. Recovery cards and busy replies re-present the
  // pending edit with its full metadata, so they are found and returned before
  // this flag can be set — only a genuinely unrelated reply (a grounded
  // answer, a different question) marks the pending edit as no longer the
  // last thing the assistant said.
  let sawNewerAssistantMessage = false;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "USER" && jsonRecord(jsonRecord(message.metadata).resolvedPendingEdit).request !== undefined) {
      // The most recent pending edit was already applied; don't re-apply it.
      return null;
    }
    // Apply/Cancel settle the pending edit the same way. An Apply the busy
    // gate deflected is not a settlement, but its `busy` reply is *newer* than
    // the settlement row, so the walk has already returned it by the time it
    // could get here.
    if (settlesPendingEdit(message)) {
      return null;
    }
    if (message.role !== "ASSISTANT") {
      continue;
    }
    const metadata = jsonRecord(message.metadata);
    const pending = jsonRecord(metadata.pendingEdit);
    const request = typeof pending.request === "string" ? pending.request.trim() : "";
    if (
      (pending.clarification === "scope" ||
        pending.clarification === "busy" ||
        pending.clarification === "confirm") &&
      request.length > 0
    ) {
      const proposal = pendingEditProposalFromMetadata(metadata, pending, request);
      // Only states whose confirmation executes a charge demand the explicit
      // form once stale. A scope state resumed by "ok" merely re-proposes, so
      // gating it would strand the recovery flow behind exact wording.
      const confirmationCharges =
        pending.clarification === "confirm" || (pending.clarification === "busy" && proposal.proposalId);
      return {
        request,
        scope: currentScope !== "none" ? currentScope : scopeFromRecentUserMessages(messages.slice(0, index)),
        clarification: pending.clarification,
        ...(proposal.intent ? { intent: proposal.intent } : {}),
        ...(proposal.affectedPageIndexes ? { affectedPageIndexes: proposal.affectedPageIndexes } : {}),
        ...(proposal.credits !== undefined ? { credits: proposal.credits } : {}),
        ...(proposal.proposalId ? { proposalId: proposal.proposalId } : {}),
        ...characterContextFromPending(pending),
        ...(sawNewerAssistantMessage && confirmationCharges ? { requiresExplicitConfirmation: true } : {})
      };
    }
    if (isScopeClarificationAssistantMessage(message.content)) {
      const priorUser = messages
        .slice(index + 1)
        .find((candidate) => candidate.role === "USER" && !isBookEditScopeOnlyMessage(candidate.content));
      const priorRequest = priorUser?.content.trim();
      if (priorRequest) {
        return {
          request: priorRequest,
          scope: currentScope !== "none" ? currentScope : scopeFromRecentUserMessages(messages.slice(0, index)),
          clarification: "scope"
        };
      }
    }
    sawNewerAssistantMessage = true;
  }
  return null;
}

/**
 * Rebuild a priced proposal from assistant metadata so "apply it" can skip
 * re-routing. Busy replies that deflected an already-confirmed proposal carry
 * the same fields, so a resume after the job settles executes the confirmed
 * edit instead of re-proposing it.
 */
export function pendingEditProposalFromMetadata(
  metadata: Record<string, unknown>,
  pending: Record<string, unknown>,
  request: string
): Pick<PendingEditState, "intent" | "affectedPageIndexes" | "credits" | "proposalId"> {
  if (pending.clarification !== "confirm" && pending.clarification !== "busy") {
    return {};
  }
  const card = jsonRecord(metadata.editProposal);
  const proposalIdRaw = pending.proposalId ?? card.id;
  const proposalId = typeof proposalIdRaw === "string" && proposalIdRaw.trim().length > 0 ? proposalIdRaw : undefined;
  const intentSource = jsonRecord(pending.intent);
  const kind = typeof intentSource.kind === "string" ? intentSource.kind : typeof card.kind === "string" ? card.kind : "";
  if (!RESUMABLE_PROPOSAL_KINDS.has(kind)) {
    return proposalId ? { proposalId } : {};
  }
  const affectedPageIndexes = Array.isArray(pending.affectedPageIndexes)
    ? pending.affectedPageIndexes.filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0)
    : Array.isArray(card.affectedPageIndexes)
      ? card.affectedPageIndexes.filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0)
      : [];
  const creditsRaw = pending.credits ?? card.credits;
  const credits = typeof creditsRaw === "number" && Number.isFinite(creditsRaw) ? Math.max(0, Math.round(creditsRaw)) : undefined;
  const scope =
    intentSource.scope === "explicit_pages" ||
    intentSource.scope === "matching_pages" ||
    intentSource.scope === "all_pages" ||
    intentSource.scope === "none"
      ? intentSource.scope
      : affectedPageIndexes.length > 0
        ? "explicit_pages"
        : "none";
  const impact =
    intentSource.impact === "style_rewrite" || intentSource.impact === "structural_replan"
      ? intentSource.impact
      : kind === "book_replan"
        ? "structural_replan"
        : kind === "page_rewrite" || kind === "chapter_regenerate"
          ? "style_rewrite"
          : "small_text";
  const intent: BookEditIntent = {
    kind: kind as BookEditIntent["kind"],
    confidence: typeof intentSource.confidence === "number" ? intentSource.confidence : 0.9,
    reasoning: typeof intentSource.reasoning === "string" ? intentSource.reasoning : "Confirmed priced edit proposal.",
    affectedPageIndexes,
    assistantMessage:
      typeof intentSource.assistantMessage === "string" && intentSource.assistantMessage.trim()
        ? intentSource.assistantMessage
        : request,
    scope,
    impact,
    clarification: "none",
    ...(typeof intentSource.affectedChapterIndex === "number"
      ? { affectedChapterIndex: intentSource.affectedChapterIndex }
      : typeof card.affectedChapterIndex === "number"
        ? { affectedChapterIndex: card.affectedChapterIndex }
        : {}),
    ...(typeof intentSource.targetLanguage === "string"
      ? { targetLanguage: intentSource.targetLanguage }
      : typeof card.targetLanguage === "string"
        ? { targetLanguage: card.targetLanguage }
        : {}),
    // The settings the request named are what the shown quote was computed from,
    // so dropping them here would charge the quoted price and then build the old
    // book — the shape of bug this field exists to close.
    ...(kind === "book_replan" ? replanSettingsFromMetadata(intentSource.replanSettings ?? card.replanSettings) : {}),
    ...(kind === "continue_book"
      ? {
          continuation: {
            chapterCount:
              typeof jsonRecord(intentSource.continuation).chapterCount === "number"
                ? Math.min(8, Math.max(1, jsonRecord(intentSource.continuation).chapterCount as number))
                : 1
          }
        }
      : {}),
    ...(kind === "add_image" ? imageEditFromMetadata(intentSource.imageEdit) : {}),
    ...(kind === "move_image" || kind === "remove_image"
      ? imageLayoutFromMetadata(intentSource.imageLayout)
      : {})
  };
  return {
    intent,
    ...(affectedPageIndexes.length > 0 ? { affectedPageIndexes } : {}),
    ...(credits !== undefined ? { credits } : {}),
    ...(proposalId ? { proposalId } : {})
  };
}

/**
 * Reads a stored `imageEdit` blob back, dropping malformed fields. Without a
 * usable subject the whole field is dropped; the proposal path then falls back
 * to its deterministic generic subject rather than dead-ending the resume.
 */
function imageEditFromMetadata(value: unknown): { imageEdit?: ImageInsertionEdit } {
  const stored = jsonRecord(value);
  const subject = typeof stored.subject === "string" ? stored.subject.trim().slice(0, 300) : "";
  if (!subject) {
    return {};
  }
  const placement = stored.placement === "end_of_book" || stored.placement === "page" ? stored.placement : undefined;
  const pageIndex =
    placement === "page" &&
    typeof stored.pageIndex === "number" &&
    Number.isInteger(stored.pageIndex) &&
    stored.pageIndex > 0
      ? stored.pageIndex
      : undefined;
  // A replacement must survive the resume, or the retried Apply silently adds
  // a second picture instead of swapping the first. Malformed blobs drop the
  // whole replace field, degrading to a plain add — visible on the card.
  const replaceStored = jsonRecord(stored.replace);
  const replaceOperationId = typeof replaceStored.operationId === "string" ? replaceStored.operationId : undefined;
  const replaceAssetId =
    typeof replaceStored.assetId === "string" && replaceStored.assetId.trim()
      ? replaceStored.assetId.trim().slice(0, 80)
      : undefined;
  const replaceMarker =
    typeof replaceStored.marker === "string" && replaceStored.marker.trim()
      ? replaceStored.marker.trim().slice(0, 200)
      : undefined;
  const replaceOldSubject =
    typeof replaceStored.oldSubject === "string" && replaceStored.oldSubject.trim()
      ? replaceStored.oldSubject.trim().slice(0, 300)
      : undefined;
  const hasReplace =
    replaceOperationId !== undefined || replaceAssetId !== undefined || replaceMarker !== undefined;
  return {
    imageEdit: {
      subject,
      ...(placement ? { placement } : {}),
      ...(pageIndex !== undefined ? { pageIndex } : {}),
      ...(stored.replace !== undefined && hasReplace
        ? {
            replace: {
              operationId: replaceOperationId ?? "",
              ...(replaceAssetId ? { assetId: replaceAssetId } : {}),
              ...(replaceMarker ? { marker: replaceMarker } : {}),
              ...(replaceOldSubject ? { oldSubject: replaceOldSubject } : {})
            }
          }
        : {})
    }
  };
}

/**
 * Reads a stored `imageLayout` blob back. Without a usable action the whole
 * field is dropped; the proposal path then answers rather than inventing a
 * move or remove the card never showed.
 */
function imageLayoutFromMetadata(value: unknown): { imageLayout?: ImageLayoutEdit } {
  const stored = jsonRecord(value);
  const action = stored.action === "move" || stored.action === "remove" ? stored.action : undefined;
  if (!action) {
    return {};
  }
  const pageIndex =
    typeof stored.pageIndex === "number" && Number.isInteger(stored.pageIndex) && stored.pageIndex > 0
      ? stored.pageIndex
      : undefined;
  const destPlacement =
    stored.destPlacement === "end_of_book" || stored.destPlacement === "page" ? stored.destPlacement : undefined;
  const destPageIndex =
    destPlacement === "page" &&
    typeof stored.destPageIndex === "number" &&
    Number.isInteger(stored.destPageIndex) &&
    stored.destPageIndex > 0
      ? stored.destPageIndex
      : undefined;
  const targetStored = jsonRecord(stored.target);
  const targetOperationId = typeof targetStored.operationId === "string" ? targetStored.operationId : undefined;
  const targetAssetId =
    typeof targetStored.assetId === "string" && targetStored.assetId.trim()
      ? targetStored.assetId.trim().slice(0, 80)
      : undefined;
  const targetMarker =
    typeof targetStored.marker === "string" && targetStored.marker.trim()
      ? targetStored.marker.trim().slice(0, 200)
      : undefined;
  const targetOldSubject =
    typeof targetStored.oldSubject === "string" && targetStored.oldSubject.trim()
      ? targetStored.oldSubject.trim().slice(0, 300)
      : undefined;
  const targetPageIndex =
    typeof targetStored.pageIndex === "number" && Number.isInteger(targetStored.pageIndex) && targetStored.pageIndex > 0
      ? targetStored.pageIndex
      : undefined;
  const hasTarget =
    targetOperationId !== undefined || targetAssetId !== undefined || targetMarker !== undefined;
  return {
    imageLayout: {
      action,
      ...(pageIndex !== undefined ? { pageIndex } : {}),
      ...(destPlacement ? { destPlacement } : {}),
      ...(destPageIndex !== undefined ? { destPageIndex } : {}),
      ...(stored.target !== undefined && hasTarget && targetPageIndex !== undefined
        ? {
            target: {
              operationId: targetOperationId ?? "",
              pageIndex: targetPageIndex,
              ...(targetAssetId ? { assetId: targetAssetId } : {}),
              ...(targetMarker ? { marker: targetMarker } : {}),
              ...(targetOldSubject ? { oldSubject: targetOldSubject } : {})
            }
          }
        : {})
    }
  };
}

/** Reads a stored `replanSettings` blob back, dropping anything malformed. */
function replanSettingsFromMetadata(value: unknown): { replanSettings?: ReplanSettings } {
  const stored = jsonRecord(value);
  const settings: ReplanSettings = {
    ...(typeof stored.targetPages === "number" && Number.isInteger(stored.targetPages) && stored.targetPages > 0
      ? { targetPages: stored.targetPages }
      : {}),
    ...(typeof stored.fullIllustrations === "boolean" ? { fullIllustrations: stored.fullIllustrations } : {}),
    ...(typeof stored.includeCover === "boolean" ? { includeCover: stored.includeCover } : {})
  };
  return Object.keys(settings).length > 0 ? { replanSettings: settings } : {};
}

export function scopeFromRecentUserMessages(messages: MobileProjectChatMessageRecord[]): BookEditScope {
  for (const message of messages) {
    if (message.role !== "USER" || !isBookEditScopeOnlyMessage(message.content)) {
      continue;
    }
    const scope = bookEditScopeFromMessage(message.content);
    if (scope !== "none") {
      return scope;
    }
  }
  return "none";
}

/**
 * "Proceed with what you already have." The insistence forms matter as much as
 * the polite ones: a user who has been asked a question they do not want to
 * answer replies "just add" or "you decide", not "apply it".
 */
export function isPendingEditConfirmationMessage(message: string): boolean {
  const normalized = normalizeShortFollowUpMessage(message);
  // Deliberately no bare verbs ("change", "fix"): this also confirms a priced
  // proposal, so the intent to proceed has to be explicit — a "just" prefix, an
  // "it" object, or an adverb like "anyway".
  return /^(?:ok|okay|yes|yep|yeah|sure|do it|apply it|go ahead|please do|start|run it)$/i.test(normalized) ||
    /^just\s+(?:do|add|apply|go|run|make|write|change|fix)(?:\s+it)?(?:\s+(?:anyway|already|now|please))?$/i.test(
      normalized
    ) ||
    /^(?:do|add|apply|run|make|write)\s+it(?:\s+(?:anyway|already|now|please))?$/i.test(normalized) ||
    /^(?:do|add|apply|run|go)\s+(?:ahead|anyway|already|now)$/i.test(normalized) ||
    /^(?:you\s+decide|whatever\s+you\s+think|whatever\s+you\s+want|up\s+to\s+you|your\s+choice|surprise\s+me|i\s+don'?t\s+(?:care|mind))$/i.test(
      normalized
    );
}

/**
 * The confirmation forms that are also ordinary agreement — "ok" after an
 * answer means "thanks", not "charge me". When the pending edit is no longer
 * the assistant's latest message these do not confirm it; the explicit forms
 * ("apply it", "do it", "just add") always do.
 */
export function isBareAcknowledgementMessage(message: string): boolean {
  return /^(?:ok|okay|yes|yep|yeah|sure)$/i.test(normalizeShortFollowUpMessage(message));
}

export function isPendingEditCancellationMessage(message: string): boolean {
  return /^(?:no|nope|nah|cancel|never\s*mind|nevermind|don'?t|do not|stop|forget it|not now|discard)$/i.test(
    normalizeShortFollowUpMessage(message)
  );
}

export function isPendingEditNudgeMessage(message: string): boolean {
  const normalized = normalizeShortFollowUpMessage(message);
  // No bare "why": the normalizer strips the question mark, so a genuine
  // "why?" about the book would get the recovery card instead of an answer.
  return isPendingEditConfirmationMessage(message) ||
    /^(?:wow|come on|seriously|same thing|again|i already said it|i said it)$/i.test(normalized) ||
    /^i\s+(?:already\s+)?said\b/i.test(normalized);
}

export function normalizeShortFollowUpMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function pendingScopeRecoveryMessage(pending: PendingEditState): string {
  if (pending.clarification === "confirm") {
    // The price is carried by the proposal card's credit badge, not the prose.
    return "I still have that edit ready. Tap Apply to run it, or Cancel to drop it.";
  }
  if (pending.scope === "all_pages") {
    // No proposal card exists for a bare scope state, so there is no Apply
    // button to tap — only "apply it" in chat resumes it.
    return `I still have your earlier edit: “${pending.request}”, and I saw that you want it for the whole book. Say “apply it” to start that edit, or send a new edit.`;
  }
  return `I still have your earlier edit: “${pending.request}”. Should I apply it to the whole book, matching text, or a specific page?`;
}

export function isScopeClarificationAssistantMessage(content: string): boolean {
  return /which\s+page\s+or\s+exact\s+phrase\s+should\s+i\s+(?:change|edit)/i.test(content) ||
    /should\s+i\s+(?:change|edit|rewrite)\s+(?:a\s+)?specific\s+page/i.test(content);
}

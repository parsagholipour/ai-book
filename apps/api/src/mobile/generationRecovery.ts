import { payloadOwnsProjectOutcome } from "@book-maker/core";
import { type GenerationJobType } from "../queue.js";
import { jsonRecord } from "./support.js";

/**
 * Recovery predicates: whether a stranded GenerationJob row can be resumed
 * against the project's *current* plan and pages, and with what payload. Split
 * out of projectSerializers.ts, which re-exports it.
 */

/**
 * Statuses in which a project is already being worked on, and a resume must
 * therefore stand down. Both resume surfaces claim the project by writing
 * their status *conditionally* against this list — the operator's free
 * requeue and the mobile paid retry used to share no claim at all, so the two
 * racing each other enqueued overlapping work for one book: the old rows
 * requeued for free alongside a freshly charged retry of the same run.
 */
export const LIVE_PROJECT_STATUSES = ["PLANNING", "GENERATING", "EDITING"] as const;

export function canRecoverGenerationJob(
  type: GenerationJobType,
  payload: unknown,
  context: { currentPlanId: string | null; currentPlanCreatedAt: Date | null; pageIds: Set<string> },
  jobCreatedAt: Date
): boolean {
  // Work that settles on its own row — an export repair for a finished, paid
  // book, or a free presentation-only reprint — is nobody's recovery: resuming
  // it would put the project back into GENERATING for something its outcome
  // does not depend on, and a requeued presentation recompile can never
  // publish from there (its status claim names the EDITING it was born under),
  // so the book would sit GENERATING until the stranded-generation sweep
  // re-ran full QA on a delivered book.
  if (!payloadOwnsProjectOutcome(payload)) {
    return false;
  }

  const payloadRecord = jsonRecord(payload);

  if (type === "PLAN_BOOK") {
    return !context.currentPlanCreatedAt || jobCreatedAt > context.currentPlanCreatedAt;
  }

  if (type === "REVISE_PLAN") {
    return (
      typeof payloadRecord.planId === "string" &&
      payloadRecord.planId === context.currentPlanId &&
      typeof payloadRecord.message === "string" &&
      payloadRecord.message.trim().length > 0
    );
  }

  if (!context.currentPlanId) {
    return false;
  }

  const planId = payloadPlanId(payloadRecord);
  if (planId && planId !== context.currentPlanId) {
    return false;
  }

  if (type === "GENERATE_BOOK") {
    return planId === context.currentPlanId;
  }

  if (type === "GENERATE_PAGE") {
    return isCurrentPagePayload(payloadRecord, context);
  }

  if (type === "GENERATE_IMAGE") {
    return (
      isCurrentCoverPayload(payloadRecord, context) ||
      (isCurrentPagePayload(payloadRecord, context) && typeof payloadRecord.prompt === "string")
    );
  }

  return type === "COMPILE_EXPORT" || type === "APPLY_BOOK_EDIT" || type === "REPLAN_BOOK";
}

export function isPlanningRecoveryJob(type: GenerationJobType): boolean {
  return type === "PLAN_BOOK" || type === "REVISE_PLAN";
}

export function recoveryPayload(
  type: GenerationJobType,
  payload: unknown,
  currentPlanId: string | null
): Record<string, unknown> {
  if (isPlanningRecoveryJob(type) || !currentPlanId) {
    return jsonRecord(payload);
  }
  return {
    ...jsonRecord(payload),
    planId: currentPlanId
  };
}

export function payloadPlanId(payload: Record<string, unknown>): string | null {
  return typeof payload.planId === "string" ? payload.planId : null;
}

export function isCurrentPagePayload(
  payload: Record<string, unknown>,
  context: { pageIds: Set<string> }
): boolean {
  return typeof payload.pageId === "string" && context.pageIds.has(payload.pageId);
}

export function isCurrentCoverPayload(
  payload: Record<string, unknown>,
  context: { currentPlanId: string | null }
): boolean {
  return payload.assetType === "COVER" && payloadPlanId(payload) === context.currentPlanId;
}

import { type GenerationJobType } from "../queue.js";
import { jsonRecord } from "./support.js";

/**
 * Recovery predicates: whether a stranded GenerationJob row can be resumed
 * against the project's *current* plan and pages, and with what payload. Split
 * out of projectSerializers.ts, which re-exports it.
 */

export function canRecoverGenerationJob(
  type: GenerationJobType,
  payload: unknown,
  context: { currentPlanId: string | null; currentPlanCreatedAt: Date | null; pageIds: Set<string> },
  jobCreatedAt: Date
): boolean {
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

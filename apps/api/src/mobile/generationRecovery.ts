import { payloadOwnsProjectOutcome } from "@book-maker/core";
import { type GenerationJobType } from "../queue.js";
import { jsonRecord } from "./support.js";

/**
 * Resume predicates and reporting filters for GenerationJob rows. Resume asks
 * whether a stranded row can be recovered against the project's *current* plan
 * and pages, and with what payload. Reporting asks whether a FAILED owning job
 * has already been replaced by later work — which `canRecoverGenerationJob`
 * cannot answer. Split out of projectSerializers.ts, which re-exports it.
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
  return isPlanningWork(type);
}

function isPlanningWork(type: string): boolean {
  return type === "PLAN_BOOK" || type === "REVISE_PLAN";
}

type StatusJobRef = { type: string; status: string; payload: unknown };

/**
 * Newest FAILED owning job that later work has not already replaced.
 * Both reporting surfaces must ask this of the same newest-first window.
 */
export function findCurrentOwningFailure<T extends StatusJobRef>(
  jobs: readonly T[],
  ownsType: (type: string) => boolean
): T | undefined {
  return jobs.find(
    (job, index) =>
      job.status === "FAILED" &&
      ownsType(job.type) &&
      payloadOwnsProjectOutcome(job.payload) &&
      !laterJobSupersedesOwningFailure(job, jobs.slice(0, index))
  );
}

/**
 * Whether a later row has already replaced this FAILED owning job.
 * The later row must own the project outcome. Jobs are newest-first;
 * `newerJobs` is the prefix before this row.
 */
export function laterJobSupersedesOwningFailure(
  failed: { type: string; payload: unknown },
  newerJobs: ReadonlyArray<StatusJobRef>
): boolean {
  return newerJobs.some(
    (job) =>
      jobReplacesFailedWork(job.status) &&
      payloadOwnsProjectOutcome(job.payload) &&
      jobsTargetSameOwningWork(failed, job)
  );
}

function jobReplacesFailedWork(status: string): boolean {
  return status === "QUEUED" || status === "ACTIVE" || status === "COMPLETED";
}

function jobsTargetSameOwningWork(
  failed: { type: string; payload: unknown },
  candidate: { type: string; payload: unknown }
): boolean {
  if (isPlanningWork(failed.type) && isPlanningWork(candidate.type)) {
    return true;
  }
  if (failed.type !== candidate.type) {
    return false;
  }
  if (failed.type === "GENERATE_PAGE") {
    return samePayloadString(failed.payload, candidate.payload, "pageId");
  }
  if (failed.type === "GENERATE_IMAGE") {
    return sameImageTarget(failed.payload, candidate.payload);
  }
  if (failed.type === "GENERATE_BOOK" || failed.type === "COMPILE_EXPORT") {
    return true;
  }
  if (
    failed.type === "APPLY_BOOK_EDIT" ||
    failed.type === "CONTINUE_BOOK" ||
    failed.type === "REPLAN_BOOK"
  ) {
    return samePayloadString(failed.payload, candidate.payload, "operationId");
  }
  return false;
}

function samePayloadString(left: unknown, right: unknown, key: string): boolean {
  const value = jsonRecord(left)[key];
  return typeof value === "string" && value.length > 0 && value === jsonRecord(right)[key];
}

function sameImageTarget(left: unknown, right: unknown): boolean {
  const leftRecord = jsonRecord(left);
  const rightRecord = jsonRecord(right);
  if (leftRecord.assetType === "COVER" || rightRecord.assetType === "COVER") {
    return leftRecord.assetType === "COVER" && rightRecord.assetType === "COVER";
  }
  return samePayloadString(left, right, "pageId");
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

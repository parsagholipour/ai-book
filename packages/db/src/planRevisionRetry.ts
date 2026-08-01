export const PLAN_REVISION_AUTOMATIC_RETRY_LIMIT = 2;
export const PLAN_REVISION_RETRY_BASE_DELAY_MS = 30_000;

export type PlanRevisionRetryState = {
  status: string;
  automaticRetryCount: number;
  automaticRetryLimit: number;
  nextRetryAt: Date | null;
  generationJob: {
    status: string;
    startedAt: Date | null;
    updatedAt: Date;
  } | null;
};

export function planRevisionRetryDelayMs(retryNumber: number): number {
  return PLAN_REVISION_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryNumber - 1);
}

/**
 * `terminal` marks a rejection that no amount of waiting can turn into a
 * retry. The automatic reconciler retires those operations instead of
 * re-deriving the same answer on its next pass; everything else is a poll it
 * should back off and repeat.
 */
export function canClaimPlanRevisionRetry(
  operation: PlanRevisionRetryState,
  now = new Date()
): { eligible: boolean; staleActive: boolean; terminal: boolean; reason: string | null } {
  if (operation.automaticRetryCount >= operation.automaticRetryLimit) {
    return { eligible: false, staleActive: false, terminal: true, reason: "automatic retry budget exhausted" };
  }
  if (operation.nextRetryAt && operation.nextRetryAt > now) {
    return { eligible: false, staleActive: false, terminal: false, reason: "retry backoff has not elapsed" };
  }
  const failed = operation.status === "FAILED" && operation.generationJob?.status === "FAILED";
  if (!failed) {
    return { eligible: false, staleActive: false, terminal: false, reason: "operation is not failed" };
  }
  return { eligible: true, staleActive: false, terminal: false, reason: null };
}

export function retryRequestKey(operationId: string, retryNumber: number): string {
  return `plan-revision-retry:${operationId}:${retryNumber}`;
}

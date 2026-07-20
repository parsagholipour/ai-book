export const PLAN_REVISION_AUTOMATIC_RETRY_LIMIT = 2;
export const PLAN_REVISION_RETRY_BASE_DELAY_MS = 30_000;
export const PLAN_REVISION_ACTIVE_STALE_MS = 15 * 60_000;

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

export function canClaimPlanRevisionRetry(
  operation: PlanRevisionRetryState,
  now = new Date()
): { eligible: boolean; staleActive: boolean; reason: string | null } {
  if (operation.automaticRetryCount >= operation.automaticRetryLimit) {
    return { eligible: false, staleActive: false, reason: "automatic retry budget exhausted" };
  }
  if (operation.nextRetryAt && operation.nextRetryAt > now) {
    return { eligible: false, staleActive: false, reason: "retry backoff has not elapsed" };
  }
  const staleBefore = now.getTime() - PLAN_REVISION_ACTIVE_STALE_MS;
  const activeTimestamp = operation.generationJob?.startedAt ?? operation.generationJob?.updatedAt;
  const staleActive =
    operation.status === "ACTIVE" &&
    operation.generationJob?.status === "ACTIVE" &&
    Boolean(activeTimestamp && activeTimestamp.getTime() <= staleBefore);
  const failed = operation.status === "FAILED" && operation.generationJob?.status === "FAILED";
  if (!failed && !staleActive) {
    return { eligible: false, staleActive: false, reason: "operation is not failed or stale" };
  }
  return { eligible: true, staleActive, reason: null };
}

export function retryRequestKey(operationId: string, retryNumber: number): string {
  return `plan-revision-retry:${operationId}:${retryNumber}`;
}

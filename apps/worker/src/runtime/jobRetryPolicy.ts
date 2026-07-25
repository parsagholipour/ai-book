/**
 * Which BullMQ jobs get automatic retries, and when a failed attempt counts as
 * recoverable. Only transient network failures are retried; deterministic
 * errors bypass the configured attempts so they fail immediately.
 *
 * generate-page has always retried; generate-book joined once the direct
 * generation modes learned to resume (directGenerationResume.ts), so a retry
 * continues from the settled pages instead of regenerating the whole book.
 */

export const GENERATE_PAGE_RECOVERY_ATTEMPTS = 4;
export const GENERATE_BOOK_RECOVERY_ATTEMPTS = 2;
export const RECOVERY_BACKOFF_MS = 15_000;

const NETWORK_RETRYABLE_JOB_NAMES = new Set(["generate-page", "generate-book"]);

export type JobRetryContext = {
  jobName: string;
  /** Attempts already completed before the current one (BullMQ's job.attemptsMade). */
  attemptsMade: number;
  /** Configured attempt budget for the job (job.opts.attempts, minimum 1). */
  maxAttempts: number;
  recoverableNetworkError: boolean;
};

export function retryJobOptions(
  jobName: string
): { attempts: number; backoff: { type: "exponential"; delay: number } } | undefined {
  const attempts =
    jobName === "generate-page"
      ? GENERATE_PAGE_RECOVERY_ATTEMPTS
      : jobName === "generate-book"
        ? GENERATE_BOOK_RECOVERY_ATTEMPTS
        : undefined;
  if (attempts === undefined) {
    return undefined;
  }
  return {
    attempts,
    backoff: { type: "exponential", delay: RECOVERY_BACKOFF_MS }
  };
}

/** True when the failed attempt should be marked recovering and re-queued by BullMQ. */
export function shouldRecoverJobAttempt(context: JobRetryContext): boolean {
  return (
    NETWORK_RETRYABLE_JOB_NAMES.has(context.jobName) &&
    context.recoverableNetworkError &&
    context.attemptsMade + 1 < context.maxAttempts
  );
}

/** True when remaining configured attempts should be skipped because the error is deterministic. */
export function shouldBypassConfiguredRetries(context: JobRetryContext): boolean {
  return NETWORK_RETRYABLE_JOB_NAMES.has(context.jobName) && context.maxAttempts > 1 && !context.recoverableNetworkError;
}

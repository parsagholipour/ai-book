/**
 * The queue dispatch policy shared by the API (apps/api/src/queue.ts) and the
 * worker (apps/worker/src/runtime/dispatch.ts, jobRetryPolicy.ts). Both sides
 * publish to and consume from the same BullMQ queue, so the job-name table,
 * the retry budgets, the dispatch backoff, and the stop-signalling constants
 * must be one definition — they used to be hand-copied forks with "keep in
 * sync" comments. Only the Redis handle and the Prisma client stay local to
 * each side.
 */

/**
 * Every job the worker's dispatch switch actually handles — keep in sync with
 * `JobType` in the Prisma schema and the `switch` in apps/worker/src/index.ts.
 * The Prisma enum's RESEARCH is deliberately absent: nothing writes it and the
 * worker rejects it, so naming it here would let the API dispatch a job that
 * could only die.
 */
export const jobNames = {
  PLAN_BOOK: "plan-book",
  REVISE_PLAN: "revise-plan",
  GENERATE_BOOK: "generate-book",
  GENERATE_PAGE: "generate-page",
  GENERATE_IMAGE: "generate-image",
  COMPILE_EXPORT: "compile-export",
  APPLY_BOOK_EDIT: "apply-book-edit",
  REPLAN_BOOK: "replan-book",
  PREPARE_CHARACTER_CANDIDATES: "prepare-character-candidates",
  BUILD_CHARACTER_PERSONA: "build-character-persona",
  IMPORT_BOOK: "import-book",
  CONTINUE_BOOK: "continue-book",
  GENERATE_AUDIOBOOK: "generate-audiobook"
} as const;

export type GenerationJobType = keyof typeof jobNames;

export type WorkerJobName = (typeof jobNames)[GenerationJobType];

export function workerJobNameForType(type: string): string {
  const name = (jobNames as Record<string, string>)[type];
  if (!name) {
    throw new Error(`Unknown generation job type: ${type}`);
  }
  return name;
}

/** The message/error pair a user-stopped job is marked with. */
export const STOPPED_JOB_MESSAGE = "Stopped";
export const STOPPED_JOB_ERROR = "Stopped by user";

/*
 * Which BullMQ jobs get automatic retries, and when a failed attempt counts as
 * recoverable. Only transient network failures are retried; deterministic
 * errors bypass the configured attempts so they fail immediately.
 *
 * generate-page has always retried; generate-book joined once the direct
 * generation modes learned to resume (the worker's directGenerationResume.ts),
 * so a retry continues from the settled pages instead of regenerating the
 * whole book. generate-audiobook resumes the same way, from the chapters
 * already marked READY — and it is the job most exposed to a per-minute quota,
 * because it is dozens of speech calls in a row.
 */

export const GENERATE_PAGE_RECOVERY_ATTEMPTS = 4;
export const GENERATE_BOOK_RECOVERY_ATTEMPTS = 2;
export const GENERATE_AUDIOBOOK_RECOVERY_ATTEMPTS = 3;
export const RECOVERY_BACKOFF_MS = 15_000;

const NETWORK_RETRYABLE_JOB_NAMES = new Set(["generate-page", "generate-book", "generate-audiobook"]);

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
        : jobName === "generate-audiobook"
          ? GENERATE_AUDIOBOOK_RECOVERY_ATTEMPTS
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

/** Backoff bounds for re-dispatching durable jobs that failed to reach Redis. */
export const DISPATCH_BACKOFF_BASE_MS = 5_000;
export const DISPATCH_BACKOFF_MAX_MS = 5 * 60_000;

export function dispatchBackoffMs(attempt: number): number {
  return Math.min(DISPATCH_BACKOFF_MAX_MS, DISPATCH_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

/** A GenerationJob payload column, read defensively as a plain record. */
export function jsonPayloadToRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  return payload as Record<string, unknown>;
}

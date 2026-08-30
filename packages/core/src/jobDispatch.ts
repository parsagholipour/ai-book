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
  GENERATE_AUDIOBOOK: "generate-audiobook",
  GENERATE_CHARACTER_PORTRAIT: "generate-character-portrait"
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

const generationJobTypesByWorkerName = new Map<string, GenerationJobType>(
  Object.entries(jobNames).map(([type, name]) => [name, type as GenerationJobType])
);

/**
 * The inverse of `workerJobNameForType`, for the sites that only ever hold the
 * kebab BullMQ name — a running `Job` — and need to reach a table keyed by
 * `GenerationJobType`.
 *
 * Returns null rather than throwing: its callers are display paths (the step
 * template a job's progress row is seeded with), where an unrecognised name is
 * an empty list, not a failed job.
 */
export function generationJobTypeForWorkerName(name: string): GenerationJobType | null {
  return generationJobTypesByWorkerName.get(name) ?? null;
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
 *
 * apply-book-edit and continue-book have a budget for a different reason, and
 * it is deliberately invisible to their handlers. They publish the manuscript
 * and settle the charge inside one transaction, then run a checkpointed tail
 * — export invalidation, the memory write, the compile enqueue, the settled
 * status — outside the failure boundary, and `processJob` rethrows a tail
 * failure so BullMQ replays it. With no `attempts` that rethrow only moved the
 * job to failed: a COMPLETED durable row is not requeued by either side's
 * dispatch reconciliation, so the tail was simply lost and the book sat
 * EDITING until the stranded-generation sweep found it. Every failure the
 * handler itself reaches still bypasses the budget below, so a failed,
 * refunded edit is redelivered no more than it ever was.
 */

export const GENERATE_PAGE_RECOVERY_ATTEMPTS = 4;
export const GENERATE_BOOK_RECOVERY_ATTEMPTS = 2;
export const GENERATE_AUDIOBOOK_RECOVERY_ATTEMPTS = 3;
export const DELIVERED_TAIL_RECOVERY_ATTEMPTS = 2;
export const RECOVERY_BACKOFF_MS = 15_000;

const NETWORK_RETRYABLE_JOB_NAMES = new Set(["generate-page", "generate-book", "generate-audiobook"]);

const JOB_ATTEMPT_BUDGETS: Record<string, number> = {
  "generate-page": GENERATE_PAGE_RECOVERY_ATTEMPTS,
  "generate-book": GENERATE_BOOK_RECOVERY_ATTEMPTS,
  "generate-audiobook": GENERATE_AUDIOBOOK_RECOVERY_ATTEMPTS,
  "apply-book-edit": DELIVERED_TAIL_RECOVERY_ATTEMPTS,
  "continue-book": DELIVERED_TAIL_RECOVERY_ATTEMPTS
};

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
  const attempts = JOB_ATTEMPT_BUDGETS[jobName];
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

/**
 * True when remaining configured attempts should be skipped because the error
 * is deterministic — or because this job's budget was never the handler's to
 * spend. A name outside the network-retryable set carries attempts only for
 * its post-completion tail, so **every** failure that reaches the settlement
 * path is terminal for it, transient or not: the delivery has already failed
 * and refunded the edit, and a redelivery would re-run it against the row it
 * just settled.
 */
export function shouldBypassConfiguredRetries(context: JobRetryContext): boolean {
  if (context.maxAttempts <= 1) {
    return false;
  }
  return !NETWORK_RETRYABLE_JOB_NAMES.has(context.jobName) || !context.recoverableNetworkError;
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

/*
 * How the charge that paid for a book-generation run is found — shared by the
 * worker's failed/stopped-run refunds (runtime/jobLifecycle.ts) and the API's
 * user stop (apps/api/src/queue.ts). GENERATE_BOOK carries the ledger entry on
 * its own payload; fan-out children carry only the planId, so their charge is
 * resolved through the newest GENERATE_BOOK payload for that plan. Callers may
 * still fall back to the project's latest FULL_BOOK_GENERATION charge when
 * nothing resolves — that keeps rows enqueued before the stamp refundable, but
 * it can claw back a *newer* run's charge, which is why resolution comes first.
 */

/** How many recent GENERATE_BOOK rows a caller should fetch for the plan walk. */
export const BOOK_GENERATION_CHARGE_LOOKBACK = 10;

/** The ledger entry stamped on the newest GENERATE_BOOK payload for this plan; rows newest-first. */
export function bookGenerationChargeFromPayloads(
  rows: ReadonlyArray<{ payload: unknown }>,
  planId: string
): string | null {
  for (const row of rows) {
    const payload = jsonPayloadToRecord(row.payload);
    if (payload.planId === planId && typeof payload.billingLedgerEntryId === "string" && payload.billingLedgerEntryId) {
      return payload.billingLedgerEntryId;
    }
  }
  return null;
}

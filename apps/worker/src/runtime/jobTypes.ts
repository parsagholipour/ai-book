import { STOPPED_JOB_ERROR, STOPPED_JOB_MESSAGE, type ChapterBrief, type ChapterPlan, type PageDraft } from "@book-maker/core";

/**
 * Job-shaped types and stop-signalling shared by the worker runtime and every
 * job handler. Kept free of runtime dependencies so handlers can import it
 * without pulling in the queue or provider stack.
 */

export { STOPPED_JOB_ERROR, STOPPED_JOB_MESSAGE };

/**
 * Thrown when a user stops a generation mid-flight. The worker translates this
 * into an unrecoverable BullMQ error so the job is not retried.
 */
export class StopRequestedError extends Error {
  constructor() {
    super(STOPPED_JOB_ERROR);
    this.name = "StopRequestedError";
  }
}

export function isStopRequestedError(error: unknown): boolean {
  return error instanceof StopRequestedError;
}

/**
 * A structural redelivery waited out the owner's lease without ever acquiring
 * it. `processJob` must not `markCompleted` — this delivery did not finish the
 * work — and must not `markFailed`: acquire-wait `abandoned` means the owner
 * is still holding a live lease, so failing the shared row would refund and
 * fail an insert that is still drafting.
 */
export class UnownedStructuralDeliveryError extends Error {
  constructor() {
    super("Structural page edit wait gave up without owning the delivery");
    this.name = "UnownedStructuralDeliveryError";
  }
}

export function isUnownedStructuralDeliveryError(error: unknown): boolean {
  return error instanceof UnownedStructuralDeliveryError;
}

/**
 * A text-edit redelivery waited for a live lease without ever owning it. The
 * shared durable job still belongs to the delivery doing the rewrite, so this
 * invocation may neither complete nor fail it.
 */
export class UnownedTextEditDeliveryError extends Error {
  constructor() {
    super("Text edit wait gave up without owning the delivery");
    this.name = "UnownedTextEditDeliveryError";
  }
}

export function isUnownedTextEditDeliveryError(error: unknown): boolean {
  return error instanceof UnownedTextEditDeliveryError;
}

/**
 * Drafting failed and the revert did not put the book back, so the shifted
 * manuscript is still there with its stamp. `processJob` must not `markFailed`:
 * that would refund the ACTIVE operation, clear its lease and restore COMPLETE
 * over pages that have not been put back. The handler has already yielded the
 * lease and requeued the durable job; this delivery exits unrecoverably so it
 * does not occupy a slot.
 */
export class StructuralRollbackRedeliveryError extends Error {
  constructor() {
    super("Structural page edit rollback failed; the shifted book was requeued to resume drafting");
    this.name = "StructuralRollbackRedeliveryError";
  }
}

export function isStructuralRollbackRedeliveryError(error: unknown): boolean {
  return error instanceof StructuralRollbackRedeliveryError;
}

export function isStoppedGenerationJob(
  job: { status: string; message: string | null; error: string | null } | null
): boolean {
  return job?.status === "FAILED" && (job.message === STOPPED_JOB_MESSAGE || job.error === STOPPED_JOB_ERROR);
}

export type ExportPageForRepair = {
  id: string;
  index: number;
  title: string;
  markdown: string;
  summary: string;
  imagePrompt: string | null;
  qualityReport?: unknown;
  revision: number;
  status: string;
  chapter?: { id: string; index: number; productionBrief: unknown } | null;
  images: Array<{ path: string }>;
};

export type ChapterSetup = {
  chapter: ChapterPlan;
  brief?: ChapterBrief | undefined;
  startPage: number;
  endPage: number;
};

export type IndexedPageDraft = PageDraft & {
  index: number;
};

export type WorkerImageAsset = {
  id: string;
  path: string;
  metadata: unknown;
};

export type JobLifecycleSettlement = "settle" | "defer-to-successor";

/** Returned by a handler that needs work to run after the job is marked complete. */
export type JobCompletion = {
  /**
   * The handler atomically committed the durable job's terminal verdict with
   * its delivered output. A later `markCompleted` error is bookkeeping only and
   * must not make Bull report that already-delivered work as failed.
   */
  durableCompletionCommitted?: boolean;
  /**
   * Terminalize this durable job without settling its shared attempt or edit.
   * The successor preserves that scope and owns its eventual success/failure.
   */
  lifecycleSettlement?: JobLifecycleSettlement;
  afterJobCompleted?: () => Promise<void>;
};

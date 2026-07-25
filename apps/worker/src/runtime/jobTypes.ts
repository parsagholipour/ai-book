import type { ChapterBrief, ChapterPlan, PageDraft } from "@book-maker/core";

/**
 * Job-shaped types and stop-signalling shared by the worker runtime and every
 * job handler. Kept free of runtime dependencies so handlers can import it
 * without pulling in the queue or provider stack.
 */

export const STOPPED_JOB_MESSAGE = "Stopped";
export const STOPPED_JOB_ERROR = "Stopped by user";

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
  revision: number;
  status: string;
  chapter?: { index: number; productionBrief: unknown } | null;
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

/** Returned by a handler that needs work to run after the job is marked complete. */
export type JobCompletion = {
  afterJobCompleted?: () => Promise<void>;
};

/**
 * Jobs that produce optional experiences from an existing book rather than
 * changing the book itself. Their durable rows own their lifecycle; they must
 * never move Project.status.
 *
 * The allowlist is intentionally narrow. An unknown future job defaults to the
 * book lifecycle until its independent owner and failure handling are explicit.
 */
export const DERIVATIVE_GENERATION_JOBS = {
  PREPARE_CHARACTER_CANDIDATES: "prepare-character-candidates",
  BUILD_CHARACTER_PERSONA: "build-character-persona",
  GENERATE_AUDIOBOOK: "generate-audiobook"
} as const;

export type DerivativeGenerationJobType = keyof typeof DERIVATIVE_GENERATION_JOBS;
export type DerivativeWorkerJobName = (typeof DERIVATIVE_GENERATION_JOBS)[DerivativeGenerationJobType];

const derivativeJobTypes = new Set<string>(Object.keys(DERIVATIVE_GENERATION_JOBS));
const derivativeWorkerJobNames = new Set<string>(Object.values(DERIVATIVE_GENERATION_JOBS));

export function isDerivativeGenerationJobType(type: string): type is DerivativeGenerationJobType {
  return derivativeJobTypes.has(type);
}

export function isDerivativeWorkerJobName(name: string): name is DerivativeWorkerJobName {
  return derivativeWorkerJobNames.has(name);
}

export function generationJobControlsProjectStatus(type: string): boolean {
  return !isDerivativeGenerationJobType(type);
}

export function workerJobControlsProjectStatus(name: string): boolean {
  return !isDerivativeWorkerJobName(name);
}

/**
 * Payload flag for a job that redoes work for a project which is *already
 * finished and already paid for*.
 *
 * The allowlist above is per job *name*, which is the right granularity for a
 * job that is always derivative. It is the wrong granularity for
 * `compile-export`, which is both: the compile at the end of generation owns the
 * book's outcome and must fail it if it cannot produce the artifacts, while a
 * compile queued later to rebuild a missing file owns nothing. Without this,
 * that second kind takes the first kind's failure path — `markFailed` flips a
 * COMPLETE project to FAILED and `refundFailedProjectCredits` walks the payload's
 * `planId` to the book's own `GENERATE_BOOK` charge and refunds it. One Chromium
 * blip on a repair, and a delivered book is marked failed and given back.
 *
 * A job carrying this flag fails alone: its own row records the failure, the
 * project is left exactly as it was, and nothing is refunded because nothing was
 * charged for it.
 *
 * "Left exactly as it was" includes what the project *reports*. A failed row is
 * still a failed row, so every surface that reads one as the book's own trouble
 * has to ask: the mobile status serializer's `failureMessage` (a COMPLETE book
 * would say "needs attention" forever), the failed generation step, and the
 * recovery predicates behind both resume routes — `/resume` moves a project to
 * GENERATING for everything it requeues, and a repair that failed again could
 * not move it back out, since this flag is what stops it reporting failure.
 * Detached work comes back on demand instead (`ensureExportRepairQueued`).
 */
export const DETACHED_FROM_PROJECT_LIFECYCLE = "detachedFromProjectLifecycle";

function payloadFlag(payload: unknown, key: string): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  return (payload as Record<string, unknown>)[key] === true;
}

export function isDetachedFromProjectLifecycle(payload: unknown): boolean {
  return payloadFlag(payload, DETACHED_FROM_PROJECT_LIFECYCLE);
}

/**
 * Payload flag for a recompile that changes how the book is *printed* rather
 * than what it says.
 *
 * Set by `applyPresentationPreference` — the Sources list, the chapter-heading
 * style — which writes one `mediaSettings` field and queues a recompile. Not
 * one character of `Page.markdown` moves, so the manuscript the last real QA
 * pass read is still the manuscript on disk.
 *
 * It exists because `skipFinalReview` cannot answer that question. An edit's own
 * recompile sets that too (`applyBookEdit`, a manual Edit Mode save, an undo),
 * and those genuinely rewrite prose: their deterministic-only verdict *should*
 * replace a verdict that describes pages which no longer exist, or the quality
 * card would keep naming issues on a page the reader just fixed, forever —
 * nothing runs full QA on a finished book again.
 */
export const PRESENTATION_ONLY_RECOMPILE = "presentationOnlyRecompile";

export function isPresentationOnlyRecompile(payload: unknown): boolean {
  return payloadFlag(payload, PRESENTATION_ONLY_RECOMPILE);
}

/**
 * Whether this payload belongs to work whose outcome is the paid book's own.
 *
 * False for the two payload-flagged kinds that settle alone — a detached export
 * repair and a presentation-only recompile. Every surface that settles, reports
 * or resumes a row on the book's behalf must ask this one question, and ask it
 * here: a site that checks one flag by hand misses the other, which is exactly
 * how a non-owning row ends up refunding a delivered book or painting a
 * COMPLETE one as failed.
 */
export function payloadOwnsProjectOutcome(payload: unknown): boolean {
  return !isDetachedFromProjectLifecycle(payload) && !isPresentationOnlyRecompile(payload);
}

/** The settled status a free presentation reprint must return to on failure. */
export const PRESENTATION_RECOMPILE_FALLBACK_STATUS = "presentationRecompileFallbackStatus";

export type SettledProjectStatus = "COMPLETE" | "REVIEW_REQUIRED";

export function presentationRecompileFallbackStatus(payload: unknown): SettledProjectStatus {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "COMPLETE";
  }
  return (payload as Record<string, unknown>)[PRESENTATION_RECOMPILE_FALLBACK_STATUS] === "REVIEW_REQUIRED"
    ? "REVIEW_REQUIRED"
    : "COMPLETE";
}

/** The one artifact a detached export repair was asked to replace. */
export const EXPORT_REPAIR_FORMAT = "exportRepairFormat";

export type ExportRepairFormat = "pdf" | "epub";

export function exportRepairFormatFromPayload(payload: unknown): ExportRepairFormat | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const value = (payload as Record<string, unknown>)[EXPORT_REPAIR_FORMAT];
  return value === "pdf" || value === "epub" ? value : null;
}

/** Project status a compile observed when it was enqueued and may publish over. */
export const EXPORT_PUBLICATION_PROJECT_STATUS = "exportPublicationProjectStatus";

export type ExportPublicationProjectStatus = "GENERATING" | "EDITING" | "COMPLETE" | "REVIEW_REQUIRED";

export function exportPublicationProjectStatusFromPayload(
  payload: unknown
): ExportPublicationProjectStatus | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const value = (payload as Record<string, unknown>)[EXPORT_PUBLICATION_PROJECT_STATUS];
  return value === "GENERATING" ||
    value === "EDITING" ||
    value === "COMPLETE" ||
    value === "REVIEW_REQUIRED"
    ? value
    : null;
}

/**
 * Whether failure/stopping this durable row owns the paid book's outcome.
 *
 * Presentation recompiles still own their successful EDITING -> settled status
 * transition, but they are free derivative work on an already delivered book.
 * They therefore share neither the generation compile's refund nor its FAILED
 * transition. Detached repairs are even narrower: they own no project status
 * on success either.
 */
export function generationJobOwnsFailureLifecycle(type: string, payload: unknown): boolean {
  return generationJobControlsProjectStatus(type) && payloadOwnsProjectOutcome(payload);
}

export function workerJobOwnsFailureLifecycle(name: string, payload: unknown): boolean {
  return workerJobControlsProjectStatus(name) && payloadOwnsProjectOutcome(payload);
}

/**
 * Whether this job's quality report, if it writes one, is the *book's* verdict.
 *
 * A pure function of the row a job is created with, which is why it is applied
 * where those rows are born — `enqueueGenerationJob` in the API and
 * `enqueueWorkerJob` in the worker, the same two places `contentRevision` is
 * promoted out of the payload — and stored on `GenerationJob.ownsQualityVerdict`
 * so the read side can ask the database for the owner instead of scanning the
 * newest handful of jobs and hoping it is still among them.
 *
 * Only `compile-export` writes a manuscript quality report at all, and it is two
 * jobs wearing one name. The compile that ends a generation, or applies an edit,
 * reviews the book it just produced and owns the answer. Two kinds do not: a
 * detached export repair rebuilds a file for a book that is already finished and
 * already paid for (`skipFinalReview`, so its report is the deterministic checks
 * alone), and a presentation-only recompile reprints an unchanged manuscript.
 * Letting either speak replaces real model QA — chapter coherence, transitions,
 * the `affectedPageIndexes` the card's "Fix page N" button is built from — with
 * a report that never asked a model anything.
 */
export function jobOwnsQualityVerdict(type: string, payload: unknown): boolean {
  return type === "COMPILE_EXPORT" && payloadOwnsProjectOutcome(payload);
}

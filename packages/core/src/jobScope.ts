import { generationJobTypeForWorkerName, type GenerationJobType } from "./jobDispatch.js";

/**
 * Jobs that produce optional experiences from an existing book rather than
 * changing the book itself. Their durable rows own their lifecycle; they must
 * never move Project.status.
 *
 * The allowlist is intentionally narrow. An unknown future job defaults to the
 * book lifecycle until its independent owner and failure handling are explicit.
 */
export const DERIVATIVE_GENERATION_JOBS = Object.freeze({
  PREPARE_CHARACTER_CANDIDATES: "prepare-character-candidates",
  BUILD_CHARACTER_PERSONA: "build-character-persona",
  GENERATE_AUDIOBOOK: "generate-audiobook",
  GENERATE_CHARACTER_PORTRAIT: "generate-character-portrait"
} as const);

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
 * Payload flag for a recompile whose markdown change carries no new quality
 * information: the chat `add_image` apply appended one image line to a saved
 * page. `Page.markdown` moved, so this is not `PRESENTATION_ONLY_RECOMPILE` —
 * the compile still owns the project's status and failure lifecycle like any
 * edit recompile — but no prose changed, so the model-QA findings the book
 * earned still describe every page and this compile's deterministic-only
 * report must not replace them.
 */
export const MARKDOWN_RECOMPILE_WITHOUT_VERDICT = "markdownRecompileWithoutVerdict";

export function isMarkdownRecompileWithoutVerdict(payload: unknown): boolean {
  return payloadFlag(payload, MARKDOWN_RECOMPILE_WITHOUT_VERDICT);
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

function settledStatusFromPayload(payload: unknown, key: string): SettledProjectStatus {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "COMPLETE";
  }
  return (payload as Record<string, unknown>)[key] === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "COMPLETE";
}

export function presentationRecompileFallbackStatus(payload: unknown): SettledProjectStatus {
  return settledStatusFromPayload(payload, PRESENTATION_RECOMPILE_FALLBACK_STATUS);
}

/**
 * The settled status the book was in before the edit this job applies.
 *
 * Carried rather than read, because the enqueue is what takes it away: a chat
 * Apply writes `status: "EDITING"` in the same committed transaction as the
 * `GenerationJob` row, so by the time the handler runs the project can only
 * answer EDITING — before its own EDITING write as much as after it, and on a
 * redelivery the first delivery deliberately left it there too. Every worker
 * fork and the shared failed/stopped lifecycle exits therefore use this stamp
 * whenever they settle the project themselves: a delivered no-op or a
 * recompile they could not queue must not turn an in-review book COMPLETE.
 *
 * COMPLETE when the key is absent, which is what a job enqueued before this
 * existed means and what almost every book is.
 */
export const PRE_EDIT_PROJECT_STATUS = "preEditProjectStatus";

export function preEditProjectStatus(payload: unknown): SettledProjectStatus {
  return settledStatusFromPayload(payload, PRE_EDIT_PROJECT_STATUS);
}

/**
 * Jobs that temporarily take an already-settled book into EDITING and must put
 * it back when their own work exits without publishing.
 *
 * Operation linkage cannot answer this question: REPLAN_BOOK and the
 * GENERATE_BOOK it starts carry the replan operation too, but they own the
 * lifecycle of a brand-new copy with no settled status to restore. Unknown
 * future jobs therefore default to generation ownership until explicitly
 * classified here.
 */
export const PRE_EDIT_STATUS_RESTORING_JOB_TYPES = Object.freeze([
  "APPLY_BOOK_EDIT",
  "CONTINUE_BOOK"
] as const satisfies readonly GenerationJobType[]);

const preEditStatusRestoringGenerationJobTypes = new Set<string>(PRE_EDIT_STATUS_RESTORING_JOB_TYPES);

export function generationJobRestoresPreEditProjectStatus(type: string): boolean {
  return preEditStatusRestoringGenerationJobTypes.has(type);
}

export function workerJobRestoresPreEditProjectStatus(name: string): boolean {
  const type = generationJobTypeForWorkerName(name);
  return type !== null && generationJobRestoresPreEditProjectStatus(type);
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
 * reviews the book it just produced and owns the answer. Three kinds do not: a
 * detached export repair rebuilds a file for a book that is already finished and
 * already paid for (`skipFinalReview`, so its report is the deterministic checks
 * alone), a presentation-only recompile reprints an unchanged manuscript, and a
 * `MARKDOWN_RECOMPILE_WITHOUT_VERDICT` recompile follows a markdown append that
 * touched no prose. Letting any of them speak replaces real model QA — chapter
 * coherence, transitions, the `affectedPageIndexes` the card's "Fix page N"
 * button is built from — with a report that never asked a model anything.
 */
export function jobOwnsQualityVerdict(type: string, payload: unknown): boolean {
  return (
    type === "COMPILE_EXPORT" &&
    payloadOwnsProjectOutcome(payload) &&
    !isMarkdownRecompileWithoutVerdict(payload)
  );
}

/**
 * Payload flag for a compile that skips the final quality review — and with it
 * the repair pass that review drives, which `compileExport.ts` hands *every*
 * FAILED_QA page in the book rather than only the pages the review named.
 *
 * Set by every edit's own recompile, every presentation reprint and every
 * detached export repair; `compileExport.ts` reads it off `job.data` to decide.
 * Named here because the read side asks the same question of a row that has not
 * run yet — see `openJobRewritesPages`.
 */
export const SKIP_FINAL_REVIEW = "skipFinalReview";

export function skipsFinalReview(payload: unknown): boolean {
  return payloadFlag(payload, SKIP_FINAL_REVIEW);
}

/**
 * When an *open* row of a job type can still rewrite a page the project already
 * holds — the prose in `Page.markdown`, or the QA verdict `Page.status` carries
 * for it.
 *
 * `never` is a claim about a queued or running row, not about the handler's
 * whole reach: `generate-image` writes `Page.imageFailureReason` and
 * `generate-audiobook` reads every page's markdown, and both are `never`
 * because neither can change what a page says or whether it passed.
 */
export type PageRewriteScope = "never" | "always" | "unless_final_review_skipped";

/**
 * Which job types can still rewrite the book's pages, exhaustively over
 * `GenerationJobType`.
 *
 * The reader of this table is a status poll: a page that ran out of QA budget
 * keeps its best draft and does ship, so it counts as a page of the book — but
 * only once nothing is going to redraft it (`isBookPage` in
 * `apps/api/src/projectPageCounts.ts`). Project status alone cannot answer that,
 * because three forks draft pages in a status that reads as settled:
 * `restructurePages` and `replanBook` set the project EDITING and then draft
 * through `reviewAndSaveGeneratedPage`, and `continueBook` sets it COMPLETE and
 * then queues its recompile. A poll landing inside any of those windows used to
 * count a page that was still being written.
 *
 * A `Record` rather than an array so a new entry in `jobNames` is a compile
 * error until someone answers the question for it — the shape `JOB_STEP_TEMPLATES`
 * uses one file over, and for the same reason: this project's hand-maintained
 * per-job-type lists have drifted every time they were allowed to.
 *
 * Answer for the *open row*, not for the handler's happiest path. `import-book`
 * only ever creates pages and `generate-book` usually fans out rather than
 * drafting inline, but both write `Page.markdown` themselves, and an answer that
 * holds only while nothing goes wrong is the failure this table exists to stop.
 */
export const JOB_PAGE_REWRITE_SCOPE: Readonly<Record<GenerationJobType, PageRewriteScope>> = Object.freeze({
  /** Writes a plan. The pages it will produce do not exist yet. */
  PLAN_BOOK: "never",
  REVISE_PLAN: "never",
  /** Creates the page rows and, in the direct modes, drafts them inline. */
  GENERATE_BOOK: "always",
  /** One page, drafted and reviewed — including the FAILED_QA it may settle as. */
  GENERATE_PAGE: "always",
  /** Renders an illustration; the only page column it touches is `imageFailureReason`. */
  GENERATE_IMAGE: "never",
  /**
   * Two jobs wearing one name. The compile that ends a generation or applies a
   * structural edit runs the final-QA repair over every FAILED_QA page; an
   * edit's own recompile, a presentation reprint and an export repair carry
   * `skipFinalReview` and rewrite nothing.
   */
  COMPILE_EXPORT: "unless_final_review_skipped",
  /**
   * Every fork of it — a page rewrite, a structural insert's drafting, an exact
   * replacement, and the three that only move a picture about. The fork is
   * decided by the operation's `kind`, which is on the `BookEditOperation` row
   * rather than this job's payload, so at this granularity the answer can only
   * be yes: the finer one is a read of that row, and this package is the leaf
   * that cannot make it. `EDIT_OPERATION_PAGE_REWRITE_SCOPE` in
   * `apps/api/src/projectPageCounts.ts` answers it there, and it *narrows* this
   * rather than replacing it — a caller that never asks gets the conservative
   * answer, which is what makes the coarse one safe to keep.
   */
  APPLY_BOOK_EDIT: "always",
  /** Replaces the plan and redrafts the pages it changed. */
  REPLAN_BOOK: "always",
  /** Reads pages to propose characters; writes none of them. */
  PREPARE_CHARACTER_CANDIDATES: "never",
  BUILD_CHARACTER_PERSONA: "never",
  /** Writes the manuscript's pages. */
  IMPORT_BOOK: "always",
  /** Drafts the new chapters' pages through the same review loop. */
  CONTINUE_BOOK: "always",
  /** Narrates a finished book. Failing one must not even touch the book. */
  GENERATE_AUDIOBOOK: "never",
  /** Account-scoped: it has no project, let alone a page. */
  GENERATE_CHARACTER_PORTRAIT: "never"
});

/**
 * The job types worth reading at all — everything the table above does not
 * answer `never` for. Derived rather than spelled a second time, so the `where`
 * a caller builds from it cannot fall behind the table.
 *
 * `readonly`, and frozen so the compiler is not the only thing saying so. This
 * is one array for the life of the process and it is handed to a Prisma `where`
 * that decides which open jobs a status poll asks about, so a consumer that
 * sorted it in place or spliced a type out of it would change what *every*
 * later poll asks — and a poll that has stopped asking about `GENERATE_PAGE`
 * answers "nothing is going to rewrite this page" while the page is being
 * written, which is the skew the table exists to prevent. Callers copy it into
 * the query rather than handing this object over, which is also why the frozen
 * array never reaches anything that might normalise its arguments in place.
 */
export const PAGE_REWRITING_JOB_TYPES: readonly GenerationJobType[] = Object.freeze(
  (Object.entries(JOB_PAGE_REWRITE_SCOPE) as Array<[GenerationJobType, PageRewriteScope]>).flatMap(
    ([type, scope]) => (scope === "never" ? [] : [type])
  )
);

/** The same table as a lookup, so an inherited property cannot answer for a type. */
const pageRewriteScopeByType = new Map<string, PageRewriteScope>(Object.entries(JOB_PAGE_REWRITE_SCOPE));

/**
 * Whether this open `GenerationJob` row can still rewrite one of the book's
 * pages. The type decides, except where a payload flag takes the work away —
 * `skipFinalReview` on a compile, which is the difference between the pass that
 * repairs every kept draft and a reprint that touches none of them.
 *
 * An unknown type answers false: this is a read-side question about work that
 * is *going* to happen, and a type nothing dispatches is not going to happen.
 */
export function openJobRewritesPages(type: string, payload: unknown): boolean {
  const scope = pageRewriteScopeByType.get(type);
  if (scope === undefined || scope === "never") {
    return false;
  }
  return scope === "always" || !skipsFinalReview(payload);
}

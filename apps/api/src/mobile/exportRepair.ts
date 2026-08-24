import {
  DETACHED_FROM_PROJECT_LIFECYCLE,
  EXPORT_PUBLICATION_PROJECT_STATUS,
  EXPORT_REPAIR_FORMAT,
  type AppConfig
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
// Shared with status availability so both surfaces agree on whether a path is
// a readable regular file without full-reading and hashing large exports.
import { probeReadableProjectExport } from "../routes/projectExports.js";
import { TimeBudgetExceededError, withTimeout } from "../withTimeout.js";

/**
 * Rebuilding a compiled export that is missing from disk.
 *
 * Reachable in the window a user edit opens — `invalidateCompiledProjectExports`
 * deletes the files and `queueUserEditExportRecompile` queues the rebuild a
 * moment later — and afterwards, if that rebuild never landed.
 */

export type RepairableProject = {
  id: string;
  status: string;
  currentPlanId: string | null;
  contentRevision: number;
};

/** The file a caller found missing. It decides how often the repair may repeat. */
export type MissingExportFormat = "pdf" | "epub";

/**
 * All the repair needs of the config: where compiled books live.
 *
 * Narrowed rather than taking the whole `AppConfig` because the only thing this
 * module does with it is re-stat one path — and because the callers that hold a
 * project id and no config at all (`ensureExportRepairQueuedFor`, the tests
 * that drive the decision directly) then have one obvious thing to supply.
 */
export type ExportRepairStorage = Pick<AppConfig, "BOOK_STORAGE_DIR">;

/**
 * Which missing file a status read should repair, or null when both are there.
 *
 * The PDF wins when both are gone: a compile produces both files anyway, and
 * the PDF's repair is the one that may retry.
 */
export function missingExportFormat(exports: {
  pdf: { available: boolean };
  epub: { available: boolean };
}): MissingExportFormat | null {
  if (!exports.pdf.available) {
    return "pdf";
  }
  if (!exports.epub.available) {
    return "epub";
  }
  return null;
}

export function exportableStatus(status: string): boolean {
  return status === "COMPLETE" || status === "REVIEW_REQUIRED";
}

/**
 * How long one repair attempt stands for.
 *
 * Long enough that a project whose compile keeps failing cannot turn the app's
 * four-second poll into a job per poll, and short enough that a reader who comes
 * back later gets a fresh attempt. The app's own poll budget is two minutes, so
 * one "preparing" episode queues one repair.
 */
const EXPORT_REPAIR_WINDOW_MS = 5 * 60_000;

/**
 * How long a request may wait for the repair's hand-off to BullMQ.
 *
 * The durable row is committed before the hand-off runs, and a row left QUEUED
 * with no `bullJobId` is exactly what `reconcileUndispatchedGenerationJobs`
 * republishes — the API sweeps for those every five seconds. So the publish is
 * *late*, never lost, which is the whole reason `enqueueGenerationJob` is called
 * with `dispatch: false` in the first place.
 *
 * What it must not be is unbounded. `apps/api/src/queue.ts` builds its ioredis
 * connection with `maxRetriesPerRequest: null` — required by BullMQ, and it
 * means a command issued while Redis is unreachable waits in the offline queue
 * for the server to come back instead of failing. `bookQueue.add` therefore
 * neither resolves nor rejects during an outage, and every caller here is a
 * Fastify handler the app polls: the PDF and EPUB downloads, `GET …/status`, and
 * each tick of the `…/status/events` stream. Awaiting that hand-off is what let
 * a Redis outage hold those requests open for the length of the outage, on a
 * path whose only honest answer is "not ready yet" — an answer it already had
 * before it ever touched the queue.
 *
 * Two seconds is far above a healthy `add` (one round trip) and far below any
 * client budget, so it only ever fires when Redis is actually gone.
 */
const EXPORT_REPAIR_DISPATCH_BUDGET_MS = 2_000;

/**
 * The dedupe key for a repair.
 *
 * It is deliberately *not* `queueUserEditExportRecompile`'s normalized
 * revision-and-policy intent key. Sharing that key reads as "collapse with the
 * edit's recompile" and does that correctly only while the edit's job is still
 * live: `enqueueGenerationJob` returns any existing row for a key and only
 * re-dispatches one that is still QUEUED, so once that row goes COMPLETED or
 * FAILED the key is spent and every later repair for the same revision enqueues
 * nothing at all. That is worst exactly where it hurts most — an edit deletes
 * the exports *before* queueing its recompile, so a recompile that fails leaves
 * a book with no files, a terminal key, and an app that polls "preparing"
 * forever. The collapse itself is now done by asking whether a compile is
 * actually pending, which holds whatever key that compile used.
 *
 * The window is what keeps a burst of callers — the reader, the saved-export
 * card, the actions menu and the status poll can all fire at once — to a single
 * job, through the unique index on `dedupeKey`.
 *
 * EPUB repairs use the same bounded retry window. Keeping `epub` in the key
 * leaves room for one dedicated conversion attempt after a PDF repair completes
 * without producing its companion EPUB; the pending-job guard still collapses
 * compiles that are actually concurrent. The window makes a terminal EPUB row
 * retryable. Without it, one transient conversion failure permanently spends
 * the revision-only key and every later status or download attempt gets that
 * settled row back until the manuscript is edited.
 */
export function exportRepairDedupeKey(options: {
  projectId: string;
  planId: string;
  contentRevision: number;
  format?: MissingExportFormat | undefined;
  now?: number | undefined;
}): string {
  const base = `compile-export:${options.projectId}:${options.planId}`;
  const window = Math.floor((options.now ?? Date.now()) / EXPORT_REPAIR_WINDOW_MS);
  if (options.format === "epub") {
    return `${base}:repair-epub-${options.contentRevision}-${window}`;
  }
  return `${base}:repair-${options.contentRevision}-${window}`;
}

/**
 * Queues a repair for a caller that holds an id rather than the row.
 *
 * The status *stream* reads its project once, when the client subscribes, and
 * then stays open for the whole run — so by the time it notices a missing file,
 * the status, plan and content revision it was opened with have all moved on.
 * They are read again here, at the moment the decision is actually made.
 *
 * Best-effort by construction: a repair that cannot even be considered must not
 * take down the stream that noticed the missing file.
 */
export async function ensureExportRepairQueuedFor(
  projectId: string,
  userId: string,
  missing: MissingExportFormat,
  appConfig: ExportRepairStorage
): Promise<void> {
  try {
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { id: true, status: true, currentPlanId: true, contentRevision: true }
    });
    if (project) {
      await ensureExportRepairQueued(project, missing, appConfig);
    }
  } catch {
    // Callers answer "not ready" either way.
  }
}

/**
 * Whether the file the caller found missing is *still* missing.
 *
 * Readability is the whole predicate, deliberately through the same lightweight
 * probe status availability uses: a repair exists to put a downloadable file
 * back, so a path that merely stats (a directory, unreadable inode, or torn
 * file) is still missing. The provenance record beside it is not consulted — a file
 * published before those records existed reads as `unknown` and is perfectly
 * downloadable, and a `mismatch` means a publication is landing under this very
 * read, which is the last moment anything should start another compile.
 *
 * An unreadable answer counts as missing. Reaching the catch means storage
 * failed in some other way; standing down on that would be a book left broken
 * by the one condition that also stops it healing on its own.
 */
async function exportArtifactStillMissing(
  appConfig: ExportRepairStorage,
  projectId: string,
  format: MissingExportFormat
): Promise<boolean> {
  try {
    return (await probeReadableProjectExport(appConfig, projectId, format)) === null;
  } catch {
    return true;
  }
}

/**
 * Queues the compile that will produce the missing file, if none is already coming.
 *
 * The look and the queueing are one decision, because the unique index cannot
 * make them one. It collapses a burst of callers only while they agree on a key,
 * and the two formats deliberately do not: a status read that finds the PDF
 * missing and an EPUB download that lands in the same millisecond compute
 * `repair-{revision}-{window}` and `repair-epub-{revision}-{window}`, so each
 * inserts a row of its own. Both are whole compiles of the same manuscript —
 * both render the book in Chromium, taking both of the browser pool's two slots,
 * and both regroup its reader chapters — to rebuild one file. The same split
 * opens between two PDF callers who straddle a window boundary.
 *
 * Serializable is what closes it: the loser's insert conflicts with the winner's
 * predicate read of the pending compiles, Postgres refuses it, and it lands in
 * the catch below like any other failure — the caller answers "not ready", which
 * is what it was going to answer anyway, and by its next poll the winner's job is
 * the pending one everybody stands down for. Only these transactions run
 * serializable, so nothing the worker is doing to the same rows can be aborted by
 * one.
 *
 * The other half of the decision is the file itself, which is why it is re-read
 * here rather than trusted from the caller — see the guard below.
 */
export async function ensureExportRepairQueued(
  project: RepairableProject,
  missing: MissingExportFormat,
  appConfig: ExportRepairStorage
): Promise<void> {
  const planId = project.currentPlanId;
  if (!planId || !exportableStatus(project.status)) {
    return;
  }
  try {
    const queued = await prisma.$transaction(
      async (tx) => {
        // An edit's recompile, or an earlier repair, is already on its way.
        // Reading the job's *state* rather than reusing its key is what makes
        // this keep working after that job settles.
        const pending = await tx.generationJob.findFirst({
          where: {
            projectId: project.id,
            type: "COMPILE_EXPORT",
            status: { in: ["QUEUED", "ACTIVE"] }
          },
          select: { id: true }
        });
        if (pending) {
          return null;
        }
        // …and the file is still missing *now*.
        //
        // Every caller reached this function by observing a missing file — the
        // download route read it, both status surfaces stat it through
        // `serializeExportSet` — and that observation is already stale by the
        // time this transaction opens. A compile that finishes in between is
        // invisible to the pending read above, so the repair bought the book a
        // whole second compile of a manuscript that already has its file — a
        // Chromium render holding one of the browser pool's two slots, which is
        // a slot a real compile is then waiting for.
        //
        // Which is why this runs *after* the pending read rather than before
        // it. Together the two have no gap, because `publishCompiledExports`
        // installs the file and terminalizes its durable row in the same
        // transaction. A compile still working is caught by the read, and one
        // that committed early enough for the read to miss it has already left
        // the file where this probe will find it. What is left is the instant
        // between this probe
        // and the insert — the filesystem is not in the transaction, so no
        // isolation level can cover it — which is microseconds of a window that
        // was previously as long as a compile.
        //
        // Nothing here takes a lock or reads the project row, deliberately. A
        // publication holds that row while it renames; a repair decision that
        // wanted the same row would queue behind every publication in flight,
        // on a path whose callers are Fastify handlers the app polls. This
        // takes a predicate read on `GenerationJob` and one lightweight file
        // probe, so it can neither deadlock with a publication nor wait on a
        // compile.
        if (!(await exportArtifactStillMissing(appConfig, project.id, missing))) {
          return null;
        }
        return enqueueGenerationJob({
          projectId: project.id,
          type: "COMPILE_EXPORT",
          dedupeKey: exportRepairDedupeKey({
            projectId: project.id,
            planId,
            contentRevision: project.contentRevision,
            format: missing
          }),
          contentRevision: project.contentRevision,
          transaction: tx,
          // Redis is not part of the decision, and a job published from inside
          // the transaction would outlive a rollback of the row that owns it.
          // Dispatching after the commit is what `reconcileUndispatchedWorkerJobs`
          // already exists to finish.
          dispatch: false,
          payload: {
            planId,
            skipFinalReview: true,
            contentRevision: project.contentRevision,
            [EXPORT_PUBLICATION_PROJECT_STATUS]: project.status,
            [EXPORT_REPAIR_FORMAT]: missing,
            // This book is finished and paid for; the repair only rebuilds a file
            // that went missing. Without the flag it takes the *generation*
            // compile's failure path — a Chromium blip would mark the project
            // FAILED and refund the reader's whole book charge, which the payload's
            // `planId` leads straight to.
            [DETACHED_FROM_PROJECT_LIFECYCLE]: true
          }
        });
      },
      { isolationLevel: "Serializable" }
    );
    if (queued) {
      await handOffRepairToQueue(queued.id, project.id);
    }
  } catch {
    // Callers answer "not ready" either way; a queue hiccup — or the refused
    // write that is how the loser of the race above finds out — must not turn
    // that into a failed request.
  }
}

/**
 * Publishes the committed repair row to BullMQ, but only for as long as a
 * request may reasonably wait — see `EXPORT_REPAIR_DISPATCH_BUDGET_MS`.
 *
 * Giving up on the *wait* is not giving up on the publish, and both halves of
 * that matter:
 *
 * - The row is untouched. It stays QUEUED with a null `bullJobId` and a null
 *   `nextDispatchAt`, which is precisely what the reconcile sweep selects, so
 *   the repair is retried on its own within seconds of Redis returning.
 *   Cancelling it here would be the actively wrong compensation: nothing was
 *   charged for a repair, and a canceled row takes the book's only route back to
 *   having a PDF away from both reconcilers *and* from
 *   `ensureExportRepairQueued`, whose window key would then have to roll before
 *   anything could try again.
 * - The abandoned call keeps running, and it is the same publish the reconciler
 *   would make — so it has to be idempotent against one, and it is at every
 *   layer. `bookQueue.add` is keyed on the durable row's id, so BullMQ collapses
 *   a late add onto the copy already in Redis instead of delivering the compile
 *   twice, and the row update behind it only rewrites `bullJobId`/`dispatchedAt`
 *   with the same values. Once the first delivery has run and left the queue,
 *   the late add does create a second delivery — and that is the worker's
 *   ordinary re-delivery case, refused by `markActive` on a row that is already
 *   COMPLETED and by the pre-claim stale check on one a stop settled.
 *
 * `withTimeout` handles the rejection of the abandoned promise itself — it
 * already attached a handler before the race — so a hand-off that fails minutes
 * later cannot surface as an unhandled rejection here.
 */
async function handOffRepairToQueue(generationJobId: string, projectId: string): Promise<void> {
  try {
    await withTimeout(dispatchGenerationJob(generationJobId), EXPORT_REPAIR_DISPATCH_BUDGET_MS, "Export repair dispatch");
  } catch (error) {
    if (!(error instanceof TimeBudgetExceededError)) {
      // A dispatch that *failed* has already recorded its own backoff and
      // warning; let the caller's best-effort net swallow it as before.
      throw error;
    }
    // A hang leaves no trace anywhere else: `dispatchGenerationJob` only logs
    // when `bookQueue.add` rejects, which under `maxRetriesPerRequest: null` is
    // the one thing it will not do.
    console.warn("Export repair dispatch deferred", {
      event: "generation.consistency_warning",
      warning: "queue_dispatch_timeout",
      generationJobId,
      projectId,
      budgetMs: EXPORT_REPAIR_DISPATCH_BUDGET_MS
    });
  }
}

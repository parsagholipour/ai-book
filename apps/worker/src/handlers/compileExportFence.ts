import { pagesTheCompileNoLongerSpeaksFor, readWithRetry } from "./compileExportStandDown.js";
import { errorMessage } from "@book-maker/core";
import { bestEffortPass } from "../generation/bestEffortPass.js";
import { exportPublicationSuperseded } from "../generation/exportPublication.js";
import { createRunLogger } from "../providers/runLogging.js";
import { isStopRequestedError, type ExportPageForRepair } from "../runtime/jobTypes.js";
import { serializeError } from "../runtime/serialization.js";
import type { Prisma } from "@book-maker/db";
import type { Job } from "bullmq";

/**
 * The fence a compile's final-QA repair is held to, the three things it can
 * answer, and the note a pass leaves when it stops early. Split out of
 * `compileExportStandDown.ts` along the seam its size budget named — that file
 * is about the verdict a compile that publishes nothing may still leave behind,
 * and this one is about the read that decides whether it is still writing the
 * book at all.
 *
 * The asymmetry both halves are written against is the same: `compile-export`
 * has no BullMQ retry budget and, for a verdict-owning row, owns the project's
 * outcome, so an error that travels marks a finished, fully paid book FAILED
 * and refunds `FULL_BOOK_GENERATION`. Every class below exists to keep one
 * particular condition from becoming that error.
 */

/**
 * Raised by the final-QA repair's ownership fence when the manuscript moved on
 * mid-pass.
 *
 * It exists to be *distinguishable*. The fence is called from inside
 * `runPageQualityLoop`, so its throw travels back through two modules that both
 * treat an unrecognised error as a real failure — and a compile that fails is a
 * compile that reaches `markFailed`, which for a verdict-owning row marks a
 * finished, fully paid book FAILED and refunds `FULL_BOOK_GENERATION`. That is
 * a far worse answer than the one this condition already has at the compile's
 * own supersede read: stand down and let the newer export publish, recording
 * the verdict on the way out. A dedicated class is what lets
 * the catch be narrow enough that a `StopRequestedError` — the one error that
 * must never be swallowed — passes straight through it.
 */
export class ExportRepairSupersededError extends Error {
  constructor() {
    super("Export compile lost the manuscript during its final-QA repair");
    this.name = "ExportRepairSupersededError";
  }
}

/**
 * Raised when the fence's own read will not answer, which is a different fact
 * about the world than either answer it was asked for.
 *
 * The fence is two indexed barriers *per repaired page* and one more for any
 * page that reaches a brief repair, across the several minutes a long book's repair
 * takes, and a pool that is momentarily
 * exhausted or a failover mid-pass makes one of them throw. That throw is not
 * an `ExportRepairSupersededError`, so before this class existed it travelled
 * the whole way out of the handler and settled the compile as a failure: a book
 * whose pages were all written went FAILED and gave its generation charge back
 * because one `SELECT "contentRevision"` did not come back. The fence exists to
 * *prevent* that outcome, so producing it was the one thing it may not do.
 *
 * Neither of the fence's two answers may be guessed in its place. "Not
 * superseded" is the expensive guess: the pass would carry on rewriting pages
 * of a book the reader has since paid to edit, which is exactly what the fence
 * is threaded through `repairPagesFromFinalQa` to stop. "Superseded" reads
 * cheap and is not — the stand-down publishes nothing and writes no project
 * status, and for the two full-review compiles queued against a *live* project
 * it discards the immediate handoff: `restructurePages` leaves EDITING and the
 * generation fan-in leaves GENERATING. Delayed `reconcileStrandedGeneration`
 * now covers both only after its grace period and after every job is terminal.
 * Standing down on a guess therefore trades a bounded read retry for a delayed
 * recovery while abandoning work that may still own the manuscript.
 *
 * So the barrier admits it cannot answer, and the handler treats that as "stop
 * repairing, decide nothing" — see the catch in `compileExport.ts`.
 */
export class ExportRepairFenceUnreadableError extends Error {
  constructor(
    readonly cause: unknown,
    /**
     * Barriers this pass answered before one stopped answering: raw evidence
     * about the *fence*, and no longer anybody's measure of the pass.
     *
     * It is kept because it is the one number that exists even when nothing has
     * been written yet — a fence that goes dark on its very first ask says so
     * with a zero — and because it cannot drift from the read that produced it.
     * What it may not be used for is arithmetic about pages. There are two asks
     * per repaired page and three for the few that reach recovery:
     * `repairPagesFromFinalQa` asks at the loop top and claims atomically beside
     * the writes, while `repairPageBriefForRecovery` asks once after its planner
     * call. An operator
     * dividing by two read a 15-page pass that stopped on page 7 as one that
     * stopped around page 6. Where the pass actually got is `repairProgress`,
     * counted in pages by the only thing that counts pages.
     */
    readonly barriersCleared: number,
    /**
     * How much of the repair finished, stamped on the way back through
     * `repairPagesFromFinalQa` — the one frame that knows both how many pages
     * the pass set out to repair and how many of them it saw through.
     *
     * Null only for a fence asked outside that pass, which nothing does today;
     * the readers below fall back to the barrier count rather than inventing a
     * page number for it.
     */
    readonly repairProgress: TruncatedRepairProgress | null = null,
    /** A durable replacement image was created before this fence stopped answering. */
    readonly replacementIllustrationCreated = false
  ) {
    super("Export compile could not read the manuscript revision its repair is fenced on");
    this.name = "ExportRepairFenceUnreadableError";
  }
}

/**
 * How far a truncated repair pass got, in the unit an operator acts on.
 *
 * Pages, not fence asks: "repaired 2 of 15" says which pages of the shipped
 * book are unrepaired and whether re-queueing the compile is worth it, and it
 * stays true however many times the fence is consulted per page. The count is
 * the pass's own — see `repairPagesFromFinalQa`, which is where a page's writes
 * either complete or do not.
 */
export interface TruncatedRepairProgress {
  /** Pages whose repair ran to the end of its writes before the fence went dark. */
  pagesRepaired: number;
  /**
   * Pages this pass set out to repair: the indexes the verdict and the
   * deterministic sweep named, **minus the ones the manuscript does not hold**.
   *
   * A denominator has to be reachable or the sentence it appears in is wrong in
   * the operator's favour. Not every named index is a page — an error-severity
   * finding names whatever pages it names, the verdict's own indexes are
   * bounded only by the book's highest one, and a manuscript with a gap in its
   * numbering holds neither end of it — so a pass that walked the raw list
   * reported a target it could never have reached and made itself look one page
   * less finished for each. `repairPagesFromFinalQa` resolves the list to rows
   * before it walks it, which is why there is nothing left here to skip.
   */
  pagesTargeted: number;
}

/**
 * The same fence failure, told where the pass had got to.
 *
 * A new error rather than a mutated one, so every field stays readonly and the
 * `cause` the fence gave up on travels unchanged. `repairPagesFromFinalQa`
 * raises this on its way out; nothing else may, because nothing else counts
 * pages.
 */
export function fenceUnreadableAfter(
  fence: ExportRepairFenceUnreadableError,
  progress: TruncatedRepairProgress,
  replacementIllustrationCreated = false
): ExportRepairFenceUnreadableError {
  return new ExportRepairFenceUnreadableError(
    fence.cause,
    fence.barriersCleared,
    progress,
    fence.replacementIllustrationCreated || replacementIllustrationCreated
  );
}

/**
 * How far the pass got, in one clause, for the two places a human reads it: the
 * `error` column `markFailed` writes and the warning line an operator greps.
 */
export function truncatedRepairSummary(fence: ExportRepairFenceUnreadableError): string {
  const progress = fence.repairProgress;
  return progress
    ? `repaired ${progress.pagesRepaired} of ${progress.pagesTargeted} page${progress.pagesTargeted === 1 ? "" : "s"}`
    : `${fence.barriersCleared} fence read${fence.barriersCleared === 1 ? "" : "s"} answered`;
}

/**
 * What settles the compile when the manuscript re-read fails behind an
 * unreadable fence: the read failure that earned the settlement, carrying the
 * fence's evidence out with it.
 *
 * That re-read is deliberately unguarded: it is the liveness question, and a
 * compile that cannot reach the database has nothing left to publish against,
 * so letting it travel is the honest settlement. What was not honest was what
 * travelled. The driver's error *replaced* the fence's, and the fence's is the
 * only record of the repair that had already stopped —
 * `ExportRepairFenceUnreadableError` carries how far the pass got, the barrier
 * count and the read it gave up on for exactly one reader, and on this path that
 * reader never ran.
 * `markFailed` writes `error.message` onto the `GenerationJob` row and
 * `processJob` serialises the same object into the run log's `job.failed` line,
 * so a book marked FAILED and refunded `FULL_BOOK_GENERATION` this way said
 * "Connection terminated unexpectedly" and nothing at all about how far its
 * repair got before the database went quiet.
 *
 * `recordTruncatedRepairPass` is not the answer here, and moving it above the
 * re-read to make it one would be worse: it is the note a compile files about a
 * pass it *shipped a book around*, and two of its numbers are measured
 * against the manuscript as re-read. Filed before that read, it would announce a
 * truncated pass on a compile that is about to fail, with a page count it does
 * not have. The ordering stands; the diagnostic travels instead.
 *
 * So the failure is composed rather than swapped. The message keeps the driver's
 * own words, which is what the durable `error` column and an operator's first
 * look at the row show, and states in front of them how much of the repair had
 * finished — in pages, because the row is read by somebody deciding whether the
 * book that did not ship was nearly repaired or barely started, and a count of
 * fence reads answers a question nobody asked. The fence is the `cause`, so
 * anyone holding the object still reaches `error.cause.cause` — the read that
 * went dark. And the numbers are copied into own enumerable fields, because
 * that is the only form that survives the trip: `serializeError` spreads own
 * entries, and a nested `Error` renders as `{}` once the run log stringifies
 * it, so a `cause` chain alone reaches the file as nothing whatever.
 */
export class ExportManuscriptUnreadableError extends Error {
  /** Pages of the repair that finished, and pages it was for, off the pass's own count. */
  readonly repairProgress: TruncatedRepairProgress | null;
  /** Fence reads that answered before one stopped, kept as evidence about the fence. */
  readonly barriersCleared: number;
  /** The read the barrier gave up on, in the shape the run log can hold. */
  readonly fenceError: Record<string, unknown>;
  /** The re-read that settles this compile, kept with its driver code and stack. */
  readonly manuscriptError: Record<string, unknown>;

  constructor(fence: ExportRepairFenceUnreadableError, cause: unknown) {
    super(
      `Export compile could not re-read its manuscript after its repair fence stopped answering (${truncatedRepairSummary(fence)}): ${errorMessage(cause)}`,
      { cause: fence }
    );
    this.name = "ExportManuscriptUnreadableError";
    this.repairProgress = fence.repairProgress;
    this.barriersCleared = fence.barriersCleared;
    this.fenceError = serializeError(fence.cause);
    this.manuscriptError = serializeError(cause);
  }
}

/**
 * The one composition, so the handler's catch cannot compose it differently —
 * and the stop rethrow that has to survive it.
 *
 * A `StopRequestedError` is handed straight back rather than wrapped. Nothing in
 * a Prisma read raises one today, but `processJob` tells a stopped run from a
 * failed one with `instanceof`, and a wrapper would turn a reader's cancellation
 * into a FAILED book — the one thing no path in this file may do, reached by
 * composing rather than by swallowing.
 */
export function manuscriptUnreadableAfterFence(
  fence: ExportRepairFenceUnreadableError,
  cause: unknown
): unknown {
  if (isStopRequestedError(cause)) {
    return cause;
  }
  return new ExportManuscriptUnreadableError(fence, cause);
}

async function supersededWithRetry(
  projectId: string,
  queuedContentRevision: number,
  barriersCleared: number
): Promise<boolean> {
  try {
    return await readWithRetry(() => exportPublicationSuperseded(projectId, queuedContentRevision));
  } catch (error) {
    if (isStopRequestedError(error)) {
      throw error;
    }
    throw new ExportRepairFenceUnreadableError(error, barriersCleared);
  }
}

/**
 * The compile's answer to "may I still leave a durable opinion of this book
 * behind?", or `undefined` when it can never honestly say yes.
 *
 * A compile holds no lease. The calls made without a transaction client are
 * advisory reads: they stop a compile that has already been overtaken from
 * spending the next few minutes rewriting pages. The call made with the page
 * publication's transaction client is the binding one: a no-op compare-and-set
 * claims and locks the queued `contentRevision`, then the page and optional
 * chapter brief publish in that same transaction. An edit that commits in the
 * millisecond after an advisory read therefore makes the claim miss.
 *
 * **A null `contentRevision` gets no fence at all.**
 * `exportPublicationSuperseded` answers `false` for null, and false there means
 * "no revision to be superseded from" rather than "still owns the book" —
 * exactly the reading that would hand the unfenceable case the strongest
 * permission, so `undefined` is returned instead of a fence that always says
 * yes. Every enqueue site records the revision in the payload — the run's own
 * fan-in and an edit's recompile through `maybeEnqueueCompile`, a manual edit,
 * undo or presentation reprint through `queueUserEditExportRecompile`, and a
 * detached repair through `ensureExportRepairQueued` — which is the same list
 * `queuedContentRevision` names in the handler, so no row this project queues
 * arrives without one. What lands here without one is a hand-requeued or
 * pre-`contentRevision` row, which is precisely the row most likely to be
 * describing a book that has moved, and precisely the row nothing can *tell*
 * has moved.
 *
 * Such a compile still repairs and still saves its pages — that is the whole of
 * the pass, and it is what every compile did before this existed. The one write
 * it declines is the persisted chapter brief, which outlives the compile
 * entirely; `repairPagesFromFinalQa`'s `assertOwnership` parameter is where that
 * split is argued.
 */
export function exportRepairOwnershipFence(
  projectId: string,
  queuedContentRevision: number | null
): ((client?: Pick<Prisma.TransactionClient, "project">) => Promise<void>) | undefined {
  if (queuedContentRevision === null) {
    return undefined;
  }
  // Two barriers per repaired page: an indexed read as it opens, and the
  // revision CAS in the publication transaction. A page that reaches brief
  // recovery asks once more after its planner call. The advisory asks are made
  // every time rather than cached, which is how they stop wasted work after an
  // edit lands halfway through the pass; the CAS is what closes their last gap.
  //
  // Which also means it is asked hundreds of times per long book, so a database
  // barrier failure is a routine third outcome rather than an exotic one. The
  // advisory read gets a bounded retry; the transaction claim rolls back. Both
  // become the same explicit unreadable answer, never one of the other two
  // guessed at. See `ExportRepairFenceUnreadableError`.
  //
  // The tally below is evidence about *this fence*, not a measure of the pass:
  // three asks per brief-repaired page and two for the rest means no arithmetic
  // over it recovers a page number, and one that tried was off by a page on
  // every book. What survives to say where the pass stopped is
  // `TruncatedRepairProgress`, counted in pages one frame up. This stays
  // because it is exact and exists before anything has been written — a fence
  // dark on its first ask reports zero.
  let barriersCleared = 0;
  return async (client) => {
    let superseded: boolean;
    if (client) {
      try {
        // This is the binding ask. `updateMany` is a no-op compare-and-set that
        // locks the project row until the repaired page publication commits;
        // the page and optional brief use the same transaction client. An edit
        // that committed after the preceding advisory read therefore makes
        // this claim miss instead of letting stale prose overwrite its keeper.
        const claim = await client.project.updateMany({
          where: { id: projectId, contentRevision: queuedContentRevision },
          data: { contentRevision: { increment: 0 } }
        });
        superseded = claim.count !== 1;
      } catch (error) {
        if (isStopRequestedError(error)) {
          throw error;
        }
        throw new ExportRepairFenceUnreadableError(error, barriersCleared);
      }
    } else {
      superseded = await supersededWithRetry(projectId, queuedContentRevision, barriersCleared);
    }
    if (superseded) {
      throw new ExportRepairSupersededError();
    }
    barriersCleared += 1;
  };
}

/**
 * The trace a truncated repair pass leaves, which is the only thing that tells
 * it apart from one that ran to the end.
 *
 * The unreadable fence is the one of this file's three answers that stands
 * nothing down: the compile keeps its slot, re-reads the manuscript, renders, publishes
 * and settles COMPLETE. What it silently stops doing is the repair — and it
 * stopped doing it with no trace whatever. `supersededWithRetry` keeps each
 * failed read only as the `cause` it hands the error, the handler's catch
 * discards that error once it has the pages, and `markCompleted` overwrites the
 * job's progress message moments later. So a pool that was briefly full while
 * page 3 of 15 was being repaired shipped twelve pages the compile was paid to
 * repair, unrepaired, and left a run indistinguishable from one where the pass
 * finished. Both siblings warn — `standDownForNewerExport` and its best-effort
 * record, one file over — and the only path that hides a *partial* pass was the
 * one that said nothing.
 *
 * Two lines, and they are not the same line twice. The `console.warn` is what
 * an operator greps `generation.consistency_warning` for across every book on
 * the box, in the shape the siblings already use. The run log is where somebody
 * who already has one book in front of them and is asking "why is this one
 * unrepaired" actually looks: `<BOOK_STORAGE_DIR>/<projectId>/runs/`, the same
 * file every provider call this compile made is in, so the line lands in
 * sequence between the repair's last rewrite and the render that followed it.
 * `RunLogger.append` swallows its own write failures, which is what makes it
 * safe to await on a path whose entire purpose is to not fail the compile. Job
 * progress is deliberately not a third home: `markCompleted` overwrites it
 * before anyone could read it, which is the reason this needed a home at all.
 *
 * How far it got is stated in pages, because that is the only unit anyone can
 * act on. `pagesRepaired` of `pagesTargeted` comes off the pass itself — the
 * frame that knows which pages of the book the verdict named and which of them
 * it saw through to their writes — and answers the operator's actual question: how
 * much of the book that shipped is unrepaired. It replaced `barriersCleared` as
 * the headline for a plain reason: that number counts fence *reads*, at two per
 * repaired page and three for any page that reaches a brief repair, so the
 * division this line used to instruct was wrong by exactly the number of pages
 * that took the expensive route.
 *
 * The other two stay because neither is the same fact. `barriersCleared` is
 * exact evidence about the fence and exists when nothing has been written at
 * all — a pass that stops on its first ask reports zero pages and zero
 * barriers, and only the second zero says it never started. `pagesRewritten` is
 * measured the way the stand-down report measures it, against the manuscript as
 * re-read, so it counts prose that actually changed; on this path it may
 * include a reader's own edit, which is precisely the ambiguity the fence
 * exists because of and not one this line can resolve — and the gap between it
 * and `pagesRepaired` is where a reader's edit shows up.
 *
 * **A note about a book cannot be allowed to fail the book.** This is called
 * from inside the catch whose entire purpose is to keep a finished, fully paid
 * compile away from `markFailed`, and it was the one call in there that was
 * awaited bare while its two sibling stand-down writes were wrapped. The risk
 * looked small because `RunLogger.append` swallows its own write failures — but
 * `createRunLogger` reads config and builds a path, `serializeError` walks an
 * arbitrary `cause` off a driver, and `pagesTheCompileNoLongerSpeaksFor` walks
 * two manuscripts, and a throw from any of those travels the whole way out and
 * refunds `FULL_BOOK_GENERATION` for a book whose pages are all written. That
 * is the exact asymmetry the `ExportRepairSupersededError` branch beside this
 * call already refuses, so the guard lives *here* rather than at the call
 * site: a function whose whole job is to leave a trace on a path that may not
 * fail should not be able to fail it, whoever calls it next. A
 * `StopRequestedError` still escapes, the way it escapes every other pass
 * through `bestEffortPass`.
 */
export async function recordTruncatedRepairPass(options: {
  job: Job;
  projectId: string;
  generationJobId: string;
  error: ExportRepairFenceUnreadableError;
  /** The manuscript the pass opened with. */
  reviewedPages: ExportPageForRepair[];
  /** The manuscript the handler re-read once the barrier gave up. */
  repairedPages: ExportPageForRepair[];
}): Promise<void> {
  await bestEffortPass<void>({
    attempt: async () => {
      const measured = {
        ...options.error.repairProgress,
        barriersCleared: options.error.barriersCleared,
        pagesRewritten: pagesTheCompileNoLongerSpeaksFor(options.reviewedPages, options.repairedPages).size,
        pagesInBook: options.repairedPages.length
      };
      console.warn("Export compile stopped repairing: its ownership fence could not be read", {
        event: "generation.consistency_warning",
        warning: "export_repair_fence_unreadable",
        projectId: options.projectId,
        generationJobId: options.generationJobId,
        ...measured,
        error: options.error.cause
      });
      // The project and the durable job are already on every entry this logger
      // writes, so only the measurements and the failure itself are added here.
      await createRunLogger(options.job).append("export.repair.fence_unreadable", {
        ...measured,
        error: serializeError(options.error.cause)
      });
    },
    fallback: undefined,
    warning: "Truncated export repair could not be recorded",
    details: {
      event: "generation.consistency_warning",
      warning: "export_repair_truncation_record_failed",
      projectId: options.projectId,
      generationJobId: options.generationJobId
    }
  });
}

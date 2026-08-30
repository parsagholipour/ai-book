import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import {
  BOOK_GENERATION_CHARGE_LOOKBACK,
  STOPPED_JOB_ERROR,
  STOPPED_JOB_MESSAGE,
  bookGenerationChargeFromPayloads,
  dispatchBackoffMs,
  errorMessage,
  generationJobOwnsFailureLifecycle,
  generationJobRestoresPreEditProjectStatus,
  isPresentationOnlyRecompile,
  jobNames,
  payloadOwnsProjectOutcome,
  jobOwnsQualityVerdict,
  jsonPayloadToRecord,
  loadConfig,
  parseStructuralApplication,
  preEditProjectStatus,
  presentationRecompileFallbackStatus,
  retryJobOptions,
  type GenerationJobType
} from "@book-maker/core";
import { classifyStoppedContinuationsTx } from "./continuationStopPolicy.js";
import { hasLiveCompletedPublicationTailTx } from "./stopPublicationOwnership.js";
import {
  PAGE_RESTRUCTURE_TRANSACTION_OPTIONS,
  Prisma,
  compensateStructuralPageChangeTx,
  prisma,
  type StructuralCompensationResult
} from "@book-maker/db";
import {
  GenerationAttemptJobClaimError,
  failGenerationAttempt,
  refundCreditLedgerEntry,
  refundLatestProjectOperationCredits
} from "@book-maker/db/billing";

// The job-name table, retry budgets, backoff, and stop constants are shared
// with the worker through @book-maker/core/jobDispatch — one definition on
// both sides of the queue.
export { jobNames, type GenerationJobType };

export const BOOK_QUEUE_NAME = "book-maker";

const config = loadConfig();

export const redisConnection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null
});

export const bookQueue = new Queue(BOOK_QUEUE_NAME, {
  connection: redisConnection
});

type RequeueableGenerationJob = {
  id: string;
  projectId: string | null;
  type: GenerationJobType;
  payload: Prisma.JsonValue | Record<string, unknown>;
};

export async function enqueueGenerationJob(options: {
  /** Null for account-level work (a library-character portrait) with no book. */
  projectId: string | null;
  type: GenerationJobType;
  payload: Record<string, unknown>;
  dedupeKey?: string | undefined;
  contentRevision?: number | undefined;
  attemptId?: string | undefined;
  transaction?: Prisma.TransactionClient | undefined;
  dispatch?: boolean | undefined;
}) {
  const db = options.transaction ?? prisma;
  if (options.dedupeKey) {
    const existing = await db.generationJob.findUnique({ where: { dedupeKey: options.dedupeKey } });
    if (existing) {
      assertEnqueueMayClaimFoundJob(options, existing);
      if (options.dispatch !== false && existing.status === "QUEUED" && !existing.bullJobId) {
        return (await dispatchGenerationJob(existing.id)) ?? existing;
      }
      return existing;
    }
  }
  let generationJob;
  try {
    generationJob = await db.generationJob.create({
      data: {
        ...(options.projectId ? { projectId: options.projectId } : {}),
        type: options.type,
        payload: options.payload as Prisma.InputJsonValue,
        // Promoted out of the payload here for the same reason
        // `contentRevision` is: the read side has to be able to ask for the
        // compile whose verdict is the book's, and a payload flag cannot be
        // negated in SQL without dropping every row that never carried it.
        ownsQualityVerdict: jobOwnsQualityVerdict(options.type, options.payload),
        ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
        ...(options.contentRevision !== undefined ? { contentRevision: options.contentRevision } : {}),
        ...(options.attemptId ? { attemptId: options.attemptId } : {}),
        status: "QUEUED",
        progress: 0,
        message: "Queued"
      }
    });
  } catch (error) {
    if (!(options.dedupeKey && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
      throw error;
    }
    generationJob = await db.generationJob.findUnique({ where: { dedupeKey: options.dedupeKey } });
    if (!generationJob) {
      throw error;
    }
    // The unique conflict is the concurrent half of the lookup above, and it
    // answers with a row this call did not write for exactly the same reason.
    assertEnqueueMayClaimFoundJob(options, generationJob);
  }
  if (options.dispatch === false) {
    return generationJob;
  }
  return (await dispatchGenerationJob(generationJob.id)) ?? generationJob;
}

/**
 * A paid attempt may only be parented onto the job this call actually wrote.
 *
 * `enqueueGenerationJob` answers a spent `dedupeKey` with whatever row already
 * stands under it, and it used to answer with that row whoever asked. Passing
 * `attemptId` is a caller saying "this row is my attempt's work", so a row that
 * carries somebody else's stamp — or no stamp at all — is refused here rather
 * than handed back to be charged against.
 *
 * The refusal belongs at this call and not only at
 * `assertPrimaryJobBelongsToAttempt` (`packages/db/src/generationAttempts.ts`),
 * because that one can only vouch for the *primary* job: a `create` callback
 * that enqueues several — `POST /api/mobile/projects/:id/resume` loops over the
 * failed run's jobs and keeps the first as `primaryJobId` — left every job after
 * the first neither stamped nor verified. A second job answered from a spent key
 * would leave the charge committed, its attempt id absent from the BullMQ payload
 * that carries settlement, and the dispatch query `where: { attemptId }` unable
 * to find the row at all: fewer actions queued than the reader paid for, and, if
 * that pre-existing row had already finished, nothing left to mark the attempt
 * succeeded or failed. Refusing here covers every job of every attempt, and it
 * is free for the reader: every `attemptId` caller is inside
 * `startGenerationAttempt`'s serializable transaction, so the reservation, the
 * spend, the quota slot and every domain write roll back with the throw.
 *
 * A caller that passes no `attemptId` is unaffected — the operator routes, the
 * export repair, the free presentation recompiles and `enqueueOrRequeueGenerationJob`,
 * whose options carry no `attemptId` to disagree with. This is deliberately not
 * a `GenerationAttemptConflictError`: that one is a 409 the reader can act on,
 * and this is a wiring fault nothing above it can. `sendGenerationAttemptError`
 * (`apps/api/src/mobile/httpErrors.ts`) keeps its 500 and answers with reader
 * copy; a caller that can give a better answer refuses *before* it enqueues, the
 * way `queueInitialMobilePlan` does.
 */
function assertEnqueueMayClaimFoundJob(
  options: { dedupeKey?: string | undefined; attemptId?: string | undefined },
  existing: { id: string; attemptId: string | null }
): void {
  if (!options.attemptId || existing.attemptId === options.attemptId) {
    return;
  }
  throw new GenerationAttemptJobClaimError(
    `Generation attempt ${options.attemptId} may not claim generation job ${existing.id}: it is ${
      existing.attemptId ? `already attempt ${existing.attemptId}'s work` : "not stamped with any attempt"
    }, and it already stood under dedupe key ${options.dedupeKey}. A paid start must enqueue its own job, never adopt one it found under a spent key.`
  );
}

/**
 * Enqueues under a dedupe key, resurrecting a terminal row instead of
 * returning it inert.
 *
 * `enqueueGenerationJob` treats a spent key as "this work already happened":
 * the existing row comes back and nothing is dispatched. That is right for
 * charged work, and a permanent dead end for retryable derivative work — a
 * persona build that failed once left a FAILED row under its key, so every
 * later attempt enqueued nothing and the character said "getting ready"
 * forever. Only callers that have just re-established the need for the work
 * should use this; a QUEUED or ACTIVE row is already that work and is
 * returned untouched.
 */
export async function enqueueOrRequeueGenerationJob(options: {
  projectId: string;
  type: GenerationJobType;
  payload: Record<string, unknown>;
  dedupeKey: string;
}) {
  const job = await enqueueGenerationJob(options);
  if (job && job.status !== "QUEUED" && job.status !== "ACTIVE") {
    return requeueGenerationJob({
      id: job.id,
      projectId: job.projectId,
      type: job.type as GenerationJobType,
      payload: options.payload
    });
  }
  return job;
}

/**
 * Publishes a durable database job to BullMQ. A Redis outage deliberately
 * leaves the row QUEUED so reconciliation can publish it later; callers can
 * safely return the durable job instead of rolling domain state back.
 */
export async function dispatchGenerationJob(generationJobId: string) {
  const generationJob = await prisma.generationJob.findUnique({ where: { id: generationJobId } });
  if (!generationJob || generationJob.status !== "QUEUED") {
    return generationJob;
  }
  if (generationJob.bullJobId) {
    return generationJob;
  }
  const payload = jsonPayloadToRecord(generationJob.payload);
  const jobName = jobNames[generationJob.type as GenerationJobType];
  if (!jobName) {
    console.error("Generation job has no worker job name; leaving it undispatched", {
      generationJobId: generationJob.id,
      type: generationJob.type
    });
    return generationJob;
  }
  try {
    const bullJob = await bookQueue.add(
      jobName,
      {
        ...payload,
        // Absent rather than null for account-level jobs: every worker read is
        // `as string | undefined` behind a falsy guard.
        ...(generationJob.projectId ? { projectId: generationJob.projectId } : {}),
        generationJobId: generationJob.id,
        ...(generationJob.attemptId ? { attemptId: generationJob.attemptId } : {})
      },
      { ...jobOptionsForType(generationJob.type as GenerationJobType), jobId: generationJob.id }
    );
    return prisma.generationJob.update({
      where: { id: generationJob.id },
      data: {
        bullJobId: bullJob.id ?? generationJob.id,
        dispatchedAt: new Date(),
        nextDispatchAt: null,
        message: "Queued"
      }
    });
  } catch (error) {
    const attempts = generationJob.dispatchAttempts + 1;
    console.warn("Generation dispatch deferred", {
      event: "generation.consistency_warning",
      warning: "queue_dispatch_failed",
      generationJobId: generationJob.id,
      projectId: generationJob.projectId,
      type: generationJob.type,
      dispatchAttempt: attempts,
      error: errorMessage(error)
    });
    return prisma.generationJob.update({
      where: { id: generationJob.id },
      data: {
        dispatchAttempts: attempts,
        nextDispatchAt: new Date(Date.now() + dispatchBackoffMs(attempts)),
        message: "Waiting for the generation queue"
      }
    });
  }
}

export async function reconcileUndispatchedGenerationJobs(limit = 50): Promise<number> {
  const jobs = await prisma.generationJob.findMany({
    where: {
      status: "QUEUED",
      bullJobId: null,
      OR: [{ nextDispatchAt: null }, { nextDispatchAt: { lte: new Date() } }]
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true }
  });
  // allSettled, not all: one undispatchable row must not abort the sweep for
  // every other stranded job, every interval, forever.
  const results = await Promise.allSettled(jobs.map((job) => dispatchGenerationJob(job.id)));
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("Generation job reconciliation failed for a row", result.reason);
    }
  }
  return jobs.length;
}

export async function requeueGenerationJob(job: RequeueableGenerationJob) {
  const payload = jsonPayloadToRecord(job.payload);

  const existingBullId = await prisma.generationJob.findUnique({
    where: { id: job.id },
    select: { bullJobId: true }
  });
  if (existingBullId?.bullJobId) {
    const existingBullJob = await bookQueue.getJob(existingBullId.bullJobId);
    if (existingBullJob && (await existingBullJob.getState()) !== "active") {
      await existingBullJob.remove().catch(() => undefined);
    }
  }

  await prisma.generationJob.update({
    where: { id: job.id },
    data: {
      status: "QUEUED",
      progress: 0,
      message: "Queued for resume",
      error: null,
      startedAt: null,
      finishedAt: null,
      bullJobId: null,
      dispatchedAt: null,
      nextDispatchAt: null,
      steps: Prisma.JsonNull,
      payload: payload as Prisma.InputJsonValue
    }
  });

  const durableJob = await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } });
  return (await dispatchGenerationJob(job.id)) ?? durableJob;
}

/**
 * The statuses a stop may not move a project out of.
 *
 * A finished book is finished whatever is stopped alongside it, and work is
 * queued against a COMPLETE or REVIEW_REQUIRED project all the time: an export
 * repair the status poll asked for, a narration, an edit that has not started
 * yet. None of that is the book's own outcome — the worker refuses to fail the
 * project for any of it (`jobOwnsProjectLifecycle`, and `ownsProjectStatus` on
 * the success side) — but a stop cancels a QUEUED job without the worker ever
 * seeing it, so the same decision has to be made a third time, here.
 *
 * Getting it wrong is terminal rather than cosmetic. A delivered, paid book
 * marked FAILED reads as trouble on every surface (`failureMessage` feeds the
 * app's `hasFailure`, i.e. `BookStage.needsAttention`) and nothing can move it
 * back: `ensureExportRepairQueued` only queues for these two statuses, so the
 * self-repair lane is shut off, and `canRecoverGenerationJob` refuses detached
 * rows, so neither resume route will requeue one either. The operator console
 * offers Stop whenever any job is QUEUED or ACTIVE, which a repair is, so one
 * click on a book whose PDF had gone missing was enough.
 *
 * The guard is on the *status* rather than on what was stopped, because that is
 * the property worth holding: the two settled statuses are exactly the ones a
 * book reaches by being finished. Real in-flight work is never in one — a
 * generation is GENERATING, an edit that has started is EDITING — so anything
 * whose stop genuinely fails a book still fails it.
 */
const SETTLED_PROJECT_STATUSES = ["COMPLETE", "REVIEW_REQUIRED"] as const;

export async function stopProjectGenerationJobs(projectId: string) {
  // Publication takes the project row and then its durable job row. Stop uses
  // the same lock order and terminalizes both in one transaction, so exactly
  // one outcome wins: a committed publication owns COMPLETED and cannot be
  // refunded, while a committed stop owns FAILED and cannot publish.
  // On the shared manuscript budget, not Prisma's 5 s default: a structural
  // stop reverts a whole book in here — page restores, the two-pass renumber
  // over every page, two plan writes — which is what every other caller of the
  // shared compensation primitive already buys this budget for. A P2028 rolls
  // the entire stop back, and every retry reproduces it.
  const openJobs = await prisma.$transaction(async (tx) => {
    const project = await tx.project.update({
      where: { id: projectId },
      data: { contentRevision: { increment: 0 } },
      select: { status: true, contentRevision: true }
    });
    const candidates = await tx.generationJob.findMany({
      where: { projectId, status: { in: ["QUEUED", "ACTIVE"] } },
      select: { id: true, bullJobId: true, status: true, type: true, payload: true, attemptId: true }
    });
    // Take every candidate job lock before touching an edit operation. The
    // zero increment is only a row claim; terminalization waits until the
    // linked operation answers whether Stop still owns this work.
    const lockedCandidates = [] as typeof candidates;
    for (const candidate of candidates) {
      const locked = await tx.generationJob.updateMany({
        where: { id: candidate.id, status: { in: ["QUEUED", "ACTIVE"] } },
        data: { dispatchAttempts: { increment: 0 } }
      });
      if (locked.count === 1) {
        lockedCandidates.push(candidate);
      }
    }

    // Project -> GenerationJob -> BookEditOperation is the publication lock
    // order. Revoke the linked operation while those first two claims are
    // still held, before restoring the project or committing: a provider-
    // paused Apply may resume immediately after this transaction, and both its
    // text and structural publication assertions accept only a live operation
    // lease. `generationJobId` is the durable linkage; payload ids keep jobs
    // created before that relation (and replan-copy operations owned by the
    // source project) on the same atomic path.
    const editStop = await cancelEditOperationsForStoppedJobsTx(tx, projectId, lockedCandidates);
    const appliedEditHandoffJobIds = editStop.handoffJobIds;
    const stopped = [] as typeof candidates;
    for (const candidate of lockedCandidates) {
      if (appliedEditHandoffJobIds.has(candidate.id)) {
        continue;
      }
      const claimed = await tx.generationJob.updateMany({
        where: { id: candidate.id, status: { in: ["QUEUED", "ACTIVE"] } },
        data: {
          status: "FAILED",
          message: STOPPED_JOB_MESSAGE,
          error: STOPPED_JOB_ERROR,
          finishedAt: new Date()
        }
      });
      if (claimed.count === 1) {
        stopped.push(candidate);
      }
    }

    // The stopped job, canceled operation/lease, restored project and the paid
    // attempt's *refund obligation* are one verdict: a crash after this commit
    // must not leave an open attempt whose failed job nothing will reconcile.
    // The ledger move deliberately stays outside. It has to be SERIALIZABLE —
    // `refundCreditLedgerEntryTx` reads the entry and the account without `FOR
    // UPDATE` and increments from that snapshot, so at this transaction's Read
    // Committed it can release the same charge twice beside the worker's own
    // settlement — and it is the one write that can fail alone (the
    // `reversesEntryId` unique index), which in here would roll back every job,
    // operation and project write above it. `refundPending` on a terminal row
    // is what `reconcileGenerationAttemptRefunds` sweeps, so the settlement
    // below and the reconciler are both free to finish it.
    for (const attemptId of settlingAttemptIds(stopped)) {
      await tx.generationAttempt.updateMany({
        where: { id: attemptId, status: { in: ["QUEUED", "ACTIVE"] } },
        data: { status: "CANCELED", error: STOPPED_JOB_ERROR, finishedAt: new Date(), refundPending: true }
      });
    }

    // Outcome precedence is deliberate and independent of query order. A real
    // generation run still owns FAILED even when stopped beside derivative or
    // edit rows. Without one, an edit restores its queue-time settled status;
    // REVIEW_REQUIRED wins if inconsistent legacy rows are ever stopped
    // together, preserving the more cautious verdict. A presentation-only
    // reprint is the final restore case. Anything else — including a stop that
    // claims zero rows — keeps the stranded-project fallback to FAILED.
    const stoppedRestorableEdits = stopped.filter((job) =>
      restoresPreEditProjectStatusOnStop(job, editStop.restorableContinuationJobIds)
    );
    const stoppedRestorableEditIds = new Set(stoppedRestorableEdits.map((job) => job.id));
    const owningGenerationStopped = stopped.some(
      (job) =>
        !stoppedRestorableEditIds.has(job.id) && generationJobOwnsFailureLifecycle(job.type, job.payload)
    );
    const presentationJobs = stopped.filter((job) => isPresentationOnlyRecompile(job.payload));
    const completedPublicationOwnsEditing =
      project.status === "EDITING" && appliedEditHandoffJobIds.size === 0
        ? await hasLiveCompletedPublicationTailTx(tx, projectId, project.contentRevision)
        : false;
    if (owningGenerationStopped) {
      await tx.project.updateMany({
        where: { id: projectId, status: { notIn: [...SETTLED_PROJECT_STATUSES] } },
        data: { status: "FAILED" }
      });
    } else if (appliedEditHandoffJobIds.size > 0 || completedPublicationOwnsEditing) {
      // APPLIED is the edit handler's durable publication fence. Its job is
      // either still ACTIVE at the publication handoff above, or already
      // COMPLETED because the manuscript transaction durably settled it before
      // its idempotent compile/status tail. Leave the exact live publication
      // and its EDITING project to that tail instead of failing or restoring
      // delivered work.
    } else if (stoppedRestorableEdits.length > 0 && project.status === "EDITING") {
      const restoredStatus = stoppedRestorableEdits.some(
        (job) => preEditProjectStatus(job.payload) === "REVIEW_REQUIRED"
      )
        ? "REVIEW_REQUIRED"
        : "COMPLETE";
      await tx.project.updateMany({
        where: { id: projectId, status: "EDITING" },
        data: { status: restoredStatus }
      });
    } else if (presentationJobs.length > 0 && project.status === "EDITING") {
      const restoredStatus = presentationJobs.some(
        (job) => presentationRecompileFallbackStatus(job.payload) === "REVIEW_REQUIRED"
      )
        ? "REVIEW_REQUIRED"
        : "COMPLETE";
      await tx.project.updateMany({
        where: { id: projectId, status: "EDITING" },
        data: { status: restoredStatus }
      });
    } else {
      await tx.project.updateMany({
        where: { id: projectId, status: { notIn: [...SETTLED_PROJECT_STATUSES] } },
        data: { status: "FAILED" }
      });
    }
    return stopped;
  }, PAGE_RESTRUCTURE_TRANSACTION_OPTIONS);
  let removedQueueJobs = 0;

  await Promise.all(
    openJobs.map(async (job) => {
      if (!job.bullJobId) {
        return;
      }
      const bullJob = await bookQueue.getJob(job.bullJobId);
      if (!bullJob) {
        return;
      }
      const state = await bullJob.getState();
      if (state === "active") {
        return;
      }
      try {
        await bullJob.remove();
        removedQueueJobs += 1;
      } catch {
        // A worker may have claimed the job between the state check and remove.
      }
    })
  );

  // Every stopped job that belongs to a paid attempt settles through the
  // attempt state machine: terminalizing the attempt refunds its own ledger
  // entry (plan, edit, audiobook or book — whichever paid for it) exactly once,
  // and marks the attempt CANCELED so its rows can never be resumed for free.
  // `failGenerationAttempt` is the serializable form, and the only one: the
  // transaction above committed the obligation, this settles it. Idempotent
  // against the worker noticing the stop on an active job and settling the same
  // attempt itself, and against that committed `refundPending` stamp.
  for (const attemptId of settlingAttemptIds(openJobs)) {
    await failGenerationAttempt(attemptId, STOPPED_JOB_ERROR, "CANCELED").catch((error) => {
      // The attempt is already CANCELED with refundPending set, so the worker's
      // refund reconciler finishes the settlement.
      console.error(`Failed to settle stopped generation attempt ${attemptId}`, error);
    });
  }

  // Only rows enqueued before the attempt ledger existed still resolve through
  // the legacy paths — and only when such rows were actually stopped. Running
  // the fallback unconditionally refunded the latest full-book charge for
  // stops that cancelled nothing but attempt-tracked work.
  //
  // A detached row is excluded for exactly the reason the worker excludes it
  // from `markFailed`, and this is the second place that decision has to be
  // made: an export repair is attempt-less, is typed `COMPILE_EXPORT`, and
  // carries the finished book's own `planId` — so the book-run walk below finds
  // that book's `GENERATE_BOOK` charge and hands it back because a rebuild of a
  // missing file was cancelled. Deleting a finished book is enough to trigger
  // it: the status poll queues a repair the moment the PDF is missing, and both
  // delete routes stop the project's open jobs first. It is not legacy work —
  // nothing was charged for it, so nothing settles.
  const legacyJobs = openJobs.filter((job) => !job.attemptId && payloadOwnsProjectOutcome(job.payload));
  if (legacyJobs.length > 0) {
    await settleLegacyStoppedJobs(projectId, legacyJobs);
  }
  await closeDerivativeRowsForStoppedJobs(openJobs);

  return {
    stoppedJobs: openJobs.length,
    activeJobs: openJobs.filter((job) => job.status === "ACTIVE").length,
    removedQueueJobs
  };
}

/** One settlement per distinct paid attempt among the jobs a stop claimed. */
function settlingAttemptIds(jobs: ReadonlyArray<{ attemptId?: string | null | undefined; payload: unknown }>) {
  const owning = jobs.flatMap((job) => (job.attemptId && payloadOwnsProjectOutcome(job.payload) ? [job.attemptId] : []));
  return [...new Set(owning)];
}

/**
 * Apply restores after Stop revokes its publication lease. Continue restores
 * whenever its durable job is still QUEUED — whatever its operation says, and
 * whether or not one is durably linked at all — and, once ACTIVE, only when the
 * classifier proves the in-memory-candidates protocol owns this exact job. An
 * ACTIVE row under any other protocol stays conservative, because an older
 * worker may have committed its plan, chapters, pages or semantic tail
 * incrementally.
 */
function restoresPreEditProjectStatusOnStop(
  job: { id: string; type: string },
  restorableContinuationJobIds: ReadonlySet<string>
): boolean {
  return (
    generationJobRestoresPreEditProjectStatus(job.type) &&
    (job.type !== "CONTINUE_BOOK" || restorableContinuationJobIds.has(job.id))
  );
}

const BOOK_RUN_JOB_TYPES = new Set(["GENERATE_BOOK", "GENERATE_PAGE", "GENERATE_IMAGE", "COMPILE_EXPORT"]);

/**
 * Legacy (attempt-less) rows settle the way the worker settles them: each job
 * type against its own charge. Only book-run rows may walk to the project's
 * full-book entry — routing a stopped audiobook or edit there refunds a charge
 * that paid for a book the user keeps.
 */
async function settleLegacyStoppedJobs(
  projectId: string,
  legacyJobs: ReadonlyArray<{ id: string; type: string; payload: unknown }>
): Promise<void> {
  const refundedEntryIds = new Set<string>();
  const refundOnce = async (entryId: string) => {
    if (!refundedEntryIds.has(entryId)) {
      refundedEntryIds.add(entryId);
      await refundCreditLedgerEntry(entryId, STOPPED_JOB_ERROR);
    }
  };
  const bookRunJobs: Array<{ type: string; payload: unknown }> = [];
  for (const job of legacyJobs) {
    const payload = jsonPayloadToRecord(job.payload);
    const ownEntryId =
      typeof payload.billingLedgerEntryId === "string" && payload.billingLedgerEntryId
        ? payload.billingLedgerEntryId
        : null;
    if (BOOK_RUN_JOB_TYPES.has(job.type)) {
      bookRunJobs.push(job);
      continue;
    }
    if (job.type === "PLAN_BOOK") {
      if (ownEntryId) {
        await refundOnce(ownEntryId);
      } else {
        await refundLatestProjectOperationCredits({ projectId, operation: "PLAN_GENERATION", reason: STOPPED_JOB_ERROR });
      }
      continue;
    }
    // Audiobooks, edits, continuations, replans: their own stamped entry, or
    // their operation's. Unpriced derivative work (characters, research)
    // stamps nothing and refunds nothing.
    if (ownEntryId) {
      await refundOnce(ownEntryId);
      continue;
    }
    const operationId = legacyOperationId(payload);
    if (operationId) {
      const operation = await prisma.bookEditOperation.findUnique({
        where: { id: operationId },
        select: { ledgerEntryId: true }
      });
      if (operation?.ledgerEntryId) {
        await refundOnce(operation.ledgerEntryId);
      }
    }
  }
  if (bookRunJobs.length > 0) {
    const chargedEntryId = await stoppedRunLedgerEntryId(projectId, bookRunJobs);
    if (chargedEntryId) {
      await refundOnce(chargedEntryId);
    } else {
      await refundLatestProjectOperationCredits({
        projectId,
        operation: "FULL_BOOK_GENERATION",
        reason: STOPPED_JOB_ERROR
      });
    }
  }
}

/**
 * A stopped QUEUED job never reaches the worker, so the rows it would have
 * closed on failure must be closed here: an Audiobook left GENERATING blocks
 * every future narration, and an open BookEditOperation blocks every future
 * edit through the one-open-per-project index.
 */
async function closeDerivativeRowsForStoppedJobs(
  openJobs: ReadonlyArray<{ id: string; type: string; payload: unknown }>
): Promise<void> {
  const audiobookJobIds = openJobs.filter((job) => job.type === "GENERATE_AUDIOBOOK").map((job) => job.id);
  if (audiobookJobIds.length > 0) {
    await prisma.audiobook.updateMany({
      where: { generationJobId: { in: audiobookJobIds }, status: "GENERATING" },
      data: { status: "FAILED", error: STOPPED_JOB_ERROR }
    });
  }
}

type StoppedEditClassification = {
  handoffJobIds: Set<string>;
  restorableContinuationJobIds: Set<string>;
};

async function cancelEditOperationsForStoppedJobsTx(
  tx: Prisma.TransactionClient,
  projectId: string,
  stoppedJobs: ReadonlyArray<{ id: string; status: string; type: string; payload: unknown }>
): Promise<StoppedEditClassification> {
  if (stoppedJobs.length === 0) {
    return { handoffJobIds: new Set(), restorableContinuationJobIds: new Set() };
  }
  const generationJobIds = stoppedJobs.map((job) => job.id);
  const legacyOperationIds = [
    ...new Set(stoppedJobs.flatMap((job) => {
      const operationId = legacyOperationId(jsonPayloadToRecord(job.payload));
      return operationId ? [operationId] : [];
    }))
  ];

  // A structural shift commits before its prose is drafted. Stop therefore
  // owns compensation before it owns cancellation: clearing the lease first
  // strands the shifted indexes/placeholders because the worker's rollback CAS
  // can no longer renew. Project and every candidate GenerationJob are already
  // locked by the caller; the shared primitive takes the operation lock next,
  // restores the exact stamped shape, and records completion atomically.
  const linkedWhere = [
    { generationJobId: { in: generationJobIds } },
    ...(legacyOperationIds.length > 0 ? [{ id: { in: legacyOperationIds } }] : [])
  ];
  const { handoffJobIds, restorableContinuationJobIds, retainedOperationIds } =
    await classifyStoppedContinuationsTx(tx, projectId, stoppedJobs);
  const structuralOperations = await tx.bookEditOperation.findMany({
    where: {
      kind: "RESTRUCTURE_PAGES",
      status: { in: ["QUEUED", "ACTIVE"] },
      OR: linkedWhere
    },
    select: { id: true, generationJobId: true, status: true, classifier: true }
  });
  for (const operation of structuralOperations) {
    if (operation.status !== "QUEUED" && operation.status !== "ACTIVE") continue;
    const expectedApplication = parseStructuralApplication(operation.classifier);
    const compensation = await compensateStoppedStructuralShiftTx(tx, {
      projectId,
      operationId: operation.id,
      ...(expectedApplication ? { expectedAppliedAt: expectedApplication.appliedAt } : {})
    });
    if (compensation.outcome === "compensated" || compensation.outcome === "not-needed") continue;
    // A Stop that cannot prove it reverted the exact stamped shift owns no
    // cleanup verdict. `lost` can mean another live lease or a row/stamp that
    // changed under the locked read; `superseded` means a newer manuscript
    // revision won. In both cases clearing the lease, canceling, or refunding
    // would strand the shifted shape while revoking the delivery that can
    // still draft/recover it. Preserve the stamp and stand down exactly as for
    // an APPLIED/publication winner; only a completed or unnecessary revert
    // grants Stop permission to terminalize this operation.
    retainedOperationIds.add(operation.id);
    if (operation.generationJobId) {
      handoffJobIds.add(operation.generationJobId);
    } else {
      for (const job of stoppedJobs) {
        if (legacyOperationId(jsonPayloadToRecord(job.payload)) === operation.id) {
          handoffJobIds.add(job.id);
        }
      }
    }
  }
  await tx.bookEditOperation.updateMany({
    where: {
      status: { in: ["QUEUED", "ACTIVE"] },
      ...(retainedOperationIds.size > 0 ? { id: { notIn: [...retainedOperationIds] } } : {}),
      OR: linkedWhere
    },
    data: {
      status: "CANCELED",
      error: STOPPED_JOB_ERROR,
      structuralLeaseToken: null,
      structuralLeaseExpiresAt: null
    }
  });

  const restorableJobs = stoppedJobs.filter((job) => generationJobRestoresPreEditProjectStatus(job.type));
  if (restorableJobs.length === 0) {
    return { handoffJobIds, restorableContinuationJobIds };
  }
  const restorableJobIds = restorableJobs.map((job) => job.id);
  const restorableLegacyOperationIds = [
    ...new Set(restorableJobs.flatMap((job) => {
      const operationId = legacyOperationId(jsonPayloadToRecord(job.payload));
      return operationId ? [operationId] : [];
    }))
  ];
  const appliedOperations = await tx.bookEditOperation.findMany({
    where: {
      status: "APPLIED",
      OR: [
        { generationJobId: { in: restorableJobIds } },
        ...(restorableLegacyOperationIds.length > 0 ? [{ id: { in: restorableLegacyOperationIds } }] : [])
      ]
    },
    select: { id: true, generationJobId: true }
  });
  const appliedGenerationJobIds = new Set(
    appliedOperations.flatMap((operation) => operation.generationJobId ? [operation.generationJobId] : [])
  );
  const appliedOperationIds = new Set(appliedOperations.map((operation) => operation.id));
  for (const job of restorableJobs) {
    const legacyId = legacyOperationId(jsonPayloadToRecord(job.payload));
    if (appliedGenerationJobIds.has(job.id) || (legacyId !== null && appliedOperationIds.has(legacyId))) {
      handoffJobIds.add(job.id);
    }
  }
  return { handoffJobIds, restorableContinuationJobIds };
}

const STRUCTURAL_STOP_SAVEPOINT = `SAVEPOINT "stop_structural_compensation"`;
const STRUCTURAL_STOP_ROLLBACK = `ROLLBACK TO SAVEPOINT "stop_structural_compensation"`;
const STRUCTURAL_STOP_RELEASE = `RELEASE SAVEPOINT "stop_structural_compensation"`;

/**
 * A shift this stop cannot revert may not take the stop down with it.
 *
 * `revertStructuralPageChange` refuses transactionally and by design — an
 * archive whose rows do not match the count the stamp recorded, a plan lineage
 * it does not recognise, an embedding re-point that would collide — and each of
 * those *throws*. Inside the one transaction above, that rolled back every other
 * row the stop was settling: no job terminalized, no operation canceled, nothing
 * refunded, and `POST /:id/stop` reproducing it on every retry, because a
 * refusal is a fact about the stored stamp rather than a transient.
 *
 * The savepoint is what makes continuing safe rather than reckless: the refusals
 * are not all raised before the first write — `repointPageEmbeddings` checks
 * between its park and land passes, with the renumber already landed — so a bare
 * catch would commit a half-reverted book. Rolling back discards the attempt's
 * writes and, since PostgreSQL keeps a transaction aborted after a statement
 * error, is also what leaves this one committable. The verdict is then `lost`,
 * which makes the caller preserve the operation, job, lease and
 * `structuralApplication` stamp and stand down. The durable delivery retains
 * responsibility for recovering the shifted manuscript.
 */
async function compensateStoppedStructuralShiftTx(
  tx: Prisma.TransactionClient,
  options: { projectId: string; operationId: string; expectedAppliedAt?: string }
): Promise<StructuralCompensationResult> {
  await tx.$executeRawUnsafe(STRUCTURAL_STOP_SAVEPOINT);
  try {
    const compensation = await compensateStructuralPageChangeTx(tx, options);
    await tx.$executeRawUnsafe(STRUCTURAL_STOP_RELEASE);
    return compensation;
  } catch (error) {
    try {
      await tx.$executeRawUnsafe(STRUCTURAL_STOP_ROLLBACK);
      await tx.$executeRawUnsafe(STRUCTURAL_STOP_RELEASE);
    } catch (recoveryError) {
      // Nothing is committable after this, so fail rather than report a settlement the database will discard.
      throw new AggregateError([error, recoveryError], `Stop could not recover after compensating ${options.operationId}`);
    }
    console.error(`Stop could not revert structural page shift ${options.operationId}`, error);
    return { outcome: "lost" };
  }
}

function legacyOperationId(payload: Record<string, unknown>): string | null {
  const value = payload.operationId ?? payload.editOperationId ?? payload.replanOperationId;
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The charge that paid for the run being stopped, resolved the same way the
 * worker settles a failed run (its runtime/jobLifecycle.ts): the GENERATE_BOOK
 * payload's own ledger entry first, then the plan walk shared through
 * `bookGenerationChargeFromPayloads`. Null falls back to the latest
 * FULL_BOOK_GENERATION charge, which keeps runs enqueued before the payload
 * stamp refundable.
 */
async function stoppedRunLedgerEntryId(
  projectId: string,
  openJobs: ReadonlyArray<{ type: string; payload: unknown }>
): Promise<string | null> {
  let planId: string | null = null;
  for (const job of openJobs) {
    const payload = jsonPayloadToRecord(job.payload);
    if (job.type === "GENERATE_BOOK" && typeof payload.billingLedgerEntryId === "string" && payload.billingLedgerEntryId) {
      return payload.billingLedgerEntryId;
    }
    if (!planId && typeof payload.planId === "string" && payload.planId) {
      planId = payload.planId;
    }
  }
  if (!planId) {
    return null;
  }
  const rows = await prisma.generationJob.findMany({
    where: { projectId, type: "GENERATE_BOOK" },
    orderBy: { createdAt: "desc" },
    take: BOOK_GENERATION_CHARGE_LOOKBACK,
    select: { payload: true }
  });
  return bookGenerationChargeFromPayloads(rows, planId);
}

export async function isBullJobActive(bullJobId: string | null): Promise<boolean> {
  if (!bullJobId) {
    return false;
  }
  const bullJob = await bookQueue.getJob(bullJobId);
  if (!bullJob) {
    return false;
  }
  return (await bullJob.getState()) === "active";
}

export async function closeQueue() {
  await bookQueue.close();
  redisConnection.disconnect();
}

function jobOptionsForType(type: GenerationJobType): JobsOptions | undefined {
  return retryJobOptions(jobNames[type]);
}

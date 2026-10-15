import { errorMessage, workerJobNameForType } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { markFailed, markMalformedJobFailed } from "./jobLifecycle.js";
import { parseWorkerJob, type RawWorkerJob } from "./jobPayloads.js";
import { jsonPayloadToRecord } from "./serialization.js";

/**
 * A durable row whose Bull job can never run again, settled the way the
 * processor would have settled it.
 *
 * The other sweeps all leave such a row alone. `reconcileUndispatchedWorkerJobs`
 * takes only rows with no `bullJobId`, and `reconcileStrandedGeneration` skips
 * any project that still has a QUEUED or ACTIVE row — so a row whose Bull job
 * is gone sits open forever and holds its book GENERATING with it. Two such
 * `GENERATE_BOOK` rows from June were still ACTIVE on 2026-10-01, pointing at
 * Bull jobs 14 and 24, which Redis no longer had. A job reaches that state two
 * ways: Redis loses it (a flush, a manual clean), or BullMQ fails it for
 * stalling past `maxStalledCount` — that failure never calls the processor, so
 * `markFailed` never runs. The lanes now settle the second case themselves, from
 * the failing worker's `failed` event (`settleStalledOutDelivery` below); this
 * sweep is what still catches the first, and any stall-out that settlement had
 * to leave alone.
 *
 * Only those two Bull states count, because only they are final: a waiting,
 * delayed or active job is still going to run, and its own delivery settles it.
 * The row must also have been untouched for `LOST_DELIVERY_GRACE_MS`, so a
 * handler still writing progress (a stall-failed job's old process can keep
 * running) is never failed under itself. The claim then re-asserts the exact
 * row that was read, and settlement is `markFailed` itself, so the payload
 * flags — detached repairs, presentation reprints, edits, covers, the
 * attempt-owned refunds — settle exactly as they would for any failed delivery.
 */
export const LOST_DELIVERY_GRACE_MS = 2 * 60 * 60 * 1000;

export const LOST_DELIVERY_ERROR =
  "This job was lost from the generation queue and can no longer run, so it was closed.";

const LOST_BULL_STATES = new Set(["missing", "failed"]);

/**
 * How the sweep reads Bull, handed in by `index.ts`: `runtime/queue.ts` opens
 * Redis at import, and only the entry point and the dispatch layer may hold it.
 */
export type BullJobLookup = {
  getJob(id: string): Promise<{ getState(): Promise<string>; failedReason?: string } | undefined | null>;
};

/**
 * Where the sweep's lap stands: the last row it examined, or null to start from
 * the oldest. A row whose Bull job is still waiting is never written by the
 * sweep, so it keeps its place at the front of `updatedAt` order — and with a
 * page of only the oldest twenty, a backlog of twenty legitimately waiting rows
 * hid every lost one behind them until the backlog drained. The lap walks
 * `(updatedAt, id)` forward a page per sweep and starts over after a short page,
 * so every open row is examined within `⌈open / limit⌉ + 1` sweeps while each
 * sweep still reads one bounded page.
 */
export type LostDeliverySweepCursor = { after: { updatedAt: Date; id: string } | null };

const sweepCursor: LostDeliverySweepCursor = { after: null };

export async function reconcileLostQueueDeliveries(
  bull: BullJobLookup,
  limit = 20,
  now = Date.now(),
  cursor: LostDeliverySweepCursor = sweepCursor
): Promise<number> {
  const after = cursor.after;
  const rows = await prisma.generationJob.findMany({
    where: {
      status: { in: ["QUEUED", "ACTIVE"] },
      bullJobId: { not: null },
      updatedAt: { lt: new Date(now - LOST_DELIVERY_GRACE_MS) },
      ...(after
        ? { OR: [{ updatedAt: { gt: after.updatedAt } }, { updatedAt: after.updatedAt, id: { gt: after.id } }] }
        : {})
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: limit,
    select: OPEN_ROW_SELECT
  });
  // A full page may have more behind it; a short one ended the lap.
  const last = rows.at(-1);
  cursor.after = rows.length >= limit && last ? { updatedAt: last.updatedAt, id: last.id } : null;
  let settled = 0;
  for (const row of rows) {
    try {
      if (await settleIfLost(bull, row)) settled += 1;
    } catch (error) {
      // One unreadable row (Redis down, a bad payload) must not stop the rest.
      console.error("Lost queue delivery reconciliation failed for a row", { generationJobId: row.id, error: errorMessage(error) });
    }
  }
  return settled;
}

/** BullMQ's `failedReason` for a job it failed for stalling past `maxStalledCount`. */
export const STALLED_OUT_FAILED_REASON = "job stalled more than allowable limit";

export const STALLED_OUT_DELIVERY_ERROR =
  "This job was interrupted too many times to finish, so it was closed.";

type FailedBullJob = { id?: string | undefined; data: unknown; deferredFailure?: string | undefined };

/**
 * Whether BullMQ failed this delivery for stalling too often. It decides that
 * before the processor: `moveStalledJobsToWait` marks the job, the next worker
 * to fetch it fails it unrecoverably without calling the processor, and the
 * only thing this process ever sees is that worker's `failed` event.
 */
export function isStalledOutFailure(job: FailedBullJob, error: Error | undefined): boolean {
  return job.deferredFailure === STALLED_OUT_FAILED_REASON || error?.message === STALLED_OUT_FAILED_REASON;
}

/** The durable row a Bull job delivers: the payload's row id, else the Bull id, as `deliveryGuard.ts` keys it. */
export function deliveryRowId(job: FailedBullJob): string | null {
  const data = job.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const id = (data as Record<string, unknown>).generationJobId;
    if (typeof id === "string" && id) return id;
  }
  return job.id ? job.id : null;
}

/**
 * Settles a row whose Bull job BullMQ has just failed for stalling, at the
 * moment it does so, rather than when the sweep above finds it a grace period
 * later. That grace is two hours, and meanwhile the book read "generating".
 *
 * The caller has already ruled out the original still running in this process
 * (`laneWorkers.ts` asks the delivery guard). What it cannot see is a second
 * worker process, so the row must also have been silent for `quietMs`: a dead
 * holder has been, because its lock outlived it by at least half a lock before
 * any stall check could see it missing, while a live one still writing progress
 * has not — and is left to the sweep, exactly as before. The row must still
 * name this Bull job, so a requeue's newer delivery is never failed for an older
 * one's stalls. Settlement is the sweep's own: the same claim on the row as it
 * was read, then `markFailed`.
 */
export async function settleStalledOutDelivery(
  job: FailedBullJob,
  options: { quietMs: number; now?: number }
): Promise<boolean> {
  const rowId = deliveryRowId(job);
  if (!rowId || !job.id) return false;
  const row = await prisma.generationJob.findUnique({ where: { id: rowId }, select: OPEN_ROW_SELECT });
  if (!row || (row.status !== "QUEUED" && row.status !== "ACTIVE") || row.bullJobId !== job.id) return false;
  const now = options.now ?? Date.now();
  if (row.updatedAt.getTime() > now - options.quietMs) {
    console.warn("Leaving a stalled-out job to the lost-delivery sweep: its row is still being written", {
      event: "generation.stalled_out_deferred",
      generationJobId: row.id,
      bullJobId: job.id,
      updatedAt: row.updatedAt.toISOString()
    });
    return false;
  }
  return settleOpenRow(row, { bullState: "failed", failedReason: STALLED_OUT_FAILED_REASON, error: new Error(STALLED_OUT_DELIVERY_ERROR) });
}

const OPEN_ROW_SELECT = {
  id: true,
  type: true,
  status: true,
  projectId: true,
  attemptId: true,
  payload: true,
  bullJobId: true,
  updatedAt: true
} as const;

type OpenRow = {
  id: string;
  type: string;
  status: string;
  projectId: string | null;
  attemptId: string | null;
  payload: unknown;
  bullJobId: string | null;
  updatedAt: Date;
};

async function settleIfLost(bull: BullJobLookup, row: OpenRow): Promise<boolean> {
  if (!row.bullJobId) return false;
  const bullJob = await bull.getJob(row.bullJobId);
  const state = bullJob ? await bullJob.getState() : "missing";
  if (!LOST_BULL_STATES.has(state)) return false;
  return settleOpenRow(row, { bullState: state, failedReason: bullJob?.failedReason ?? null, error: new Error(LOST_DELIVERY_ERROR) });
}

async function settleOpenRow(
  row: OpenRow,
  context: { bullState: string; failedReason: string | null; error: Error }
): Promise<boolean> {
  // The row as it was read, or nothing: a resume, a stop or a redelivery that
  // touched it since moved `updatedAt`, and that row is not this sweep's.
  const claimed = await prisma.generationJob.updateMany({
    where: { id: row.id, status: row.status as "QUEUED" | "ACTIVE", bullJobId: row.bullJobId, updatedAt: row.updatedAt },
    data: { message: "Lost from the generation queue" }
  });
  if (claimed.count !== 1) return false;

  console.warn("Settling a generation job lost from the queue", {
    event: "generation.lost_delivery_settled",
    generationJobId: row.id,
    projectId: row.projectId,
    type: row.type,
    bullJobId: row.bullJobId,
    bullState: context.bullState,
    failedReason: context.failedReason
  });
  const raw = {
    id: row.id,
    name: workerJobNameForType(row.type),
    data: {
      ...jsonPayloadToRecord(row.payload),
      ...(row.projectId ? { projectId: row.projectId } : {}),
      generationJobId: row.id,
      ...(row.attemptId ? { attemptId: row.attemptId } : {})
    },
    attemptsMade: 0,
    opts: {}
  } as unknown as RawWorkerJob;
  let job;
  try {
    job = parseWorkerJob(raw);
  } catch {
    // A payload from an older schema still names its row; settle it as the
    // processor settles any payload it cannot read.
    await markMalformedJobFailed(raw, context.error);
    return true;
  }
  await markFailed(job, context.error);
  return true;
}

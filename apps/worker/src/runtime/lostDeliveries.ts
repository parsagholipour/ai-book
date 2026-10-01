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
 * `markFailed` never runs.
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

export async function reconcileLostQueueDeliveries(bull: BullJobLookup, limit = 20, now = Date.now()): Promise<number> {
  const rows = await prisma.generationJob.findMany({
    where: {
      status: { in: ["QUEUED", "ACTIVE"] },
      bullJobId: { not: null },
      updatedAt: { lt: new Date(now - LOST_DELIVERY_GRACE_MS) }
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: {
      id: true,
      type: true,
      status: true,
      projectId: true,
      attemptId: true,
      payload: true,
      bullJobId: true,
      updatedAt: true
    }
  });
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
    bullState: state,
    failedReason: bullJob?.failedReason ?? null
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
  const error = new Error(LOST_DELIVERY_ERROR);
  let job;
  try {
    job = parseWorkerJob(raw);
  } catch {
    // A payload from an older schema still names its row; settle it as the
    // processor settles any payload it cannot read.
    await markMalformedJobFailed(raw, error);
    return true;
  }
  await markFailed(job, error);
  return true;
}

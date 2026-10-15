import { Worker, type ConnectionOptions, type WorkerOptions } from "bullmq";
import {
  GENERATION_JOB_RETENTION,
  INTERACTIVE_JOB_QUEUE,
  LONG_JOB_QUEUE,
  type GenerationJobQueueName,
  type JobLane
} from "@book-maker/core";
import { createDeliveryGuard, type DeliveryGuard } from "./deliveryGuard.js";
import type { RawWorkerJob } from "./jobPayloads.js";
import { deliveryRowId, isStalledOutFailure, settleStalledOutDelivery } from "./lostDeliveries.js";

/**
 * One BullMQ Worker per lane (`jobLanes.ts` in core), both in this process: a
 * long lane's books cannot hold the interactive lane's plans and edits, and
 * each lane has its own concurrency. The long lane consumes the original
 * `book-maker` queue, so whatever the previous release left there still runs.
 *
 * Both lanes share one delivery guard, so a row reclaimed by BullMQ while it
 * is still running here waits for the original whichever lane either copy is
 * in (`deliveryGuard.ts`).
 *
 * The lock is four times BullMQ's default. A lock is renewed every half of
 * it, so the default reclaimed a running job after as little as fifteen
 * seconds without a renewal — a Redis restart, a long pause — and handed it out
 * beside the original. The guard makes that copy wait; the longer lock makes
 * it rare. The price is that a job killed with its process is picked up two
 * minutes later instead of thirty seconds, against runs measured in tens of
 * minutes.
 */
export const LANE_LOCK_DURATION_MS = 2 * 60_000;

/**
 * How many times a job may be reclaimed from a dead or silent holder before
 * BullMQ fails it. BullMQ's default is one, and its stall counter only ever
 * rises, so the *second* reclaim in a job's life failed it — two deploys (each
 * one stops the worker after a five-minute drain) or a deploy and an OOM kill
 * inside one 60–90 minute book were enough. A reclaim is a resume, and has been
 * since the first one was allowed: `markActive` takes an ACTIVE row back on
 * purpose, a composed book restarts at its first unwritten chapter, a COMPLETED
 * row replays only its tail, and a copy that arrives while the original still
 * runs here waits for it (`deliveryGuard.ts`). Five more of those cost at most
 * the chapter each interruption was writing; the bound stays because a job that
 * kills its worker every time it runs must still stop.
 */
export const LANE_MAX_STALLED_COUNT = 5;

/**
 * How long a stalled-out job's row must have been silent before the lane fails
 * it itself: half a lock, because a dead holder's lock outlives it by at least
 * that before any stall check can see it missing (`settleStalledOutDelivery`).
 */
export const STALLED_OUT_QUIET_MS = LANE_LOCK_DURATION_MS / 2;

const LANE_QUEUES: ReadonlyArray<[JobLane, GenerationJobQueueName]> = [
  ["long", LONG_JOB_QUEUE],
  ["interactive", INTERACTIVE_JOB_QUEUE]
];

type LaneWorker = Pick<Worker, "name" | "on" | "close" | "isRunning">;

type SettleStalledOut = (job: RawWorkerJob) => Promise<unknown>;

type CreateWorker = (
  queueName: string,
  processor: (job: RawWorkerJob, token?: string) => Promise<void>,
  options: WorkerOptions
) => LaneWorker;

export type LaneWorkers = {
  /** `running` counts this lane's deliveries in flight in this process, for its heartbeat. */
  workers: ReadonlyArray<{ lane: JobLane; queueName: GenerationJobQueueName; worker: LaneWorker; running(): number }>;
  guard: DeliveryGuard;
  /** Closes both together: each waits for its own running jobs, and the deploy's grace covers the slower lane. */
  close(): Promise<void>;
};

export function startLaneWorkers(options: {
  connection: ConnectionOptions;
  processor: (job: RawWorkerJob, token?: string) => Promise<void>;
  concurrency: Record<JobLane, number>;
  createWorker?: CreateWorker;
  settleStalledOut?: SettleStalledOut;
}): LaneWorkers {
  const guard = createDeliveryGuard();
  const settleStalledOut: SettleStalledOut =
    options.settleStalledOut ?? ((job) => settleStalledOutDelivery(job, { quietMs: STALLED_OUT_QUIET_MS }));
  // Settlements still writing when the lanes close; `close` waits for them.
  const settling = new Set<Promise<void>>();
  const processor = guard.wrap(options.processor);
  const create: CreateWorker =
    options.createWorker ?? ((queueName, laneProcessor, workerOptions) => new Worker(queueName, laneProcessor, workerOptions));
  const workers = LANE_QUEUES.map(([lane, queueName]) => {
    let running = 0;
    const counted = async (job: RawWorkerJob, token?: string): Promise<void> => {
      running += 1;
      try {
        await processor(job, token);
      } finally {
        running -= 1;
      }
    };
    const worker = create(queueName, counted, {
      connection: options.connection,
      concurrency: options.concurrency[lane],
      lockDuration: LANE_LOCK_DURATION_MS,
      maxStalledCount: LANE_MAX_STALLED_COUNT,
      // For jobs whose own options predate retention — the previous release's.
      removeOnComplete: { ...GENERATION_JOB_RETENTION.removeOnComplete },
      removeOnFail: { ...GENERATION_JOB_RETENTION.removeOnFail }
    });
    // A job BullMQ fails for stalling never reaches the processor, so nothing
    // below it settles the row; this event is the only place it is seen.
    worker.on("failed", (job: RawWorkerJob | undefined, error: Error) => {
      if (!job || !isStalledOutFailure(job, error)) return;
      const rowId = deliveryRowId(job);
      if (rowId && guard.running().has(rowId)) {
        // The original is still running here and settles the row itself.
        console.warn("A stalled-out job is still running in this process; leaving it to its own delivery", {
          event: "generation.stalled_out_running",
          generationJobId: rowId,
          bullJobId: job.id ?? null
        });
        return;
      }
      const settlement: Promise<void> = settleStalledOut(job)
        .then(() => undefined)
        .catch((settleError: unknown) => {
          // The lost-delivery sweep still finds it.
          console.error("Settling a stalled-out job failed", { generationJobId: rowId, error: settleError });
        })
        .finally(() => settling.delete(settlement));
      settling.add(settlement);
    });
    return { lane, queueName, running: () => running, worker };
  });
  return {
    workers,
    guard,
    close: async () => {
      await Promise.all(workers.map(({ worker }) => worker.close()));
      await Promise.all(settling);
    }
  };
}

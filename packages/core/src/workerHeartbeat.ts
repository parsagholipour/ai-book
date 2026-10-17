import { GENERATION_JOB_QUEUES, JOB_LANE_NAMES, type GenerationJobQueueName, type JobLane } from "./jobLanes.js";

/*
 * A worker lane's proof of life, written by the worker
 * (`apps/worker/src/runtime/workerHeartbeat.ts`) and read by the API's
 * readiness probe and alert sweep (`apps/api/src/monitoring/`).
 *
 * One Redis key per lane, rewritten every interval with a TTL of three
 * intervals, so a lane is alive exactly while its key exists: nothing has to
 * notice a worker dying, the key simply stops being there. The beat comes from a
 * timer on the worker's own event loop, so a process that is up but wedged —
 * a synchronous loop, a blocked thread pool that starves the timer — stops
 * beating just as a dead one does. BullMQ's own `getWorkers()` (the compose
 * healthcheck) cannot tell those apart: a wedged worker keeps its Redis
 * connection, and its client name with it.
 *
 * Keyed by queue rather than by process: the question the readiness probe asks
 * is "does this lane have a live consumer", and two worker processes on one lane
 * answer it together — whichever beat last. The payload is diagnostics for the
 * alert email (which process, since when, how busy), never an input to the
 * verdict beyond its own age.
 */

export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
/** Three missed beats, so one timer running late behind a busy event loop is not an outage. */
export const WORKER_HEARTBEAT_TTL_MS = 3 * WORKER_HEARTBEAT_INTERVAL_MS;

export type WorkerHeartbeat = {
  lane: JobLane;
  queue: GenerationJobQueueName;
  pid: number;
  host: string;
  /** When the beating process started (ISO). A recent one on every alert is a crash loop. */
  startedAt: string;
  /** When this beat was written (ISO). */
  beatAt: string;
  /** Jobs this process is running on the lane right now. */
  running: number;
  concurrency: number;
};

/** Outside BullMQ's `bull:` prefix, so no queue operation ever reads or trims it. */
export function workerHeartbeatKey(queue: GenerationJobQueueName): string {
  return `book-maker:worker-heartbeat:${queue}`;
}

/** The keys for every lane, in `GENERATION_JOB_QUEUES` order. */
export const WORKER_HEARTBEAT_KEYS: readonly string[] = Object.freeze(GENERATION_JOB_QUEUES.map(workerHeartbeatKey));

/**
 * A stored beat, or null for anything that is not one — an older release's
 * shape, a hand-written key. A heartbeat the reader cannot parse is a lane it
 * cannot vouch for.
 */
export function parseWorkerHeartbeat(raw: string | null | undefined): WorkerHeartbeat | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { lane, queue, pid, host, startedAt, beatAt, running, concurrency } = record;
  if (typeof lane !== "string" || !(JOB_LANE_NAMES as readonly string[]).includes(lane)) return null;
  if (typeof queue !== "string" || !(GENERATION_JOB_QUEUES as readonly string[]).includes(queue)) return null;
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) return null;
  if (typeof beatAt !== "string" || Number.isNaN(Date.parse(beatAt))) return null;
  if (![pid, running, concurrency].every((number) => typeof number === "number" && Number.isFinite(number))) return null;
  return {
    lane: lane as JobLane,
    queue: queue as GenerationJobQueueName,
    pid: pid as number,
    host: typeof host === "string" ? host : "",
    startedAt,
    beatAt,
    running: running as number,
    concurrency: concurrency as number
  };
}

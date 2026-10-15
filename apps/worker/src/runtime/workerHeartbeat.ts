import { hostname } from "node:os";
import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_TTL_MS,
  workerHeartbeatKey,
  type GenerationJobQueueName,
  type JobLane,
  type WorkerHeartbeat
} from "@book-maker/core";

/**
 * Writes each lane's heartbeat key (`workerHeartbeat.ts` in core) every
 * interval, with a TTL of three, for the API's readiness probe and alert sweep.
 *
 * The beat is a timer on this process's event loop, and that is the point: a
 * worker whose loop is wedged — a synchronous spin, a render that never yields —
 * keeps its Redis connection, so BullMQ still lists it as a consumer and the
 * compose healthcheck stays green, but no timer fires, the key expires, and the
 * API reports the lane down within ninety seconds. A lane whose BullMQ `Worker`
 * has stopped running (its main loop failed, or it has closed) is skipped, so
 * one dead lane in a live process is reported on its own.
 *
 * It takes the Redis client as an argument rather than importing
 * `runtime/queue.ts`, which opens a connection at import; only the entry point
 * holds that.
 */

/** The one Redis call a beat makes: `SET key value PX ttl`. */
export type HeartbeatStore = {
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
};

export type HeartbeatLane = {
  lane: JobLane;
  queueName: GenerationJobQueueName;
  concurrency: number;
  /** BullMQ's `Worker.isRunning()`: its main loop is up, draining included. */
  isRunning(): boolean;
  running(): number;
};

export type WorkerHeartbeatHandle = {
  /** One beat now; a beat still waiting on Redis is not doubled. */
  beat(): Promise<void>;
  /** No more beats. The keys are left to expire, so a quick restart never reads as an outage. */
  stop(): void;
};

type HeartbeatLog = {
  warn(message: string, detail?: unknown): void;
  info(message: string): void;
};

export function startWorkerHeartbeat(options: {
  store: HeartbeatStore;
  lanes: readonly HeartbeatLane[];
  intervalMs?: number;
  ttlMs?: number;
  now?: () => Date;
  startedAt?: Date;
  pid?: number;
  host?: string;
  log?: HeartbeatLog;
}): WorkerHeartbeatHandle {
  const intervalMs = options.intervalMs ?? WORKER_HEARTBEAT_INTERVAL_MS;
  const ttlMs = options.ttlMs ?? WORKER_HEARTBEAT_TTL_MS;
  const now = options.now ?? (() => new Date());
  const startedAt = (options.startedAt ?? new Date(Date.now() - process.uptime() * 1000)).toISOString();
  const pid = options.pid ?? process.pid;
  const host = options.host ?? hostname();
  const log: HeartbeatLog = options.log ?? {
    warn: (message, detail) => console.warn(message, detail),
    info: (message) => console.log(message)
  };

  let stopped = false;
  let failing = false;
  let inFlight: Promise<void> | null = null;

  const writeBeats = async (): Promise<void> => {
    const beatAt = now().toISOString();
    const writes = options.lanes
      .filter((lane) => lane.isRunning())
      .map((lane) => {
        const heartbeat: WorkerHeartbeat = {
          lane: lane.lane,
          queue: lane.queueName,
          pid,
          host,
          startedAt,
          beatAt,
          running: lane.running(),
          concurrency: lane.concurrency
        };
        return options.store.set(workerHeartbeatKey(lane.queueName), JSON.stringify(heartbeat), "PX", ttlMs);
      });
    const failure = (await Promise.allSettled(writes)).find((result) => result.status === "rejected");
    // Said once per streak: Redis being down is already loud in this log, and
    // the API reports the lane as down either way.
    if (failure && !failing) {
      failing = true;
      log.warn("Worker heartbeat could not be written; the API reports this worker down until it is", failure.reason);
    } else if (!failure && failing) {
      failing = false;
      log.info("Worker heartbeat is being written again");
    }
  };

  const beat = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    // ioredis holds a command while it reconnects, so a beat can wait as long
    // as Redis is down; queueing another behind it would only pile them up.
    inFlight ??= writeBeats().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const timer = setInterval(() => void beat(), intervalMs);
  timer.unref();
  void beat();

  return {
    beat,
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}

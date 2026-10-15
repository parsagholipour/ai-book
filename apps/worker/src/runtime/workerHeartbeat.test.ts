import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTERACTIVE_JOB_QUEUE,
  LONG_JOB_QUEUE,
  parseWorkerHeartbeat,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_TTL_MS,
  workerHeartbeatKey
} from "@book-maker/core";
import { startWorkerHeartbeat, type HeartbeatLane } from "./workerHeartbeat.js";

/** Redis's `SET … PX` and `GET`, with expiry read off the (fake) clock. */
function fakeRedis() {
  const entries = new Map<string, { value: string; expiresAt: number }>();
  return {
    entries,
    set: vi.fn(async (key: string, value: string, mode: "PX", ttlMs: number) => {
      expect(mode).toBe("PX");
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
      return "OK";
    }),
    get(key: string): string | null {
      const entry = entries.get(key);
      return entry && entry.expiresAt > Date.now() ? entry.value : null;
    }
  };
}

function lanes(state: { longRunning?: boolean; interactiveJobs?: number } = {}): HeartbeatLane[] {
  return [
    { lane: "long", queueName: LONG_JOB_QUEUE, concurrency: 1, isRunning: () => state.longRunning ?? true, running: () => 0 },
    {
      lane: "interactive",
      queueName: INTERACTIVE_JOB_QUEUE,
      concurrency: 2,
      isRunning: () => true,
      running: () => state.interactiveJobs ?? 0
    }
  ];
}

const quiet = { warn: vi.fn(), info: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T10:00:00.000Z"));
  quiet.warn.mockReset();
  quiet.info.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startWorkerHeartbeat", () => {
  it("writes one key per running lane at once, with the three-beat TTL and what the alert email needs", async () => {
    const redis = fakeRedis();
    const heartbeat = startWorkerHeartbeat({
      store: redis,
      lanes: lanes({ interactiveJobs: 2 }),
      startedAt: new Date("2026-10-13T09:00:00.000Z"),
      pid: 7,
      host: "worker-a",
      log: quiet
    });
    await heartbeat.beat();

    expect(redis.set).toHaveBeenCalledWith(workerHeartbeatKey(LONG_JOB_QUEUE), expect.any(String), "PX", WORKER_HEARTBEAT_TTL_MS);
    expect(parseWorkerHeartbeat(redis.get(workerHeartbeatKey(INTERACTIVE_JOB_QUEUE)))).toEqual({
      lane: "interactive",
      queue: INTERACTIVE_JOB_QUEUE,
      pid: 7,
      host: "worker-a",
      startedAt: "2026-10-13T09:00:00.000Z",
      beatAt: "2026-10-13T10:00:00.000Z",
      running: 2,
      concurrency: 2
    });
    heartbeat.stop();
  });

  it("keeps a lane alive only while its timer keeps firing, and lets it expire when the loop stops", async () => {
    const redis = fakeRedis();
    const heartbeat = startWorkerHeartbeat({ store: redis, lanes: lanes(), log: quiet });
    const key = workerHeartbeatKey(LONG_JOB_QUEUE);

    // A healthy loop: every interval rewrites the key, so it never lapses.
    for (let beat = 0; beat < 5; beat += 1) {
      await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
      expect(redis.get(key)).not.toBeNull();
    }

    // A wedged loop: the clock moves, but no timer runs on this process.
    vi.setSystemTime(Date.now() + WORKER_HEARTBEAT_TTL_MS - 1);
    expect(redis.get(key)).not.toBeNull();
    vi.setSystemTime(Date.now() + 2);
    expect(redis.get(key)).toBeNull();
    heartbeat.stop();
  });

  it("skips a lane whose BullMQ worker is no longer running, so it is reported on its own", async () => {
    const redis = fakeRedis();
    const state = { longRunning: true };
    const heartbeat = startWorkerHeartbeat({ store: redis, lanes: lanes(state), log: quiet });
    await heartbeat.beat();
    state.longRunning = false;
    vi.setSystemTime(Date.now() + WORKER_HEARTBEAT_TTL_MS + 1);
    await heartbeat.beat();

    expect(redis.get(workerHeartbeatKey(LONG_JOB_QUEUE))).toBeNull();
    expect(redis.get(workerHeartbeatKey(INTERACTIVE_JOB_QUEUE))).not.toBeNull();
    heartbeat.stop();
  });

  it("stops beating on stop() and leaves the keys to expire rather than deleting them", async () => {
    const redis = fakeRedis();
    const heartbeat = startWorkerHeartbeat({ store: redis, lanes: lanes(), log: quiet });
    await heartbeat.beat();
    const writes = redis.set.mock.calls.length;
    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(5 * WORKER_HEARTBEAT_INTERVAL_MS);
    expect(redis.set.mock.calls.length).toBe(writes);
    expect(redis.entries.size).toBe(2);
  });

  it("does not pile beats up behind a Redis that does not answer, and says so once", async () => {
    let answer!: () => void;
    const store = { set: vi.fn(() => new Promise<unknown>((resolve) => (answer = () => resolve("OK")))) };
    const heartbeat = startWorkerHeartbeat({ store, lanes: lanes(), log: quiet });
    await vi.advanceTimersByTimeAsync(3 * WORKER_HEARTBEAT_INTERVAL_MS);
    // The first beat's two writes are still pending; no later beat queued more.
    expect(store.set).toHaveBeenCalledTimes(2);
    answer();
    heartbeat.stop();

    const failing = { set: vi.fn(async (): Promise<unknown> => Promise.reject(new Error("ECONNREFUSED"))) };
    const broken = startWorkerHeartbeat({ store: failing, lanes: lanes(), log: quiet });
    await broken.beat();
    await vi.advanceTimersByTimeAsync(2 * WORKER_HEARTBEAT_INTERVAL_MS);
    expect(quiet.warn).toHaveBeenCalledTimes(1);
    failing.set.mockImplementation(async () => "OK");
    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
    expect(quiet.info).toHaveBeenCalledTimes(1);
    broken.stop();
  });
});

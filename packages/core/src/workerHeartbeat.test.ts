import { describe, expect, it } from "vitest";
import { INTERACTIVE_JOB_QUEUE, LONG_JOB_QUEUE } from "./jobLanes.js";
import {
  parseWorkerHeartbeat,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_KEYS,
  WORKER_HEARTBEAT_TTL_MS,
  workerHeartbeatKey,
  type WorkerHeartbeat
} from "./workerHeartbeat.js";

const beat: WorkerHeartbeat = {
  lane: "interactive",
  queue: INTERACTIVE_JOB_QUEUE,
  pid: 42,
  host: "worker-1",
  startedAt: "2026-10-13T10:00:00.000Z",
  beatAt: "2026-10-13T10:05:00.000Z",
  running: 1,
  concurrency: 2
};

describe("worker heartbeat keys", () => {
  it("names one key per lane, outside BullMQ's own prefix", () => {
    expect(WORKER_HEARTBEAT_KEYS).toEqual([workerHeartbeatKey(LONG_JOB_QUEUE), workerHeartbeatKey(INTERACTIVE_JOB_QUEUE)]);
    for (const key of WORKER_HEARTBEAT_KEYS) {
      expect(key.startsWith("bull:")).toBe(false);
    }
    expect(new Set(WORKER_HEARTBEAT_KEYS).size).toBe(2);
  });

  it("outlives exactly three missed beats", () => {
    expect(WORKER_HEARTBEAT_TTL_MS).toBe(3 * WORKER_HEARTBEAT_INTERVAL_MS);
  });
});

describe("parseWorkerHeartbeat", () => {
  it("reads back what the worker writes", () => {
    expect(parseWorkerHeartbeat(JSON.stringify(beat))).toEqual(beat);
  });

  it.each([
    ["nothing", null],
    ["an empty value", ""],
    ["not JSON", "alive"],
    ["a bare number", "1"],
    ["an unknown lane", JSON.stringify({ ...beat, lane: "bulk" })],
    ["an unknown queue", JSON.stringify({ ...beat, queue: "other" })],
    ["an unreadable beat time", JSON.stringify({ ...beat, beatAt: "yesterday" })],
    ["a missing running count", JSON.stringify({ ...beat, running: undefined })]
  ])("vouches for nothing given %s", (_label, raw) => {
    expect(parseWorkerHeartbeat(raw)).toBeNull();
  });
});

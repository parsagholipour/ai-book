import type { WorkerOptions } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  markFailed: vi.fn(),
  markMalformedJobFailed: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  prisma: { generationJob: { findUnique: mocks.findUnique, updateMany: mocks.updateMany } }
}));
vi.mock("./jobLifecycle.js", () => ({
  markFailed: mocks.markFailed,
  markMalformedJobFailed: mocks.markMalformedJobFailed
}));

import { GENERATION_JOB_RETENTION, JOB_LANE_NAMES } from "@book-maker/core";
import { LANE_LOCK_DURATION_MS, LANE_MAX_STALLED_COUNT, STALLED_OUT_QUIET_MS, startLaneWorkers } from "./laneWorkers.js";
import { STALLED_OUT_DELIVERY_ERROR, STALLED_OUT_FAILED_REASON } from "./lostDeliveries.js";

type FailedListener = (job: unknown, error: Error, prev?: string) => void;

/** Production's shape (docker-compose.production.yml). */
const CONCURRENCY = { long: 30, interactive: 2, images: 4, compile: 3, background: 4 } as const;

function fakeWorkers() {
  const created: Array<{
    queueName: string;
    options: Record<string, unknown>;
    close: ReturnType<typeof vi.fn>;
    emitFailed: FailedListener;
  }> = [];
  const createWorker = vi.fn((queueName: string, _processor: unknown, options: WorkerOptions) => {
    const listeners = new Map<string, FailedListener>();
    const worker = {
      name: queueName,
      on: vi.fn((event: string, listener: FailedListener) => listeners.set(event, listener)),
      close: vi.fn(async () => undefined),
      isRunning: vi.fn(() => true)
    };
    created.push({
      queueName,
      options: options as unknown as Record<string, unknown>,
      close: worker.close,
      emitFailed: (job, error) => listeners.get("failed")?.(job, error, "active")
    });
    return worker as never;
  });
  return { created, createWorker };
}

/** A Bull job as BullMQ hands a stalled-out one to `failed`: marked, never processed. */
function stalledOutJob(rowId = "gj-1") {
  return { id: rowId, name: "generate-book", data: { generationJobId: rowId, projectId: "project-1", planId: "plan-1" }, deferredFailure: STALLED_OUT_FAILED_REASON };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe("startLaneWorkers", () => {
  it("consumes the old book-maker queue as the long lane and the other four lanes beside it", () => {
    const { created, createWorker } = fakeWorkers();
    const lanes = startLaneWorkers({
      connection: {} as never,
      processor: vi.fn(async () => undefined),
      concurrency: CONCURRENCY,
      createWorker
    });
    expect(lanes.workers.map(({ lane }) => lane)).toEqual(["long", "interactive", "images", "compile", "background"]);
    // A job the previous release left in `book-maker` is still delivered.
    expect(created.map(({ queueName }) => queueName)).toEqual([
      "book-maker",
      "book-maker-interactive",
      "book-maker-images",
      "book-maker-compile",
      "book-maker-background"
    ]);
    expect(created[0]!.options).toMatchObject({
      concurrency: 30,
      lockDuration: LANE_LOCK_DURATION_MS,
      removeOnComplete: GENERATION_JOB_RETENTION.removeOnComplete,
      removeOnFail: GENERATION_JOB_RETENTION.removeOnFail
    });
    expect(created.map(({ options }) => options.concurrency)).toEqual([30, 2, 4, 3, 4]);
    // Every lane gets the same lock and the same retention.
    for (const { options } of created) {
      expect(options).toMatchObject({ lockDuration: LANE_LOCK_DURATION_MS, removeOnFail: GENERATION_JOB_RETENTION.removeOnFail });
    }
  });

  it("lets a job be reclaimed five times before BullMQ fails it, on every lane", () => {
    const { created, createWorker } = fakeWorkers();
    startLaneWorkers({ connection: {} as never, processor: vi.fn(async () => undefined), concurrency: CONCURRENCY, createWorker });
    // BullMQ's default of one failed a book at its second deploy.
    expect(LANE_MAX_STALLED_COUNT).toBe(5);
    expect(created.map(({ options }) => options.maxStalledCount)).toEqual(JOB_LANE_NAMES.map(() => LANE_MAX_STALLED_COUNT));
  });

  it("closes every lane together, and only resolves once all have closed", async () => {
    const { created, createWorker } = fakeWorkers();
    const lanes = startLaneWorkers({
      connection: {} as never,
      processor: vi.fn(async () => undefined),
      concurrency: CONCURRENCY,
      createWorker
    });
    let releaseLong!: () => void;
    created[0]!.close.mockImplementation(() => new Promise<void>((resolve) => (releaseLong = resolve)));
    let closed = false;
    const closing = lanes.close().then(() => (closed = true));
    await Promise.resolve();
    // The other lanes are asked to close while the long lane is still draining.
    for (const lane of created.slice(1)) expect(lane.close).toHaveBeenCalledTimes(1);
    expect(closed).toBe(false);
    releaseLong();
    await closing;
    expect(closed).toBe(true);
  });

  it("hands every lane one shared delivery guard", async () => {
    const { createWorker } = fakeWorkers();
    let release!: () => void;
    const processor = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const lanes = startLaneWorkers({ connection: {} as never, processor, concurrency: CONCURRENCY, createWorker });
    const longProcessor = createWorker.mock.calls[0]![1] as (job: unknown, token?: string) => Promise<void>;
    const interactiveProcessor = createWorker.mock.calls[1]![1] as (job: unknown, token?: string) => Promise<void>;
    const job = (id: string) => ({ id, name: "apply-book-edit", data: { generationJobId: "gj-1" }, moveToDelayed: vi.fn(async () => undefined) });
    const imageProcessor = createWorker.mock.calls[2]![1] as (job: unknown, token?: string) => Promise<void>;
    const running = longProcessor(job("gj-1"), "a");
    await expect(interactiveProcessor(job("gj-1"), "b")).rejects.toThrow();
    // A picture the previous release queued in `book-maker`, re-pushed into the image lane while it still runs.
    await expect(imageProcessor(job("gj-1"), "c")).rejects.toThrow();
    expect(lanes.guard.running().has("gj-1")).toBe(true);
    release();
    await running;
  });

  it("counts each lane's deliveries in flight, for the lane's heartbeat", async () => {
    const { createWorker } = fakeWorkers();
    const releases: Array<() => void> = [];
    const processor = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const lanes = startLaneWorkers({ connection: {} as never, processor, concurrency: CONCURRENCY, createWorker });
    const [long, interactive] = lanes.workers;
    const interactiveProcessor = createWorker.mock.calls[1]![1] as (job: unknown, token?: string) => Promise<void>;
    const job = (id: string) => ({ id, name: "plan-book", data: { generationJobId: id }, moveToDelayed: vi.fn(async () => undefined) });
    const first = interactiveProcessor(job("gj-1"), "a");
    const second = interactiveProcessor(job("gj-2"), "b");
    expect(interactive!.running()).toBe(2);
    expect(long!.running()).toBe(0);
    expect(interactive!.queueName).toBe("book-maker-interactive");
    releases.forEach((release) => release());
    await Promise.all([first, second]);
    expect(interactive!.running()).toBe(0);
  });

  it("still counts a delivery out when it throws", async () => {
    const { createWorker } = fakeWorkers();
    const lanes = startLaneWorkers({
      connection: {} as never,
      processor: vi.fn(async () => {
        throw new Error("provider down");
      }),
      concurrency: CONCURRENCY,
      createWorker
    });
    const longProcessor = createWorker.mock.calls[0]![1] as (job: unknown, token?: string) => Promise<void>;
    await expect(
      longProcessor({ id: "1", name: "generate-book", data: { generationJobId: "gj-9" }, moveToDelayed: vi.fn() }, "a")
    ).rejects.toThrow("provider down");
    expect(lanes.workers[0]!.running()).toBe(0);
  });
});

describe("a job BullMQ fails for stalling", () => {
  type LaneOptions = Parameters<typeof startLaneWorkers>[0];
  const start = (
    settleStalledOut?: LaneOptions["settleStalledOut"],
    processor: LaneOptions["processor"] = async () => undefined
  ) => {
    const { created, createWorker } = fakeWorkers();
    const lanes = startLaneWorkers({
      connection: {} as never,
      processor,
      concurrency: CONCURRENCY,
      createWorker,
      ...(settleStalledOut ? { settleStalledOut } : {})
    });
    return { created, createWorker, lanes };
  };

  it("settles its row FAILED through markFailed, from the failed event the processor never saw", async () => {
    const { created, lanes } = start();
    mocks.findUnique.mockResolvedValue({
      id: "gj-1",
      type: "GENERATE_BOOK",
      status: "ACTIVE",
      projectId: "project-1",
      attemptId: null,
      payload: { planId: "plan-1" },
      bullJobId: "gj-1",
      // Silent since its holder died: older than half a lock.
      updatedAt: new Date(Date.now() - STALLED_OUT_QUIET_MS - 1_000)
    });

    created[0]!.emitFailed(stalledOutJob(), new Error(STALLED_OUT_FAILED_REASON));
    await lanes.close();

    expect(mocks.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "gj-1" } }));
    const [job, error] = mocks.markFailed.mock.calls[0]!;
    expect(job.name).toBe("generate-book");
    expect(job.data).toMatchObject({ generationJobId: "gj-1", projectId: "project-1", planId: "plan-1" });
    expect((error as Error).message).toBe(STALLED_OUT_DELIVERY_ERROR);
  });

  it("leaves an ordinary processor failure alone: the processor already settled it", async () => {
    const settle = vi.fn(async () => true);
    const { created, lanes } = start(settle);
    created[0]!.emitFailed({ id: "gj-1", name: "generate-book", data: { generationJobId: "gj-1" } }, new Error("provider down"));
    created[1]!.emitFailed(undefined, new Error(STALLED_OUT_FAILED_REASON));
    await lanes.close();
    expect(settle).not.toHaveBeenCalled();
  });

  it("leaves a row whose original delivery is still running in this process to that delivery", async () => {
    const settle = vi.fn(async () => true);
    let release!: () => void;
    const { created, createWorker, lanes } = start(settle, () => new Promise<void>((resolve) => (release = resolve)));
    const longProcessor = createWorker.mock.calls[0]![1] as (job: unknown, token?: string) => Promise<void>;
    const running = longProcessor(
      { id: "gj-1", name: "generate-book", data: { generationJobId: "gj-1" }, moveToDelayed: vi.fn() },
      "a"
    );
    expect(lanes.guard.running().has("gj-1")).toBe(true);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Reclaimed in the other lane while the original runs on, then stalled out there.
    created[1]!.emitFailed(stalledOutJob(), new Error(STALLED_OUT_FAILED_REASON));
    release();
    await running;
    await lanes.close();
    expect(settle).not.toHaveBeenCalled();
  });

  it("waits for a settlement still writing when the lanes close, and survives one that fails", async () => {
    let finish!: () => void;
    const settle = vi
      .fn<NonNullable<Parameters<typeof startLaneWorkers>[0]["settleStalledOut"]>>()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
      .mockRejectedValueOnce(new Error("database down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { created, lanes } = start(settle);
    created[0]!.emitFailed(stalledOutJob("gj-1"), new Error(STALLED_OUT_FAILED_REASON));
    created[1]!.emitFailed(stalledOutJob("gj-2"), new Error(STALLED_OUT_FAILED_REASON));
    let closed = false;
    const closing = lanes.close().then(() => (closed = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(settle).toHaveBeenCalledTimes(2);
  });
});

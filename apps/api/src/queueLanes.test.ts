import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queues: new Map<string, { add: ReturnType<typeof vi.fn>; getJob: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; opts: Record<string, unknown> }>(),
  findUnique: vi.fn(),
  update: vi.fn()
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add = vi.fn();
    getJob = vi.fn();
    close = vi.fn(async () => undefined);
    constructor(name: string, opts: Record<string, unknown>) {
      mocks.queues.set(name, { add: this.add, getJob: this.getJob, close: this.close, opts });
    }
  }
}));
vi.mock("ioredis", () => ({ Redis: class { disconnect = vi.fn(); } }));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return { ...actual, loadConfig: () => ({ REDIS_URL: "redis://test" }) };
});
vi.mock("@book-maker/db", () => ({
  Prisma: { JsonNull: null },
  PAGE_RESTRUCTURE_TRANSACTION_OPTIONS: {},
  prisma: { generationJob: { findUnique: mocks.findUnique, update: mocks.update } }
}));
vi.mock("@book-maker/db/billing", () => ({
  recordUserStopSettlementTx: vi.fn(),
  failGenerationAttempt: vi.fn(),
  GenerationAttemptJobClaimError: class extends Error {}
}));

import { GENERATION_JOB_RETENTION } from "@book-maker/core";
import { closeQueue, dispatchGenerationJob, isBullJobActive } from "./queue.js";

const long = () => mocks.queues.get("book-maker")!;
const interactive = () => mocks.queues.get("book-maker-interactive")!;

function row(type: string, payload: Record<string, unknown> = {}) {
  return { id: "gj-1", projectId: "project-1", attemptId: null, type, status: "QUEUED", bullJobId: null, dispatchAttempts: 0, payload };
}

beforeEach(() => {
  for (const queue of mocks.queues.values()) {
    queue.add.mockReset();
    queue.getJob.mockReset();
    queue.add.mockImplementation(async (_n: string, _d: unknown, opts: { jobId: string }) => ({ id: opts.jobId }));
    queue.getJob.mockResolvedValue(undefined);
  }
  mocks.update.mockReset();
  mocks.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...data }));
});

describe("the API's enqueue side of the lanes", () => {
  it("builds both lane queues with the shared retention on every job", () => {
    expect([...mocks.queues.keys()].sort()).toEqual(["book-maker", "book-maker-interactive"]);
    for (const queue of mocks.queues.values()) {
      expect(queue.opts.defaultJobOptions).toEqual(GENERATION_JOB_RETENTION);
    }
  });

  it("sends a plan to the interactive lane and a book run to the long lane as a start", async () => {
    mocks.findUnique.mockResolvedValueOnce(row("PLAN_BOOK", { input: {} }));
    await dispatchGenerationJob("gj-1");
    expect(interactive().add).toHaveBeenCalledWith("plan-book", expect.anything(), expect.objectContaining({ jobId: "gj-1" }));
    expect(long().add).not.toHaveBeenCalled();

    mocks.findUnique.mockResolvedValueOnce(row("GENERATE_BOOK", { planId: "plan-1" }));
    await dispatchGenerationJob("gj-1");
    expect(long().add).toHaveBeenCalledWith("generate-book", expect.anything(), expect.objectContaining({ jobId: "gj-1", priority: 1 }));
  });

  it("sends a whole-book edit to the long lane as a start, exactly where the worker's re-push puts it", async () => {
    const wholeBook = Array.from({ length: 120 }, (_, index) => index + 1);
    mocks.findUnique.mockResolvedValueOnce(row("APPLY_BOOK_EDIT", { operationId: "op-1", affectedPageIndexes: wholeBook }));
    await dispatchGenerationJob("gj-1");
    expect(interactive().add).not.toHaveBeenCalled();
    expect(long().add).toHaveBeenCalledWith(
      "apply-book-edit",
      expect.objectContaining({ affectedPageIndexes: wholeBook }),
      expect.objectContaining({ jobId: "gj-1", priority: 1 })
    );

    mocks.findUnique.mockResolvedValueOnce(row("APPLY_BOOK_EDIT", { operationId: "op-2", affectedPageIndexes: wholeBook, mode: "exact" }));
    await dispatchGenerationJob("gj-1");
    expect(interactive().add).toHaveBeenCalledWith("apply-book-edit", expect.anything(), expect.objectContaining({ jobId: "gj-1" }));
  });

  it("defers rather than adds while the row's previous delivery is live in the other lane", async () => {
    mocks.findUnique.mockResolvedValueOnce(row("APPLY_BOOK_EDIT", { operationId: "op-1" }));
    long().getJob.mockResolvedValue({ getState: async () => "active", remove: vi.fn() });
    await dispatchGenerationJob("gj-1");
    expect(interactive().add).not.toHaveBeenCalled();
    expect(mocks.update.mock.calls[0]![0].data).toMatchObject({ dispatchAttempts: 1, message: "Waiting for the generation queue" });
  });

  it("answers active for a job running in either lane, and closes both", async () => {
    interactive().getJob.mockResolvedValue({ getState: async () => "active", remove: vi.fn() });
    await expect(isBullJobActive("gj-1")).resolves.toBe(true);
    interactive().getJob.mockResolvedValue(undefined);
    // A job retention removed reads as not running.
    await expect(isBullJobActive("gj-1")).resolves.toBe(false);
    await closeQueue();
    expect(long().close).toHaveBeenCalled();
    expect(interactive().close).toHaveBeenCalled();
  });
});

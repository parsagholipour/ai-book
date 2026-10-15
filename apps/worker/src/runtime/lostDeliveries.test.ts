import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  getJob: vi.fn(),
  markFailed: vi.fn(),
  markMalformedJobFailed: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  prisma: { generationJob: { findMany: mocks.findMany, findUnique: mocks.findUnique, updateMany: mocks.updateMany } }
}));
vi.mock("./jobLifecycle.js", () => ({
  markFailed: mocks.markFailed,
  markMalformedJobFailed: mocks.markMalformedJobFailed
}));

import { laneJobForSweep } from "@book-maker/core";
import {
  LOST_DELIVERY_ERROR,
  LOST_DELIVERY_GRACE_MS,
  STALLED_OUT_DELIVERY_ERROR,
  STALLED_OUT_FAILED_REASON,
  isStalledOutFailure,
  reconcileLostQueueDeliveries,
  settleStalledOutDelivery,
  type LostDeliverySweepCursor
} from "./lostDeliveries.js";

const NOW = Date.parse("2026-10-01T04:00:00Z");
const updatedAt = new Date(NOW - LOST_DELIVERY_GRACE_MS - 1);

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    type: "GENERATE_BOOK",
    status: "ACTIVE",
    projectId: "project-1",
    attemptId: null,
    payload: { planId: "plan-1" },
    bullJobId: "14",
    updatedAt,
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe("reconcileLostQueueDeliveries", () => {
  it("fails an open row whose Bull job Redis no longer has, through markFailed", async () => {
    mocks.findMany.mockResolvedValue([row()]);
    mocks.getJob.mockResolvedValue(undefined);

    await expect(reconcileLostQueueDeliveries({ getJob: mocks.getJob }, 20, NOW)).resolves.toBe(1);

    const where = mocks.findMany.mock.calls[0]![0].where;
    expect(where.status).toEqual({ in: ["QUEUED", "ACTIVE"] });
    expect(where.updatedAt).toEqual({ lt: new Date(NOW - LOST_DELIVERY_GRACE_MS) });
    // The claim names the row exactly as it was read.
    expect(mocks.updateMany.mock.calls[0]![0].where).toEqual({
      id: "job-1",
      status: "ACTIVE",
      bullJobId: "14",
      updatedAt
    });
    const [job, error] = mocks.markFailed.mock.calls[0]!;
    expect(job.name).toBe("generate-book");
    expect(job.data).toMatchObject({ planId: "plan-1", projectId: "project-1", generationJobId: "job-1" });
    expect((error as Error).message).toBe(LOST_DELIVERY_ERROR);
  });

  it("fails a row whose Bull job BullMQ failed for stalling, which never reaches the processor", async () => {
    mocks.findMany.mockResolvedValue([row()]);
    mocks.getJob.mockResolvedValue({ getState: async () => "failed", failedReason: "job stalled more than allowable limit" });

    await expect(reconcileLostQueueDeliveries({ getJob: mocks.getJob }, 20, NOW)).resolves.toBe(1);
    expect(mocks.markFailed).toHaveBeenCalledOnce();
  });

  it.each(["active", "waiting", "delayed", "prioritized", "waiting-children", "completed"])(
    "leaves a row alone while its Bull job is %s",
    async (state) => {
      mocks.findMany.mockResolvedValue([row()]);
      mocks.getJob.mockResolvedValue({ getState: async () => state });

      await expect(reconcileLostQueueDeliveries({ getJob: mocks.getJob }, 20, NOW)).resolves.toBe(0);
      expect(mocks.updateMany).not.toHaveBeenCalled();
      expect(mocks.markFailed).not.toHaveBeenCalled();
    }
  );

  it("settles nothing when the row moved after it was read", async () => {
    mocks.findMany.mockResolvedValue([row()]);
    mocks.getJob.mockResolvedValue(undefined);
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(reconcileLostQueueDeliveries({ getJob: mocks.getJob }, 20, NOW)).resolves.toBe(0);
    expect(mocks.markFailed).not.toHaveBeenCalled();
  });

  it("settles a payload the current schema refuses as the processor settles a malformed one", async () => {
    mocks.findMany.mockResolvedValue([row({ payload: { planId: 42 } })]);
    mocks.getJob.mockResolvedValue(undefined);

    await expect(reconcileLostQueueDeliveries({ getJob: mocks.getJob }, 20, NOW)).resolves.toBe(1);
    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(mocks.markMalformedJobFailed).toHaveBeenCalledOnce();
  });

  it("reads every lane, as index.ts wires it: a live copy in either is not lost, retention's removal is", async () => {
    const lane = (state: string | null) => ({
      getJob: vi.fn(async () => (state ? { getState: async () => state, remove: vi.fn(async () => undefined) } : undefined))
    });
    mocks.findMany.mockResolvedValue([row({ type: "APPLY_BOOK_EDIT", payload: { planId: "plan-1", operationId: "op-1" } })]);
    // A finished copy in the old queue, the live one in the interactive lane.
    const lanes = [lane("completed"), lane("waiting")];
    await expect(reconcileLostQueueDeliveries({ getJob: (id) => laneJobForSweep(lanes, id) }, 20, NOW)).resolves.toBe(0);
    expect(mocks.updateMany).not.toHaveBeenCalled();

    // Removed by retention from both lanes reads as missing, the same as a failed job.
    const gone = [lane(null), lane(null)];
    await expect(reconcileLostQueueDeliveries({ getJob: (id) => laneJobForSweep(gone, id) }, 20, NOW)).resolves.toBe(1);
  });

  it("keeps sweeping past a row it cannot read", async () => {
    mocks.findMany.mockResolvedValue([row({ id: "job-1" }), row({ id: "job-2", bullJobId: "24" })]);
    mocks.getJob.mockRejectedValueOnce(new Error("Redis is down")).mockResolvedValueOnce(undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(reconcileLostQueueDeliveries({ getJob: mocks.getJob }, 20, NOW)).resolves.toBe(1);
    expect(mocks.markFailed.mock.calls[0]![0].data.generationJobId).toBe("job-2");
  });
});

describe("the sweep's lap", () => {
  type Row = ReturnType<typeof row>;
  /** `findMany` over a table, honouring the sweep's cutoff, keyset, order and page. */
  function table(rows: Row[]) {
    return (args: {
      where: { updatedAt: { lt: Date }; OR?: Array<{ updatedAt: { gt: Date } } | { updatedAt: Date; id: { gt: string } }> };
      take: number;
    }) => {
      const cursorMatch = (candidate: Row) =>
        !args.where.OR ||
        args.where.OR.some((clause) =>
          "id" in clause
            ? candidate.updatedAt.getTime() === clause.updatedAt.getTime() && candidate.id > clause.id.gt
            : candidate.updatedAt.getTime() > clause.updatedAt.gt.getTime()
        );
      return Promise.resolve(
        rows
          .filter((candidate) => candidate.updatedAt < args.where.updatedAt.lt && cursorMatch(candidate))
          .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id))
          .slice(0, args.take)
      );
    };
  }

  it("reaches a lost row behind a page of rows that are legitimately still waiting", async () => {
    const waiting = ["w-1", "w-2", "w-3"].map((id, index) =>
      row({ id, bullJobId: id, updatedAt: new Date(updatedAt.getTime() - 60_000 + index) })
    );
    // Same `updatedAt` as the last waiting row: the tie is broken by id, never skipped.
    const lost = row({ id: "x-lost", bullJobId: "lost", updatedAt: waiting[2]!.updatedAt });
    mocks.findMany.mockImplementation(table([...waiting, lost]));
    const bull = {
      getJob: vi.fn(async (id: string) => (id === "lost" ? undefined : { getState: async () => "waiting" }))
    };
    const cursor: LostDeliverySweepCursor = { after: null };

    // Every sweep reads at most two rows. Before the lap, the first two were
    // all it ever read, for as long as they waited.
    await expect(reconcileLostQueueDeliveries(bull, 2, NOW, cursor)).resolves.toBe(0);
    expect(cursor.after).toEqual({ updatedAt: waiting[1]!.updatedAt, id: "w-2" });
    await expect(reconcileLostQueueDeliveries(bull, 2, NOW, cursor)).resolves.toBe(1);
    expect(mocks.markFailed.mock.calls[0]![0].data.generationJobId).toBe("x-lost");
    expect(bull.getJob.mock.calls.map(([id]) => id)).toEqual(["w-1", "w-2", "w-3", "lost"]);
  });

  it("starts the next lap from the oldest row after a short page", async () => {
    mocks.findMany.mockImplementation(table([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })]));
    mocks.getJob.mockResolvedValue({ getState: async () => "waiting" });
    const cursor: LostDeliverySweepCursor = { after: null };

    await reconcileLostQueueDeliveries({ getJob: mocks.getJob }, 2, NOW, cursor);
    await reconcileLostQueueDeliveries({ getJob: mocks.getJob }, 2, NOW, cursor);
    expect(cursor.after).toBeNull();
    await reconcileLostQueueDeliveries({ getJob: mocks.getJob }, 2, NOW, cursor);
    expect(mocks.findMany.mock.calls[2]![0].where.OR).toBeUndefined();
    expect(mocks.findMany.mock.calls[2]![0].take).toBe(2);
  });
});

describe("settleStalledOutDelivery", () => {
  const QUIET_MS = 60_000;
  const job = { id: "14", data: { generationJobId: "job-1" }, deferredFailure: STALLED_OUT_FAILED_REASON };

  it("recognises BullMQ's stall failure by the job's mark or the error it raised", () => {
    expect(isStalledOutFailure(job, undefined)).toBe(true);
    expect(isStalledOutFailure({ id: "14", data: {} }, new Error(STALLED_OUT_FAILED_REASON))).toBe(true);
    expect(isStalledOutFailure({ id: "14", data: {} }, new Error("provider down"))).toBe(false);
  });

  it("fails a silent open row that still names the stalled Bull job, through markFailed", async () => {
    const quietSince = new Date(NOW - QUIET_MS - 1);
    mocks.findUnique.mockResolvedValue(row({ updatedAt: quietSince }));

    await expect(settleStalledOutDelivery(job, { quietMs: QUIET_MS, now: NOW })).resolves.toBe(true);
    expect(mocks.updateMany.mock.calls[0]![0].where).toEqual({ id: "job-1", status: "ACTIVE", bullJobId: "14", updatedAt: quietSince });
    const [failedJob, error] = mocks.markFailed.mock.calls[0]!;
    expect(failedJob.data).toMatchObject({ planId: "plan-1", projectId: "project-1", generationJobId: "job-1" });
    expect((error as Error).message).toBe(STALLED_OUT_DELIVERY_ERROR);
  });

  it.each([
    ["was written within the quiet window", { updatedAt: new Date(NOW - QUIET_MS + 1_000) }],
    ["already holds a verdict", { status: "COMPLETED" }],
    ["was requeued under another Bull job", { bullJobId: "15" }]
  ])("leaves a row alone that %s", async (_case, overrides) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.findUnique.mockResolvedValue(row({ updatedAt: new Date(NOW - LOST_DELIVERY_GRACE_MS), ...overrides }));

    await expect(settleStalledOutDelivery(job, { quietMs: QUIET_MS, now: NOW })).resolves.toBe(false);
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.markFailed).not.toHaveBeenCalled();
  });

  it("settles nothing when the row moved between the read and the claim", async () => {
    mocks.findUnique.mockResolvedValue(row());
    mocks.updateMany.mockResolvedValue({ count: 0 });
    await expect(settleStalledOutDelivery(job, { quietMs: QUIET_MS, now: NOW })).resolves.toBe(false);
    expect(mocks.markFailed).not.toHaveBeenCalled();
  });
});

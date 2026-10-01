import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  getJob: vi.fn(),
  markFailed: vi.fn(),
  markMalformedJobFailed: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  prisma: { generationJob: { findMany: mocks.findMany, updateMany: mocks.updateMany } }
}));
vi.mock("./jobLifecycle.js", () => ({
  markFailed: mocks.markFailed,
  markMalformedJobFailed: mocks.markMalformedJobFailed
}));

import { LOST_DELIVERY_ERROR, LOST_DELIVERY_GRACE_MS, reconcileLostQueueDeliveries } from "./lostDeliveries.js";

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

  it("keeps sweeping past a row it cannot read", async () => {
    mocks.findMany.mockResolvedValue([row({ id: "job-1" }), row({ id: "job-2", bullJobId: "24" })]);
    mocks.getJob.mockRejectedValueOnce(new Error("Redis is down")).mockResolvedValueOnce(undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(reconcileLostQueueDeliveries({ getJob: mocks.getJob }, 20, NOW)).resolves.toBe(1);
    expect(mocks.markFailed.mock.calls[0]![0].data.generationJobId).toBe("job-2");
  });
});

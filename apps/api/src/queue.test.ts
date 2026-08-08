import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn()
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add = mocks.add;
    getJob = vi.fn();
    close = vi.fn();
  }
}));

vi.mock("ioredis", () => ({
  Redis: class {
    quit = vi.fn();
  }
}));

vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return { ...actual, loadConfig: () => ({ REDIS_URL: "redis://test" }) };
});
vi.mock("@book-maker/db", () => ({
  Prisma: { JsonNull: null },
  prisma: {
    generationJob: {
      findUnique: mocks.findUnique,
      findMany: mocks.findMany,
      create: mocks.create,
      update: mocks.update
    }
  }
}));
vi.mock("@book-maker/db/billing", () => ({ refundLatestProjectOperationCredits: vi.fn() }));

import { dispatchGenerationJob, reconcileUndispatchedGenerationJobs } from "./queue.js";

describe("durable generation outbox", () => {
  const durableJob = {
    id: "job-durable-1",
    projectId: "project-1",
    type: "PLAN_BOOK",
    status: "QUEUED",
    payload: { planId: "plan-1" },
    bullJobId: null,
    dispatchAttempts: 0
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue(durableJob);
    mocks.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...durableJob, ...data }));
  });

  it("keeps Redis failures durable and reconciles with the database job ID", async () => {
    mocks.add.mockRejectedValueOnce(new Error("Redis unavailable"));

    const waiting = await dispatchGenerationJob(durableJob.id);

    expect(waiting).toMatchObject({ status: "QUEUED", dispatchAttempts: 1, message: "Waiting for the generation queue" });
    const failedDispatchUpdate = mocks.update.mock.calls[0]![0].data;
    expect(failedDispatchUpdate.nextDispatchAt).toBeInstanceOf(Date);
    expect((failedDispatchUpdate.nextDispatchAt as Date).getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60_000);

    mocks.findMany.mockResolvedValue([{ id: durableJob.id }]);
    mocks.add.mockResolvedValue({ id: durableJob.id });
    await reconcileUndispatchedGenerationJobs();

    expect(mocks.add).toHaveBeenLastCalledWith(
      "plan-book",
      expect.objectContaining({ projectId: "project-1", generationJobId: durableJob.id }),
      expect.objectContaining({ jobId: durableJob.id })
    );
  });

  it("dispatches generate-book with an automatic retry budget for network recovery", async () => {
    mocks.findUnique.mockResolvedValue({ ...durableJob, type: "GENERATE_BOOK" });
    mocks.add.mockResolvedValue({ id: durableJob.id });

    await dispatchGenerationJob(durableJob.id);

    expect(mocks.add).toHaveBeenCalledWith(
      "generate-book",
      expect.anything(),
      expect.objectContaining({ attempts: 2, backoff: expect.objectContaining({ type: "exponential" }) })
    );
  });

  it("dispatches one-shot job types without retry options", async () => {
    mocks.findUnique.mockResolvedValue({ ...durableJob, type: "COMPILE_EXPORT" });
    mocks.add.mockResolvedValue({ id: durableJob.id });

    await dispatchGenerationJob(durableJob.id);

    const options = mocks.add.mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(options.attempts).toBeUndefined();
  });
});

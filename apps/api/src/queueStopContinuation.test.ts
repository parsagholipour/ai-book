import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  projectUpdate: vi.fn(),
  projectUpdateMany: vi.fn(),
  generationJobFindMany: vi.fn(),
  generationJobUpdateMany: vi.fn(),
  operationFindMany: vi.fn(),
  operationUpdateMany: vi.fn(),
  failGenerationAttempt: vi.fn(),
  refundCreditLedgerEntry: vi.fn(),
  refundLatestProjectOperationCredits: vi.fn()
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add = vi.fn();
    getJob = vi.fn();
    close = vi.fn();
  }
}));
vi.mock("ioredis", () => ({ Redis: class { disconnect = vi.fn(); } }));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return { ...actual, loadConfig: () => ({ REDIS_URL: "redis://test" }) };
});
vi.mock("@book-maker/db", () => ({
  Prisma: { JsonNull: null, PrismaClientKnownRequestError: class extends Error {} },
  prisma: {
    $transaction: mocks.transaction,
    generationJob: { findMany: mocks.generationJobFindMany },
    bookEditOperation: { findUnique: vi.fn() },
    audiobook: { updateMany: vi.fn() }
  }
}));
vi.mock("@book-maker/db/billing", () => ({
  failGenerationAttempt: mocks.failGenerationAttempt,
  refundCreditLedgerEntry: mocks.refundCreditLedgerEntry,
  refundLatestProjectOperationCredits: mocks.refundLatestProjectOperationCredits
}));

import { PRE_EDIT_PROJECT_STATUS } from "@book-maker/core";
import { stopProjectGenerationJobs } from "./queue.js";

type DurableContinuation = {
  id: string;
  bullJobId: null;
  status: string;
  type: "CONTINUE_BOOK";
  payload: Record<string, unknown>;
  attemptId: string;
};

function continuation(status: "QUEUED" | "ACTIVE"): DurableContinuation {
  return {
    id: "job-continue",
    bullJobId: null,
    status,
    type: "CONTINUE_BOOK",
    payload: { operationId: "op-continue", [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED" },
    attemptId: "attempt-continue"
  };
}

describe("Stop compensation for continuation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectUpdate.mockResolvedValue({ status: "EDITING" });
    mocks.projectUpdateMany.mockResolvedValue({ count: 1 });
    mocks.generationJobUpdateMany.mockResolvedValue({ count: 1 });
    mocks.operationFindMany.mockResolvedValue([]);
    mocks.operationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.failGenerationAttempt.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        project: { update: mocks.projectUpdate, updateMany: mocks.projectUpdateMany },
        generationJob: {
          findMany: mocks.generationJobFindMany,
          updateMany: mocks.generationJobUpdateMany
        },
        bookEditOperation: { findMany: mocks.operationFindMany, updateMany: mocks.operationUpdateMany }
      })
    );
  });

  it("restores a queued continuation before the worker can mutate the book", async () => {
    mocks.generationJobFindMany.mockResolvedValue([continuation("QUEUED")]);

    await stopProjectGenerationJobs("project-1");

    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "REVIEW_REQUIRED" }
    });
  });

  it.each(["after installing the extended plan", "after drafting only some appended pages"])(
    "keeps a stopped continuation failed %s",
    async () => {
      // Both phases are deliberately indistinguishable to the API: ACTIVE is
      // the durable fact that append mutations may already be committed.
      mocks.generationJobFindMany.mockResolvedValue([continuation("ACTIVE")]);

      await stopProjectGenerationJobs("project-1");

      expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
        where: { id: "project-1", status: { notIn: ["COMPLETE", "REVIEW_REQUIRED"] } },
        data: { status: "FAILED" }
      });
      expect(mocks.failGenerationAttempt).toHaveBeenCalledWith(
        "attempt-continue",
        "Stopped by user",
        "CANCELED"
      );
    }
  );

  it("keeps repeated Stop idempotent after failing an active continuation", async () => {
    const durableJob = continuation("ACTIVE");
    let projectStatus = "EDITING";
    mocks.projectUpdate.mockImplementation(async () => ({ status: projectStatus }));
    mocks.projectUpdateMany.mockImplementation(
      async ({ where, data }: { where: { status?: string | { notIn: string[] } }; data: { status: string } }) => {
        const matches =
          typeof where.status === "string"
            ? projectStatus === where.status
            : where.status
              ? !where.status.notIn.includes(projectStatus)
              : true;
        if (matches) projectStatus = data.status;
        return { count: matches ? 1 : 0 };
      }
    );
    mocks.generationJobFindMany.mockImplementation(async () =>
      durableJob.status === "ACTIVE" || durableJob.status === "QUEUED" ? [durableJob] : []
    );
    mocks.generationJobUpdateMany.mockImplementation(
      async ({ data }: { data: { status?: string } }) => {
        const open = durableJob.status === "ACTIVE" || durableJob.status === "QUEUED";
        if (open && data.status) durableJob.status = data.status;
        return { count: open ? 1 : 0 };
      }
    );

    const first = await stopProjectGenerationJobs("project-1");
    const repeated = await stopProjectGenerationJobs("project-1");

    expect([first.stoppedJobs, repeated.stoppedJobs]).toEqual([1, 0]);
    expect(projectStatus).toBe("FAILED");
    expect(durableJob.status).toBe("FAILED");
    expect(mocks.failGenerationAttempt.mock.calls).toEqual([
      ["attempt-continue", "Stopped by user", "CANCELED"]
    ]);
  });
});

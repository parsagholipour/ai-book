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

describe("Stop racing an applied edit handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectUpdate.mockResolvedValue({ status: "EDITING" });
    mocks.operationUpdateMany.mockResolvedValue({ count: 0 });
    mocks.failGenerationAttempt.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        project: { update: mocks.projectUpdate, updateMany: mocks.projectUpdateMany },
        generationJob: { findMany: mocks.generationJobFindMany, updateMany: mocks.generationJobUpdateMany },
        bookEditOperation: { findMany: mocks.operationFindMany, updateMany: mocks.operationUpdateMany }
      })
    );
  });

  it.each([
    {
      linkage: "Apply's durable relation",
      job: { id: "job-apply", type: "APPLY_BOOK_EDIT", payload: { [PRE_EDIT_PROJECT_STATUS]: "COMPLETE" } },
      operation: { id: "op-apply", generationJobId: "job-apply", status: "APPLIED" }
    },
    {
      linkage: "Continue's legacy payload",
      job: {
        id: "job-continue",
        type: "CONTINUE_BOOK",
        payload: { operationId: "op-continue", [PRE_EDIT_PROJECT_STATUS]: "REVIEW_REQUIRED" }
      },
      operation: { id: "op-continue", generationJobId: null, status: "APPLIED" }
    }
  ])("preserves $linkage across repeated Stop", async ({ job, operation }) => {
    const row = { ...job, bullJobId: null, status: "ACTIVE", attemptId: "attempt-applied" };
    mocks.generationJobFindMany.mockImplementation(async () => [row]);
    mocks.generationJobUpdateMany.mockImplementation(async ({ data }: { data: { status?: string } }) => {
      if (data.status) row.status = data.status;
      return { count: row.status === "ACTIVE" || data.status === "FAILED" ? 1 : 0 };
    });
    mocks.operationFindMany.mockResolvedValue([operation]);

    const first = await stopProjectGenerationJobs("project-1");
    const repeated = await stopProjectGenerationJobs("project-1");

    expect([first.stoppedJobs, repeated.stoppedJobs]).toEqual([0, 0]);
    expect(row.status).toBe("ACTIVE");
    expect(mocks.projectUpdateMany).not.toHaveBeenCalled();
    expect(mocks.failGenerationAttempt).not.toHaveBeenCalled();
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
    expect(mocks.refundLatestProjectOperationCredits).not.toHaveBeenCalled();
  });
});

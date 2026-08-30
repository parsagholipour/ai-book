import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  projectUpdate: vi.fn(),
  projectUpdateMany: vi.fn(),
  generationJobFindMany: vi.fn(),
  generationJobUpdateMany: vi.fn(),
  operationFindMany: vi.fn(),
  operationUpdateMany: vi.fn(),
  compensate: vi.fn(),
  executeRawUnsafe: vi.fn(),
  queryRawUnsafe: vi.fn(),
  failAttempt: vi.fn(),
  generationAttemptUpdateMany: vi.fn(),
  refundEntry: vi.fn(),
  refundLatest: vi.fn()
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
  PAGE_RESTRUCTURE_TRANSACTION_OPTIONS: { timeout: 30_000, maxWait: 10_000 },
  compensateStructuralPageChangeTx: mocks.compensate,
  prisma: {
    $transaction: mocks.transaction,
    generationJob: { findMany: vi.fn() },
    bookEditOperation: { findUnique: vi.fn() },
    audiobook: { updateMany: vi.fn() }
  }
}));
vi.mock("@book-maker/db/billing", () => ({
  failGenerationAttempt: mocks.failAttempt,
  refundCreditLedgerEntry: mocks.refundEntry,
  refundLatestProjectOperationCredits: mocks.refundLatest,
  GenerationAttemptJobClaimError: class extends Error {}
}));

import { PRE_EDIT_PROJECT_STATUS } from "@book-maker/core";
import { stopProjectGenerationJobs } from "./queue.js";

const structuralJob = {
  id: "job-structural",
  bullJobId: null,
  status: "ACTIVE",
  type: "APPLY_BOOK_EDIT",
  payload: { operationId: "op-structural", [PRE_EDIT_PROJECT_STATUS]: "COMPLETE" },
  attemptId: "attempt-structural"
};
const classifier = {
  structuralApplication: {
    action: "insert",
    pageOrderBefore: [{ pageId: "page-1", index: 1 }],
    insertedPageIds: ["placeholder-1"],
    removedPages: [],
    basePlanVersionId: "plan-1",
    newPlanVersionId: "plan-2",
    previousTargetPages: 1,
    previousChapterTargetPages: {},
    baseContentRevision: 7,
    appliedAt: "2026-08-29T00:00:00.000Z"
  }
};

describe("Stop compensation for an applied structural shift", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectUpdate.mockResolvedValue({ status: "EDITING", contentRevision: 8 });
    mocks.projectUpdateMany.mockResolvedValue({ count: 1 });
    mocks.generationJobUpdateMany.mockResolvedValue({ count: 1 });
    mocks.operationUpdateMany.mockResolvedValue({ count: 1 });
    // Keyed on the query rather than on call order: `mockResolvedValueOnce`
    // queues survive `clearAllMocks`, so a per-call chain leaks between tests.
    mocks.operationFindMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.kind === "RESTRUCTURE_PAGES"
        ? [{ id: "op-structural", generationJobId: "job-structural", status: "ACTIVE", classifier }]
        : []
    );
    mocks.compensate.mockResolvedValue({ outcome: "compensated", currentPlanId: "plan-1" });
    mocks.failAttempt.mockResolvedValue(undefined);
    mocks.queryRawUnsafe.mockResolvedValue([]);
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        project: { update: mocks.projectUpdate, updateMany: mocks.projectUpdateMany },
        generationJob: { findMany: mocks.generationJobFindMany, updateMany: mocks.generationJobUpdateMany },
        bookEditOperation: { findMany: mocks.operationFindMany, updateMany: mocks.operationUpdateMany },
        generationAttempt: { updateMany: mocks.generationAttemptUpdateMany },
        $executeRawUnsafe: mocks.executeRawUnsafe,
        $queryRawUnsafe: mocks.queryRawUnsafe
      })
    );
  });

  it("opens the stop transaction on the shared manuscript budget", async () => {
    // The revert below runs inside the stop's own transaction: page restores,
    // the two-pass renumber over every page, and two plan writes. That is what
    // every other caller of the shared compensation primitive already buys this
    // budget for. On Prisma's 5 s default a large book hits P2028 and the whole
    // stop rolls back — no job terminalized, no operation canceled, nothing
    // refunded — and `POST /api/projects/:id/stop` reproduces it on every retry.
    mocks.generationJobFindMany.mockResolvedValue([structuralJob]);

    await stopProjectGenerationJobs("project-1");

    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 30_000,
      maxWait: 10_000
    });
  });

  it("compensates before cancellation/refund and repeated Stop is idempotent", async () => {
    const order: string[] = [];
    mocks.generationJobFindMany.mockResolvedValueOnce([structuralJob]).mockResolvedValue([]);
    mocks.compensate.mockImplementation(async () => {
      order.push("compensate");
      return { outcome: "compensated", currentPlanId: "plan-1" };
    });
    mocks.operationUpdateMany.mockImplementation(async () => {
      order.push("cancel");
      return { count: 1 };
    });
    mocks.failAttempt.mockImplementation(async () => {
      order.push("refund");
    });

    const first = await stopProjectGenerationJobs("project-1");
    const repeated = await stopProjectGenerationJobs("project-1");

    expect([first.stoppedJobs, repeated.stoppedJobs]).toEqual([1, 0]);
    expect(mocks.compensate).toHaveBeenCalledOnce();
    expect(mocks.compensate).toHaveBeenCalledWith(expect.anything(), {
      projectId: "project-1",
      operationId: "op-structural",
      expectedAppliedAt: "2026-08-29T00:00:00.000Z"
    });
    expect(order).toEqual(["compensate", "cancel", "refund"]);
  });

  // `superseded` means a newer manuscript revision moved past the stamp;
  // `lost` means the locked read could not prove ownership of this exact row,
  // lease and stamp. Both leave the shift standing, so Stop must preserve the
  // operation and job for the durable delivery rather than clearing the only
  // recovery record and refunding work it did not unwind.
  it.each(["superseded", "lost"])("stands down without canceling or refunding a %s shift", async (outcome) => {
    mocks.generationJobFindMany.mockResolvedValue([structuralJob]);
    mocks.compensate.mockResolvedValue({ outcome });

    const result = await stopProjectGenerationJobs("project-1");

    expect(result.stoppedJobs).toBe(0);
    expect(mocks.generationJobUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) })
    );
    expect(mocks.operationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { notIn: ["op-structural"] } })
      })
    );
    expect(mocks.generationAttemptUpdateMany).not.toHaveBeenCalled();
    expect(mocks.failAttempt).not.toHaveBeenCalled();
    expect(mocks.refundEntry).not.toHaveBeenCalled();
    expect(mocks.refundLatest).not.toHaveBeenCalled();
    expect(mocks.projectUpdateMany).not.toHaveBeenCalled();
  });

  // A refusal is not an outcome the primitive returns — `revertStructuralPageChange`
  // *throws* for a snapshot archive whose rows do not match the count the stamp
  // recorded, a plan lineage it does not recognise, or an embedding re-point
  // that would collide — and inside the stop's one transaction that throw took
  // every other row down with it: no job terminalized, no operation canceled,
  // nothing refunded, and `POST /:id/stop` reproducing it on every retry,
  // because the refusal is a fact about the stored stamp rather than a
  // transient. It stands down like `lost` instead, on a savepoint, because those
  // refusals are not all raised before the first write and a bare catch would
  // commit a half-reverted book.
  it("stands down without canceling or refunding a shift the revert refuses", async () => {
    mocks.generationJobFindMany.mockResolvedValue([structuralJob]);
    mocks.compensate.mockRejectedValue(
      new Error("Structural snapshot archive stop-1 expected 3 rows, found 2")
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await stopProjectGenerationJobs("project-1");

    expect(result.stoppedJobs).toBe(0);
    expect(mocks.executeRawUnsafe.mock.calls.flat()).toEqual([
      'SAVEPOINT "stop_structural_compensation"',
      'ROLLBACK TO SAVEPOINT "stop_structural_compensation"',
      'RELEASE SAVEPOINT "stop_structural_compensation"'
    ]);
    expect(mocks.generationJobUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) })
    );
    expect(mocks.operationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { notIn: ["op-structural"] } }) })
    );
    expect(mocks.generationAttemptUpdateMany).not.toHaveBeenCalled();
    expect(mocks.failAttempt).not.toHaveBeenCalled();
    expect(mocks.refundEntry).not.toHaveBeenCalled();
    expect(mocks.refundLatest).not.toHaveBeenCalled();
    expect(mocks.projectUpdateMany).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("releases the savepoint a compensation it completed was taken on", async () => {
    mocks.generationJobFindMany.mockResolvedValue([structuralJob]);

    await stopProjectGenerationJobs("project-1");

    expect(mocks.executeRawUnsafe.mock.calls.flat()).toEqual([
      'SAVEPOINT "stop_structural_compensation"',
      'RELEASE SAVEPOINT "stop_structural_compensation"'
    ]);
  });

  it("leaves a published shift, its job and its project to the delivery that won", async () => {
    mocks.generationJobFindMany.mockResolvedValue([structuralJob]);
    mocks.compensate.mockResolvedValue({ outcome: "published" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await stopProjectGenerationJobs("project-1");

    expect(result.stoppedJobs).toBe(0);
    expect(mocks.operationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { notIn: ["op-structural"] } }) })
    );
    expect(mocks.projectUpdateMany).not.toHaveBeenCalled();
    expect(mocks.generationAttemptUpdateMany).not.toHaveBeenCalled();
    expect(mocks.failAttempt).not.toHaveBeenCalled();
    expect(mocks.refundEntry).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });
});

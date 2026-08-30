import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: { $queryRawUnsafe: vi.fn(), $transaction: vi.fn() },
  waitForStructuralPageLease: vi.fn(),
  renewStructuralPageLeaseTx: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: {},
  PAGE_RESTRUCTURE_TRANSACTION_OPTIONS: { timeout: 30_000, maxWait: 10_000 }
}));
vi.mock("../runtime/durableEditCompletion.js", () => ({
  claimDurableEditCompletionTx: vi.fn(async () => true),
  settleDurableEditAttemptTx: vi.fn(async () => true)
}));
vi.mock("./structuralPageLease.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./structuralPageLease.js")>()),
  waitForStructuralPageLease: mocks.waitForStructuralPageLease,
  renewStructuralPageLeaseTx: mocks.renewStructuralPageLeaseTx
}));

import {
  acquireReplanStagingLeaseTx,
  completeReplanEditLease,
  releaseReplanEditTailLease,
  releaseReplanStagingLeaseTx,
  renewReplanStagingLeaseTx,
  startReplanEditLeaseHeartbeat,
  startReplanEditTailLeaseHeartbeat,
  waitForReplanEditLease
} from "./replanEditLease.js";
import { STRUCTURAL_PAGE_LEASE_MS } from "./structuralPageLease.js";

const key = {
  operationId: "operation-1",
  generationJobId: "job-replan",
  ownerToken: "owner-1"
};

const operation = {
  id: "operation-1",
  projectId: "source-project",
  sourceProjectId: "source-project",
  generationJobId: "job-replan",
  status: "ACTIVE",
  request: "make it shorter",
  editInstruction: "Reduce the book to three pages.",
  characterContext: null,
  classifier: {}
};

const tailIdentity = {
  projectId: "target-project",
  operationId: "operation-1",
  planVersionId: "plan-new",
  publicationRevision: 7
};

const tx = () => ({ $queryRawUnsafe: vi.fn() });

describe("replan staging database-time lease", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("uses PostgreSQL time for acquisition and expired-owner takeover despite worker clock skew", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-12-31T23:59:59.000Z"));
    const client = tx();
    client.$queryRawUnsafe.mockResolvedValue([operation]);

    await expect(acquireReplanStagingLeaseTx(client as never, key)).resolves.toEqual(operation);

    const [sql, operationId, generationJobId, ownerToken, ttlMs] = client.$queryRawUnsafe.mock.calls[0]!;
    expect(sql).toContain('"structuralLeaseExpiresAt" <= CURRENT_TIMESTAMP');
    expect(sql).toContain(
      '"structuralLeaseExpiresAt" = CURRENT_TIMESTAMP + ($4::double precision * INTERVAL \'1 millisecond\')'
    );
    expect(sql).toContain('OR "structuralLeaseToken" = $3');
    expect([operationId, generationJobId, ownerToken, ttlMs]).toEqual([
      "operation-1",
      "job-replan",
      "owner-1",
      STRUCTURAL_PAGE_LEASE_MS
    ]);
    expect([operationId, generationJobId, ownerToken, ttlMs].some((value) => value instanceof Date)).toBe(false);
  });

  it("excludes a live rival owner and settled stop/cancel states in the acquisition CAS", async () => {
    const client = tx();
    client.$queryRawUnsafe.mockResolvedValue([]);

    await expect(acquireReplanStagingLeaseTx(client as never, key)).resolves.toBeNull();

    const [sql] = client.$queryRawUnsafe.mock.calls[0]!;
    expect(sql).toContain('"structuralLeaseToken" IS NULL');
    expect(sql).toContain('"structuralLeaseExpiresAt" <= CURRENT_TIMESTAMP');
    expect(sql).toContain('"status" IN (\'QUEUED\', \'ACTIVE\')');
    expect(sql).not.toContain("CANCELED");
    expect(sql).not.toContain("FAILED");
  });

  it("renews only the exact active owner while its lease is live in database time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("1970-01-01T00:00:00.000Z"));
    const client = tx();
    client.$queryRawUnsafe.mockResolvedValue([operation]);

    await expect(renewReplanStagingLeaseTx(client as never, key)).resolves.toEqual(operation);

    const [sql, operationId, generationJobId, ownerToken, ttlMs] = client.$queryRawUnsafe.mock.calls[0]!;
    expect(sql).toContain('"structuralLeaseToken" = $3');
    expect(sql).toContain('"structuralLeaseExpiresAt" > CURRENT_TIMESTAMP');
    expect(sql).toContain(
      '"structuralLeaseExpiresAt" = CURRENT_TIMESTAMP + ($4::double precision * INTERVAL \'1 millisecond\')'
    );
    expect([operationId, generationJobId, ownerToken, ttlMs]).toEqual([
      "operation-1",
      "job-replan",
      "owner-1",
      STRUCTURAL_PAGE_LEASE_MS
    ]);
    expect([operationId, generationJobId, ownerToken, ttlMs].some((value) => value instanceof Date)).toBe(false);
  });

  it("releases only the exact unexpired owner and stamps the write with database time", async () => {
    const client = tx();
    client.$queryRawUnsafe.mockResolvedValue([{ id: "operation-1" }]);

    await expect(releaseReplanStagingLeaseTx(client as never, key)).resolves.toBe(true);

    const [sql, operationId, generationJobId, ownerToken] = client.$queryRawUnsafe.mock.calls[0]!;
    expect(sql).toContain('"structuralLeaseToken" = $3');
    expect(sql).toContain('"structuralLeaseExpiresAt" > CURRENT_TIMESTAMP');
    expect(sql).toContain('"updatedAt" = CURRENT_TIMESTAMP');
    expect([operationId, generationJobId, ownerToken]).toEqual(["operation-1", "job-replan", "owner-1"]);
  });

  it("heartbeats through the shared database-time lease renewal", async () => {
    mocks.prisma.$queryRawUnsafe.mockResolvedValue([
      { structuralLeaseExpiresAt: new Date("2030-01-01T00:03:00.000Z") }
    ]);
    const heartbeat = startReplanEditLeaseHeartbeat("operation-1", "owner-1");

    await expect(heartbeat.assertHeld()).resolves.toBeUndefined();
    await heartbeat.stop();

    const [sql, operationId, ownerToken, ttlMs] = mocks.prisma.$queryRawUnsafe.mock.calls[0]!;
    expect(sql).toContain('"structuralLeaseExpiresAt" > CURRENT_TIMESTAMP');
    expect(sql).toContain(
      '"structuralLeaseExpiresAt" = CURRENT_TIMESTAMP + ($3::double precision * INTERVAL \'1 millisecond\')'
    );
    expect([operationId, ownerToken, ttlMs]).toEqual(["operation-1", "owner-1", STRUCTURAL_PAGE_LEASE_MS]);
  });

  it("heartbeats an APPLIED tail only while its target publication is still the project's", async () => {
    mocks.prisma.$queryRawUnsafe.mockResolvedValue([{ id: "operation-1" }]);
    const heartbeat = startReplanEditTailLeaseHeartbeat(tailIdentity, "owner-1");

    await expect(heartbeat.assertHeld()).resolves.toBeUndefined();
    await heartbeat.stop();

    const [sql, ...params] = mocks.prisma.$queryRawUnsafe.mock.calls[0]!;
    expect(sql).toContain('"publicationRevision" = $4');
    expect(sql).toContain('"Project"."id" = $3');
    expect(sql).toContain('"Project"."currentPlanId" = $5');
    expect(sql).toContain('"Project"."contentRevision" = $4');
    expect(params.slice(0, 5)).toEqual(["operation-1", "owner-1", "target-project", 7, "plan-new"]);
  });

  /**
   * The tail's own last step is what clears EDITING —
   * `checkpointReplanFollowUp(..., "compile", "not-ready")` moves the project to
   * REVIEW_REQUIRED inside that step — and everything after it (the completion
   * write, its fifteen-minute wait, the catch's release) still belongs to this
   * owner. A status fence therefore reported a lease that was never lost and
   * refused to release a token nobody else could clear.
   */
  it.each([
    { label: "renew", run: () => startReplanEditTailLeaseHeartbeat(tailIdentity, "owner-1").assertHeld() },
    { label: "release", run: () => releaseReplanEditTailLease(tailIdentity, "owner-1") }
  ])("does not fence the $label on a status the tail itself takes away", async ({ run }) => {
    mocks.prisma.$queryRawUnsafe.mockResolvedValue([{ id: "operation-1" }]);

    await run();

    expect(mocks.prisma.$queryRawUnsafe.mock.calls[0]![0]).not.toContain("EDITING");
  });

  it("releases on exactly the rows a completion would claim, project status aside", async () => {
    mocks.prisma.$queryRawUnsafe.mockResolvedValue([{ id: "operation-1" }]);

    await expect(releaseReplanEditTailLease(tailIdentity, "owner-1")).resolves.toBe(true);

    const [sql, ...params] = mocks.prisma.$queryRawUnsafe.mock.calls[0]!;
    expect(sql).toContain('"publicationRevision" = $3');
    expect(sql).toContain('"structuralLeaseToken" = $2');
    expect(sql).toContain('"status" = \'APPLIED\'');
    expect(sql).not.toContain('"Project"');
    expect(params).toEqual(["operation-1", "owner-1", 7]);
  });

  it("completes the exact operation revision even when the operation belongs to the source copy", async () => {
    mocks.prisma.$queryRawUnsafe.mockResolvedValue([{ id: "operation-1" }]);

    await expect(completeReplanEditLease(tailIdentity, "owner-1")).resolves.toBe(true);

    const [sql, operationId, ownerToken, publicationRevision] = mocks.prisma.$queryRawUnsafe.mock.calls[0]!;
    expect(sql).toContain('"publicationRevision" = $3');
    expect(sql).not.toContain('"projectId" =');
    expect([operationId, ownerToken, publicationRevision]).toEqual(["operation-1", "owner-1", 7]);
  });
});

describe("claiming a replan publication tail", () => {
  const project = { currentPlanId: "plan-old", contentRevision: 3, status: "COMPLETE" };

  function tailTransaction(options: { operationStatus: string; completedCount: number; project?: typeof project }) {
    const client = {
      project: { update: vi.fn(async () => options.project ?? project) },
      bookEditOperation: {
        updateMany: vi
          .fn()
          .mockResolvedValueOnce({ count: options.completedCount })
          .mockResolvedValue({ count: 1 })
      }
    };
    mocks.waitForStructuralPageLease.mockResolvedValue({
      outcome: "acquired",
      phase: "tail",
      application: null,
      expiresAt: new Date("2030-01-01T00:03:00.000Z")
    });
    mocks.renewStructuralPageLeaseTx.mockResolvedValue({
      classifier: {},
      status: options.operationStatus,
      generationJobId: "job-replan"
    });
    mocks.prisma.$transaction.mockImplementation((run: (tx: unknown) => Promise<unknown>) => run(client));
    return client;
  }

  beforeEach(() => vi.clearAllMocks());

  it("acquires the tail whose exact publication the project still holds", async () => {
    const client = tailTransaction({
      operationStatus: "APPLIED",
      completedCount: 1,
      project: { currentPlanId: "plan-new", contentRevision: 7, status: "EDITING" }
    });

    await expect(waitForReplanEditLease("operation-1", "owner-1", tailIdentity)).resolves.toEqual({
      outcome: "acquired",
      phase: "tail"
    });

    expect(client.bookEditOperation.updateMany).not.toHaveBeenCalled();
  });

  it("stamps a superseded tail complete with one write", async () => {
    const client = tailTransaction({ operationStatus: "APPLIED", completedCount: 1 });

    await expect(waitForReplanEditLease("operation-1", "owner-1", tailIdentity)).resolves.toEqual({
      outcome: "completed"
    });

    expect(client.bookEditOperation.updateMany).toHaveBeenCalledTimes(1);
  });

  it("hands the lease back when the completion marker claims no row", async () => {
    // Reported as completed while the renewed token stayed on the row, so every
    // rival delivery waited out a full lease for an owner that had gone home.
    const client = tailTransaction({ operationStatus: "ACTIVE", completedCount: 0 });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(waitForReplanEditLease("operation-1", "owner-1", tailIdentity)).resolves.toEqual({
      outcome: "completed"
    });

    expect(client.bookEditOperation.updateMany).toHaveBeenCalledTimes(2);
    expect(client.bookEditOperation.updateMany).toHaveBeenLastCalledWith({
      where: { id: "operation-1", structuralLeaseToken: "owner-1", structuralLeaseCompletedAt: null },
      data: { structuralLeaseToken: null, structuralLeaseExpiresAt: null }
    });
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("without a completion marker"),
      expect.objectContaining({ event: "generation.replan_tail_completion_missed", operationStatus: "ACTIVE" })
    );
    logged.mockRestore();
  });

  it("never opens the identity transaction for a draft claim", async () => {
    mocks.waitForStructuralPageLease.mockResolvedValue({
      outcome: "acquired",
      phase: "draft",
      application: null,
      expiresAt: new Date("2030-01-01T00:03:00.000Z")
    });

    await expect(waitForReplanEditLease("operation-1", "owner-1", tailIdentity)).resolves.toEqual({
      outcome: "acquired",
      phase: "draft"
    });

    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });
});

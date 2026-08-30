import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    $queryRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
    bookEditOperation: { findUnique: vi.fn(), update: vi.fn() }
  }
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

import {
  acquireStructuralPageLeaseTx,
  isStructuralPageLeaseLostError,
  markStructuralPageLeaseApplied,
  releaseStructuralPageLease,
  renewStructuralPageLease,
  renewStructuralPageLeaseTx,
  settleSkippedStructuralPageLeaseTx,
  startStructuralPageLeaseHeartbeat,
  STRUCTURAL_PAGE_LEASE_MS,
  STRUCTURAL_PAGE_LEASE_WAIT_MS,
  waitForStructuralPageLease,
  waitForStructuralPageLeaseCompletion
} from "./structuralPageLease.js";

const application = {
  action: "insert",
  pageOrderBefore: [{ pageId: "page-1", index: 1 }],
  insertedPageIds: ["page-new"],
  removedPages: [],
  basePlanVersionId: "plan-1",
  newPlanVersionId: "plan-2",
  previousTargetPages: 1,
  previousChapterTargetPages: {},
  appliedAt: "2026-08-18T00:00:00.000Z"
};

const tx = () => ({
  $queryRawUnsafe: vi.fn(),
  project: { update: vi.fn() },
  bookEditOperation: {
    findUnique: vi.fn(),
    update: vi.fn()
  }
});

describe("structural page delivery lease", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps a concurrent loser out while the stamped winner's lease is live", async () => {
    const client = tx();
    client.$queryRawUnsafe.mockResolvedValue([]);
    client.bookEditOperation.findUnique.mockResolvedValue({
      status: "ACTIVE",
      classifier: { structuralApplication: application },
      structuralLeaseToken: "winner",
      structuralLeaseExpiresAt: new Date("2026-08-18T00:03:00.000Z"),
      structuralLeaseCompletedAt: null
    });

    const claim = await acquireStructuralPageLeaseTx(client as never, "op-1", "loser");

    expect(claim).toMatchObject({
      outcome: "busy",
      application: { insertedPageIds: ["page-new"] },
      retryAt: new Date("2026-08-18T00:03:00.000Z")
    });
    expect(client.bookEditOperation.update).not.toHaveBeenCalled();
  });

  it("lets a crash redelivery take an expired stamped edit and resume its recorded pages", async () => {
    const client = tx();
    client.$queryRawUnsafe.mockResolvedValue([
      {
        status: "ACTIVE",
        classifier: { structuralApplication: application },
        structuralLeaseToken: "redelivery",
        structuralLeaseExpiresAt: new Date("2026-08-18T00:06:00.000Z"),
        structuralLeaseCompletedAt: null
      }
    ]);

    const claim = await acquireStructuralPageLeaseTx(client as never, "op-1", "redelivery");

    expect(claim).toMatchObject({
      outcome: "acquired",
      phase: "draft",
      application: { newPlanVersionId: "plan-2", insertedPageIds: ["page-new"] }
    });
    const [sql] = client.$queryRawUnsafe.mock.calls[0]!;
    expect(sql).toContain('"structuralLeaseExpiresAt" <= CURRENT_TIMESTAMP');
  });

  it("takes over only the durable tail after a crash that already marked the edit applied", async () => {
    const client = tx();
    client.$queryRawUnsafe.mockResolvedValue([
      {
        status: "APPLIED",
        classifier: { structuralApplication: application },
        structuralLeaseToken: "redelivery",
        structuralLeaseExpiresAt: new Date("2026-08-18T00:06:00.000Z"),
        structuralLeaseCompletedAt: null
      }
    ]);

    await expect(acquireStructuralPageLeaseTx(client as never, "op-1", "redelivery")).resolves.toMatchObject({
      outcome: "acquired",
      phase: "tail"
    });
  });

  it("does not let an expired zombie renew or publish after another delivery takes over", async () => {
    mocks.prisma.$queryRawUnsafe.mockResolvedValueOnce([]);
    const client = tx();
    client.project.update.mockResolvedValue({ contentRevision: 8 });
    client.$queryRawUnsafe.mockResolvedValue([]);
    mocks.prisma.$transaction.mockImplementation(async (run: (client: unknown) => Promise<unknown>) => run(client));

    await expect(renewStructuralPageLease("op-1", "old-owner")).resolves.toBe(false);
    await expect(
      markStructuralPageLeaseApplied({
        projectId: "project-1",
        operationId: "op-1",
        ownerToken: "old-owner",
        affectedPageIndexes: [4, 5],
        generationJobId: "job-1"
      })
    ).resolves.toBeNull();

    const renewalSql = mocks.prisma.$queryRawUnsafe.mock.calls[0]![0] as string;
    const publishSql = client.$queryRawUnsafe.mock.calls[0]![0] as string;
    expect(renewalSql).toContain('"structuralLeaseExpiresAt" > CURRENT_TIMESTAMP');
    expect(publishSql).toContain('"structuralLeaseToken" = $2');
    expect(client.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { contentRevision: { increment: 1 } },
      select: { contentRevision: true }
    });
  });

  it("stamps the exact post-mutation revision in the same transaction as APPLIED", async () => {
    const client = tx();
    client.project.update.mockResolvedValue({ contentRevision: 12 });
    client.$queryRawUnsafe.mockResolvedValue([{ id: "op-1" }]);
    mocks.prisma.$transaction.mockImplementation(async (run: (client: unknown) => Promise<unknown>) => run(client));

    await expect(
      markStructuralPageLeaseApplied({
        projectId: "project-1",
        operationId: "op-1",
        ownerToken: "owner",
        affectedPageIndexes: [2, 3],
        generationJobId: "job-1"
      })
    ).resolves.toBe(12);

    const [sql, operationId, ownerToken, leaseMs, indexes, publicationRevision, projectId] =
      client.$queryRawUnsafe.mock.calls[0]!;
    expect(sql).toContain('"publicationRevision" = $5');
    expect(sql).toContain('"projectId" = $6');
    expect([operationId, ownerToken, leaseMs, indexes, publicationRevision, projectId]).toEqual([
      "op-1",
      "owner",
      STRUCTURAL_PAGE_LEASE_MS,
      "{2,3}",
      12,
      "project-1"
    ]);
    expect(client.project.update.mock.invocationCallOrder[0]!).toBeLessThan(
      client.$queryRawUnsafe.mock.invocationCallOrder[0]!
    );
  });

  it("still publishes a legacy row that never carried a generationJobId", async () => {
    // `BookEditOperation.generationJobId` is nullable and Stop still finds the
    // legacy shape by payload id, so an equality predicate would fence such a
    // row out of its own publication for good: rolled back and refunded on
    // every delivery, over pages that are already shifted. The insert publisher
    // tolerates the same NULL, and the two may not disagree about one kind.
    const client = tx();
    client.project.update.mockResolvedValue({ contentRevision: 4 });
    client.$queryRawUnsafe.mockResolvedValue([{ id: "op-1" }]);
    mocks.prisma.$transaction.mockImplementation(async (run: (client: unknown) => Promise<unknown>) => run(client));

    await expect(
      markStructuralPageLeaseApplied({
        projectId: "project-1",
        operationId: "op-1",
        ownerToken: "owner",
        affectedPageIndexes: [],
        generationJobId: "job-1"
      })
    ).resolves.toBe(4);

    const [sql] = client.$queryRawUnsafe.mock.calls[0]!;
    expect(sql).toContain('AND ("generationJobId" IS NULL OR "generationJobId" = $7)');
  });

  it("renews the matching live owner", async () => {
    mocks.prisma.$queryRawUnsafe.mockResolvedValue([{ structuralLeaseExpiresAt: new Date() }]);
    await expect(renewStructuralPageLease("op-1", "current-owner")).resolves.toBe(true);
  });

  it("makes rollback's first statement an unexpired-owner renewal", async () => {
    const client = tx();
    client.$queryRawUnsafe.mockResolvedValue([]);

    await expect(renewStructuralPageLeaseTx(client as never, "op-1", "stale-owner")).resolves.toBeNull();

    expect(client.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql] = client.$queryRawUnsafe.mock.calls[0]!;
    expect(sql).toContain('"structuralLeaseToken" = $2');
    expect(sql).toContain('"structuralLeaseExpiresAt" > CURRENT_TIMESTAMP');
  });

  it("settles a skip only for the delivery that still owns the row", async () => {
    // The refusal path acquires a lease, refunds, and only then writes. A
    // refund that outlives the lease is a replacement already shifting, and an
    // unconditional settle marked *its* live edit skipped, cleared its token
    // and put the project back down. Zero rows is the answer that stands down.
    const client = tx();
    client.$queryRawUnsafe.mockResolvedValue([]);

    await expect(settleSkippedStructuralPageLeaseTx(client as never, "op-1", "stale-owner")).resolves.toBeNull();

    const [sql] = client.$queryRawUnsafe.mock.calls[0]!;
    expect(sql).toContain('"structuralLeaseToken" = $2');
    expect(sql).toContain('"structuralLeaseExpiresAt" > CURRENT_TIMESTAMP');
    expect(sql).toContain("\"status\" = 'ACTIVE'");
  });

  it("returns the classifier the settling swap locked, so the marker merges onto that row", async () => {
    const client = tx();
    client.$queryRawUnsafe.mockResolvedValue([{ classifier: { structuralRolledBackAt: "2026-08-19" } }]);

    await expect(settleSkippedStructuralPageLeaseTx(client as never, "op-1", "owner")).resolves.toEqual({
      classifier: { structuralRolledBackAt: "2026-08-19" }
    });

    const [sql] = client.$queryRawUnsafe.mock.calls[0]!;
    expect(sql).toContain("\"status\" = 'APPLIED'");
    expect(sql).toContain('"structuralLeaseCompletedAt" = CURRENT_TIMESTAMP');
  });

  it("yields an ACTIVE owner without completing the lease", async () => {
    mocks.prisma.$queryRawUnsafe.mockResolvedValue([{ id: "op-1" }]);

    await expect(releaseStructuralPageLease("op-1", "owner")).resolves.toBe(true);

    const [sql] = mocks.prisma.$queryRawUnsafe.mock.calls[0]!;
    expect(sql).toContain('"structuralLeaseToken" = NULL');
    expect(sql).toContain("\"status\" = 'ACTIVE'");
    expect(sql).not.toContain("structuralLeaseCompletedAt\" = CURRENT_TIMESTAMP");
  });
});

describe("structural page lease heartbeat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$queryRawUnsafe.mockReset();
  });

  it("retries a barrier after a transient renewal failure instead of pinning the stale error", async () => {
    mocks.prisma.$queryRawUnsafe
      .mockRejectedValueOnce(new Error("connection terminated unexpectedly"))
      .mockResolvedValue([{ structuralLeaseExpiresAt: new Date("2026-08-18T00:03:00.000Z") }]);

    const heartbeat = startStructuralPageLeaseHeartbeat("op-1", "owner");

    // The barrier surfaces the blip: it could not prove the lease is still ours.
    await expect(heartbeat.assertHeld()).rejects.toThrow("connection terminated unexpectedly");
    // ...and the next one actually asks the database again, rather than replaying it.
    await expect(heartbeat.assertHeld()).resolves.toBeUndefined();
    expect(mocks.prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);

    await expect(heartbeat.stop()).resolves.toBeUndefined();
  });

  it("stops without throwing after a failed renewal, so teardown cannot mask the caller's error", async () => {
    mocks.prisma.$queryRawUnsafe.mockRejectedValue(new Error("connection terminated unexpectedly"));

    const heartbeat = startStructuralPageLeaseHeartbeat("op-1", "owner");
    await expect(heartbeat.assertHeld()).rejects.toThrow("connection terminated unexpectedly");

    await expect(heartbeat.stop()).resolves.toBeUndefined();
  });

  it("keeps a database-refused renewal permanent, because that one is real takeover", async () => {
    mocks.prisma.$queryRawUnsafe.mockResolvedValue([]);

    const heartbeat = startStructuralPageLeaseHeartbeat("op-1", "old-owner");
    await expect(heartbeat.assertHeld()).rejects.toSatisfy(isStructuralPageLeaseLostError);
    await expect(heartbeat.assertHeld()).rejects.toSatisfy(isStructuralPageLeaseLostError);
    // The second barrier does not re-ask: ownership is gone, not merely unproven.
    expect(mocks.prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);

    await expect(heartbeat.stop()).resolves.toBeUndefined();
  });
});

/**
 * Both waits poll a row nobody may be left to write, and the deadline is the
 * only thing that ends them. The delivery doing the waiting is still inside its
 * BullMQ processor, so its job lock keeps being renewed and no redelivery ever
 * arrives to take the expired lease and finish the edit: without a deadline the
 * poll is a worker concurrency slot lost until the process restarts.
 */
describe("structural page lease waits", () => {
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logged.mockRestore();
    vi.useRealTimers();
  });

  /** Resolves only if the wait is still polling once the deadline has passed. */
  const pastTheDeadline = <T,>(stillPolling: T) =>
    vi.advanceTimersByTimeAsync(STRUCTURAL_PAGE_LEASE_WAIT_MS + STRUCTURAL_PAGE_LEASE_MS).then(() => stillPolling);

  it("gives up on a completion nothing is left to write, rather than holding the slot forever", async () => {
    // APPLIED, not skipped, never completed: exactly the row a delivery that
    // lost its lease after the APPLIED write polls, with no owner behind it.
    mocks.prisma.bookEditOperation.findUnique.mockResolvedValue({
      status: "APPLIED",
      classifier: {},
      structuralLeaseCompletedAt: null
    });

    const waiting = waitForStructuralPageLeaseCompletion("op-1");
    await expect(Promise.race([waiting, pastTheDeadline("still-polling")])).resolves.toBe("abandoned");
  });

  it("still waits the winner out when one is actually finishing the edit", async () => {
    mocks.prisma.bookEditOperation.findUnique
      .mockResolvedValueOnce({ status: "APPLIED", classifier: {}, structuralLeaseCompletedAt: null })
      .mockResolvedValue({ status: "APPLIED", classifier: {}, structuralLeaseCompletedAt: new Date() });

    const waiting = waitForStructuralPageLeaseCompletion("op-1");
    await expect(Promise.race([waiting, pastTheDeadline("still-polling")])).resolves.toBe("completed");
    expect(logged).not.toHaveBeenCalled();
  });

  it("gives up on an owner that outlasts the wait, because a wedged one renews forever", async () => {
    const client = tx();
    client.$queryRawUnsafe.mockResolvedValue([]);
    client.bookEditOperation.findUnique.mockImplementation(async () => ({
      status: "ACTIVE",
      classifier: {},
      structuralLeaseToken: "winner",
      structuralLeaseExpiresAt: new Date(Date.now() + STRUCTURAL_PAGE_LEASE_MS),
      structuralLeaseCompletedAt: null
    }));
    mocks.prisma.$transaction.mockImplementation(async (run: (client: unknown) => Promise<unknown>) => run(client));

    const waiting = waitForStructuralPageLease("op-1", "loser");
    await expect(Promise.race([waiting, pastTheDeadline({ outcome: "still-polling" })])).resolves.toEqual({
      outcome: "abandoned"
    });
  });
});

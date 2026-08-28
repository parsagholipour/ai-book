import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyEditFailure, imageLimitReachedMessage } from "@book-maker/core/editFailure";

const fake = vi.hoisted(() => {
  class KnownRequestError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }

  const state = { attempts: new Map<string, any>(), jobs: new Map<string, any>(), sequence: 0 };
  let committed: Promise<void>;
  let resolveCommitted: () => void;

  const resetCommit = () => {
    committed = new Promise<void>((resolve) => {
      resolveCommitted = resolve;
    });
  };
  resetCommit();

  const findByWhere = (where: Record<string, any>) => {
    if (where.commandKey) {
      return [...state.attempts.values()].find((attempt) => attempt.commandKey === where.commandKey) ?? null;
    }
    if (where.id) return state.attempts.get(where.id) ?? null;
    return null;
  };
  const withRetry = (attempt: any) => {
    if (!attempt) return null;
    return {
      ...attempt,
      retryAttempt:
        [...state.attempts.values()].find((candidate) => candidate.retryOfAttemptId === attempt.id) ?? null
    };
  };

  const generationAttempt = {
    findUnique: vi.fn(async ({ where, select }: any) =>
      select?.retryAttempt ? withRetry(findByWhere(where)) : findByWhere(where)
    ),
    create: vi.fn(async ({ data }: any) => {
      const duplicate = [...state.attempts.values()].some(
        (attempt) =>
          attempt.commandKey === data.commandKey ||
          (data.retryOfAttemptId && attempt.retryOfAttemptId === data.retryOfAttemptId)
      );
      if (duplicate) {
        await committed;
        throw new KnownRequestError("P2002");
      }
      const id = `attempt-${++state.sequence}`;
      state.attempts.set(id, {
        id,
        ...data,
        status: "QUEUED",
        projectId: data.projectId ?? null,
        editOperationId: null,
        ledgerEntryId: null,
        primaryJobId: null,
        retryOfAttemptId: data.retryOfAttemptId ?? null,
        error: null,
        refundPending: false
      });
      return { id };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const attempt = state.attempts.get(where.id);
      Object.assign(attempt, data);
      resolveCommitted();
      return attempt;
    }),
    updateMany: vi.fn()
  };
  const generationJob = {
    findUnique: vi.fn(async ({ where }: any) => state.jobs.get(where.id) ?? null)
  };
  const tx = {
    generationAttempt,
    generationJob,
    creditLedgerEntry: { update: vi.fn(async () => ({})) }
  };
  const prisma = {
    generationAttempt: {
      findFirst: vi.fn(async ({ where }: any) => {
        const keys = where.OR.map((condition: any) => condition.commandKey ?? condition.retryOfAttemptId);
        return (
          [...state.attempts.values()].find(
            (attempt) => keys.includes(attempt.commandKey) || keys.includes(attempt.retryOfAttemptId)
          ) ?? null
        );
      }),
      findUnique: generationAttempt.findUnique,
      updateMany: vi.fn(),
      findMany: vi.fn()
    }
  };

  return {
    KnownRequestError,
    prisma,
    tx,
    state,
    reserve: vi.fn(),
    commit: vi.fn(),
    refund: vi.fn(),
    /**
     * What every real `create` callback does: enqueue a durable job stamped
     * with the attempt it is being paid for. Passing a different `attemptId`
     * (or null) is how a test spells "this row was already standing under the
     * dedupe key", which is the only way `enqueueGenerationJob` can hand one
     * back that this attempt did not make.
     */
    enqueueJob(id: string, attemptId: string | null) {
      state.jobs.set(id, { id, attemptId });
      return { id };
    },
    reset() {
      state.attempts.clear();
      state.jobs.clear();
      state.sequence = 0;
      resetCommit();
      vi.clearAllMocks();
    }
  };
});

vi.mock("./client.ts", () => ({
  prisma: fake.prisma,
  Prisma: { PrismaClientKnownRequestError: fake.KnownRequestError }
}));
vi.mock("./billingInternals.ts", () => ({
  runSerializable: (callback: (tx: unknown) => unknown) => callback(fake.tx)
}));
vi.mock("./billingLedger.ts", () => ({
  reserveCreditsTx: fake.reserve,
  commitReservedCreditsTx: fake.commit,
  refundCreditLedgerEntryTx: fake.refund
}));
vi.mock("./billingEntitlements.ts", () => ({ grantProjectEntitlementTx: vi.fn() }));
vi.mock("./planPeriods.ts", () => ({ consumeIllustratedBookUseTx: vi.fn() }));

const {
  GenerationAttemptConflictError,
  GenerationAttemptJobClaimError,
  GenerationQuotaExceededError,
  failGenerationAttempt,
  startGenerationAttempt
} = await import("./generationAttempts.ts");

describe("generation attempt command claims", () => {
  beforeEach(() => {
    fake.reset();
    fake.reserve.mockResolvedValue({ id: "reservation-1" });
    fake.commit.mockResolvedValue({ id: "ledger-1" });
  });

  it("converges simultaneous copies of one command on one debit and job", async () => {
    const create = vi.fn(async (_tx: unknown, { attemptId }: { attemptId: string }) => {
      fake.enqueueJob("job-1", attemptId);
      return { projectId: "project-1", primaryJobId: "job-1" };
    });
    const options = {
      userId: "user-1",
      commandKey: "mobile:plan-approval:plan-1",
      requestFingerprint: "fingerprint-1",
      operation: "FULL_BOOK_GENERATION" as const,
      quotedCredits: 900,
      projectId: "project-1",
      description: "Book generation",
      create
    };

    const [first, second] = await Promise.all([
      startGenerationAttempt(options),
      startGenerationAttempt(options)
    ]);

    expect(first.attempt.id).toBe(second.attempt.id);
    expect(fake.reserve).toHaveBeenCalledTimes(1);
    expect(fake.commit).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(fake.tx.generationJob.findUnique).toHaveBeenCalledTimes(1);
  });

  it("lets differently keyed concurrent retry commands create only one child", async () => {
    fake.state.attempts.set("source-attempt", {
      id: "source-attempt",
      userId: "user-1",
      commandKey: "source-command",
      requestFingerprint: "source-fingerprint",
      status: "FAILED",
      operation: "PLAN_REVISION",
      quotedCredits: 40,
      projectId: "project-1",
      editOperationId: "operation-1",
      ledgerEntryId: "old-ledger",
      primaryJobId: "old-job",
      retryOfAttemptId: null,
      error: "failed",
      refundPending: false
    });
    const create = vi.fn(async (_tx: unknown, { attemptId }: { attemptId: string }) => {
      fake.enqueueJob("retry-job", attemptId);
      return { projectId: "project-1", primaryJobId: "retry-job", editOperationId: "operation-1" };
    });
    const base = {
      userId: "user-1",
      requestFingerprint: "same-retry-input",
      operation: "PLAN_REVISION" as const,
      quotedCredits: 40,
      projectId: "project-1",
      retryOfAttemptId: "source-attempt",
      description: "Plan retry",
      create
    };

    const [first, second] = await Promise.all([
      startGenerationAttempt({ ...base, commandKey: "retry-request-1" }),
      startGenerationAttempt({ ...base, commandKey: "retry-request-2" })
    ]);

    expect(first.attempt.id).toBe(second.attempt.id);
    expect(fake.reserve).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of a command key with different generation settings", async () => {
    const base = {
      userId: "user-1",
      commandKey: "mobile:plan-approval:plan-1",
      requestFingerprint: "fingerprint-1",
      operation: "FULL_BOOK_GENERATION" as const,
      quotedCredits: 900,
      projectId: "project-1",
      description: "Book generation",
      create: async (_tx: unknown, { attemptId }: { attemptId: string }) => {
        fake.enqueueJob("job-1", attemptId);
        return { projectId: "project-1", primaryJobId: "job-1" };
      }
    };
    await startGenerationAttempt(base);

    await expect(
      startGenerationAttempt({ ...base, requestFingerprint: "different-fingerprint" })
    ).rejects.toBeInstanceOf(GenerationAttemptConflictError);
    expect(fake.reserve).toHaveBeenCalledTimes(1);
  });

  /**
   * `enqueueGenerationJob` returns whatever row already stands under a
   * `dedupeKey` instead of creating one, so a key another path already spent
   * hands a `create` callback a job this attempt never made. Re-parenting the
   * attempt and its committed spend onto that row is the mis-parent the whole
   * reserve -> commit -> refund loop has no answer for: the charge lands on
   * someone else's work, and where that work has already finished nothing will
   * ever mark this attempt succeeded or failed.
   *
   * Both shapes below are reachable. A job stamped with another attempt is
   * `plan-book:<projectId>`, written by the mobile creation flow and asked for
   * again by `POST /api/mobile/projects/:id/plan`. An unstamped one is
   * `generate-book:<projectId>:<planId>`, written for free by the operator
   * approval route, which takes no attempt at all.
   *
   * The fake runs `runSerializable` as a bare callback, so the assertions here
   * are about what was *written* before the throw — Postgres is what rolls the
   * spend back, and it can only do that because the refusal happens inside the
   * transaction.
   */
  it("refuses to parent a paid attempt onto a job another attempt already owns", async () => {
    fake.enqueueJob("plan-book-job", "other-attempt");
    const create = vi.fn(async () => ({ projectId: "project-1", primaryJobId: "plan-book-job" }));

    await expect(
      startGenerationAttempt({
        userId: "user-1",
        commandKey: "mobile:project-initial-plan:project-1",
        requestFingerprint: "fingerprint-1",
        operation: "PLAN_GENERATION",
        quotedCredits: 40,
        projectId: "project-1",
        description: "Plan generation",
        create
      })
    ).rejects.toBeInstanceOf(GenerationAttemptJobClaimError);

    expect(create).toHaveBeenCalledTimes(1);
    expect(fake.state.jobs.get("plan-book-job")?.attemptId).toBe("other-attempt");
    expect(fake.tx.creditLedgerEntry.update).not.toHaveBeenCalled();
    expect(fake.tx.generationAttempt.update).not.toHaveBeenCalled();
  });

  it("refuses to parent a paid attempt onto an unbilled job no attempt stamped", async () => {
    fake.enqueueJob("operator-approval-job", null);
    const create = vi.fn(async () => ({ projectId: "project-1", primaryJobId: "operator-approval-job" }));

    await expect(
      startGenerationAttempt({
        userId: "user-1",
        commandKey: "mobile:plan-approval:plan-1",
        requestFingerprint: "fingerprint-1",
        operation: "FULL_BOOK_GENERATION",
        quotedCredits: 900,
        projectId: "project-1",
        description: "Book generation",
        grantExportEntitlement: true,
        create
      })
    ).rejects.toBeInstanceOf(GenerationAttemptJobClaimError);

    expect(fake.state.jobs.get("operator-approval-job")?.attemptId).toBeNull();
    expect(fake.tx.creditLedgerEntry.update).not.toHaveBeenCalled();
    expect(fake.tx.generationAttempt.update).not.toHaveBeenCalled();
  });

  it("refuses a create callback that names a job row that was never written", async () => {
    await expect(
      startGenerationAttempt({
        userId: "user-1",
        commandKey: "mobile:character-portrait:character-1",
        requestFingerprint: "fingerprint-1",
        operation: "CHARACTER_PORTRAIT_GENERATION",
        quotedCredits: 30,
        description: "Character portrait",
        create: async () => ({ projectId: null, primaryJobId: "job-that-never-existed" })
      })
    ).rejects.toBeInstanceOf(GenerationAttemptJobClaimError);

    expect(fake.tx.generationAttempt.update).not.toHaveBeenCalled();
  });

  it("does not start a paid retry while the source refund is pending", async () => {
    fake.state.attempts.set("source-attempt", {
      id: "source-attempt",
      userId: "user-1",
      commandKey: "source-command",
      requestFingerprint: "source-fingerprint",
      status: "FAILED",
      operation: "PLAN_REVISION",
      quotedCredits: 40,
      projectId: "project-1",
      editOperationId: "operation-1",
      ledgerEntryId: "old-ledger",
      primaryJobId: "old-job",
      retryOfAttemptId: null,
      error: "failed",
      refundPending: true
    });

    await expect(
      startGenerationAttempt({
        userId: "user-1",
        commandKey: "retry-request-1",
        requestFingerprint: "same-retry-input",
        operation: "PLAN_REVISION",
        quotedCredits: 40,
        projectId: "project-1",
        retryOfAttemptId: "source-attempt",
        description: "Plan retry",
        create: async () => ({ projectId: "project-1", primaryJobId: "retry-job" })
      })
    ).rejects.toBeInstanceOf(GenerationAttemptConflictError);
    expect(fake.reserve).not.toHaveBeenCalled();
  });

  it("ignores a late failure after the generation attempt succeeded", async () => {
    fake.state.attempts.set("successful-attempt", {
      id: "successful-attempt",
      status: "SUCCEEDED",
      ledgerEntryId: "ledger-1",
      refundPending: false
    });

    await failGenerationAttempt("successful-attempt", "late child failure");

    expect(fake.refund).not.toHaveBeenCalled();
    expect(fake.tx.generationAttempt.update).not.toHaveBeenCalled();
    expect(fake.state.attempts.get("successful-attempt")?.status).toBe("SUCCEEDED");
  });

  it("reconciles a pending terminal refund without changing its terminal status", async () => {
    fake.state.attempts.set("canceled-attempt", {
      id: "canceled-attempt",
      status: "CANCELED",
      ledgerEntryId: "ledger-1",
      refundPending: true
    });

    await failGenerationAttempt("canceled-attempt", "refund retry", "FAILED");

    expect(fake.refund).toHaveBeenCalledWith(fake.tx, "ledger-1", "refund retry");
    expect(fake.state.attempts.get("canceled-attempt")).toMatchObject({
      status: "CANCELED",
      refundPending: false
    });
  });
});

/**
 * The reader copy on `BookEditOperation.error` is keyed on the wire `code`
 * these classes declare, not on `instanceof`: the classifier lives in
 * `packages/core` because that is the only package both the API and the worker
 * can reach, and core may not import this one. Nothing else checks that the
 * codes it dispatches on are the codes the real classes carry — the API suite
 * asks the question of a hand-written mock, which is exactly where the two can
 * drift apart.
 */
describe("the wire codes the reader copy is keyed on", () => {
  it("gives a real quota refusal the sentence its HTTP twin sends", () => {
    const error = new GenerationQuotaExceededError({
      allowed: false,
      used: 3,
      limit: 3,
      periodKey: "2026-06",
      resetsAt: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(classifyEditFailure(error, "start")).toEqual({
      message: imageLimitReachedMessage(3),
      internal: false
    });
    // The class's own words are the internal sentence this rung exists to keep
    // off the card: no count, and nothing to do next.
    expect(error.message).toBe("The illustrated-book limit has been reached for this period.");
    expect(error.message).not.toBe(imageLimitReachedMessage(3));
  });

  it("keeps a real command conflict's own sentence", () => {
    expect(
      classifyEditFailure(
        new GenerationAttemptConflictError("Another book edit operation is already in progress."),
        "start"
      )
    ).toEqual({ message: "Another book edit operation is already in progress.", internal: false });
  });

  it("never lets a real job-claim fault reach the reader", () => {
    const failure = classifyEditFailure(new GenerationAttemptJobClaimError(
        "Generation attempt attempt-2 may not claim generation job job-1: it is already attempt attempt-1's work."
      ), "start");

    expect(failure.internal).toBe(true);
    expect(failure.message).not.toMatch(/dedupeKey|attemptId|job-1|attempt-\d/);
  });
});

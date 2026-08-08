import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  class KnownRequestError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }

  const state = { attempts: new Map<string, any>(), sequence: 0 };
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
  const tx = {
    generationAttempt,
    generationJob: { update: vi.fn(async () => ({})) },
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
    reset() {
      state.attempts.clear();
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

const { GenerationAttemptConflictError, failGenerationAttempt, startGenerationAttempt } = await import(
  "./generationAttempts.ts"
);

describe("generation attempt command claims", () => {
  beforeEach(() => {
    fake.reset();
    fake.reserve.mockResolvedValue({ id: "reservation-1" });
    fake.commit.mockResolvedValue({ id: "ledger-1" });
  });

  it("converges simultaneous copies of one command on one debit and job", async () => {
    const create = vi.fn(async () => ({ projectId: "project-1", primaryJobId: "job-1" }));
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
    expect(fake.tx.generationJob.update).toHaveBeenCalledTimes(1);
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
    const create = vi.fn(async () => ({
      projectId: "project-1",
      primaryJobId: "retry-job",
      editOperationId: "operation-1"
    }));
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
      create: async () => ({ projectId: "project-1", primaryJobId: "job-1" })
    };
    await startGenerationAttempt(base);

    await expect(
      startGenerationAttempt({ ...base, requestFingerprint: "different-fingerprint" })
    ).rejects.toBeInstanceOf(GenerationAttemptConflictError);
    expect(fake.reserve).toHaveBeenCalledTimes(1);
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

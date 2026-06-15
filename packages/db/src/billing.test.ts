import { beforeEach, describe, expect, it, vi } from "vitest";
import { creditCostForOperation } from "@book-maker/core";
import {
  InsufficientCreditsError,
  commitReservedCredits,
  ensureProjectExportEntitlementOrSpend,
  getCreditBalance,
  grantCredits,
  grantProjectEntitlement,
  hasActiveProjectEntitlement,
  refundCreditLedgerEntry,
  refundLatestProjectOperationCredits,
  reserveCredits,
  spendCredits
} from "./billing.js";

type Account = {
  userId: string;
  availableCredits: number;
  reservedCredits: number;
  lifetimeCreditsGranted: number;
  lifetimeCreditsSpent: number;
};

type Ledger = {
  id: string;
  userId: string;
  projectId: string | null;
  operation: string;
  amountCredits: number;
  entryType: string;
  status: string;
  idempotencyKey: string;
  reversesEntryId: string | null;
  createdAt: Date;
};

type Entitlement = {
  id: string;
  userId: string;
  projectId: string | null;
  type: string;
  status: string;
  source: string;
  creditsCost: number;
  relatedLedgerEntryId: string | null;
  startsAt: Date;
  expiresAt: Date | null;
};

const fakeDb = vi.hoisted(() => {
  const state = {
    accounts: new Map<string, Account>(),
    ledger: new Map<string, Ledger>(),
    entitlements: new Map<string, Entitlement>(),
    ledgerSeq: 0,
    entitlementSeq: 0
  };

  function account(userId: string): Account {
    let existing = state.accounts.get(userId);
    if (!existing) {
      existing = {
        userId,
        availableCredits: 0,
        reservedCredits: 0,
        lifetimeCreditsGranted: 0,
        lifetimeCreditsSpent: 0
      };
      state.accounts.set(userId, existing);
    }
    return existing;
  }

  function applyNumberMutation(target: Account, data: Record<string, any>) {
    for (const key of ["availableCredits", "reservedCredits", "lifetimeCreditsGranted", "lifetimeCreditsSpent"] as const) {
      const mutation = data[key];
      if (!mutation) {
        continue;
      }
      if (typeof mutation.increment === "number") {
        target[key] += mutation.increment;
      }
      if (typeof mutation.decrement === "number") {
        target[key] -= mutation.decrement;
      }
    }
  }

  function ledgerMatchesWhere(row: Ledger, where: Record<string, any>) {
    if (where.projectId !== undefined && row.projectId !== where.projectId) {
      return false;
    }
    if (where.operation !== undefined && row.operation !== where.operation) {
      return false;
    }
    if (where.amountCredits?.lt !== undefined && !(row.amountCredits < where.amountCredits.lt)) {
      return false;
    }
    if (where.status?.in && !where.status.in.includes(row.status)) {
      return false;
    }
    if (where.reversedByEntry === null) {
      return ![...state.ledger.values()].some((candidate) => candidate.reversesEntryId === row.id);
    }
    return true;
  }

  function entitlementMatchesWhere(row: Entitlement, where: Record<string, any>) {
    if (where.userId !== undefined && row.userId !== where.userId) {
      return false;
    }
    if (where.projectId !== undefined && row.projectId !== where.projectId) {
      return false;
    }
    if (where.type !== undefined && row.type !== where.type) {
      return false;
    }
    if (where.status !== undefined && row.status !== where.status) {
      return false;
    }
    if (where.relatedLedgerEntryId !== undefined && row.relatedLedgerEntryId !== where.relatedLedgerEntryId) {
      return false;
    }
    if (Array.isArray(where.OR)) {
      return where.OR.some((clause: Record<string, any>) => {
        if (clause.expiresAt === null) {
          return row.expiresAt === null;
        }
        if (clause.expiresAt?.gt instanceof Date) {
          return row.expiresAt !== null && row.expiresAt > clause.expiresAt.gt;
        }
        return false;
      });
    }
    return true;
  }

  const prisma = {
    $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma)),
    productCatalog: { upsert: vi.fn() },
    userCreditAccount: {
      upsert: vi.fn(async ({ where, create }: any) => account(where.userId ?? create.userId)),
      update: vi.fn(async ({ where, data }: any) => {
        const target = account(where.userId);
        applyNumberMutation(target, data);
        return target;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const target = account(where.userId);
        if (where.availableCredits?.gte !== undefined && target.availableCredits < where.availableCredits.gte) {
          return { count: 0 };
        }
        if (where.reservedCredits?.gte !== undefined && target.reservedCredits < where.reservedCredits.gte) {
          return { count: 0 };
        }
        applyNumberMutation(target, data);
        return { count: 1 };
      })
    },
    creditLedgerEntry: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) {
          return state.ledger.get(where.id) ?? null;
        }
        if (where.idempotencyKey) {
          return [...state.ledger.values()].find((row) => row.idempotencyKey === where.idempotencyKey) ?? null;
        }
        if (where.reversesEntryId) {
          return [...state.ledger.values()].find((row) => row.reversesEntryId === where.reversesEntryId) ?? null;
        }
        return null;
      }),
      findFirst: vi.fn(async ({ where }: any) =>
        [...state.ledger.values()]
          .filter((row) => ledgerMatchesWhere(row, where))
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null
      ),
      create: vi.fn(async ({ data }: any) => {
        const row: Ledger = {
          id: `ledger-${++state.ledgerSeq}`,
          userId: data.userId,
          projectId: data.projectId ?? null,
          operation: data.operation,
          amountCredits: data.amountCredits,
          entryType: data.entryType,
          status: data.status,
          idempotencyKey: data.idempotencyKey,
          reversesEntryId: data.reversesEntryId ?? null,
          createdAt: new Date(2026, 5, 15, 12, state.ledgerSeq)
        };
        state.ledger.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = state.ledger.get(where.id);
        if (!row) {
          throw new Error("Ledger entry missing");
        }
        Object.assign(row, data);
        return row;
      })
    },
    userEntitlement: {
      findMany: vi.fn(async ({ where }: any) => [...state.entitlements.values()].filter((row) => entitlementMatchesWhere(row, where))),
      findFirst: vi.fn(async ({ where }: any) => [...state.entitlements.values()].find((row) => entitlementMatchesWhere(row, where)) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const row: Entitlement = {
          id: `entitlement-${++state.entitlementSeq}`,
          userId: data.userId,
          projectId: data.projectId ?? null,
          type: data.type,
          status: "ACTIVE",
          source: data.source,
          creditsCost: data.creditsCost,
          relatedLedgerEntryId: data.relatedLedgerEntryId ?? null,
          startsAt: new Date("2026-06-15T12:00:00.000Z"),
          expiresAt: data.expiresAt ?? null
        };
        state.entitlements.set(row.id, row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of state.entitlements.values()) {
          if (entitlementMatchesWhere(row, where)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      })
    }
  };

  return {
    state,
    prisma,
    Prisma: {
      TransactionIsolationLevel: { Serializable: "Serializable" }
    }
  };
});

vi.mock("./client.ts", () => ({
  prisma: fakeDb.prisma,
  Prisma: fakeDb.Prisma
}));

describe("credit ledger operations", () => {
  beforeEach(() => {
    fakeDb.state.accounts.clear();
    fakeDb.state.ledger.clear();
    fakeDb.state.entitlements.clear();
    fakeDb.state.ledgerSeq = 0;
    fakeDb.state.entitlementSeq = 0;
    vi.clearAllMocks();
  });

  it("grants, reserves, commits, and refunds credits atomically", async () => {
    await grantCredits({
      userId: "user-a",
      amountCredits: 1000,
      idempotencyKey: "grant:user-a:initial"
    });

    const reservation = await reserveCredits({
      userId: "user-a",
      projectId: "project-1",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: 300,
      idempotencyKey: "reserve:project-1"
    });
    expect(await getCreditBalance("user-a")).toMatchObject({ availableCredits: 700, reservedCredits: 300 });

    const spend = await commitReservedCredits(reservation!.id);
    expect(spend.entryType).toBe("SPEND");
    expect(await getCreditBalance("user-a")).toMatchObject({ availableCredits: 700, reservedCredits: 0, lifetimeCreditsSpent: 300 });

    await refundCreditLedgerEntry(spend.id, "Generation failed");
    expect(await getCreditBalance("user-a")).toMatchObject({ availableCredits: 1000, reservedCredits: 0, lifetimeCreditsSpent: 0 });
  });

  it("prevents double spend and treats duplicate idempotency keys as one reservation", async () => {
    await grantCredits({ userId: "user-a", amountCredits: 500, idempotencyKey: "grant:user-a" });

    const first = await reserveCredits({
      userId: "user-a",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: 400,
      idempotencyKey: "reserve:same"
    });
    const duplicate = await reserveCredits({
      userId: "user-a",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: 400,
      idempotencyKey: "reserve:same"
    });

    expect(duplicate?.id).toBe(first?.id);
    expect(await getCreditBalance("user-a")).toMatchObject({ availableCredits: 100, reservedCredits: 400 });
    await expect(
      reserveCredits({
        userId: "user-a",
        operation: "FULL_BOOK_GENERATION",
        amountCredits: 200,
        idempotencyKey: "reserve:too-much"
      })
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it("spends export unlock credits once and then allows the entitlement", async () => {
    await grantCredits({ userId: "user-a", amountCredits: 200, idempotencyKey: "grant:user-a" });

    expect(await hasActiveProjectEntitlement({ userId: "user-a", projectId: "project-1", type: "EXPORT_UNLOCK" })).toBe(false);
    const unlocked = await ensureProjectExportEntitlementOrSpend({
      userId: "user-a",
      projectId: "project-1",
      idempotencyKey: "export:project-1"
    });
    const second = await ensureProjectExportEntitlementOrSpend({
      userId: "user-a",
      projectId: "project-1",
      idempotencyKey: "export:project-1"
    });

    expect(unlocked.chargedLedgerEntry?.amountCredits).toBe(-creditCostForOperation("EXPORT_UNLOCK"));
    expect(second.chargedLedgerEntry).toBeNull();
    expect(await hasActiveProjectEntitlement({ userId: "user-a", projectId: "project-1", type: "EXPORT_UNLOCK" })).toBe(true);
    expect(await getCreditBalance("user-a")).toMatchObject({ availableCredits: 50, reservedCredits: 0 });
  });

  it("refunds failed project generation once and revokes ledger-backed entitlements", async () => {
    await grantCredits({ userId: "user-a", amountCredits: 1000, idempotencyKey: "grant:user-a" });
    const spend = await spendCredits({
      userId: "user-a",
      projectId: "project-1",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: 800,
      idempotencyKey: "spend:project-1"
    });
    await grantProjectEntitlement({
      userId: "user-a",
      projectId: "project-1",
      type: "EXPORT_UNLOCK",
      source: "full_generation_credits",
      creditsCost: 800,
      relatedLedgerEntryId: spend?.id
    });

    const refund = await refundLatestProjectOperationCredits({
      projectId: "project-1",
      operation: "FULL_BOOK_GENERATION",
      reason: "Worker failed"
    });
    const secondRefund = await refundLatestProjectOperationCredits({
      projectId: "project-1",
      operation: "FULL_BOOK_GENERATION",
      reason: "Worker failed again"
    });

    expect(refund?.entryType).toBe("REFUND");
    expect(secondRefund).toBeNull();
    expect(await getCreditBalance("user-a")).toMatchObject({ availableCredits: 1000, lifetimeCreditsSpent: 0 });
    expect(await hasActiveProjectEntitlement({ userId: "user-a", projectId: "project-1", type: "EXPORT_UNLOCK" })).toBe(false);
  });
});

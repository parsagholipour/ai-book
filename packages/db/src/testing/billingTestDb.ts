/**
 * An in-memory stand-in for the billing tables, so the ledger suites can run
 * without Postgres.
 *
 * It models only what the billing modules actually ask of Prisma: guarded
 * `updateMany` (which is how every balance change stays atomic), composite-key
 * lookups, and enough `where` shapes to be honest about which writes would have
 * matched. Anything it does not model, it ignores rather than pretending.
 *
 * Like the API's `mobileApiMocks.ts`, this file imports nothing but `vitest`: it
 * is pulled in from inside a `vi.mock` factory, and reaching any module that
 * transitively imports a mocked one deadlocks the registry.
 */
import { vi } from "vitest";

export type Account = {
  userId: string;
  availableCredits: number;
  reservedCredits: number;
  lifetimeCreditsGranted: number;
  lifetimeCreditsSpent: number;
  planCredits: number;
  planCreditsPerPeriod: number;
  planPeriodStart: Date | null;
  planPeriodEnd: Date | null;
  planPeriodKey: string | null;
};

export type Ledger = {
  id: string;
  userId: string;
  projectId: string | null;
  operation: string;
  amountCredits: number;
  planCreditsDelta: number;
  balanceAfterCredits: number | null;
  entryType: string;
  status: string;
  idempotencyKey: string;
  reversesEntryId: string | null;
  description: string | null;
  metadata: unknown;
  createdAt: Date;
};

export type Entitlement = {
  id: string;
  userId: string;
  projectId: string | null;
  type: string;
  status: string;
  source: string;
  creditsCost: number;
  relatedLedgerEntryId: string | null;
  purchaseRecordId: string | null;
  startsAt: Date;
  expiresAt: Date | null;
};

export type Product = {
  id: string;
  sku: string;
  title: string;
  productType: string;
  creditAmount: number;
  priceMicros: bigint;
  currency: string;
  active: boolean;
};

export type Purchase = {
  id: string;
  userId: string;
  productId: string | null;
  provider: string;
  externalPurchaseId: string | null;
  purchaseTokenHash: string | null;
  status: string;
  creditsGranted: number;
  amountMicros: bigint | null;
  currency: string;
  purchasedAt: Date | null;
  verifiedAt: Date | null;
  metadata: unknown;
};

export type Subscription = {
  id: string;
  userId: string;
  productId: string | null;
  provider: string;
  externalSubscriptionId: string | null;
  purchaseToken: string | null;
  status: string;
  creditsPerPeriod: number;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  nextCreditGrantAt: Date | null;
  autoRenewing: boolean | null;
  canceledAt: Date | null;
  metadata: unknown;
};

export type Usage = {
  id: string;
  userId: string;
  kind: string;
  periodKey: string;
  used: number;
};

/** The catalog rows the suites verify purchases against. */
export const TEST_PRODUCTS: Product[] = [
  {
    id: "product-one-book",
    sku: "tomeza.one_book_export",
    title: "One book export",
    productType: "ONE_TIME_UNLOCK",
    creditAmount: 1000,
    priceMicros: 9_990_000n,
    currency: "USD",
    active: true
  },
  {
    id: "product-creator",
    sku: "tomeza.creator_monthly",
    title: "Creator",
    productType: "SUBSCRIPTION",
    creditAmount: 6000,
    priceMicros: 19_990_000n,
    currency: "USD",
    active: true
  },
  {
    id: "product-max",
    sku: "tomeza.max_monthly",
    title: "Max",
    productType: "SUBSCRIPTION",
    creditAmount: 80000,
    priceMicros: 199_990_000n,
    currency: "USD",
    active: true
  }
];

export function createBillingTestDb() {
  const state = {
    accounts: new Map<string, Account>(),
    ledger: new Map<string, Ledger>(),
    entitlements: new Map<string, Entitlement>(),
    products: new Map<string, Product>(),
    purchases: new Map<string, Purchase>(),
    subscriptions: new Map<string, Subscription>(),
    usage: new Map<string, Usage>(),
    ledgerSeq: 0,
    entitlementSeq: 0,
    purchaseSeq: 0,
    subscriptionSeq: 0,
    usageSeq: 0
  };

  function account(userId: string): Account {
    let existing = state.accounts.get(userId);
    if (!existing) {
      existing = {
        userId,
        availableCredits: 0,
        reservedCredits: 0,
        lifetimeCreditsGranted: 0,
        lifetimeCreditsSpent: 0,
        planCredits: 0,
        planCreditsPerPeriod: 0,
        planPeriodStart: null,
        planPeriodEnd: null,
        planPeriodKey: null
      };
      state.accounts.set(userId, existing);
    }
    return existing;
  }

  /** Prisma-ish write: `{increment}`/`{decrement}` adjust, anything else assigns. */
  function applyMutation(target: Record<string, any>, data: Record<string, any>) {
    for (const [key, mutation] of Object.entries(data)) {
      if (mutation && typeof mutation === "object" && !(mutation instanceof Date)) {
        if (typeof mutation.increment === "number") {
          target[key] += mutation.increment;
        }
        if (typeof mutation.decrement === "number") {
          target[key] -= mutation.decrement;
        }
        continue;
      }
      target[key] = mutation;
    }
  }

  /** The guards that make a conditional update the thing enforcing a balance. */
  function meetsNumericGuards(target: Record<string, any>, where: Record<string, any>) {
    for (const [key, guard] of Object.entries(where)) {
      if (!guard || typeof guard !== "object" || guard instanceof Date) {
        continue;
      }
      if (typeof guard.gte === "number" && !(target[key] >= guard.gte)) {
        return false;
      }
      if (typeof guard.gt === "number" && !(target[key] > guard.gt)) {
        return false;
      }
      if (typeof guard.lt === "number" && !(target[key] < guard.lt)) {
        return false;
      }
    }
    return true;
  }

  function ledgerMatchesWhere(row: Ledger, where: Record<string, any>) {
    if (where.id?.in && !where.id.in.includes(row.id)) {
      return false;
    }
    if (where.projectId !== undefined && row.projectId !== where.projectId) {
      return false;
    }
    if (where.operation !== undefined && row.operation !== where.operation) {
      return false;
    }
    if (where.amountCredits?.lt !== undefined && !(row.amountCredits < where.amountCredits.lt)) {
      return false;
    }
    if (typeof where.status === "string" && row.status !== where.status) {
      return false;
    }
    if (where.status?.in && !where.status.in.includes(row.status)) {
      return false;
    }
    if (
      where.idempotencyKey?.startsWith !== undefined &&
      !row.idempotencyKey.startsWith(where.idempotencyKey.startsWith)
    ) {
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
    if (where.type !== undefined) {
      if (Array.isArray(where.type?.in)) {
        if (!where.type.in.includes(row.type)) {
          return false;
        }
      } else if (row.type !== where.type) {
        return false;
      }
    }
    if (where.status !== undefined && row.status !== where.status) {
      return false;
    }
    if (where.source !== undefined && row.source !== where.source) {
      return false;
    }
    if (where.relatedLedgerEntryId !== undefined && row.relatedLedgerEntryId !== where.relatedLedgerEntryId) {
      return false;
    }
    if (where.purchaseRecordId !== undefined && row.purchaseRecordId !== where.purchaseRecordId) {
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

  function usageKey(where: { userId: string; kind: string; periodKey: string }) {
    return `${where.userId}:${where.kind}:${where.periodKey}`;
  }

  const prisma = {
    $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma)),
    productCatalog: {
      upsert: vi.fn(),
      findUnique: vi.fn(async ({ where }: any) => state.products.get(where.sku) ?? null)
    },
    purchaseRecord: {
      findFirst: vi.fn(async ({ where }: any) =>
        [...state.purchases.values()].find((row) => {
          if (where.provider !== undefined && row.provider !== where.provider) {
            return false;
          }
          if (where.purchaseTokenHash !== undefined && row.purchaseTokenHash !== where.purchaseTokenHash) {
            return false;
          }
          return true;
        }) ?? null
      ),
      create: vi.fn(async ({ data }: any) => {
        const row: Purchase = {
          id: `purchase-${++state.purchaseSeq}`,
          userId: data.userId,
          productId: data.productId ?? null,
          provider: data.provider,
          externalPurchaseId: data.externalPurchaseId ?? null,
          purchaseTokenHash: data.purchaseTokenHash ?? null,
          status: data.status,
          creditsGranted: data.creditsGranted ?? 0,
          amountMicros: data.amountMicros ?? null,
          currency: data.currency,
          purchasedAt: data.purchasedAt ?? null,
          verifiedAt: data.verifiedAt ?? null,
          metadata: data.metadata
        };
        state.purchases.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = state.purchases.get(where.id);
        if (!row) {
          throw new Error("Purchase missing");
        }
        Object.assign(row, data);
        return row;
      })
    },
    subscriptionState: {
      findFirst: vi.fn(async ({ where }: any) => {
        const row = [...state.subscriptions.values()].find((candidate) => {
          if (where.provider !== undefined && candidate.provider !== where.provider) {
            return false;
          }
          if (where.externalSubscriptionId !== undefined && candidate.externalSubscriptionId !== where.externalSubscriptionId) {
            return false;
          }
          if (where.userId !== undefined && candidate.userId !== where.userId) {
            return false;
          }
          if (where.status?.in && !where.status.in.includes(candidate.status)) {
            return false;
          }
          return true;
        });
        if (!row) {
          return null;
        }
        const product = [...state.products.values()].find((candidate) => candidate.id === row.productId);
        return { ...row, product: product ? { sku: product.sku } : null };
      }),
      findMany: vi.fn(async ({ where, take }: any) => {
        const rows = [...state.subscriptions.values()].filter((candidate) => {
          if (where?.userId !== undefined && candidate.userId !== where.userId) {
            return false;
          }
          if (where?.status?.in && !where.status.in.includes(candidate.status)) {
            return false;
          }
          if (where?.purchaseToken?.not === null && candidate.purchaseToken === null) {
            return false;
          }
          if (where?.nextCreditGrantAt?.lte instanceof Date) {
            if (!candidate.nextCreditGrantAt || candidate.nextCreditGrantAt > where.nextCreditGrantAt.lte) {
              return false;
            }
          }
          return true;
        });
        const product = (productId: string | null) =>
          [...state.products.values()].find((candidate) => candidate.id === productId) ?? null;
        return rows.slice(0, take ?? rows.length).map((row) => {
          const catalog = product(row.productId);
          return { ...row, product: catalog ? { sku: catalog.sku } : null };
        });
      }),
      create: vi.fn(async ({ data }: any) => {
        const row: Subscription = {
          id: `subscription-${++state.subscriptionSeq}`,
          userId: data.userId,
          productId: data.productId ?? null,
          provider: data.provider,
          externalSubscriptionId: data.externalSubscriptionId ?? null,
          purchaseToken: data.purchaseToken ?? null,
          status: data.status,
          creditsPerPeriod: data.creditsPerPeriod,
          currentPeriodStart: data.currentPeriodStart ?? null,
          currentPeriodEnd: data.currentPeriodEnd ?? null,
          nextCreditGrantAt: data.nextCreditGrantAt ?? null,
          autoRenewing: data.autoRenewing ?? null,
          canceledAt: data.canceledAt ?? null,
          metadata: data.metadata
        };
        state.subscriptions.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = state.subscriptions.get(where.id);
        if (!row) {
          throw new Error("Subscription missing");
        }
        Object.assign(row, data);
        return row;
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const key = where.provider_externalSubscriptionId;
        const existing = [...state.subscriptions.values()].find(
          (row) =>
            row.provider === key.provider && row.externalSubscriptionId === key.externalSubscriptionId
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row: Subscription = {
          id: `subscription-${++state.subscriptionSeq}`,
          userId: create.userId,
          productId: create.productId ?? null,
          provider: create.provider,
          externalSubscriptionId: create.externalSubscriptionId ?? null,
          purchaseToken: create.purchaseToken ?? null,
          status: create.status,
          creditsPerPeriod: create.creditsPerPeriod,
          currentPeriodStart: create.currentPeriodStart ?? null,
          currentPeriodEnd: create.currentPeriodEnd ?? null,
          nextCreditGrantAt: create.nextCreditGrantAt ?? null,
          autoRenewing: create.autoRenewing ?? null,
          canceledAt: create.canceledAt ?? null,
          metadata: create.metadata
        };
        state.subscriptions.set(row.id, row);
        return row;
      })
    },
    userCreditAccount: {
      upsert: vi.fn(async ({ where, create }: any) => account(where.userId ?? create.userId)),
      update: vi.fn(async ({ where, data }: any) => {
        const target = account(where.userId);
        applyMutation(target, data);
        return target;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const target = account(where.userId);
        if (!meetsNumericGuards(target, where)) {
          return { count: 0 };
        }
        applyMutation(target, data);
        return { count: 1 };
      })
    },
    usageCounter: {
      findUnique: vi.fn(async ({ where }: any) => state.usage.get(usageKey(where.userId_kind_periodKey)) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const row: Usage = {
          id: `usage-${++state.usageSeq}`,
          userId: data.userId,
          kind: data.kind,
          periodKey: data.periodKey,
          used: data.used ?? 0
        };
        state.usage.set(usageKey(row), row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = state.usage.get(usageKey(where));
        if (!row || !meetsNumericGuards(row, where)) {
          return { count: 0 };
        }
        applyMutation(row, data);
        return { count: 1 };
      }),
      upsert: vi.fn(async ({ where, create }: any) => {
        const existing = state.usage.get(usageKey(where.userId_kind_periodKey));
        if (existing) {
          return existing;
        }
        const row: Usage = {
          id: `usage-${++state.usageSeq}`,
          userId: create.userId,
          kind: create.kind,
          periodKey: create.periodKey,
          used: create.used ?? 0
        };
        state.usage.set(usageKey(row), row);
        return row;
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
      findMany: vi.fn(async ({ where, orderBy, take, skip, cursor, select }: any) => {
        let rows = [...state.ledger.values()].filter((row) => ledgerMatchesWhere(row, where ?? {}));
        const orderClauses: any[] = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
        if (orderClauses.some((clause) => clause?.createdAt === "desc")) {
          const byId = orderClauses.some((clause) => clause?.id === "desc");
          rows = rows.sort(
            (left, right) =>
              right.createdAt.getTime() - left.createdAt.getTime() ||
              (byId ? right.id.localeCompare(left.id) : 0)
          );
        }
        // Cursor pagination, as the bounded refund scan uses it: the cursor row
        // is found in the ordered list and `skip` steps past it.
        if (cursor?.id !== undefined) {
          const index = rows.findIndex((row) => row.id === cursor.id);
          rows = index === -1 ? [] : rows.slice(index);
        }
        if (typeof skip === "number") {
          rows = rows.slice(skip);
        }
        rows = rows.slice(0, take ?? rows.length);
        if (select?.reversedByEntry) {
          return rows.map((row) => ({
            ...row,
            reversedByEntry:
              [...state.ledger.values()].find((candidate) => candidate.reversesEntryId === row.id) ?? null
          }));
        }
        return rows;
      }),
      create: vi.fn(async ({ data }: any) => {
        const row: Ledger = {
          id: `ledger-${++state.ledgerSeq}`,
          userId: data.userId,
          projectId: data.projectId ?? null,
          operation: data.operation,
          amountCredits: data.amountCredits,
          planCreditsDelta: data.planCreditsDelta ?? 0,
          balanceAfterCredits: data.balanceAfterCredits ?? null,
          entryType: data.entryType,
          status: data.status,
          idempotencyKey: data.idempotencyKey,
          reversesEntryId: data.reversesEntryId ?? null,
          description: data.description ?? null,
          metadata: data.metadata,
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
      findMany: vi.fn(async ({ where }: any) =>
        [...state.entitlements.values()].filter((row) => entitlementMatchesWhere(row, where))
      ),
      findFirst: vi.fn(async ({ where }: any) =>
        [...state.entitlements.values()].find((row) => entitlementMatchesWhere(row, where)) ?? null
      ),
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
          purchaseRecordId: data.purchaseRecordId ?? null,
          startsAt: new Date("2026-06-15T12:00:00.000Z"),
          expiresAt: data.expiresAt ?? null
        };
        state.entitlements.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = state.entitlements.get(where.id);
        if (!row) {
          throw new Error("Entitlement missing");
        }
        Object.assign(row, data);
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

  /** Wipe every table and re-seed the product catalog. Call in `beforeEach`. */
  function reset() {
    state.accounts.clear();
    state.ledger.clear();
    state.entitlements.clear();
    state.products.clear();
    state.purchases.clear();
    state.subscriptions.clear();
    state.usage.clear();
    state.ledgerSeq = 0;
    state.entitlementSeq = 0;
    state.purchaseSeq = 0;
    state.subscriptionSeq = 0;
    state.usageSeq = 0;
    for (const product of TEST_PRODUCTS) {
      state.products.set(product.sku, { ...product });
    }
    vi.clearAllMocks();
  }

  return {
    state,
    prisma,
    reset,
    Prisma: {
      TransactionIsolationLevel: { Serializable: "Serializable" },
      PrismaClientKnownRequestError: class extends Error {
        code = "P2002";
      }
    }
  };
}

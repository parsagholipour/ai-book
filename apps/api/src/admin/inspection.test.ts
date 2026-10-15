import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({ $queryRawUnsafe: vi.fn() }));
vi.mock("@book-maker/db", () => ({ prisma: mockPrisma }));
vi.mock("@book-maker/db/billing", () => ({ getImageQuota: vi.fn(), resolvePlanTier: vi.fn() }));

import { PLAY_ONE_TIME_PRODUCT_FEE_RATE, PLAY_SUBSCRIPTION_FEE_RATE } from "@book-maker/core";
import { listAdminUsers } from "./inspection.js";

function rollupRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    email: "reader@example.com",
    displayName: null,
    status: "ACTIVE",
    createdAt: new Date("2026-10-01T00:00:00Z"),
    availableCredits: 100n,
    planCredits: 0n,
    planCreditsPerPeriod: 0n,
    reservedCredits: 0n,
    lifetimeGranted: 1_250n,
    lifetimeSpent: 1_150n,
    projects: 2n,
    books_completed: 1n,
    cash_micros: 24_980_000n,
    cash_net_micros: 21_233_000,
    subscription_status: "ACTIVE",
    last_activity: null,
    total: 1n,
    ...overrides
  };
}

beforeEach(() => {
  mockPrisma.$queryRawUnsafe.mockReset();
});

describe("the users list's Paid column", () => {
  it("is net of Google's fee per product type, with the gross beside it, as the inspector reads it", async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([rollupRow()]);

    const { users } = await listAdminUsers({});

    expect(users[0]).toMatchObject({ cashUsd: 24.98, cashNetUsd: 21.23 });
    const [sql, ...params] = mockPrisma.$queryRawUnsafe.mock.calls[0]!;
    // The fee rates are core's, passed in rather than restated in SQL.
    expect(params.slice(3)).toEqual([PLAY_SUBSCRIPTION_FEE_RATE, PLAY_ONE_TIME_PRODUCT_FEE_RATE]);
    expect(sql).toMatch(/"productType"::text = 'SUBSCRIPTION' THEN \$4::float8 ELSE \$5::float8/);
    // A refund is clamped to its order, as summarizePayments clamps it.
    expect(sql).toContain('LEAST(GREATEST(pr."refundedAmountMicros", 0), pr."amountMicros")');
  });

  it("sorts by what was kept after Google's fee, and reads a reader who never paid as $0", async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([rollupRow({ cash_micros: null, cash_net_micros: null })]);

    const { users } = await listAdminUsers({ sort: "cash" });

    expect(users[0]).toMatchObject({ cashUsd: 0, cashNetUsd: 0 });
    expect(mockPrisma.$queryRawUnsafe.mock.calls[0]![0]).toContain("ORDER BY cash_net_micros DESC NULLS LAST");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({ $queryRaw: vi.fn() }));
vi.mock("@book-maker/db", () => ({ prisma: mockPrisma }));

import {
  INTRO_RENEWAL_DUE_DAYS,
  loadChurn,
  loadGrowthPayments,
  loadIntroConversion,
  summarizeChurn,
  summarizeRevenueByCountry,
  summarizeSkuCash,
  utcMonths,
  type PlanSpan
} from "./growthMonetization.js";

const window = { days: 90, since: new Date("2026-07-15T00:00:00Z"), until: new Date("2026-10-13T12:00:00Z") };

function payment(overrides: Partial<Parameters<typeof summarizeSkuCash>[0][number]> = {}) {
  return {
    userId: "u1",
    paidAt: new Date("2026-10-01T00:00:00Z"),
    amountMicros: 19_990_000n,
    refundedAmountMicros: 0n,
    localPriceMicros: null,
    localCurrency: null,
    localPriceSource: null,
    productType: "SUBSCRIPTION",
    sku: "tomeza.creator_monthly",
    country: "US",
    ...overrides
  };
}

beforeEach(() => {
  mockPrisma.$queryRaw.mockReset();
});

describe("cash per product", () => {
  it("reports gross and net of Google's fee, refunds taken off first", () => {
    const rows = [
      payment(),
      payment({ userId: "u2" }),
      payment({ userId: "u2", sku: "tomeza.credit_pack_1", productType: "CREDIT_PACK", amountMicros: 4_990_000n, refundedAmountMicros: 4_990_000n })
    ];

    expect(summarizeSkuCash(rows)).toEqual([
      { sku: "tomeza.creator_monthly", payments: 2, buyers: 2, cashUsd: 39.98, netUsd: 33.98 },
      { sku: "tomeza.credit_pack_1", payments: 1, buyers: 1, cashUsd: 0, netUsd: 0 }
    ]);
  });
});

describe("revenue by signup country", () => {
  it("groups by the country recorded at signup, keeps local currencies apart and puts unknown last", () => {
    const rows = [
      payment({ country: null, userId: "u9" }),
      payment({ country: "TR", userId: "u3", localPriceMicros: 299_990_000n, localCurrency: "TRY", localPriceSource: "client" }),
      payment({ country: "TR", userId: "u3", localPriceMicros: 299_990_000n, localCurrency: "try", refundedAmountMicros: 9_995_000n }),
      payment({ country: "US", userId: "u1", productType: "CREDIT_PACK", sku: "tomeza.credit_pack_1", amountMicros: 4_990_000n })
    ];

    const result = summarizeRevenueByCountry(rows);

    expect(result.map((row) => row.country)).toEqual(["TR", "US", null]);
    expect(result[0]).toMatchObject({ orders: 2, buyers: 1, collectedUsd: 29.99, netUsd: 25.49 });
    expect(result[0]?.byCurrency).toEqual([{ currency: "TRY", orders: 2, localKept: 449.99 }]);
    expect(result[1]).toMatchObject({ orders: 1, collectedUsd: 4.99, netUsd: 4.24 });
    expect(result[1]?.byCurrency).toEqual([{ currency: null, orders: 1, localKept: 0 }]);
  });

  it("reads one row per payment with its product and signup country", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        user_id: "u1",
        paid_at: new Date("2026-10-01T00:00:00Z"),
        amount_micros: 19_990_000n,
        refunded_micros: 0n,
        local_micros: null,
        local_currency: null,
        local_source: null,
        sku: "tomeza.creator_monthly",
        product_type: "SUBSCRIPTION",
        country: " de "
      }
    ]);

    const rows = await loadGrowthPayments(window);

    expect(rows[0]).toMatchObject({ userId: "u1", sku: "tomeza.creator_monthly", productType: "SUBSCRIPTION", country: "DE" });
    const sql = Array.from(mockPrisma.$queryRaw.mock.calls[0]?.[0] as readonly string[]).join("?");
    expect(sql).toContain('"WelcomeCreditGrant"');
    expect(sql).toContain('p."paidAt" >= ?');
  });
});

describe("intro conversion", () => {
  it("counts an intro as due only once its full-price charge should have landed", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ sku: "tomeza.creator_monthly", intros: 5n, due: 3n, renewed: 2n }]);
    const now = new Date("2026-10-13T00:00:00Z");

    expect(await loadIntroConversion(window, now)).toEqual([{ sku: "tomeza.creator_monthly", intros: 5, due: 3, renewed: 2 }]);

    const [strings, ...values] = mockPrisma.$queryRaw.mock.calls[0] as [readonly string[], ...unknown[]];
    const sql = Array.from(strings).join("?");
    expect(sql).toContain('"amountSource" IN (?, ?)');
    expect(sql).toContain("f.\"refundedAmountMicros\" < f.\"amountMicros\"");
    expect(values).toContain("intro_offer");
    expect(values).toContainEqual(new Date(now.getTime() - INTRO_RENEWAL_DUE_DAYS * 86_400_000));
    expect(values).toContain("local-admin");
  });
});

describe("churn", () => {
  const span = (userId: string, startsAt: string, status: string, expiresAt: string | null): PlanSpan => ({
    userId,
    status,
    startsAt: new Date(startsAt),
    expiresAt: expiresAt === null ? null : new Date(expiresAt),
    updatedAt: new Date(expiresAt ?? startsAt)
  });
  const months = utcMonths(new Date("2026-08-20T00:00:00Z"), new Date("2026-10-13T00:00:00Z"));
  const now = new Date("2026-10-13T00:00:00Z");

  it("lists every UTC month the window touches", () => {
    expect(months.map((month) => month.toISOString())).toEqual([
      "2026-08-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z"
    ]);
  });

  it("counts readers who held a paid plan as a month opened and none as it closed", () => {
    const result = summarizeChurn(
      [
        // Held throughout, renewing in place.
        span("steady", "2026-06-01T00:00:00Z", "ACTIVE", "2026-10-30T00:00:00Z"),
        // Lapsed in September.
        span("lapsed", "2026-07-10T00:00:00Z", "EXPIRED", "2026-09-10T00:00:00Z"),
        // Refunded in August.
        span("refunded", "2026-07-20T00:00:00Z", "REVOKED", "2026-08-05T00:00:00Z"),
        // Upgraded mid-September: one plan ends as the other starts, not churn.
        span("upgrader", "2026-07-01T00:00:00Z", "EXPIRED", "2026-09-15T00:00:00Z"),
        span("upgrader", "2026-09-15T00:00:00Z", "ACTIVE", "2026-10-15T00:00:00Z"),
        // New in October, still running although its period end has passed:
        // an ACTIVE plan is held until Google says otherwise.
        span("newcomer", "2026-10-02T00:00:00Z", "ACTIVE", "2026-10-05T00:00:00Z")
      ],
      months,
      now
    );

    expect(result).toEqual([
      { month: "2026-08", activeAtStart: 4, ended: 1, refunded: 1, started: 0, partial: false },
      { month: "2026-09", activeAtStart: 3, ended: 1, refunded: 0, started: 0, partial: false },
      { month: "2026-10", activeAtStart: 2, ended: 0, refunded: 0, started: 1, partial: true }
    ]);
  });

  it("reads paid plans only and leaves the console's user out", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);

    const result = await loadChurn(window, new Date("2026-10-13T12:00:00Z"));

    expect(result.map((month) => month.month)).toEqual(["2026-07", "2026-08", "2026-09", "2026-10"]);
    const [strings, ...values] = mockPrisma.$queryRaw.mock.calls[0] as [readonly string[], ...unknown[]];
    const sql = Array.from(strings).join("?");
    expect(sql).toContain("e.source = 'google_play_subscription'");
    expect(sql).toContain("'CREATOR_PLAN', 'PRO_PLAN', 'MAX_PLAN'");
    expect(values).toContain("local-admin");
  });
});

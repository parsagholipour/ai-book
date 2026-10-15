import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({ $queryRawUnsafe: vi.fn() }));
vi.mock("@book-maker/db", () => ({ prisma: mockPrisma }));

import {
  creditValuationSummary,
  grantRate,
  loadOutstandingPaidCredits,
  loadValuedSpends,
  lotsFromGrants,
  remainingPaidValue,
  sumValued,
  valueSpend,
  type GrantLotRow,
  type SpendRow,
  type UserLots
} from "./creditValuation.js";

/** Google's cut is 15% on both kinds of product. */
const CREATOR = (19.99 * 0.85) / 6_000;
const PRO = (39.99 * 0.85) / 15_000;
const INTRO = (9.99 * 0.85) / 4_000;
const PACK_1 = (7.99 * 0.85) / 1_000;
const PACK_2 = (14.99 * 0.85) / 2_000;

const day = (n: number) => new Date(Date.UTC(2026, 9, n, 12));

const CATALOG = {
  "tomeza.creator_monthly": { product_type: "SUBSCRIPTION", price_micros: 19_990_000, product_credits: 6_000 },
  "tomeza.pro_monthly": { product_type: "SUBSCRIPTION", price_micros: 39_990_000, product_credits: 15_000 },
  "tomeza.credit_pack_1": { product_type: "CREDIT_PACK", price_micros: 7_990_000, product_credits: 1_000 },
  "tomeza.credit_pack_2": { product_type: "CREDIT_PACK", price_micros: 14_990_000, product_credits: 2_000 }
} as const;

function grant(
  at: Date,
  operation: string,
  amount: number,
  options: { sku?: keyof typeof CATALOG; allowance?: boolean; basis?: string; reversed?: number; noProductRow?: boolean } = {}
): GrantLotRow {
  const product = options.sku && !options.noProductRow ? CATALOG[options.sku] : null;
  return {
    user_id: "reader",
    created_at: at,
    operation,
    amount_credits: amount,
    plan_credits: options.allowance ? amount : 0,
    reversed_credits: options.reversed ?? null,
    reversed_plan_credits: options.reversed ? 0 : null,
    allowance_basis: options.basis ?? null,
    sku: options.sku ?? null,
    product_type: product?.product_type ?? null,
    price_micros: product?.price_micros ?? null,
    product_credits: product?.product_credits ?? null
  };
}

const welcome = (at: Date, credits = 1_150) => grant(at, "WELCOME_GRANT", credits);
const plan = (at: Date, sku: keyof typeof CATALOG = "tomeza.creator_monthly", credits = 6_000, basis?: string) =>
  grant(at, "SUBSCRIPTION_CREDIT_GRANT", credits, { sku, allowance: true, ...(basis ? { basis } : {}) });
const pack = (at: Date, sku: keyof typeof CATALOG = "tomeza.credit_pack_1", credits = 1_000, reversed?: number) =>
  grant(at, "PURCHASE_CREDIT_GRANT", credits, { sku, ...(reversed ? { reversed } : {}) });

type Charge = { at: Date; credits: number; fromAllowance?: number; refunded?: number };

/**
 * One reader's charges in order, with `purchased_before` accumulated exactly as
 * the SQL window does: each charge's bought share, net of its refund.
 */
function charges(list: Charge[]): SpendRow[] {
  let before = 0;
  return list.map((charge, index) => {
    const allowance = Math.min(charge.fromAllowance ?? 0, charge.credits);
    const refunded = charge.refunded ?? 0;
    const row: SpendRow = {
      id: `spend-${index}`,
      user_id: "reader",
      created_at: charge.at,
      operation: "FULL_BOOK_GENERATION",
      project_id: "book",
      gross: charge.credits,
      allowance,
      refunded,
      purchased_before: before
    };
    before += ((charge.credits - allowance) * Math.max(charge.credits - refunded, 0)) / charge.credits;
    return row;
  });
}

function lotsOf(grants: GrantLotRow[]): UserLots {
  return lotsFromGrants(grants).get("reader")!;
}

const total = (rows: SpendRow[], lots: UserLots | undefined) =>
  rows.map((row) => valueSpend(row, lots)).reduce((sum, value) => sum + value.usd, 0);

describe("valuing a charge by where its credits came from", () => {
  it("values a free reader's welcome credits at nothing, however much they spend", () => {
    const lots = lotsOf([welcome(day(1))]);
    const rows = charges([
      { at: day(1), credits: 650 },
      { at: day(3), credits: 500 }
    ]);

    expect(rows.map((row) => valueSpend(row, lots))).toEqual([
      { usd: 0, refundedUsd: 0, paidCredits: 0 },
      { usd: 0, refundedUsd: 0, paidCredits: 0 }
    ]);
    // A reader with no grants on record was never paid, and is not even read.
    expect(valueSpend(rows[0]!, undefined)).toEqual({ usd: 0, refundedUsd: 0, paidCredits: 0 });
  });

  it("values a Creator subscriber's allowance at the plan's price over its allowance, after Google's fee", () => {
    const lots = lotsOf([welcome(day(1)), plan(day(2))]);
    const [charge] = charges([{ at: day(5), credits: 1_000, fromAllowance: 1_000 }]);

    const value = valueSpend(charge!, lots);

    expect(value.usd).toBeCloseTo(1_000 * CREATOR, 9);
    expect(value.paidCredits).toBe(1_000);
  });

  it("values an intro month at the intro's own price and credits, and the renewal at the plan's", () => {
    const lots = lotsOf([plan(day(1), "tomeza.creator_monthly", 4_000, "intro_offer"), plan(day(31))]);
    const rows = charges([
      { at: day(10), credits: 4_000, fromAllowance: 4_000 },
      { at: new Date(Date.UTC(2026, 10, 2)), credits: 6_000, fromAllowance: 6_000 }
    ]);

    expect(valueSpend(rows[0]!, lots).usd).toBeCloseTo(4_000 * INTRO, 9);
    expect(valueSpend(rows[1]!, lots).usd).toBeCloseTo(6_000 * CREATOR, 9);
  });

  it("values a prorated switch at its plan's full-period rate", () => {
    const lots = lotsOf([plan(day(1), "tomeza.pro_monthly", 4_500, "prorated")]);
    const [charge] = charges([{ at: day(2), credits: 4_500, fromAllowance: 4_500 }]);

    expect(valueSpend(charge!, lots).usd).toBeCloseTo(4_500 * PRO, 9);
  });

  it("spends a pack buyer's welcome credits first, then values the pack at its own rate", () => {
    const lots = lotsOf([welcome(day(1)), pack(day(10))]);
    const rows = charges([
      { at: day(2), credits: 1_150 },
      { at: day(11), credits: 600 },
      { at: day(12), credits: 400 }
    ]);

    const values = rows.map((row) => valueSpend(row, lots));
    expect(values[0]!.usd).toBe(0);
    expect(values[1]!.usd).toBeCloseTo(600 * PACK_1, 9);
    expect(values[2]!.usd).toBeCloseTo(400 * PACK_1, 9);
    // Everything the reader paid for, and nothing more, once the pool is spent.
    expect(total(rows, lots)).toBeCloseTo(1_000 * PACK_1, 9);
  });

  it("splits a charge that straddles the end of the welcome credits and the start of a pack", () => {
    const lots = lotsOf([welcome(day(1)), pack(day(2), "tomeza.credit_pack_2", 2_000)]);
    const [charge] = charges([{ at: day(3), credits: 1_400 }]);

    const value = valueSpend(charge!, lots);

    expect(value.usd).toBeCloseTo(250 * PACK_2, 9);
    expect(value.paidCredits).toBe(250);
  });

  it("does not value a charge against a pack bought after it", () => {
    const lots = lotsOf([welcome(day(1), 500), pack(day(5))]);
    // Only possible past the welcome grant if the pool came from elsewhere;
    // either way the pack did not exist yet.
    const [charge] = charges([{ at: day(2), credits: 800 }]);

    expect(valueSpend(charge!, lots).usd).toBe(0);
  });

  it("values a mixed reader's allowance and bought shares each at their own source", () => {
    const lots = lotsOf([welcome(day(1)), pack(day(2)), plan(day(3))]);
    const rows = charges([
      // The allowance goes first; the rest comes off the bought pool, welcome first.
      { at: day(4), credits: 7_000, fromAllowance: 6_000 },
      { at: day(5), credits: 500 }
    ]);

    const [first, second] = rows.map((row) => valueSpend(row, lots));
    expect(first!.usd).toBeCloseTo(6_000 * CREATOR, 9);
    expect(first!.paidCredits).toBe(6_000);
    // 1,000 of the 1,150 welcome credits went with the first charge.
    expect(second!.usd).toBeCloseTo(350 * PACK_1, 9);
    expect(second!.paidCredits).toBe(350);
  });

  it("keeps a refunded charge's rate and counts only the part that stuck as delivered", () => {
    const lots = lotsOf([plan(day(1))]);
    const [charge] = charges([{ at: day(2), credits: 200, fromAllowance: 200, refunded: 120 }]);

    const value = valueSpend(charge!, lots);

    expect(value.usd).toBeCloseTo(80 * CREATOR, 9);
    expect(value.refundedUsd).toBeCloseTo(120 * CREATOR, 9);
    expect(value.paidCredits).toBeCloseTo(80, 9);
  });

  it("does not let a refunded charge use up the bought pool", () => {
    const lots = lotsOf([pack(day(1))]);
    const rows = charges([
      { at: day(2), credits: 1_000, refunded: 1_000 },
      { at: day(3), credits: 1_000 }
    ]);

    expect(valueSpend(rows[0]!, lots).usd).toBe(0);
    expect(valueSpend(rows[1]!, lots).usd).toBeCloseTo(1_000 * PACK_1, 9);
  });

  it("drops the credits Google took back from a store-refunded pack", () => {
    const lots = lotsOf([welcome(day(1), 100), pack(day(2), "tomeza.credit_pack_1", 1_000, 1_000), pack(day(3), "tomeza.credit_pack_2", 2_000)]);
    const [charge] = charges([{ at: day(4), credits: 600 }]);

    // 100 welcome credits, then the second pack: the refunded one is not in the pool.
    expect(valueSpend(charge!, lots).usd).toBeCloseTo(500 * PACK_2, 9);
  });

  it("values bought-pool credits beyond every grant at the reader's latest paid rate", () => {
    // An allowance refunded after its period ended lands in the bought pool.
    const lots = lotsOf([welcome(day(1), 100), plan(day(2))]);
    const [charge] = charges([{ at: day(3), credits: 300 }]);

    expect(valueSpend(charge!, lots).usd).toBeCloseTo(200 * CREATOR, 9);
  });

  it("prices a grant whose catalog row is gone from the compiled catalog", () => {
    expect(grantRate(grant(day(1), "PURCHASE_CREDIT_GRANT", 1_000, { sku: "tomeza.credit_pack_1", noProductRow: true })))
      .toEqual({ usdPerCredit: expect.closeTo(PACK_1, 9), source: "pack" });
    expect(grantRate(grant(day(1), "ADMIN_GRANT", 5_000))).toEqual({ usdPerCredit: 0, source: "operator" });
    expect(grantRate(grant(day(1), "PLAN_ALLOWANCE_GRANT", 300, { allowance: true }))).toEqual({
      usdPerCredit: 0,
      source: "free_allowance"
    });
  });
});

describe("paid credits still unspent", () => {
  it("are the pack credits left after the welcome credits were used first", () => {
    const lots = lotsOf([welcome(day(1)), pack(day(2))]);

    const remaining = remainingPaidValue(lots, 1_500);

    expect(remaining.credits).toBe(650);
    expect(remaining.usd).toBeCloseTo(650 * PACK_1, 9);
    expect(remainingPaidValue(lots, 0).credits).toBe(1_000);
    expect(remainingPaidValue(lots, 5_000)).toEqual({ credits: 0, usd: 0 });
  });
});

describe("loading valued charges", () => {
  beforeEach(() => {
    mockPrisma.$queryRawUnsafe.mockReset();
  });

  it("asks for nothing when there is no project to value", async () => {
    expect(await loadValuedSpends({ kind: "projects", projectIds: [] })).toEqual([]);
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("reads only paying readers' charges, then their grants, and values each charge", async () => {
    const [charge] = charges([{ at: day(5), credits: 1_000, fromAllowance: 1_000 }]);
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ ...charge, operation: "PAGE_REGENERATION" }])
      .mockResolvedValueOnce([plan(day(1))]);
    const since = day(1);
    const until = day(30);

    const valued = await loadValuedSpends({ kind: "window", since, until });

    expect(valued).toEqual([
      expect.objectContaining({
        userId: "reader",
        operation: "PAGE_REGENERATION",
        projectId: "book",
        grossCredits: 1_000,
        refundedCredits: 0,
        usd: expect.closeTo(1_000 * CREATOR, 9)
      })
    ]);
    const [spendSql, ...spendParams] = mockPrisma.$queryRawUnsafe.mock.calls[0]!;
    expect(spendParams).toEqual([since, until]);
    expect(spendSql).toContain('e."createdAt" >= $1::timestamptz AND e."createdAt" <= $2::timestamptz');
    expect(spendSql).toContain('FROM "PurchaseRecord" pr');
    expect(spendSql).toContain("ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING");
    const [grantSql, userIds] = mockPrisma.$queryRawUnsafe.mock.calls[1]!;
    expect(grantSql).toContain(`g."userId" = ANY($1::text[])`);
    expect(userIds).toEqual(["reader"]);
  });

  it("scopes to projects and an operation with bound parameters, and skips the grants when no paying reader charged", async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);

    expect(await loadValuedSpends({ kind: "projects", projectIds: ["a", "b"], operation: "PLAN_GENERATION" })).toEqual([]);

    const [sql, ...params] = mockPrisma.$queryRawUnsafe.mock.calls[0]!;
    expect(sql).toContain('e."projectId" IN ($1, $2) AND e.operation::text = $3');
    expect(params).toEqual(["a", "b", "PLAN_GENERATION"]);
    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it("sums what pack buyers have bought and not yet spent", async () => {
    mockPrisma.$queryRawUnsafe.mockImplementation(async (sql: string) =>
      sql.includes("consumed") ? [{ user_id: "reader", consumed: 1_500 }] : [welcome(day(1)), pack(day(2))]
    );

    const outstanding = await loadOutstandingPaidCredits();

    expect(outstanding.credits).toBe(650);
    expect(outstanding.usd).toBeCloseTo(650 * PACK_1, 9);
  });
});

describe("summing and explaining", () => {
  it("sums valued charges by key", () => {
    const base = { userId: "u", createdAt: day(1), projectId: null, grossCredits: 1, refundedCredits: 0, refundedUsd: 0, paidCredits: 1 };
    const totals = sumValued(
      [
        { ...base, operation: "A", usd: 1 },
        { ...base, operation: "A", usd: 2 },
        { ...base, operation: "B", usd: 4 }
      ],
      (spend) => spend.operation
    );

    expect(totals.get("A")?.usd).toBe(3);
    expect(totals.get("B")?.usd).toBe(4);
  });

  it("states the method and the rates it reads, welcome credits at nothing", () => {
    const summary = creditValuationSummary();

    expect(summary.method).toContain("net of Google's fee (15% on subscriptions, 15% on packs)");
    expect(summary.rates).toEqual(
      expect.arrayContaining([
        { key: "tomeza.creator_monthly", label: "Creator", usdPerCredit: expect.closeTo(CREATOR, 9) },
        { key: "tomeza.creator_monthly:creator-intro-first-month", label: "Creator intro offer", usdPerCredit: expect.closeTo(INTRO, 9) },
        { key: "welcome", label: "Welcome credits", usdPerCredit: 0 }
      ])
    );
    expect(summary.cheapestPaidUsdPerCredit).toBeCloseTo(INTRO, 9);
  });
});

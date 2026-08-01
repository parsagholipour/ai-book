import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CREDIT_COSTS, resetCreditPricing } from "@book-maker/core";

const fakeDb = await vi.hoisted(async () => (await import("./testing/billingTestDb.js")).createBillingTestDb());

vi.mock("./client.ts", () => ({
  prisma: fakeDb.prisma,
  Prisma: fakeDb.Prisma
}));

const {
  commitReservedCredits,
  consumeIllustratedBookUse,
  ensureCurrentPlanPeriod,
  getCreditBalance,
  getImageQuota,
  grantCredits,
  refundCreditLedgerEntry,
  releaseIllustratedBookUse,
  reserveCredits,
  resolvePlanTier
} = await import("./billing.js");

const ALLOWANCE = DEFAULT_CREDIT_COSTS.freeMonthlyCredits;
const JUNE = new Date("2026-06-15T12:00:00.000Z");
const JULY = new Date("2026-07-04T12:00:00.000Z");

describe("monthly plan allowance", () => {
  beforeEach(() => {
    fakeDb.reset();
    resetCreditPricing();
  });

  it("grants the free monthly allowance on first use and only once a month", async () => {
    await ensureCurrentPlanPeriod("user-a", JUNE);
    await ensureCurrentPlanPeriod("user-a", new Date("2026-06-28T09:00:00.000Z"));

    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      availableCredits: ALLOWANCE,
      planCredits: ALLOWANCE,
      planCreditsPerPeriod: ALLOWANCE,
      purchasedCredits: 0
    });
    expect([...fakeDb.state.ledger.values()].filter((entry) => entry.operation === "PLAN_ALLOWANCE_GRANT")).toHaveLength(1);
    expect(await resolvePlanTier("user-a", JUNE)).toBe("free");
  });

  it("resets rather than accumulates, writing off what went unused", async () => {
    await ensureCurrentPlanPeriod("user-a", JUNE);
    await reserveCredits({
      userId: "user-a",
      operation: "EXPORT_UNLOCK",
      amountCredits: 400,
      idempotencyKey: "reserve:june",
      now: JUNE
    });
    await ensureCurrentPlanPeriod("user-a", JULY);

    // What was left in June does not carry into July.
    expect(await getCreditBalance("user-a", JULY)).toMatchObject({
      planCredits: ALLOWANCE,
      availableCredits: ALLOWANCE
    });
    const forfeiture = [...fakeDb.state.ledger.values()].find((entry) => entry.entryType === "ADJUSTMENT");
    expect(forfeiture).toMatchObject({ amountCredits: -(ALLOWANCE - 400), planCreditsDelta: -(ALLOWANCE - 400) });
  });

  it("treats a lapsed subscriber's leftover allowance as already gone", async () => {
    // A paid period that ran out before the renewal was verified. The entitlement
    // is still active, so nothing re-grants — and last period's credits must not
    // be spendable in the meantime.
    fakeDb.state.accounts.set("user-a", {
      userId: "user-a",
      availableCredits: 200,
      reservedCredits: 0,
      lifetimeCreditsGranted: 6000,
      lifetimeCreditsSpent: 0,
      planCredits: 5000,
      planCreditsPerPeriod: 6000,
      planPeriodStart: new Date("2026-05-15T00:00:00.000Z"),
      planPeriodEnd: new Date("2026-06-15T00:00:00.000Z"),
      planPeriodKey: "sub:token:2026-06-15T00:00:00.000Z"
    });
    fakeDb.state.entitlements.set("entitlement-plan", {
      id: "entitlement-plan",
      userId: "user-a",
      projectId: null,
      type: "CREATOR_PLAN",
      status: "ACTIVE",
      source: "google_play_subscription",
      creditsCost: 0,
      relatedLedgerEntryId: null,
      purchaseRecordId: null,
      startsAt: new Date("2026-05-15T00:00:00.000Z"),
      expiresAt: new Date("2026-06-20T00:00:00.000Z")
    });

    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      planCredits: 0,
      purchasedCredits: 200,
      availableCredits: 200
    });
  });

  it("spends the allowance before purchased credits", async () => {
    await grantCredits({ userId: "user-a", amountCredits: 500, idempotencyKey: "grant:purchased" });
    const reservation = await reserveCredits({
      userId: "user-a",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: ALLOWANCE + 200,
      idempotencyKey: "reserve:straddle",
      now: JUNE
    });

    // The allowance goes first, because it is the pool that expires.
    expect(reservation).toMatchObject({ amountCredits: -(ALLOWANCE + 200), planCreditsDelta: -ALLOWANCE });
    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      planCredits: 0,
      purchasedCredits: 300,
      availableCredits: 300,
      reservedCredits: ALLOWANCE + 200
    });
  });

  it("returns a same-period refund to the pool it came from", async () => {
    const reservation = await reserveCredits({
      userId: "user-a",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: 600,
      idempotencyKey: "reserve:same-period",
      now: JUNE
    });
    const spend = await commitReservedCredits(reservation!.id);
    await refundCreditLedgerEntry(spend.id, "Generation failed", JUNE);

    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      planCredits: ALLOWANCE,
      purchasedCredits: 0
    });
  });

  it("releases a held reservation back to the allowance within the period", async () => {
    const reservation = await reserveCredits({
      userId: "user-a",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: 250,
      idempotencyKey: "reserve:held",
      now: JUNE
    });
    const released = await refundCreditLedgerEntry(reservation!.id, "Could not be queued", JUNE);

    expect(released).toMatchObject({ entryType: "RELEASE", planCreditsDelta: 0 });
    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      planCredits: ALLOWANCE,
      reservedCredits: 0
    });
  });

  it("routes a refund to the purchased pool once the period has rolled over", async () => {
    const reservation = await reserveCredits({
      userId: "user-a",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: 600,
      idempotencyKey: "reserve:old-period",
      now: JUNE
    });
    const spend = await commitReservedCredits(reservation!.id);
    await ensureCurrentPlanPeriod("user-a", JULY);
    await refundCreditLedgerEntry(spend.id, "Generation failed", JULY);

    // July's allowance is already full; topping it up would hand out more than
    // the plan allows, so the refund lands where it cannot expire instead.
    expect(await getCreditBalance("user-a", JULY)).toMatchObject({
      planCredits: ALLOWANCE,
      purchasedCredits: 600,
      availableCredits: ALLOWANCE + 600
    });
  });

  it("refunds pre-migration entries entirely to the purchased pool", async () => {
    await grantCredits({ userId: "user-a", amountCredits: 900, idempotencyKey: "grant:legacy" });
    const legacy = await reserveCredits({
      userId: "user-a",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: 300,
      idempotencyKey: "reserve:legacy",
      now: JUNE
    });
    // A row written before the pools existed carries no allowance portion.
    const stored = fakeDb.state.ledger.get(legacy!.id)!;
    stored.planCreditsDelta = 0;
    stored.metadata = {};

    // All of it goes to the purchased pool and the live allowance is left exactly
    // as it was, which is the right reading of "this never touched the allowance".
    await refundCreditLedgerEntry(legacy!.id, "Released", JUNE);
    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      purchasedCredits: 1200,
      planCredits: ALLOWANCE - 300
    });
  });
});

describe("illustrated book quota", () => {
  beforeEach(() => {
    fakeDb.reset();
    resetCreditPricing();
  });

  const LIMIT = DEFAULT_CREDIT_COSTS.freeIllustratedBooksPerMonth;

  it("allows the free monthly limit and then refuses", async () => {
    for (let attempt = 1; attempt <= LIMIT; attempt += 1) {
      const result = await consumeIllustratedBookUse({ userId: "user-a", limit: LIMIT, now: JUNE });
      expect(result).toMatchObject({ allowed: true, used: attempt, limit: LIMIT });
    }

    const exhausted = await consumeIllustratedBookUse({ userId: "user-a", limit: LIMIT, now: JUNE });
    expect(exhausted).toMatchObject({ allowed: false, used: LIMIT, limit: LIMIT });
    expect(await getImageQuota("user-a", JUNE)).toMatchObject({
      used: LIMIT,
      limit: LIMIT,
      periodKey: "2026-06",
      resetsAt: new Date("2026-07-01T00:00:00.000Z")
    });
  });

  it("starts over the next month", async () => {
    await consumeIllustratedBookUse({ userId: "user-a", limit: LIMIT, now: JUNE });
    expect(await getImageQuota("user-a", JULY)).toMatchObject({ used: 0, periodKey: "2026-07" });
  });

  it("hands the slot back when the generation it paid for is refunded", async () => {
    const claim = await consumeIllustratedBookUse({ userId: "user-a", limit: LIMIT, now: JUNE });
    const reservation = await reserveCredits({
      userId: "user-a",
      projectId: "project-1",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: 500,
      idempotencyKey: "reserve:illustrated",
      metadata: { imageQuota: { periodKey: claim.periodKey } },
      now: JUNE
    });

    await refundCreditLedgerEntry(reservation!.id, "Could not be queued", JUNE);
    expect(await getImageQuota("user-a", JUNE)).toMatchObject({ used: 0 });
  });

  it("releases at most down to zero", async () => {
    await releaseIllustratedBookUse("user-a", "2026-06");
    expect(await getImageQuota("user-a", JUNE)).toMatchObject({ used: 0 });
  });
});

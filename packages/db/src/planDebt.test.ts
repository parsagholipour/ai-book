import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CREDIT_COSTS, jsonRecord, setCreditPricing } from "@book-maker/core";

const db = await vi.hoisted(async () => (await import("./testing/billingTestDb.js")).createBillingTestDb());
vi.mock("./client.ts", () => ({ prisma: db.prisma, Prisma: db.Prisma }));
const billing = await import("./billing.js");

/**
 * A store refund of credits already spent leaves the purchased pool negative.
 * These pin that the debt is paid once — first by the allowance it was hiding,
 * then out of the next allowance — and never taken out of every later period.
 */

const USER = "user-a";
const CREATOR = 6000;
const HOUR = 60 * 60 * 1000;

const pack = (quantity = 1) => ({
  productSku: "tomeza.one_book_export",
  purchaseToken: "pack-token",
  kind: "one_time" as const,
  grantable: true,
  providerStatus: "PURCHASED",
  externalPurchaseId: "GPA.pack",
  quantity
});
const packRefund = { purchaseToken: "pack-token", orderId: "GPA.pack", productType: 2 as const };

/** Creator period `n`, counted in months from October 2026, each paid by its own Play order. */
function creatorPeriod(n: number) {
  return {
    start: new Date(Date.UTC(2026, 9 + n, 1)),
    end: new Date(Date.UTC(2026, 10 + n, 1)),
    orderId: `GPA.creator..${n}`
  };
}

/** The app's verify or the renewal sweep recording period `n`, an hour into it. */
async function verifyCreator(n: number, orderId = creatorPeriod(n).orderId) {
  const { start, end } = creatorPeriod(n);
  vi.setSystemTime(new Date(start.getTime() + HOUR));
  return billing.recordVerifiedGooglePlayPurchase({
    userId: USER,
    verification: {
      productSku: "tomeza.creator_monthly",
      purchaseToken: "creator-token",
      kind: "subscription",
      grantable: true,
      providerStatus: "SUBSCRIPTION_STATE_ACTIVE",
      externalPurchaseId: orderId,
      subscription: { status: "ACTIVE", currentPeriodStart: start, currentPeriodEnd: end, autoRenewing: true }
    }
  });
}

const refundCreatorOrder = (n: number) =>
  billing.recordGooglePlayRefund({ purchaseToken: "creator-token", orderId: creatorPeriod(n).orderId, productType: 1 });

const balance = () => billing.getCreditBalance(USER);

const spend = (amountCredits: number, idempotencyKey: string) =>
  billing.spendCredits({ userId: USER, amountCredits, operation: "FULL_BOOK_GENERATION", idempotencyKey });

/** Owe `debt` credits on a free account: buy packs, spend `debt` of them, have the purchase refunded. */
async function owe(debt: number) {
  await billing.recordVerifiedGooglePlayPurchase({ userId: USER, verification: pack(Math.ceil(debt / 1000)) });
  await spend(debt, "pack-book");
  await billing.recordGooglePlayRefund(packRefund);
  expect(await balance()).toMatchObject({ purchasedCredits: -debt, planCredits: 0 });
}

const ledger = () => [...db.state.ledger.values()];
const settlements = () =>
  ledger().filter((entry) => entry.entryType === "ADJUSTMENT" && jsonRecord(entry.metadata).planDebtSettlement);
const expirations = () =>
  ledger().filter((entry) => entry.entryType === "ADJUSTMENT" && "expiredPlanPeriodKey" in jsonRecord(entry.metadata));

describe("refund debt against a plan allowance", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    db.reset();
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, welcomeCreditsEnabled: 0, freeMonthlyCredits: 0 });
  });
  afterEach(() => vi.useRealTimers());

  it("gives a subscriber whose spent month was refunded every later month back", async () => {
    await verifyCreator(0);
    await spend(CREATOR, "october-book");
    await verifyCreator(1);

    // October refunded mid-November: the debt hides November, and only November.
    vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
    await refundCreatorOrder(0);
    expect(await balance()).toMatchObject({ availableCredits: 0, purchasedCredits: -CREATOR, planCredits: CREATOR });

    await verifyCreator(2);
    expect(await balance()).toMatchObject({ availableCredits: CREATOR, purchasedCredits: 0, planCredits: CREATOR });
    await spend(CREATOR, "december-book");

    await verifyCreator(3);
    expect(await balance()).toMatchObject({ availableCredits: CREATOR, purchasedCredits: 0, planCredits: CREATOR });

    // November's allowance, which the debt kept out of reach, paid it instead of
    // expiring, so December was not taxed for it a second time.
    expect(settlements()).toEqual([
      expect.objectContaining({ amountCredits: 0, planCreditsDelta: -CREATOR, balanceAfterCredits: 0 })
    ]);
    expect(expirations()).toEqual([]);
  });

  it("settles a refunded pack's debt once from the first allowance after it", async () => {
    await owe(800);

    await verifyCreator(1);
    expect(await balance()).toMatchObject({ availableCredits: 5200, purchasedCredits: 0, planCredits: 5200 });
    await spend(5200, "first-month");

    await verifyCreator(2);
    expect(await balance()).toMatchObject({ availableCredits: CREATOR, purchasedCredits: 0, planCredits: CREATOR });
    await spend(CREATOR, "second-month");
    await verifyCreator(3);
    expect(await balance()).toMatchObject({ availableCredits: CREATOR, planCredits: CREATOR });

    expect(settlements()).toEqual([
      expect.objectContaining({ amountCredits: 0, planCreditsDelta: -800, operation: "SUBSCRIPTION_CREDIT_GRANT" })
    ]);
    // The grant itself still records the whole allowance: a refund of this
    // period has to reverse all of it, including the part that paid the debt.
    const grant = ledger().find((entry) => entry.entryType === "GRANT" && entry.amountCredits === CREATOR);
    expect(grant).toMatchObject({ planCreditsDelta: CREATOR, balanceAfterCredits: 5200 });
    expect(expirations()).toEqual([]);
  });

  it("spreads a debt larger than one allowance over the periods it takes", async () => {
    await owe(9000);

    await verifyCreator(1);
    expect(await balance()).toMatchObject({ availableCredits: -3000, purchasedCredits: -3000, planCredits: 0 });

    await verifyCreator(2);
    expect(await balance()).toMatchObject({ availableCredits: 3000, purchasedCredits: 0, planCredits: 3000 });

    await spend(3000, "second-month");
    await verifyCreator(3);
    expect(await balance()).toMatchObject({ availableCredits: CREATOR, purchasedCredits: 0, planCredits: CREATOR });
    expect(settlements().map((entry) => entry.planCreditsDelta)).toEqual([-CREATOR, -3000]);
  });

  it("pays a debt from the hidden remainder first and the next allowance for the rest", async () => {
    await verifyCreator(0);
    await spend(CREATOR, "october-book");
    await verifyCreator(1);
    await spend(2000, "early-november-book");

    vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
    await refundCreatorOrder(0);
    expect(await balance()).toMatchObject({ availableCredits: -2000, purchasedCredits: -CREATOR, planCredits: 4000 });

    await verifyCreator(2);
    expect(await balance()).toMatchObject({ availableCredits: 4000, purchasedCredits: 0, planCredits: 4000 });
    expect(settlements().map((entry) => [entry.planCreditsDelta, jsonRecord(entry.metadata).planDebtSettlement])).toEqual([
      [-4000, expect.objectContaining({ source: "remainder", planPeriodKey: expect.stringContaining("2026-12-01") })],
      [-2000, expect.objectContaining({ source: "allowance", planPeriodKey: expect.stringContaining("2027-01-01") })]
    ]);
    expect(expirations()).toEqual([]);
  });

  it("settles a period's debt once across re-verification, order-id drift and a racing renewal", async () => {
    await owe(800);

    await Promise.all([verifyCreator(1), verifyCreator(1)]);
    await verifyCreator(1);
    await verifyCreator(1, "GPA.creator..1-drifted");

    expect(await balance()).toMatchObject({ availableCredits: 5200, purchasedCredits: 0, planCredits: 5200 });
    expect(settlements()).toHaveLength(1);
  });

  it("leaves a free account's debt alone at every free month", async () => {
    await owe(800);
    vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
    expect(await balance()).toMatchObject({ availableCredits: -800, purchasedCredits: -800, planCredits: 0 });
    vi.setSystemTime(new Date("2026-12-03T12:00:00Z"));
    expect(await balance()).toMatchObject({ availableCredits: -800, purchasedCredits: -800, planCredits: 0 });
    expect(settlements()).toEqual([]);
  });

  it("does not settle again when a cut-short period is adopted onto the free tier", async () => {
    await owe(800);
    await verifyCreator(1);
    await spend(1000, "november-book");

    await billing.endSubscriptionNow(USER, new Date("2026-11-20T09:00:00Z"));

    // The plan's 4,200 left over had nothing to pay off; it expires as before.
    vi.setSystemTime(new Date("2026-11-20T10:00:00Z"));
    expect(await balance()).toMatchObject({ availableCredits: 0, purchasedCredits: 0, planCredits: 0 });
    expect(settlements()).toHaveLength(1);
    expect(expirations()).toEqual([expect.objectContaining({ amountCredits: -4200, planCreditsDelta: -4200 })]);
  });

  it("keeps a mid-period refund's debt until the period ends, then pays it from what it hid", async () => {
    await billing.recordVerifiedGooglePlayPurchase({ userId: USER, verification: pack() });
    await spend(800, "pack-book");
    await verifyCreator(1);
    expect(await balance()).toMatchObject({ availableCredits: 6200, purchasedCredits: 200, planCredits: CREATOR });

    vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
    await billing.recordGooglePlayRefund(packRefund);
    // The allowance is not touched mid-period; the debt only hides part of it.
    expect(await balance()).toMatchObject({ availableCredits: 5200, purchasedCredits: -800, planCredits: CREATOR });
    await spend(5200, "november-book");
    await expect(spend(1, "one-more")).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });

    await verifyCreator(2);
    // Owed 800, lost 800: the hidden 800 paid it, nothing expired, December is whole.
    expect(await balance()).toMatchObject({ availableCredits: CREATOR, purchasedCredits: 0, planCredits: CREATOR });
    expect(settlements()).toEqual([expect.objectContaining({ planCreditsDelta: -800, amountCredits: 0 })]);
    expect(expirations()).toEqual([]);
  });

  it("returns a later refund of a spend from a settled period to the pool it came from", async () => {
    await owe(800);
    await verifyCreator(1);

    const sameMonth = await spend(1000, "refunded-in-november");
    await billing.refundCreditLedgerEntry(sameMonth!.id, "Generation failed");
    expect(await balance()).toMatchObject({ availableCredits: 5200, purchasedCredits: 0, planCredits: 5200 });

    const nextMonth = await spend(1000, "refunded-in-december");
    await verifyCreator(2);
    await billing.refundCreditLedgerEntry(nextMonth!.id, "Generation failed");
    expect(await balance()).toMatchObject({ availableCredits: CREATOR + 1000, purchasedCredits: 1000, planCredits: CREATOR });

    // The settlement moved credits between pools and charged nothing, so there is nothing to refund.
    const settlement = settlements()[0]!;
    expect(await billing.refundCreditLedgerEntry(settlement.id, "Not a charge")).toBeNull();
    expect((await balance()).availableCredits).toBe(CREATOR + 1000);
  });

  it("brings the debt back when the period that paid it is refunded", async () => {
    await owe(800);
    await verifyCreator(1);
    await spend(5200, "november-book");
    await verifyCreator(2);

    vi.setSystemTime(new Date("2026-12-10T12:00:00Z"));
    await refundCreatorOrder(1);
    // November's whole 6,000 was used — 5,200 spent and 800 paying the pack's
    // debt — so none of it is excused as an expired allowance.
    expect(await balance()).toMatchObject({ availableCredits: 0, purchasedCredits: -CREATOR, planCredits: CREATOR });
  });

  it("offsets the debt with welcome credits, which land in the purchased pool", async () => {
    await owe(800);
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, welcomeCreditsEnabled: 1, welcomeCredits: 500, freeMonthlyCredits: 0 });
    db.state.welcomeGrants.set(USER, {
      userId: USER, ipHash: "ip-a", outcome: "PENDING", amountCredits: 0, ledgerEntryId: null,
      createdAt: new Date("2026-10-01T00:00:00Z"), settledAt: null
    });
    expect(await balance()).toMatchObject({ availableCredits: -300, purchasedCredits: -300 });
  });
});

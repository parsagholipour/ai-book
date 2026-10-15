import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CREDIT_COSTS, setCreditPricing } from "@book-maker/core";
import type { VerifiedGooglePlayPurchase } from "./billingSubscriptions.ts";

const db = await vi.hoisted(async () => (await import("./testing/billingTestDb.ts")).createBillingTestDb());
vi.mock("./client.ts", () => ({ prisma: db.prisma, Prisma: db.Prisma }));
const { getCreditBalance, recordVerifiedGooglePlayPurchase, recordGooglePlayRefund } = await import("./billing.ts");

const OCTOBER = new Date("2026-10-04T12:00:00Z");
function subscription(order: string, end: string): VerifiedGooglePlayPurchase {
  return {
    productSku: "tomeza.creator_monthly", purchaseToken: "creator-token", kind: "subscription",
    grantable: true, providerStatus: "SUBSCRIPTION_STATE_ACTIVE", externalPurchaseId: order,
    // Play's startTime stays on the original subscription, including on renewal.
    purchasedAt: OCTOBER,
    subscription: { status: "ACTIVE", currentPeriodStart: OCTOBER, currentPeriodEnd: new Date(end) }
  };
}
const record = (verification: VerifiedGooglePlayPurchase) => recordVerifiedGooglePlayPurchase({ userId: "user-a", verification });
function cash(since = new Date(0), until = new Date("2100-01-01")) {
  return [...db.state.payments.values()].filter((p) => p.paidAt >= since && p.paidAt <= until)
    .reduce((sum, p) => sum + p.amountMicros - p.refundedAmountMicros, 0n);
}

beforeEach(() => {
  db.reset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(OCTOBER);
  setCreditPricing({ ...DEFAULT_CREDIT_COSTS, welcomeCreditsEnabled: 0 });
});
afterEach(() => vi.useRealTimers());

describe("subscription offer phases", () => {
  it("gives a free trial the plan but no credits and no payment", async () => {
    const trial = subscription("order-trial", "2026-10-11T12:00:00Z");
    await record({ ...trial, subscription: { ...trial.subscription!, offerPhase: "free_trial", offerId: "creator-trial" } });
    expect(cash()).toBe(0n);
    expect((await getCreditBalance("user-a")).availableCredits).toBe(0);

    // The first paid period after the trial is a new order and grants in full.
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    await record(subscription("order-first-paid", "2026-11-11T12:00:00Z"));
    expect(cash()).toBe(19_990_000n);
    expect((await getCreditBalance("user-a")).availableCredits).toBe(6_000);
  });

  it("records a known introductory offer at its own price and grants the offer's credits, then the plan's", async () => {
    const intro = subscription("order-intro", "2026-11-04T12:00:00Z");
    await record({ ...intro, subscription: { ...intro.subscription!, offerPhase: "introductory", offerId: "creator-intro-first-month" } });
    expect(cash()).toBe(9_990_000n);
    expect([...db.state.payments.values()][0]).toMatchObject({ amountSource: "intro_offer" });
    // $9.99 for the plan's 6,000 sold a credit a third under the Max floor;
    // the intro grants what its price buys at that floor.
    expect((await getCreditBalance("user-a")).availableCredits).toBe(4_000);
    const grant = [...db.state.ledger.values()].find((entry) => entry.entryType === "GRANT");
    expect(grant?.metadata).toMatchObject({ allowanceBasis: "intro_offer" });

    // The full-price renewal after it grants the plan's allowance as usual.
    vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
    const renewal = subscription("order-renewal", "2026-12-04T12:00:00Z");
    await record({ ...renewal, subscription: { ...renewal.subscription!, offerPhase: "base", offerId: null } });
    expect((await getCreditBalance("user-a")).availableCredits).toBe(6_000);
    expect(cash()).toBe(9_990_000n + 19_990_000n);
  });

  it("grants the plan's allowance for an intro offer it does not know, since nothing says what it cost", async () => {
    const intro = subscription("order-intro", "2026-11-04T12:00:00Z");
    await record({ ...intro, subscription: { ...intro.subscription!, offerPhase: "introductory", offerId: "someone-else" } });
    expect((await getCreditBalance("user-a")).availableCredits).toBe(6_000);
  });

  it("marks an introductory offer it does not know as a catalog estimate", async () => {
    const intro = subscription("order-intro", "2026-11-04T12:00:00Z");
    await record({ ...intro, subscription: { ...intro.subscription!, offerPhase: "introductory", offerId: "someone-else" } });
    expect(cash()).toBe(19_990_000n);
    expect([...db.state.payments.values()][0]).toMatchObject({ amountSource: "catalog_snapshot_unknown_offer" });
  });
});

describe("purchase payment history", () => {
  it("keeps all three paid months after expiration and puts each renewal in its own month", async () => {
    for (const month of [10, 11, 12]) {
      vi.setSystemTime(new Date(`2026-${month}-04T12:00:00Z`));
      const end = month === 12 ? "2027-01-04T12:00:00Z" : `2026-${month + 1}-04T12:00:00Z`;
      const receipt = subscription(`order-${month}`, end);
      await record(receipt);
      await record(receipt);
    }
    vi.setSystemTime(new Date("2027-01-04T12:00:00Z"));
    const expired = subscription("order-12", "2027-01-04T12:00:00Z");
    await record({ ...expired, grantable: false, providerStatus: "SUBSCRIPTION_STATE_EXPIRED", subscription: { ...expired.subscription!, status: "EXPIRED" } });
    expect(cash()).toBe(59_970_000n);
    expect(cash(new Date("2026-11-01"), new Date("2026-11-30T23:59:59Z"))).toBe(19_990_000n);
    expect(db.state.payments.size).toBe(3);
  });

  it("freezes a payment's amount through catalog changes and concurrent restores", async () => {
    const receipt = subscription("order-10", "2026-11-04T12:00:00Z");
    await Promise.all([record(receipt), record(receipt)]);
    db.state.products.get(receipt.productSku)!.priceMicros = 29_990_000n;
    await record(receipt);
    expect(cash()).toBe(19_990_000n);
    expect(db.state.payments.size).toBe(1);
  });

  it("refunds only the named renewal and never refunds it twice", async () => {
    await record(subscription("order-10", "2026-11-04T12:00:00Z"));
    vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
    await record(subscription("order-11", "2026-12-04T12:00:00Z"));
    const refund = { purchaseToken: "creator-token", orderId: "order-10", productType: 1 as const };
    await recordGooglePlayRefund(refund);
    await recordGooglePlayRefund(refund);
    expect(cash()).toBe(19_990_000n);
    expect(db.state.payments.size).toBe(2);
  });

  it("records quantities and cumulative partial refunds for one-time purchases", async () => {
    const receipt: VerifiedGooglePlayPurchase = {
      productSku: "tomeza.one_book_export", purchaseToken: "pack-token", kind: "one_time",
      grantable: true, providerStatus: "PURCHASED", externalPurchaseId: "pack-order", quantity: 3, purchasedAt: OCTOBER
    };
    await record(receipt);
    expect(cash()).toBe(29_970_000n);
    const refund = { purchaseToken: "pack-token", orderId: "pack-order", productType: 2 as const };
    await recordGooglePlayRefund({ ...refund, partialRefund: { quantity: 3, refundableQuantity: 2 } });
    await record(receipt);
    expect(cash()).toBe(19_980_000n);
    await recordGooglePlayRefund(refund);
    await record(receipt);
    expect(cash()).toBe(0n);
    expect(db.state.payments.size).toBe(1);
  });

  it("records an older paid order arriving after renewal without changing current access", async () => {
    await record(subscription("order-new", "2026-12-04T12:00:00Z"));
    await record(subscription("order-old", "2026-11-04T12:00:00Z"));
    expect(cash()).toBe(39_980_000n);
    expect([...db.state.purchases.values()][0]!.externalPurchaseId).toBe("order-new");
  });

  it("keeps a refund delivered before a historical order's verification", async () => {
    await record(subscription("order-new", "2026-12-04T12:00:00Z"));
    await recordGooglePlayRefund({ purchaseToken: "creator-token", orderId: "order-old", productType: 1 });
    await record(subscription("order-old", "2026-11-04T12:00:00Z"));
    expect(cash()).toBe(19_990_000n);
    expect(db.state.payments.size).toBe(2);
  });

  it("keeps paid cash even when the catalog grants zero credits", async () => {
    db.state.products.get("tomeza.creator_monthly")!.creditAmount = 0;
    await record(subscription("order-10", "2026-11-04T12:00:00Z"));
    expect(cash()).toBe(19_990_000n);
  });

  it("does not invent cash from pending purchases or orderless expiry extensions", async () => {
    const receipt = subscription("order-10", "2026-11-04T12:00:00Z");
    await record({ ...receipt, grantable: false, providerStatus: "SUBSCRIPTION_STATE_PENDING", subscription: null });
    await record({ ...receipt, externalPurchaseId: null });
    expect(cash()).toBe(0n);
  });

  it("does not block a paid entitlement when the catalog has no cash price", async () => {
    db.state.products.get("tomeza.creator_monthly")!.priceMicros = null;
    const result = await record(subscription("unpriced-order", "2026-11-04T12:00:00Z"));
    expect(result.status).toBe("GRANTED");
    expect(db.state.payments.size).toBe(0);
  });
});

describe("the buyer's own price", () => {
  it("records the app's report on the payment and on the purchase, without touching the USD amount", async () => {
    const receipt = subscription("order-10", "2026-11-04T12:00:00Z");
    await recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: receipt,
      clientPrice: { micros: 1_090_000_000, currency: "INR" } });
    const [payment] = [...db.state.payments.values()];
    expect(payment).toMatchObject({ amountMicros: 19_990_000n, currency: "USD",
      localPriceMicros: 1_090_000_000n, localCurrency: "INR", localPriceSource: "client" });
    expect([...db.state.purchases.values()][0]).toMatchObject({ localPriceMicros: 1_090_000_000n, localCurrency: "INR" });
    expect((await getCreditBalance("user-a")).availableCredits).toBe(6_000);
  });

  it("never reprices a payment once known, and fills one the sweep recorded without it", async () => {
    const receipt = subscription("order-10", "2026-11-04T12:00:00Z");
    await record(receipt);
    expect([...db.state.payments.values()][0]?.localPriceMicros ?? null).toBeNull();
    await recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: receipt,
      clientPrice: { micros: 18_990_000, currency: "EUR" } });
    await recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: receipt,
      clientPrice: { micros: 1, currency: "JPY" } });
    expect([...db.state.payments.values()][0]).toMatchObject({ localPriceMicros: 18_990_000n, localCurrency: "EUR" });
  });

  it("prices a full-price renewal nobody verified from the app at Google's recurring price", async () => {
    const receipt = subscription("order-10", "2026-11-04T12:00:00Z");
    await record({ ...receipt, subscription: { ...receipt.subscription!, offerPhase: "base",
      recurringPrice: { micros: 899_000_000, currency: "INR" } } });
    expect([...db.state.payments.values()][0]).toMatchObject({
      localPriceMicros: 899_000_000n, localCurrency: "INR", localPriceSource: "play_recurring_price"
    });
  });

  it("does not take the recurring price for an intro period, which charged something else", async () => {
    const receipt = subscription("order-intro", "2026-11-04T12:00:00Z");
    await record({ ...receipt, subscription: { ...receipt.subscription!, offerPhase: "introductory",
      offerId: "creator-intro-first-month", recurringPrice: { micros: 899_000_000, currency: "INR" } } });
    expect([...db.state.payments.values()][0]?.localPriceMicros ?? null).toBeNull();
  });

  it("keeps a pending pack's report for the grant that clears it later without the app", async () => {
    const pack: VerifiedGooglePlayPurchase = {
      productSku: "tomeza.one_book_export", purchaseToken: "pack-token", kind: "one_time",
      grantable: false, providerStatus: "PENDING", externalPurchaseId: null, quantity: 1, purchasedAt: OCTOBER
    };
    await recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: pack,
      clientPrice: { micros: 7_490_000, currency: "GBP" } });
    expect(db.state.payments.size).toBe(0);
    await record({ ...pack, grantable: true, providerStatus: "PURCHASED", externalPurchaseId: "pack-order" });
    expect([...db.state.payments.values()][0]).toMatchObject({ localPriceMicros: 7_490_000n, localCurrency: "GBP" });
  });
});

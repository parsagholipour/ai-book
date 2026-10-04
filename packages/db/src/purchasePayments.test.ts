import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CREDIT_COSTS, setCreditPricing } from "@book-maker/core";
import type { VerifiedGooglePlayPurchase } from "./billingSubscriptions.ts";

const db = await vi.hoisted(async () => (await import("./testing/billingTestDb.ts")).createBillingTestDb());
vi.mock("./client.ts", () => ({ prisma: db.prisma, Prisma: db.Prisma }));
const { recordVerifiedGooglePlayPurchase, recordGooglePlayRefund } = await import("./billing.ts");

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

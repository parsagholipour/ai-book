import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CREDIT_COSTS, setCreditPricing } from "@book-maker/core";

const db = await vi.hoisted(async () => (await import("./testing/billingTestDb.js")).createBillingTestDb());
vi.mock("./client.ts", () => ({ prisma: db.prisma, Prisma: db.Prisma }));
const billing = await import("./billing.js");
const verification = {
  productSku: "tomeza.one_book_export",
  purchaseToken: "refunded-token",
  kind: "one_time" as const,
  grantable: true,
  providerStatus: "PURCHASED",
  externalPurchaseId: "GPA.refunded",
  quantity: 1
};

describe("Google Play refund clawback", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    db.reset();
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, welcomeCreditsEnabled: 0, freeMonthlyCredits: 0 });
  });
  afterEach(() => vi.useRealTimers());

  it("takes back the full grant even after the buyer has spent the credits", async () => {
    await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification });
    await billing.spendCredits({ userId: "user-a", amountCredits: 800,
      operation: "FULL_BOOK_GENERATION", idempotencyKey: "book" });
    await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a",
      verification: { ...verification, grantable: false, providerStatus: "CANCELED" } });
    expect(db.state.accounts.get("user-a")?.availableCredits).toBe(-800);
    expect([...db.state.purchases.values()][0]?.status).toBe("REVOKED");
    await expect(billing.spendCredits({ userId: "user-a", amountCredits: 1,
      operation: "FULL_BOOK_GENERATION", idempotencyKey: "another-book" }))
      .rejects.toBeInstanceOf(billing.InsufficientCreditsError);
  });

  const notice = { purchaseToken: verification.purchaseToken, orderId: verification.externalPurchaseId, productType: 2 as const };

  it("reverses a grant once across duplicate notices and stale purchase verification", async () => {
    await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification });
    await Promise.all([billing.recordGooglePlayRefund(notice), billing.recordGooglePlayRefund(notice)]);
    const replay = await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification });
    expect(replay.status).toBe("REVOKED");
    expect(db.state.accounts.get("user-a")?.availableCredits).toBe(0);
    expect([...db.state.ledger.values()].filter((entry) => entry.reversesEntryId)).toHaveLength(1);
  });

  it("retains a refund before a purchase has an owner and never grants it on a later claim", async () => {
    await billing.recordGooglePlayRefund(notice);
    const result = await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification });
    expect(result.status).toBe("REVOKED");
    expect(result.ledgerEntryId).toBeNull();
    expect([...db.state.ledger.values()]).toHaveLength(0);
  });

  it.each([true, false])("handles a racing refund and first claim (refund first: %s)", async (refundFirst) => {
    const refund = () => billing.recordGooglePlayRefund(notice);
    const claim = () => billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification });
    await Promise.all(refundFirst ? [refund(), claim()] : [claim(), refund()]);
    expect((await billing.getCreditBalance("user-a")).purchasedCredits).toBe(0);
    expect([...db.state.purchases.values()][0]?.status).toBe("REVOKED");
  });

  it("uses the original grant and cumulative quantities, including out-of-order and full refunds", async () => {
    await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: { ...verification, quantity: 5 } });
    db.state.products.get(verification.productSku)!.creditAmount = 12345;
    const partial = (remaining: number) => billing.recordGooglePlayRefund({ ...notice,
      partialRefund: { quantity: 5, refundableQuantity: remaining } });
    await partial(4);
    expect(db.state.accounts.get("user-a")?.availableCredits).toBe(4000);
    await partial(2);
    await partial(4);
    await partial(2);
    expect(db.state.accounts.get("user-a")?.availableCredits).toBe(2000);
    await billing.recordGooglePlayRefund(notice);
    await partial(4);
    expect(db.state.accounts.get("user-a")?.availableCredits).toBe(0);
    expect([...db.state.ledger.values()].find((entry) => entry.reversesEntryId)?.amountCredits).toBe(-5000);
  });

  it("applies a partial refund received before the purchase is claimed", async () => {
    await billing.recordGooglePlayRefund({ ...notice, partialRefund: { quantity: 5, refundableQuantity: 3 } });
    await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: { ...verification, quantity: 5 } });
    await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: { ...verification, quantity: 5 } });
    expect(db.state.accounts.get("user-a")?.availableCredits).toBe(3000);
  });

  it("retains debt through a failed reservation and pays it down with later purchases", async () => {
    await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification });
    const hold = await billing.reserveCredits({ userId: "user-a", amountCredits: 800,
      operation: "FULL_BOOK_GENERATION", idempotencyKey: "held-book" });
    await billing.recordGooglePlayRefund(notice);
    expect(db.state.accounts.get("user-a")?.availableCredits).toBe(-800);
    await billing.refundCreditLedgerEntry(hold!.id, "Generation failed");
    expect(db.state.accounts.get("user-a")?.availableCredits).toBe(0);
    await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: {
      ...verification, purchaseToken: "another-token", externalPurchaseId: "another-order"
    } });
    expect(db.state.accounts.get("user-a")?.availableCredits).toBe(1000);
  });

  it("keeps spent purchase debt when monthly credits reset and offsets it with a new pack", async () => {
    await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification });
    await billing.spendCredits({ userId: "user-a", amountCredits: 800,
      operation: "FULL_BOOK_GENERATION", idempotencyKey: "finished-book" });
    await billing.recordGooglePlayRefund(notice);
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, welcomeCreditsEnabled: 0, freeMonthlyCredits: 1000 });
    expect(await billing.getCreditBalance("user-a", new Date("2027-01-01"))).toMatchObject({
      purchasedCredits: -800, planCredits: 1000, availableCredits: 200
    });
    await billing.spendCredits({ userId: "user-a", amountCredits: 200,
      operation: "FULL_BOOK_GENERATION", idempotencyKey: "allowance-book", now: new Date("2027-01-01") });
    expect(await billing.getCreditBalance("user-a", new Date("2027-01-01"))).toMatchObject({
      purchasedCredits: -800, planCredits: 800, availableCredits: 0
    });
    await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: {
      ...verification, purchaseToken: "paid-again", externalPurchaseId: "GPA.paid-again"
    } });
    expect(db.state.accounts.get("user-a")?.availableCredits).toBe(200);
  });

  it("does not refund a merely pending or unknown purchase state", async () => {
    await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification });
    for (const providerStatus of ["PENDING", "UNKNOWN"]) {
      await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: { ...verification, grantable: false, providerStatus } });
    }
    expect(db.state.accounts.get("user-a")?.availableCredits).toBe(1000);
  });

  const subscription = {
    ...verification, productSku: "tomeza.creator_monthly", kind: "subscription" as const,
    providerStatus: "SUBSCRIPTION_STATE_ACTIVE",
    subscription: { status: "ACTIVE" as const, currentPeriodStart: new Date("2026-10-01"), currentPeriodEnd: new Date("2026-11-01") }
  };

  it("keeps the paid allowance when a subscriber only cancels auto-renewal", async () => {
    await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: subscription });
    await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: {
      ...subscription, providerStatus: "SUBSCRIPTION_STATE_CANCELED",
      subscription: { ...subscription.subscription, status: "CANCELED", autoRenewing: false }
    } });
    expect(db.state.accounts.get("user-a")?.planCredits).toBe(6000);
    expect([...db.state.entitlements.values()][0]?.status).toBe("ACTIVE");
  });

  it("reverses the current refunded subscription allowance and carries spent credits as debt", async () => {
    await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: subscription });
    await billing.spendCredits({ userId: "user-a", amountCredits: 800,
      operation: "FULL_BOOK_GENERATION", idempotencyKey: "subscription-book", now: new Date("2026-10-03") });
    await billing.recordGooglePlayRefund({ ...notice, productType: 1 });
    await billing.recordGooglePlayRefund({ ...notice, productType: 1 });
    expect(db.state.accounts.get("user-a")).toMatchObject({ availableCredits: -800, planCredits: 0 });
    expect([...db.state.entitlements.values()][0]?.status).toBe("REVOKED");
    expect([...db.state.subscriptions.values()][0]?.status).toBe("EXPIRED");
    const stale = await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a",
      verification: { ...subscription, externalPurchaseId: null } });
    expect(stale.status).toBe("REVOKED");
    expect(db.state.accounts.get("user-a")).toMatchObject({ availableCredits: -800, planCredits: 0 });
  });

  it("refunds a historical subscription order without taking away a later paid period", async () => {
    await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: subscription });
    await billing.spendCredits({ userId: "user-a", amountCredits: 800,
      operation: "FULL_BOOK_GENERATION", idempotencyKey: "old-book", now: new Date("2026-10-03") });
    await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: {
      ...subscription, externalPurchaseId: "GPA.next",
      subscription: { status: "ACTIVE", currentPeriodStart: new Date("2026-11-01"), currentPeriodEnd: new Date("2026-12-01") }
    } });
    await billing.recordGooglePlayRefund({ ...notice, productType: 1 });
    await billing.recordGooglePlayRefund({ ...notice, productType: 1 });
    await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: subscription });
    expect(db.state.accounts.get("user-a")).toMatchObject({ availableCredits: -800, planCredits: 6000 });
    expect([...db.state.entitlements.values()][0]?.status).toBe("ACTIVE");
    expect([...db.state.purchases.values()][0]?.externalPurchaseId).toBe("GPA.next");
  });

  it("excludes unused expired credits after Google corrected the refunded period's end", async () => {
    await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: subscription });
    await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: {
      ...subscription, subscription: { ...subscription.subscription, currentPeriodEnd: new Date("2026-11-02") }
    } });
    await billing.recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: {
      ...subscription, externalPurchaseId: "GPA.next",
      subscription: { status: "ACTIVE", currentPeriodStart: new Date("2026-11-02"), currentPeriodEnd: new Date("2026-12-02") }
    } });
    await billing.recordGooglePlayRefund({ ...notice, productType: 1 });
    expect(db.state.accounts.get("user-a")).toMatchObject({ availableCredits: 0, planCredits: 6000 });
  });
});

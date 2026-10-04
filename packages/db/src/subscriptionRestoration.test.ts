import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CREDIT_COSTS, setCreditPricing } from "@book-maker/core";
import type { VerifiedGooglePlayPurchase } from "./billing.ts";

const db = await vi.hoisted(async () => (await import("./testing/billingTestDb.ts")).createBillingTestDb());
vi.mock("./client.ts", () => ({ prisma: db.prisma, Prisma: db.Prisma }));
const {
  getCreditBalance, getPlanSummary, grantCredits, recordGooglePlayRefund,
  recordVerifiedGooglePlayPurchase, resolvePlanTier, spendCredits
} = await import("./billing.ts");

beforeEach(() => {
  db.reset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
  setCreditPricing({ ...DEFAULT_CREDIT_COSTS, welcomeCreditsEnabled: 0, freeMonthlyCredits: 0 });
});
afterEach(() => vi.useRealTimers());

function receipt(tier: "creator" | "max", periodEnd = "2026-11-04T00:00:00Z"): VerifiedGooglePlayPurchase {
  return {
    productSku: `tomeza.${tier}_monthly`,
    purchaseToken: `${tier}-token`,
    kind: "subscription",
    grantable: true,
    providerStatus: "SUBSCRIPTION_STATE_ACTIVE",
    externalPurchaseId: `order-${tier}`,
    subscription: {
      status: "ACTIVE",
      currentPeriodStart: new Date("2026-10-04T00:00:00Z"),
      currentPeriodEnd: new Date(periodEnd)
    }
  };
}

const record = (verification: VerifiedGooglePlayPurchase) =>
  recordVerifiedGooglePlayPurchase({ userId: "user-a", verification });

it.each(["2026-11-04T00:00:00Z", "2026-11-09T00:00:00Z"])(
  "restoring an earlier plan with expiry %s preserves the current allowance and its period",
  async (restoredExpiry) => {
    // Older app versions could buy separate plans without a replacement link.
    await record(receipt("creator"));
    const max = receipt("max");
    await record(max);
    expect((await getCreditBalance("user-a")).planCredits).toBe(80000);
    await grantCredits({ userId: "user-a", amountCredits: 1000, idempotencyKey: "top-up" });
    await spendCredits({
      userId: "user-a", operation: "CHAT_MESSAGE", amountCredits: 400, idempotencyKey: "message-after-upgrade"
    });
    const balance = await getCreditBalance("user-a");
    const account = { ...db.state.accounts.get("user-a")! };
    const ledger = [...db.state.ledger.values()].map((entry) => ({ ...entry }));

    await record(receipt("creator", restoredExpiry));
    expect(await getCreditBalance("user-a")).toEqual(balance);
    expect(db.state.accounts.get("user-a")).toEqual(account);
    expect([...db.state.ledger.values()]).toEqual(ledger);

    // A restore can deliver both receipts in either order, more than once.
    await record(max);
    await record(receipt("creator", restoredExpiry));
    await record(max);
    expect(await getCreditBalance("user-a")).toEqual(balance);
    expect(db.state.accounts.get("user-a")).toEqual(account);
    expect([...db.state.ledger.values()]).toEqual(ledger);
  }
);

it("preserves the renewed allowance when a previously granted receipt arrives late", async () => {
  const old = receipt("creator");
  await record(old);
  vi.setSystemTime(new Date("2026-11-04T00:00:00Z"));
  const renewal = { ...receipt("creator", "2026-12-04T00:00:00Z"), externalPurchaseId: "order-creator-renewal" };
  await record(renewal);
  await spendCredits({
    userId: "user-a", operation: "CHAT_MESSAGE", amountCredits: 250, idempotencyKey: "message-after-renewal"
  });
  const balance = await getCreditBalance("user-a");
  expect(balance.planCredits).toBe(5750);
  const account = { ...db.state.accounts.get("user-a")! };
  const ledger = [...db.state.ledger.values()].map((entry) => ({ ...entry }));
  const plan = await getPlanSummary("user-a");
  const purchases = structuredClone([...db.state.purchases.values()]);
  const subscriptions = structuredClone([...db.state.subscriptions.values()]);
  const entitlements = structuredClone([...db.state.entitlements.values()]);

  // A verification response started before renewal can arrive afterward.
  const replay = await record(old);
  expect(replay).toMatchObject({ status: "GRANTED", subscriptionStatus: "ACTIVE", ledgerEntryId: null });
  expect(await resolvePlanTier("user-a")).toBe("creator");
  expect(await getPlanSummary("user-a")).toEqual(plan);
  expect([...db.state.purchases.values()]).toEqual(purchases);
  expect([...db.state.subscriptions.values()]).toEqual(subscriptions);
  expect([...db.state.entitlements.values()]).toEqual(entitlements);
  expect(await getCreditBalance("user-a")).toEqual(balance);
  expect(db.state.accounts.get("user-a")).toEqual(account);
  await record(renewal);
  expect(await getCreditBalance("user-a")).toEqual(balance);
  expect([...db.state.ledger.values()]).toEqual(ledger);
});

it("a historical refund after a late verification preserves the renewed plan and remaining allowance", async () => {
  const old = receipt("creator");
  await record(old);
  await spendCredits({ userId: "user-a", operation: "CHAT_MESSAGE", amountCredits: 800, idempotencyKey: "old-period-spend" });
  vi.setSystemTime(new Date("2026-11-04T00:00:00Z"));
  const renewal = { ...receipt("creator", "2026-12-04T00:00:00Z"), externalPurchaseId: "order-creator-renewal" };
  await record(renewal);
  await spendCredits({ userId: "user-a", operation: "CHAT_MESSAGE", amountCredits: 250, idempotencyKey: "new-period-spend" });

  await record(old);
  const refund = { purchaseToken: old.purchaseToken, orderId: old.externalPurchaseId!, productType: 1 as const };
  await recordGooglePlayRefund(refund);
  await recordGooglePlayRefund(refund);
  await record(old);
  expect(await resolvePlanTier("user-a")).toBe("creator");
  expect(await getCreditBalance("user-a")).toMatchObject({ planCredits: 5750, purchasedCredits: -800 });
  expect([...db.state.purchases.values()][0]).toMatchObject({ externalPurchaseId: renewal.externalPurchaseId, status: "GRANTED" });

  // The guard must still let a refund of the actual current order revoke it.
  await recordGooglePlayRefund({ ...refund, orderId: renewal.externalPurchaseId });
  expect(await record(old)).toMatchObject({ status: "REVOKED", subscriptionStatus: "EXPIRED", entitlementType: null });
  expect(await resolvePlanTier("user-a")).toBe("free");
  expect((await getCreditBalance("user-a")).planCredits).toBe(0);
});

it.each([true, false])("ignores an older period first delivered after renewal (grantable: %s)", async (grantable) => {
  vi.setSystemTime(new Date("2026-11-04T00:00:00Z"));
  const renewal = { ...receipt("creator", "2026-12-04T00:00:00Z"), externalPurchaseId: "order-creator-renewal" };
  await record(renewal);
  const old = receipt("creator");
  await record({ ...old, grantable, providerStatus: grantable ? "SUBSCRIPTION_STATE_ACTIVE" : "SUBSCRIPTION_STATE_EXPIRED",
    subscription: { ...old.subscription, status: grantable ? "ACTIVE" : "EXPIRED" } });
  expect(await resolvePlanTier("user-a")).toBe("creator");
  expect((await getCreditBalance("user-a")).planCredits).toBe(6000);
  expect([...db.state.purchases.values()][0]?.externalPurchaseId).toBe(renewal.externalPurchaseId);
  expect([...db.state.ledger.values()].filter((entry) => entry.entryType === "GRANT")).toHaveLength(1);
});

it("ignores a prior period when the provider supplied no order IDs", async () => {
  const old = { ...receipt("creator"), externalPurchaseId: null };
  await record(old);
  vi.setSystemTime(new Date("2026-11-04T00:00:00Z"));
  await record({ ...receipt("creator", "2026-12-04T00:00:00Z"), externalPurchaseId: null });
  const plan = await getPlanSummary("user-a");
  await record(old);
  expect(await resolvePlanTier("user-a")).toBe("creator");
  expect(await getPlanSummary("user-a")).toEqual(plan);
  expect((await getCreditBalance("user-a")).planCredits).toBe(6000);
});

it("lets the current paid receipt repair subscription state overwritten before the fix", async () => {
  await record(receipt("creator"));
  const oldPurchase = structuredClone([...db.state.purchases.values()][0]!);
  const oldSubscription = structuredClone([...db.state.subscriptions.values()][0]!);
  const oldEntitlement = structuredClone([...db.state.entitlements.values()][0]!);
  vi.setSystemTime(new Date("2026-11-04T00:00:00Z"));
  const renewal = { ...receipt("creator", "2026-12-04T00:00:00Z"), externalPurchaseId: "order-creator-renewal" };
  await record(renewal);
  await spendCredits({ userId: "user-a", operation: "CHAT_MESSAGE", amountCredits: 250, idempotencyKey: "spend-before-repair" });
  const balance = await getCreditBalance("user-a");
  const plan = await getPlanSummary("user-a");

  // The previous code could overwrite these three rows while leaving the
  // current allowance and its recorded grant intact.
  db.state.purchases.set(oldPurchase.id, oldPurchase);
  db.state.subscriptions.set(oldSubscription.id, oldSubscription);
  db.state.entitlements.set(oldEntitlement.id, oldEntitlement);
  expect(await resolvePlanTier("user-a")).toBe("free");
  await record(renewal);
  expect(await getPlanSummary("user-a")).toEqual(plan);
  expect(await getCreditBalance("user-a")).toEqual(balance);
});

it.each([null, "2026-12-09T00:00:00Z"])("ignores a previously granted old order even with a changed expiry (%s)", async (periodEnd) => {
  const old = receipt("creator");
  await record(old);
  vi.setSystemTime(new Date("2026-11-04T00:00:00Z"));
  const renewal = { ...receipt("creator", "2026-12-04T00:00:00Z"), externalPurchaseId: "order-creator-renewal" };
  await record(renewal);
  const plan = await getPlanSummary("user-a");
  await record({ ...old, subscription: { ...old.subscription, status: "ACTIVE", currentPeriodEnd: periodEnd ? new Date(periodEnd) : null } });
  expect(await getPlanSummary("user-a")).toEqual(plan);
  expect([...db.state.purchases.values()][0]?.externalPurchaseId).toBe(renewal.externalPurchaseId);
  expect((await getCreditBalance("user-a")).planCredits).toBe(6000);
});

it("applies current-order cancellation, corrected expiry and expiration without regranting credits", async () => {
  const current = receipt("creator");
  await record(current);
  await spendCredits({ userId: "user-a", operation: "CHAT_MESSAGE", amountCredits: 250, idempotencyKey: "current-spend" });
  const correctedEnd = new Date("2026-10-20T00:00:00Z");
  const canceled: VerifiedGooglePlayPurchase = { ...current, providerStatus: "SUBSCRIPTION_STATE_CANCELED",
    subscription: { ...current.subscription, status: "CANCELED", autoRenewing: false, currentPeriodEnd: correctedEnd } };
  await record(canceled);
  expect(await resolvePlanTier("user-a")).toBe("creator");
  expect(await getPlanSummary("user-a")).toMatchObject({ cancelAtPeriodEnd: true, endsAt: correctedEnd });
  expect((await getCreditBalance("user-a")).planCredits).toBe(5750);
  vi.setSystemTime(correctedEnd);
  await record({ ...canceled, grantable: false, providerStatus: "SUBSCRIPTION_STATE_EXPIRED",
    subscription: { ...canceled.subscription, status: "EXPIRED" } });
  expect(await resolvePlanTier("user-a")).toBe("free");
  expect((await getCreditBalance("user-a")).planCredits).toBe(0);
});

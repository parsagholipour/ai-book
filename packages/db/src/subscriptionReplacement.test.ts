import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CREDIT_COSTS, setCreditPricing } from "@book-maker/core";
import type { VerifiedGooglePlayPurchase } from "./billing.ts";
import { createHash } from "node:crypto";

const db = await vi.hoisted(async () => (await import("./testing/billingTestDb.js")).createBillingTestDb());
vi.mock("./client.ts", () => ({ prisma: db.prisma, Prisma: db.Prisma }));
const { recordVerifiedGooglePlayPurchase, getCreditBalance, getPlanSummary, resolvePlanTier, spendCredits } = await import("./billing.ts");

beforeEach(() => {
  db.reset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
  setCreditPricing({ ...DEFAULT_CREDIT_COSTS, welcomeCreditsEnabled: 0, freeMonthlyCredits: 0 });
});
afterEach(() => vi.useRealTimers());

function receipt(tier: string, token: string, linkedToken?: string): VerifiedGooglePlayPurchase {
  return {
    productSku: `tomeza.${tier}_monthly`, purchaseToken: token, kind: "subscription",
    grantable: true, providerStatus: "SUBSCRIPTION_STATE_ACTIVE", externalPurchaseId: `order-${token}`,
    subscription: { status: "ACTIVE", autoRenewing: true,
      currentPeriodStart: new Date("2026-10-04T00:00:00Z"), currentPeriodEnd: new Date("2026-11-04T00:00:00Z") },
    metadata: { linkedPurchaseToken: linkedToken ?? null }
  };
}
const record = (verification: VerifiedGooglePlayPurchase, userId = "user-a") =>
  recordVerifiedGooglePlayPurchase({ userId, verification });

it("retires the replaced subscription and ignores a delayed old receipt", async () => {
  const old = receipt("creator", "old-token");
  await record(old);
  await record(receipt("max", "new-token", "old-token"));
  const oldPurchase = [...db.state.purchases.values()].find((row) => row.externalPurchaseId === "order-old-token");
  expect(oldPurchase).toMatchObject({ status: "GRANTED", creditsGranted: 6000 });
  const oldSubscription = [...db.state.subscriptions.values()].find((row) => row.purchaseToken === "old-token");
  expect(oldSubscription).toMatchObject({ status: "EXPIRED", autoRenewing: false, nextCreditGrantAt: null });
  await record(old);
  expect((await getCreditBalance("user-a")).planCredits).toBe(80000);
  expect(await resolvePlanTier("user-a")).toBe("max");
  expect(await getPlanSummary("user-a")).toMatchObject({
    productSku: "tomeza.max_monthly", purchaseTokenHash: createHash("sha256").update("new-token").digest("hex")
  });
});

it("expires higher-tier perks when Google confirms an immediate downgrade", async () => {
  await record(receipt("max", "max-token"));
  await record(receipt("creator", "creator-token", "max-token"));
  expect(await resolvePlanTier("user-a")).toBe("creator");
  expect((await getCreditBalance("user-a")).planCredits).toBe(6000);
  await record(receipt("max", "max-token"));
  expect(await resolvePlanTier("user-a")).toBe("creator");
  expect((await getCreditBalance("user-a")).planCredits).toBe(6000);
});

it("records retirement even if the replaced receipt has never reached the backend", async () => {
  await record(receipt("max", "new-token", "missing-old-token"));
  const restored = await record(receipt("creator", "missing-old-token"));
  expect(restored).toMatchObject({ status: "REVOKED", subscriptionStatus: "EXPIRED", ledgerEntryId: null });
  expect((await getCreditBalance("user-a")).planCredits).toBe(80000);
  expect([...db.state.subscriptions.values()]).toHaveLength(1);
  await expect(record(receipt("creator", "missing-old-token"), "other-user")).rejects.toThrow("another account");
});

it("leaves the original plan intact while the replacement payment is pending", async () => {
  await record(receipt("creator", "old-token"));
  await record({ ...receipt("max", "pending-token", "old-token"), grantable: false,
    providerStatus: "SUBSCRIPTION_STATE_PENDING", subscription: { status: "INACTIVE" } });
  expect(await resolvePlanTier("user-a")).toBe("creator");
  expect((await getCreditBalance("user-a")).planCredits).toBe(6000);
  expect([...db.state.subscriptions.values()].find((row) => row.purchaseToken === "old-token")?.status).toBe("ACTIVE");
});

it("refuses a replacement linked to another app account", async () => {
  await record(receipt("creator", "old-token"));
  await expect(record(receipt("max", "new-token", "old-token"), "other-user"))
    .rejects.toThrow("another account");
  expect(await resolvePlanTier("user-a")).toBe("creator");
  expect([...db.state.purchases.values()]).toHaveLength(1);
});

it("replaying the replacement preserves spent credits and cannot revive earlier plans", async () => {
  const old = receipt("creator", "old-token");
  const replacement = receipt("max", "new-token", "old-token");
  await record(old);
  await record(replacement);
  await spendCredits({ userId: "user-a", operation: "CHAT_MESSAGE", amountCredits: 100,
    idempotencyKey: "message-after-upgrade" });
  await record(replacement);
  await record(old);
  await record(replacement);
  expect((await getCreditBalance("user-a")).planCredits).toBe(79900);
  expect([...db.state.subscriptions.values()].filter((row) => row.status === "ACTIVE")).toHaveLength(1);
});

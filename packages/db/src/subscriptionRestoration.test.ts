import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CREDIT_COSTS, setCreditPricing } from "@book-maker/core";
import type { VerifiedGooglePlayPurchase } from "./billing.ts";

const db = await vi.hoisted(async () => (await import("./testing/billingTestDb.ts")).createBillingTestDb());
vi.mock("./client.ts", () => ({ prisma: db.prisma, Prisma: db.Prisma }));
const { getCreditBalance, grantCredits, recordVerifiedGooglePlayPurchase, spendCredits } = await import("./billing.ts");

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

  // A verification response started before renewal can arrive afterward.
  await record(old);
  expect(await getCreditBalance("user-a")).toEqual(balance);
  expect(db.state.accounts.get("user-a")).toEqual(account);
  await record(renewal);
  expect(await getCreditBalance("user-a")).toEqual(balance);
  expect([...db.state.ledger.values()]).toEqual(ledger);
});

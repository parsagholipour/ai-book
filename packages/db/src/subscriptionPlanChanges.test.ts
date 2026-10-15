import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { DEFAULT_CREDIT_COSTS, setCreditPricing } from "@book-maker/core";
import type { VerifiedGooglePlayPurchase } from "./billing.ts";

const db = await vi.hoisted(async () => (await import("./testing/billingTestDb.js")).createBillingTestDb());
vi.mock("./client.ts", () => ({ prisma: db.prisma, Prisma: db.Prisma }));
const { recordVerifiedGooglePlayPurchase, recordGooglePlayRefund, getCreditBalance, getPlanSummary, resolvePlanTier, spendCredits } =
  await import("./billing.ts");

const OCT_4 = new Date("2026-10-04T00:00:00Z");
const NOV_4 = new Date("2026-11-04T00:00:00Z");
const DEC_4 = new Date("2026-12-04T00:00:00Z");
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

beforeEach(() => {
  db.reset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(OCT_4);
  setCreditPricing({ ...DEFAULT_CREDIT_COSTS, welcomeCreditsEnabled: 0, freeMonthlyCredits: 0 });
});
afterEach(() => vi.useRealTimers());

function receipt(tier: string, token: string, options: {
  order?: string | null; start?: Date; end?: Date; linkedToken?: string; offerPhase?: "base" | "proration";
} = {}): VerifiedGooglePlayPurchase {
  return {
    productSku: `tomeza.${tier}_monthly`, purchaseToken: token, kind: "subscription",
    grantable: true, providerStatus: "SUBSCRIPTION_STATE_ACTIVE",
    externalPurchaseId: options.order === undefined ? `order-${token}` : options.order,
    subscription: {
      status: "ACTIVE", autoRenewing: true,
      currentPeriodStart: options.start ?? OCT_4, currentPeriodEnd: options.end ?? NOV_4,
      offerPhase: options.offerPhase ?? "base"
    },
    metadata: { linkedPurchaseToken: options.linkedToken ?? null }
  };
}

/** What the verifier reports for the token Play issues for a `DEFERRED` downgrade. */
function deferredDowngrade(token: string, oldToken: string, takesEffectAt: Date): VerifiedGooglePlayPurchase {
  return {
    productSku: "tomeza.creator_monthly", purchaseToken: token, kind: "subscription",
    grantable: true, providerStatus: "SUBSCRIPTION_STATE_ACTIVE", externalPurchaseId: null,
    subscription: {
      status: "ACTIVE", autoRenewing: true, currentPeriodStart: new Date("2026-10-20T00:00:00Z"),
      currentPeriodEnd: takesEffectAt, offerPhase: null,
      deferredReplacement: { fromProductSku: "tomeza.max_monthly", takesEffectAt }
    },
    metadata: { linkedPurchaseToken: oldToken, acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING" }
  };
}

const record = (verification: VerifiedGooglePlayPurchase) =>
  recordVerifiedGooglePlayPurchase({ userId: "user-a", verification });

describe("a downgrade Play deferred to renewal", () => {
  it("keeps the Max plan and what is left of its allowance until the period it paid for ends", async () => {
    await record(receipt("max", "max-token"));
    vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    await spendCredits({ userId: "user-a", amountCredits: 30_000, operation: "FULL_BOOK_GENERATION", idempotencyKey: "spend-1" });

    const scheduled = await record(deferredDowngrade("creator-token", "max-token", NOV_4));
    expect(scheduled).toMatchObject({
      status: "VERIFIED", creditsGranted: 0, ledgerEntryId: null,
      scheduledChange: { productSku: "tomeza.creator_monthly", startsAt: NOV_4 }
    });
    // Nothing forfeited, nothing granted: the paid-for Max month runs out.
    expect((await getCreditBalance("user-a")).planCredits).toBe(50_000);
    expect(await resolvePlanTier("user-a")).toBe("max");
    // The app still holds the token under Max until the switch, and may switch again from it.
    expect(await getPlanSummary("user-a")).toMatchObject({
      productSku: "tomeza.max_monthly", purchaseTokenHash: hash("creator-token"),
      renewsAt: NOV_4, pendingChange: { productSku: "tomeza.creator_monthly", startsAt: NOV_4 }
    });
    // No cash: nothing was charged for the switch itself.
    expect([...db.state.payments.values()]).toHaveLength(1);
    // The sweep asks about the new token when the switch is due, never the old one.
    const states = [...db.state.subscriptions.values()];
    expect(states.find((row) => row.purchaseToken === "creator-token")).toMatchObject({ nextCreditGrantAt: NOV_4 });
    expect(states.find((row) => row.purchaseToken === "max-token")).toMatchObject({ status: "EXPIRED", nextCreditGrantAt: null });
  });

  it("ignores Google reporting the old token expired, and a re-verification of the new one, during the window", async () => {
    await record(receipt("max", "max-token"));
    await record(deferredDowngrade("creator-token", "max-token", NOV_4));
    await record({ ...receipt("max", "max-token"), grantable: false, providerStatus: "SUBSCRIPTION_STATE_EXPIRED",
      subscription: { status: "EXPIRED", currentPeriodStart: OCT_4, currentPeriodEnd: OCT_4 } });
    await record(deferredDowngrade("creator-token", "max-token", NOV_4));
    expect(await resolvePlanTier("user-a")).toBe("max");
    expect((await getCreditBalance("user-a")).planCredits).toBe(80_000);
  });

  it("switches to Creator at the renewal, granting the new plan's allowance once", async () => {
    await record(receipt("max", "max-token"));
    await record(deferredDowngrade("creator-token", "max-token", NOV_4));

    vi.setSystemTime(new Date("2026-11-04T01:00:00Z"));
    const renewed = await record(receipt("creator", "creator-token",
      { order: "order-creator-1", start: new Date("2026-10-20T00:00:00Z"), end: DEC_4, linkedToken: "max-token" }));
    expect(renewed).toMatchObject({ status: "GRANTED", creditsGranted: 6_000, entitlementType: "CREATOR_PLAN" });
    expect(await resolvePlanTier("user-a")).toBe("creator");
    expect((await getCreditBalance("user-a")).planCredits).toBe(6_000);
    expect(await getPlanSummary("user-a")).toMatchObject({ productSku: "tomeza.creator_monthly", renewsAt: DEC_4 });
    expect((await getPlanSummary("user-a")).pendingChange).toBeUndefined();
    // The Max entitlement carried on this record is closed, not left to an expiry date.
    const maxEntitlement = [...db.state.entitlements.values()].find((row) => row.type === "MAX_PLAN");
    expect(maxEntitlement?.status).toBe("EXPIRED");
    // The first Creator order is the first cash on the new token.
    expect([...db.state.payments.values()].map((payment) => payment.orderId)).toEqual(["order-max-token", "order-creator-1"]);
  });

  it("takes the carried Max entitlement down with it when the reader switches again before it lands", async () => {
    await record(receipt("max", "max-token"));
    await record(deferredDowngrade("creator-token", "max-token", NOV_4));
    db.state.products.set("tomeza.pro_monthly", {
      id: "product-pro", sku: "tomeza.pro_monthly", title: "Pro", productType: "SUBSCRIPTION",
      creditAmount: 15_000, priceMicros: 39_990_000n, currency: "USD", active: true
    });
    vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
    await record(receipt("pro", "pro-token", {
      order: "order-pro", start: new Date("2026-10-25T00:00:00Z"), end: new Date("2026-11-25T00:00:00Z"), linkedToken: "creator-token"
    }));
    expect(await resolvePlanTier("user-a")).toBe("pro");
    expect((await getCreditBalance("user-a")).planCredits).toBe(15_000);
  });
});

/** What Google reports for a token it has closed: not grantable, and the period end it now gives. */
function expired(verification: VerifiedGooglePlayPurchase, end: Date): VerifiedGooglePlayPurchase {
  return { ...verification, grantable: false, providerStatus: "SUBSCRIPTION_STATE_EXPIRED",
    subscription: { status: "EXPIRED", currentPeriodStart: OCT_4, currentPeriodEnd: end } };
}

/** Everything a reader or the renewal sweep can tell apart, so two event orders can be compared whole. */
async function readerState() {
  const balance = await getCreditBalance("user-a");
  const tokenOf = (purchaseRecordId: string | null) =>
    [...db.state.purchases.values()].find((purchase) => purchase.id === purchaseRecordId)?.purchaseTokenHash ?? null;
  return {
    tier: await resolvePlanTier("user-a"),
    plan: await getPlanSummary("user-a"),
    balance: { planCredits: balance.planCredits, purchasedCredits: balance.purchasedCredits, planPeriodEnd: balance.planPeriodEnd },
    states: [...db.state.subscriptions.values()]
      .map((row) => ({ token: row.purchaseToken, status: row.status, end: row.currentPeriodEnd, next: row.nextCreditGrantAt }))
      .sort((left, right) => String(left.token).localeCompare(String(right.token))),
    entitlements: [...db.state.entitlements.values()]
      .map((row) => ({ type: row.type, status: row.status, token: tokenOf(row.purchaseRecordId), expiresAt: row.expiresAt })),
    grants: [...db.state.ledger.values()].filter((entry) => entry.entryType === "GRANT").map((entry) => entry.idempotencyKey)
  };
}

describe("a deferred downgrade whose old token Google reports expired first (launch review C6)", () => {
  // Google reports the replaced token expired the moment the new one is issued.
  // An RTDN for it, the cancel sheet's refresh of the stored token, or a verify
  // of the new token that failed first can all record that before the new token.
  async function downgrade(oldTokenFirst: boolean) {
    await record(receipt("max", "max-token"));
    vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    await spendCredits({ userId: "user-a", amountCredits: 30_000, operation: "FULL_BOOK_GENERATION", idempotencyKey: "s1" });
    const oldTokenExpired = expired(receipt("max", "max-token"), new Date("2026-10-20T00:00:00Z"));
    if (oldTokenFirst) await record(oldTokenExpired);
    await record(deferredDowngrade("creator-token", "max-token", NOV_4));
    if (!oldTokenFirst) await record(oldTokenExpired);
  }

  it.each([false, true])("keeps Max and its allowance until the renewal (old token first: %s)", async (oldTokenFirst) => {
    await downgrade(oldTokenFirst);
    expect(await resolvePlanTier("user-a")).toBe("max");
    expect((await getCreditBalance("user-a")).planCredits).toBe(50_000);
    expect(await getPlanSummary("user-a")).toMatchObject({
      productSku: "tomeza.max_monthly", pendingChange: { productSku: "tomeza.creator_monthly", startsAt: NOV_4 }
    });
  });

  it("ends in the same state whichever report lands first, and switches at the renewal either way", async () => {
    await downgrade(false);
    const newTokenFirst = await readerState();
    db.reset();
    vi.setSystemTime(OCT_4);
    await downgrade(true);
    expect(await readerState()).toEqual(newTokenFirst);

    vi.setSystemTime(new Date("2026-11-04T01:00:00Z"));
    await record(receipt("creator", "creator-token",
      { order: "order-creator-1", start: new Date("2026-10-20T00:00:00Z"), end: DEC_4, linkedToken: "max-token" }));
    expect(await resolvePlanTier("user-a")).toBe("creator");
    expect((await getCreditBalance("user-a")).planCredits).toBe(6_000);
  });

  it("keeps the old plan to its paid end even when the new token never arrives, and ends it there", async () => {
    await record(receipt("max", "max-token"));
    await record(expired(receipt("max", "max-token"), new Date("2026-10-20T00:00:00Z")));
    expect(await resolvePlanTier("user-a")).toBe("max");
    // Running out, not over: the sweep asks about it again at its paid end.
    expect([...db.state.subscriptions.values()][0]).toMatchObject({
      status: "CANCELED", currentPeriodEnd: NOV_4, nextCreditGrantAt: NOV_4
    });
    expect(await getPlanSummary("user-a")).toMatchObject({ cancelAtPeriodEnd: true, endsAt: NOV_4 });

    vi.setSystemTime(new Date("2026-11-04T01:00:00Z"));
    await record(expired(receipt("max", "max-token"), NOV_4));
    expect(await resolvePlanTier("user-a")).toBe("free");
    expect((await getCreditBalance("user-a")).planCredits).toBe(0);
    expect([...db.state.subscriptions.values()][0]).toMatchObject({ status: "EXPIRED", nextCreditGrantAt: null });
  });
});

describe("a genuine expiry still ends the plan", () => {
  it("when the renewal lapsed: Google's report comes after the recorded paid end", async () => {
    await record(receipt("creator", "creator-token"));
    vi.setSystemTime(new Date("2026-11-05T00:00:00Z"));
    await record(expired(receipt("creator", "creator-token"), NOV_4));
    expect(await resolvePlanTier("user-a")).toBe("free");
    expect((await getCreditBalance("user-a")).planCredits).toBe(0);
  });

  it("when a payment failed past the grace period", async () => {
    await record(receipt("creator", "creator-token"));
    vi.setSystemTime(new Date("2026-11-05T00:00:00Z"));
    const graceEnd = new Date("2026-11-11T00:00:00Z");
    await record({ ...receipt("creator", "creator-token"), providerStatus: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
      subscription: { status: "GRACE_PERIOD", autoRenewing: true, currentPeriodStart: OCT_4, currentPeriodEnd: graceEnd } });
    expect(await resolvePlanTier("user-a")).toBe("creator");
    vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
    await record({ ...receipt("creator", "creator-token"), grantable: false, providerStatus: "SUBSCRIPTION_STATE_ON_HOLD",
      subscription: { status: "PAUSED", currentPeriodStart: OCT_4, currentPeriodEnd: graceEnd } });
    expect(await resolvePlanTier("user-a")).toBe("free");
  });

  it("when the order was refunded or revoked, even if Google's expiry reached us first", async () => {
    await record(receipt("max", "max-token"));
    // Revoked: the expiry is kept to the paid end until the refund marker lands...
    await record(expired(receipt("max", "max-token"), new Date("2026-10-10T00:00:00Z")));
    expect(await resolvePlanTier("user-a")).toBe("max");
    // ...and the refund ends it at once.
    await recordGooglePlayRefund({ purchaseToken: "max-token", orderId: "order-max-token", productType: 1 });
    expect(await resolvePlanTier("user-a")).toBe("free");
    expect((await getCreditBalance("user-a")).planCredits).toBe(0);
    const again = await record(expired(receipt("max", "max-token"), new Date("2026-10-10T00:00:00Z")));
    expect(again.status).toBe("REVOKED");
    expect(await resolvePlanTier("user-a")).toBe("free");
  });

  it("when a cancelled plan — an account deletion's cancel included — runs out its paid period", async () => {
    await record(receipt("creator", "creator-token"));
    await record({ ...receipt("creator", "creator-token"), providerStatus: "SUBSCRIPTION_STATE_CANCELED",
      subscription: { status: "CANCELED", autoRenewing: false, currentPeriodStart: OCT_4, currentPeriodEnd: NOV_4 } });
    expect(await resolvePlanTier("user-a")).toBe("creator");
    vi.setSystemTime(new Date("2026-11-04T00:00:01Z"));
    await record(expired(receipt("creator", "creator-token"), NOV_4));
    expect(await resolvePlanTier("user-a")).toBe("free");
  });
});

describe("a plan switch Google prorated", () => {
  it("grants the share of the period an immediate upgrade actually covers", async () => {
    await record(receipt("creator", "creator-token"));
    // Upgraded on the 19th, billing cycle unchanged: the first Max period runs
    // to Nov 4, 16 of the month's 31 days, and was charged only the difference.
    vi.setSystemTime(new Date("2026-10-19T00:00:00Z"));
    const upgraded = await record(receipt("max", "max-token", {
      order: "order-max", start: new Date("2026-10-19T00:00:00Z"), end: NOV_4, linkedToken: "creator-token", offerPhase: "proration"
    }));
    const covered = 16 / 31;
    expect(upgraded.creditsGranted).toBe(Math.floor(80_000 * covered));
    expect((await getCreditBalance("user-a")).planCredits).toBe(Math.floor(80_000 * covered));
    const grant = [...db.state.ledger.values()].find((entry) => entry.entryType === "GRANT" && entry.idempotencyKey.includes("order-max"));
    expect(grant?.metadata).toMatchObject({ allowanceBasis: "prorated" });

    // The first full-price Max period grants the whole allowance.
    vi.setSystemTime(new Date("2026-11-04T01:00:00Z"));
    await record(receipt("max", "max-token", {
      order: "order-max-2", start: new Date("2026-10-19T00:00:00Z"), end: DEC_4, linkedToken: "creator-token"
    }));
    expect((await getCreditBalance("user-a")).planCredits).toBe(80_000);
  });

  it("prorates a replacement whose base period is short even when Google calls it a base period", async () => {
    await record(receipt("creator", "creator-token"));
    vi.setSystemTime(new Date("2026-10-28T00:00:00Z"));
    const upgraded = await record(receipt("max", "max-token", {
      order: "order-max", start: new Date("2026-10-28T00:00:00Z"), end: new Date("2026-10-29T12:00:00Z"), linkedToken: "creator-token"
    }));
    expect(upgraded.creditsGranted).toBeLessThan(5_000);
  });

  it("grants a full-price switch in full, carried-over days and all", async () => {
    await record(receipt("creator", "creator-token"));
    vi.setSystemTime(new Date("2026-10-19T00:00:00Z"));
    const upgraded = await record(receipt("max", "max-token", {
      order: "order-max", start: new Date("2026-10-19T00:00:00Z"), end: new Date("2026-11-21T00:00:00Z"),
      linkedToken: "creator-token", offerPhase: "proration"
    }));
    expect(upgraded.creditsGranted).toBe(80_000);
  });
});

describe("a paused or on-hold subscription", () => {
  it("is asked about again when Google says it resumes, not every hour from a past period end", async () => {
    await record(receipt("creator", "creator-token"));
    vi.setSystemTime(new Date("2026-11-10T00:00:00Z"));
    const resumesAt = new Date("2027-01-04T00:00:00Z");
    await record({ ...receipt("creator", "creator-token"), grantable: false, providerStatus: "SUBSCRIPTION_STATE_PAUSED",
      subscription: { status: "PAUSED", currentPeriodStart: OCT_4, currentPeriodEnd: NOV_4, resumesAt } });
    const state = [...db.state.subscriptions.values()].find((row) => row.purchaseToken === "creator-token");
    expect(state).toMatchObject({ status: "PAUSED", nextCreditGrantAt: resumesAt });
    expect(await resolvePlanTier("user-a")).toBe("free");
  });
});

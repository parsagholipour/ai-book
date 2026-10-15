import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./mobile/testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./mobile/testing/mobileApiMocks.js")).billingModuleMock());

import { recordVerifiedGooglePlayPurchase } from "@book-maker/db/billing";
import { mockBilling, mockPrisma } from "./mobile/testing/mobileApiMocks.js";
import { renewalRecheckDelayMs, runSubscriptionRenewalSweep } from "./subscriptionRenewal.js";

const NOW = new Date("2026-07-16T00:00:00.000Z");

const HOUR = 60 * 60 * 1000;

function dueSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "subscription-1",
    userId: "user-a",
    purchaseToken: "play-token-1",
    // Due since the period Google last reported ended, an hour ago.
    currentPeriodEnd: new Date(NOW.getTime() - HOUR),
    nextCreditGrantAt: new Date(NOW.getTime() - HOUR),
    product: { sku: "tomeza.creator_monthly" },
    ...overrides
  };
}

function verifier(result: unknown = {}) {
  return {
    verifyPurchase: vi.fn(async () => ({
      productSku: "tomeza.creator_monthly",
      purchaseToken: "play-token-1",
      kind: "subscription" as const,
      grantable: true,
      providerStatus: "SUBSCRIPTION_STATE_ACTIVE",
      externalPurchaseId: "GPA.0002",
      subscription: {
        status: "ACTIVE" as const,
        currentPeriodStart: new Date("2026-07-15T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-08-15T00:00:00.000Z")
      },
      ...(result as Record<string, unknown>)
    }))
  };
}

describe("subscription renewal sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.subscriptionState.updateMany.mockResolvedValue({ count: 1 });
    mockBilling.recordVerifiedGooglePlayPurchase.mockResolvedValue({
      purchaseRecordId: "purchase-1",
      status: "GRANTED",
      creditsGranted: 6000,
      ledgerEntryId: "ledger-renewal",
      subscriptionStatus: "ACTIVE",
      entitlementType: "CREATOR_PLAN"
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("re-verifies subscriptions whose period has run out and grants the new one", async () => {
    mockPrisma.subscriptionState.findMany.mockResolvedValueOnce([dueSubscription()]);
    const play = verifier();

    const result = await runSubscriptionRenewalSweep({
      verifier: play,
      packageName: "com.tomeza.tomeza",
      now: NOW
    });

    expect(mockPrisma.subscriptionState.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          purchaseToken: { not: null },
          // PAUSED is included: Google resumes a paused subscription on its
          // own schedule, and one left out of the sweep would never be granted
          // again unless the user happened to open the app.
          status: { in: ["ACTIVE", "GRACE_PERIOD", "CANCELED", "PAUSED"] },
          nextCreditGrantAt: { lte: NOW },
          // A deleted account's tombstone is never granted into.
          user: { status: { in: ["ACTIVE", "SUSPENDED"] } }
        })
      })
    );
    expect(play.verifyPurchase).toHaveBeenCalledWith({
      packageName: "com.tomeza.tomeza",
      productId: "tomeza.creator_monthly",
      productType: "SUBSCRIPTION",
      purchaseToken: "play-token-1"
    });
    expect(recordVerifiedGooglePlayPurchase).toHaveBeenCalledWith({
      userId: "user-a",
      verification: expect.objectContaining({ kind: "subscription" })
    });
    expect(result).toEqual({ checked: 1, granted: 1, failed: 0 });
    // A grant moved the row to its new period end itself; the sweep adds nothing.
    expect(mockPrisma.subscriptionState.updateMany).not.toHaveBeenCalled();
  });

  it("counts a verification that grants nothing as checked but not granted", async () => {
    mockPrisma.subscriptionState.findMany.mockResolvedValueOnce([dueSubscription()]);
    mockBilling.recordVerifiedGooglePlayPurchase.mockResolvedValueOnce({
      purchaseRecordId: "purchase-1",
      status: "FAILED",
      creditsGranted: 0,
      ledgerEntryId: null,
      subscriptionStatus: "EXPIRED",
      entitlementType: null
    });

    const result = await runSubscriptionRenewalSweep({
      verifier: verifier({ grantable: false, subscription: { status: "EXPIRED" } }),
      packageName: "com.tomeza.tomeza",
      now: NOW
    });

    expect(result).toEqual({ checked: 1, granted: 0, failed: 0 });
  });

  it("keeps going when Google fails one subscription, and leaves it due for the next pass", async () => {
    mockPrisma.subscriptionState.findMany.mockResolvedValueOnce([
      dueSubscription(),
      dueSubscription({ id: "subscription-2", userId: "user-b", purchaseToken: "play-token-2" })
    ]);
    const play = verifier();
    play.verifyPurchase.mockRejectedValueOnce(new Error("Play unavailable"));
    const warn = vi.fn();

    const result = await runSubscriptionRenewalSweep({
      verifier: play,
      packageName: "com.tomeza.tomeza",
      now: NOW,
      log: { warn }
    });

    expect(result).toEqual({ checked: 2, granted: 1, failed: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    // The failed row stays in the query — a Play outage must not swallow a paid
    // renewal — but behind the backoff, so it cannot hold the head of the queue.
    expect(mockPrisma.subscriptionState.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.subscriptionState.updateMany).toHaveBeenCalledWith({
      where: { id: "subscription-1", nextCreditGrantAt: { lt: new Date(NOW.getTime() + HOUR) } },
      data: { nextCreditGrantAt: new Date(NOW.getTime() + HOUR) }
    });
  });

  it("pushes back every check that grants nothing, so 25 stuck rows cannot starve the renewals behind them", async () => {
    const stuck = Array.from({ length: 25 }, (_, index) => dueSubscription({
      id: `paused-${index}`, userId: `user-${index}`, purchaseToken: `token-${index}`,
      // Paused for two months: Google keeps answering PAUSED with the old period end.
      currentPeriodEnd: new Date(NOW.getTime() - 60 * 24 * HOUR)
    }));
    mockPrisma.subscriptionState.findMany.mockResolvedValueOnce(stuck);
    mockBilling.recordVerifiedGooglePlayPurchase.mockResolvedValue({
      purchaseRecordId: "purchase-1", status: "VERIFIED", creditsGranted: 0, ledgerEntryId: null,
      subscriptionStatus: "PAUSED", entitlementType: null
    });

    await runSubscriptionRenewalSweep({
      verifier: verifier({ grantable: false, subscription: { status: "PAUSED" } }),
      packageName: "com.tomeza.tomeza",
      now: NOW
    });

    expect(mockPrisma.subscriptionState.updateMany).toHaveBeenCalledTimes(25);
    for (const [call] of mockPrisma.subscriptionState.updateMany.mock.calls) {
      // A day out: long overdue means looked at daily, not hourly.
      expect(call.data.nextCreditGrantAt).toEqual(new Date(NOW.getTime() + 24 * HOUR));
    }
  });

  it("re-verifies a yearly plan at a month inside its paid year, and retries a failed month within the hour", async () => {
    // Month 4 of a year that runs to next July: the row is due at the month's start, not the year's end.
    const yearEnd = new Date("2027-07-01T00:00:00.000Z");
    mockPrisma.subscriptionState.findMany.mockResolvedValueOnce([
      dueSubscription({ product: { sku: "tomeza.creator_yearly" }, currentPeriodEnd: yearEnd, nextCreditGrantAt: new Date(NOW.getTime() - 60_000) })
    ]);
    const play = verifier({ productSku: "tomeza.creator_yearly", subscription: { status: "ACTIVE", currentPeriodEnd: yearEnd } });
    play.verifyPurchase.mockRejectedValueOnce(new Error("Play unavailable"));

    const result = await runSubscriptionRenewalSweep({ verifier: play, packageName: "com.tomeza.tomeza", now: NOW });

    expect(play.verifyPurchase).toHaveBeenCalledWith(expect.objectContaining({ productId: "tomeza.creator_yearly" }));
    expect(result).toEqual({ checked: 1, granted: 0, failed: 1 });
    // The paid year has months to run, so nothing is overdue: the month is asked about again in an hour.
    expect(mockPrisma.subscriptionState.updateMany).toHaveBeenCalledWith({
      where: { id: "subscription-1", nextCreditGrantAt: { lt: new Date(NOW.getTime() + HOUR) } },
      data: { nextCreditGrantAt: new Date(NOW.getTime() + HOUR) }
    });
  });

  it("backs off from an hour toward a day the longer a row has been overdue", () => {
    expect(renewalRecheckDelayMs(0)).toBe(HOUR);
    expect(renewalRecheckDelayMs(-5 * HOUR)).toBe(HOUR);
    expect(renewalRecheckDelayMs(6 * HOUR)).toBe(3 * HOUR);
    expect(renewalRecheckDelayMs(90 * 24 * HOUR)).toBe(24 * HOUR);
  });

  it("skips rows with no product to verify against", async () => {
    mockPrisma.subscriptionState.findMany.mockResolvedValueOnce([dueSubscription({ product: null })]);
    const play = verifier();

    const result = await runSubscriptionRenewalSweep({
      verifier: play,
      packageName: "com.tomeza.tomeza",
      now: NOW
    });

    expect(play.verifyPurchase).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 0, granted: 0, failed: 0 });
  });
});

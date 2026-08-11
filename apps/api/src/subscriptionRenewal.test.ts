import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./mobile/testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./mobile/testing/mobileApiMocks.js")).billingModuleMock());

import { recordVerifiedGooglePlayPurchase } from "@book-maker/db/billing";
import { mockBilling, mockPrisma } from "./mobile/testing/mobileApiMocks.js";
import { runSubscriptionRenewalSweep } from "./subscriptionRenewal.js";

const NOW = new Date("2026-07-16T00:00:00.000Z");

function dueSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "subscription-1",
    userId: "user-a",
    purchaseToken: "play-token-1",
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
          nextCreditGrantAt: { lte: NOW }
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
    // Nothing writes `nextCreditGrantAt` on the failure path, so the row stays in
    // the query and a Play outage cannot swallow a paid renewal.
    expect(mockPrisma.subscriptionState.update).not.toHaveBeenCalled();
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

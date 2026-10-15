import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  subscriptionState: {
    findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
    update: vi.fn(async (_args?: unknown) => ({}))
  }
}));
vi.mock("@book-maker/db", () => ({ prisma: db }));

import { GooglePlayProductMismatchError } from "./googlePlayBilling.js";
import { cancelAccountSubscriptions, retryDeletedAccountSubscriptionCancellations } from "./accountSubscriptionCancellation.js";

const log = { warn: vi.fn(), info: vi.fn() };

function row(overrides: Record<string, unknown> = {}) {
  return { id: "sub-1", userId: "user-1", purchaseToken: "play-token", canceledAt: null, product: { sku: "tomeza.max_monthly" }, ...overrides };
}

function play(subscription: Record<string, unknown> | Error) {
  return {
    packageName: "com.tomeza.tomeza",
    verifier: {
      verifyPurchase: vi.fn(async () => {
        if (subscription instanceof Error) throw subscription;
        return {
          productSku: "tomeza.max_monthly", purchaseToken: "play-token", kind: "subscription" as const,
          grantable: true, providerStatus: "SUBSCRIPTION_STATE_ACTIVE", subscription: subscription as never
        };
      }),
      cancelSubscription: vi.fn(async () => {})
    }
  };
}

/**
 * Deleting an account never told Google, so a deleted subscriber kept being
 * charged for a tombstone. These pin when Google is asked to stop, and that
 * nothing about it can block or lose a deletion.
 */
describe("cancelling a deleted account's Play subscriptions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("cancels a renewing subscription for good and closes the row", async () => {
    db.subscriptionState.findMany.mockResolvedValueOnce([row()]);
    const google = play({ status: "ACTIVE", autoRenewing: true });

    expect(await cancelAccountSubscriptions("user-1", log, google)).toEqual({ stopped: 1, failed: 0 });

    expect(db.subscriptionState.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: "user-1", purchaseToken: { not: null },
        status: { in: ["ACTIVE", "GRACE_PERIOD", "CANCELED", "PAUSED", "INACTIVE"] } })
    }));
    expect(google.verifier.cancelSubscription).toHaveBeenCalledWith({ packageName: "com.tomeza.tomeza", purchaseToken: "play-token" });
    expect(db.subscriptionState.update).toHaveBeenCalledWith({
      where: { id: "sub-1" },
      data: expect.objectContaining({ purchaseToken: null, autoRenewing: false, nextCreditGrantAt: null })
    });
  });

  it.each([
    ["expired", { status: "EXPIRED" }],
    ["already cancelled by its owner", { status: "CANCELED", autoRenewing: false }]
  ])("closes a subscription that is %s without asking Google to cancel it", async (_label, subscription) => {
    db.subscriptionState.findMany.mockResolvedValueOnce([row()]);
    const google = play(subscription);
    expect(await cancelAccountSubscriptions("user-1", log, google)).toEqual({ stopped: 1, failed: 0 });
    expect(google.verifier.cancelSubscription).not.toHaveBeenCalled();
    expect(db.subscriptionState.update).toHaveBeenCalledTimes(1);
  });

  it("cancels a paused subscription whatever it says about renewal, because Google resumes it on its own", async () => {
    db.subscriptionState.findMany.mockResolvedValueOnce([row()]);
    const google = play({ status: "PAUSED", autoRenewing: false });
    await cancelAccountSubscriptions("user-1", log, google);
    expect(google.verifier.cancelSubscription).toHaveBeenCalledTimes(1);
  });

  it("still cancels a token Google files under another plan", async () => {
    db.subscriptionState.findMany.mockResolvedValueOnce([row()]);
    const google = play(new GooglePlayProductMismatchError("tomeza.max_monthly"));
    expect(await cancelAccountSubscriptions("user-1", log, google)).toEqual({ stopped: 1, failed: 0 });
    expect(google.verifier.cancelSubscription).toHaveBeenCalledTimes(1);
  });

  it("keeps the token for the next sweep when Google cannot be reached, and never throws", async () => {
    db.subscriptionState.findMany.mockResolvedValueOnce([row(), row({ id: "sub-2", purchaseToken: "second-token" })]);
    const google = play({ status: "ACTIVE", autoRenewing: true });
    google.verifier.cancelSubscription.mockRejectedValueOnce(new Error("Play unavailable"));

    expect(await cancelAccountSubscriptions("user-1", log, google)).toEqual({ stopped: 1, failed: 1 });
    // The failed row keeps its token and only moves to the back of the retry queue.
    expect(db.subscriptionState.update).toHaveBeenCalledWith({ where: { id: "sub-1" }, data: { updatedAt: expect.any(Date) } });
    expect(db.subscriptionState.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "sub-2" }, data: expect.objectContaining({ purchaseToken: null })
    }));
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "account.subscription_cancel_failed" }), expect.any(String));

    db.subscriptionState.findMany.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(cancelAccountSubscriptions("user-1", log, google)).resolves.toEqual({ stopped: 0, failed: 1 });
  });

  it("retries only the subscriptions of accounts whose deletion has completed", async () => {
    db.subscriptionState.findMany.mockResolvedValueOnce([row()]);
    const google = play({ status: "ACTIVE", autoRenewing: true });
    expect(await retryDeletedAccountSubscriptionCancellations(log, google)).toEqual({ stopped: 1, failed: 0 });
    expect(db.subscriptionState.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        purchaseToken: { not: null },
        user: { status: "DISABLED", accountDeletionRequests: { some: { status: "COMPLETED" } } }
      }),
      take: 20
    }));
  });
});

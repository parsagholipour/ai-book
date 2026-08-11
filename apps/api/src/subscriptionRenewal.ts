import { prisma } from "@book-maker/db";
import { recordVerifiedGooglePlayPurchase } from "@book-maker/db/billing";
import type { GooglePlayVerifier } from "./googlePlayBilling.js";

/**
 * Re-verifying subscriptions whose period has run out.
 *
 * Google renews a subscription without telling us: the app finding out and
 * posting a verification is the only thing that used to grant the next month's
 * credits, which fails exactly when it matters — the subscriber who does not
 * open the app on renewal day. So `SubscriptionState.purchaseToken` is kept and
 * this sweep asks Google directly.
 *
 * Everything here is idempotent, because every API instance runs it: the grant
 * is keyed on the period, and the state upsert is last-write-wins with the same
 * data. A subscription Google reports as expired has its `nextCreditGrantAt`
 * cleared by the recording path, which is what takes it out of this query.
 */

export type SubscriptionRenewalSweepResult = {
  checked: number;
  granted: number;
  failed: number;
};

/** Small enough that a sweep cannot monopolize the Play API quota. */
const BATCH_SIZE = 25;

export async function runSubscriptionRenewalSweep(options: {
  verifier: GooglePlayVerifier;
  packageName: string;
  now?: Date | undefined;
  log?: { warn: (details: Record<string, unknown>, message: string) => void } | undefined;
}): Promise<SubscriptionRenewalSweepResult> {
  const now = options.now ?? new Date();
  const due = await prisma.subscriptionState.findMany({
    where: {
      provider: "GOOGLE_PLAY",
      purchaseToken: { not: null },
      // PAUSED is included because Google resumes a paused subscription on its
      // own schedule and tells nobody: without re-verifying, a subscriber who
      // resumed would never be granted again until they happened to open the
      // app. Only EXPIRED is truly final, and that state clears
      // `nextCreditGrantAt` anyway.
      status: { in: ["ACTIVE", "GRACE_PERIOD", "CANCELED", "PAUSED"] },
      nextCreditGrantAt: { lte: now }
    },
    orderBy: { nextCreditGrantAt: "asc" },
    take: BATCH_SIZE,
    select: {
      id: true,
      userId: true,
      purchaseToken: true,
      product: { select: { sku: true } }
    }
  });

  const result: SubscriptionRenewalSweepResult = { checked: 0, granted: 0, failed: 0 };
  for (const subscription of due) {
    const sku = subscription.product?.sku;
    if (!subscription.purchaseToken || !sku) {
      continue;
    }
    result.checked += 1;
    try {
      const verification = await options.verifier.verifyPurchase({
        packageName: options.packageName,
        productId: sku,
        productType: "SUBSCRIPTION",
        purchaseToken: subscription.purchaseToken
      });
      const recorded = await recordVerifiedGooglePlayPurchase({
        userId: subscription.userId,
        verification
      });
      if (recorded.ledgerEntryId) {
        result.granted += 1;
      }
    } catch (error) {
      // Leave `nextCreditGrantAt` where it is so the next sweep tries again;
      // a Play outage must not silently drop a paid renewal.
      result.failed += 1;
      options.log?.warn(
        { err: error, event: "subscription.renewal_check_failed", subscriptionId: subscription.id },
        "Subscription renewal check failed"
      );
    }
  }
  return result;
}

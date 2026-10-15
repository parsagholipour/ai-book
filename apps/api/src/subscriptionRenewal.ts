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
 * Everything here is idempotent, because every API instance runs it: each grant
 * is keyed on its order and month, and the state upsert is last-write-wins with
 * the same data. A subscription Google reports as expired has its
 * `nextCreditGrantAt` cleared by the recording path, which is what takes it out
 * of this query.
 *
 * **It wakes at every month inside a paid period, not only at its end.** A
 * plan's allowance is granted a month at a time (`packages/db/src/subscriptionMonths.ts`):
 * the yearly plan's 6,000 a month, and the months of carried time a plan switch
 * adds to a period. Google says nothing at a month boundary inside a period it
 * was paid for, so the recording path sets `nextCreditGrantAt` to the next
 * month's start and this sweep is what grants months two to twelve. A month
 * already granted (the app verified first) grants nothing and has moved the row
 * on itself; a check that fails is retried under the backoff below, which stays
 * at the hour while the period Google reported is still running.
 *
 * **A check that grants nothing pushes the row back.** The sweep takes the
 * oldest-due rows first, 25 an hour, and a check that failed, found the
 * subscription paused or on hold, or found Google had not renewed it yet used
 * to leave `nextCreditGrantAt` at its past date — so 25 such rows came first
 * on every pass, for ever, and starved every real renewal behind them
 * (pre-launch review, 2026-10). Each one is now due again after a backoff that
 * grows with how long it has been overdue ({@link renewalRecheckDelayMs}), so
 * a renewal Google is slow to report is asked about within the hour and a
 * subscription paused for months once a day. A failure is still retried —
 * a Play outage must not drop a paid renewal — just not ahead of everyone else.
 *
 * **Never into a deleted account.** A tombstone (`DISABLED`) is left out of the
 * query: its subscriptions are cancelled with Google by the deletion sweep
 * (`accountSubscriptionCancellation.ts`), and a renewal that slips through in
 * the meantime has nobody to grant to.
 */

export type SubscriptionRenewalSweepResult = {
  checked: number;
  granted: number;
  failed: number;
};

/** Small enough that a sweep cannot monopolize the Play API quota. */
const BATCH_SIZE = 25;

const HOUR_MS = 60 * 60 * 1000;
const RECHECK_MIN_MS = HOUR_MS;
const RECHECK_MAX_MS = 24 * HOUR_MS;

/**
 * How long a check that granted nothing waits before the next: half of how
 * long the row has been overdue, between an hour and a day. Overdue is counted
 * from the period end Google last reported, which a recheck does not move, so
 * the wait grows on its own without a counter.
 */
export function renewalRecheckDelayMs(overdueMs: number): number {
  return Math.min(RECHECK_MAX_MS, Math.max(RECHECK_MIN_MS, Math.floor(overdueMs / 2)));
}

export async function runSubscriptionRenewalSweep(options: {
  verifier: Pick<GooglePlayVerifier, "verifyPurchase">;
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
      // app. On hold is recorded as PAUSED for the same reason. Only EXPIRED
      // is truly final, and that state clears `nextCreditGrantAt` anyway.
      status: { in: ["ACTIVE", "GRACE_PERIOD", "CANCELED", "PAUSED"] },
      nextCreditGrantAt: { lte: now },
      // Not a deleted account's tombstone (cancelled in Play instead), but a
      // suspended one, whose subscription Google keeps charging: its orders are
      // recorded and its allowance waits for it (src/accountModeration.ts).
      user: { status: { in: ["ACTIVE", "SUSPENDED"] } }
    },
    orderBy: { nextCreditGrantAt: "asc" },
    take: BATCH_SIZE,
    select: {
      id: true,
      userId: true,
      purchaseToken: true,
      currentPeriodEnd: true,
      nextCreditGrantAt: true,
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
    let granted = false;
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
      granted = recorded.ledgerEntryId !== null;
      if (granted) {
        result.granted += 1;
      }
    } catch (error) {
      result.failed += 1;
      options.log?.warn(
        { err: error, event: "subscription.renewal_check_failed", subscriptionId: subscription.id },
        "Subscription renewal check failed"
      );
    }
    if (!granted) {
      await deferRecheck(subscription, now).catch((error: unknown) =>
        options.log?.warn(
          { err: error, event: "subscription.renewal_defer_failed", subscriptionId: subscription.id },
          "Subscription renewal recheck could not be deferred"
        )
      );
    }
  }
  return result;
}

/**
 * Moves a row that granted nothing back by the backoff. Only ever forward and
 * never from null: a recording that cleared it (expired) or set a later date
 * (a new period, a resume date) is left exactly as it wrote it.
 */
async function deferRecheck(
  subscription: { id: string; currentPeriodEnd: Date | null; nextCreditGrantAt: Date | null },
  now: Date
): Promise<void> {
  const overdueSince = subscription.currentPeriodEnd ?? subscription.nextCreditGrantAt ?? now;
  const next = new Date(now.getTime() + renewalRecheckDelayMs(now.getTime() - overdueSince.getTime()));
  await prisma.subscriptionState.updateMany({
    where: { id: subscription.id, nextCreditGrantAt: { lt: next } },
    data: { nextCreditGrantAt: next }
  });
}

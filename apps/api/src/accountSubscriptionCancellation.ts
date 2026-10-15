import { loadConfig } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { GooglePlayProductMismatchError, createGooglePlayVerifierFromConfig, type GooglePlayVerifier } from "./googlePlayBilling.js";

/**
 * Stopping a deleted account's Google Play subscriptions.
 *
 * Account deletion kept the user row as a tombstone and never told Google, so
 * a subscriber who deleted their account kept being charged every month for an
 * account nobody could sign in to — a chargeback each time, and the policy
 * page's promise that deletion is final broken (pre-launch review, 2026-10).
 *
 * Each subscription Google may still charge is cancelled with
 * `DEVELOPER_REQUESTED_STOP_PAYMENTS`: the period already paid runs out and
 * nothing renews. It is best effort and never blocks a deletion. Google is
 * asked first whether the subscription will renew at all, so one that already
 * expired or was cancelled by its owner is closed without a call Google would
 * refuse. Whatever fails stays on the row (`purchaseToken` kept) and is retried
 * by the hourly deletion sweep ({@link retryDeletedAccountSubscriptionCancellations})
 * until Google confirms it will not renew; a closed row drops the raw token,
 * which takes it out of both this pass and the renewal sweep.
 */

type Logger = { warn: (object: unknown, message: string) => void; info: (object: unknown, message: string) => void };

export type PlaySubscriptionCanceller = {
  verifier: Pick<GooglePlayVerifier, "verifyPurchase" | "cancelSubscription">;
  packageName: string;
};

export type SubscriptionCancellationResult = { stopped: number; failed: number };

/** Every state in which Google may still take another payment. */
const MAY_STILL_CHARGE = ["ACTIVE", "GRACE_PERIOD", "CANCELED", "PAUSED", "INACTIVE"] as const;

/** How many leftover subscriptions one sweep retries. */
const RETRY_BATCH_SIZE = 20;

let configured: PlaySubscriptionCanceller | null = null;

/** The process's own Play client, built from its config the first time a deletion needs it. */
function playFromConfig(): PlaySubscriptionCanceller {
  if (!configured) {
    const config = loadConfig();
    configured = { verifier: createGooglePlayVerifierFromConfig(config), packageName: config.GOOGLE_PLAY_PACKAGE_NAME ?? "" };
  }
  return configured;
}

type CancellableRow = {
  id: string;
  userId: string;
  purchaseToken: string | null;
  canceledAt: Date | null;
  product: { sku: string } | null;
};

const rowSelect = { id: true, userId: true, purchaseToken: true, canceledAt: true, product: { select: { sku: true } } } as const;

/** Stops every subscription of `userId` Google may still charge. Never throws. */
export async function cancelAccountSubscriptions(
  userId: string,
  log: Logger,
  play: PlaySubscriptionCanceller | null = null
): Promise<SubscriptionCancellationResult> {
  try {
    const rows = await prisma.subscriptionState.findMany({
      where: { userId, provider: "GOOGLE_PLAY", purchaseToken: { not: null }, status: { in: [...MAY_STILL_CHARGE] } },
      select: rowSelect
    });
    return await stopEach(rows, log, play);
  } catch (error) {
    log.warn({ err: error, event: "account.subscription_cancel_failed", userId }, "Could not read the account's subscriptions to cancel them");
    return { stopped: 0, failed: 1 };
  }
}

/**
 * Retries the subscriptions of accounts whose deletion has completed and that
 * Google has not yet confirmed will stop. Never throws.
 */
export async function retryDeletedAccountSubscriptionCancellations(
  log: Logger,
  play: PlaySubscriptionCanceller | null = null
): Promise<SubscriptionCancellationResult> {
  try {
    const rows = await prisma.subscriptionState.findMany({
      where: {
        provider: "GOOGLE_PLAY",
        purchaseToken: { not: null },
        status: { in: [...MAY_STILL_CHARGE] },
        user: { status: "DISABLED", accountDeletionRequests: { some: { status: "COMPLETED" } } }
      },
      orderBy: { updatedAt: "asc" },
      take: RETRY_BATCH_SIZE,
      select: rowSelect
    });
    return await stopEach(rows, log, play);
  } catch (error) {
    log.warn({ err: error, event: "account.subscription_cancel_retry_failed" }, "Deleted-account subscription retry failed");
    return { stopped: 0, failed: 1 };
  }
}

async function stopEach(
  rows: CancellableRow[],
  log: Logger,
  play: PlaySubscriptionCanceller | null
): Promise<SubscriptionCancellationResult> {
  const result: SubscriptionCancellationResult = { stopped: 0, failed: 0 };
  for (const row of rows) {
    if (!row.purchaseToken) continue;
    try {
      const outcome = await stopRenewing(row.purchaseToken, row.product?.sku ?? null, play ?? playFromConfig());
      await prisma.subscriptionState.update({
        where: { id: row.id },
        data: { purchaseToken: null, autoRenewing: false, nextCreditGrantAt: null, canceledAt: row.canceledAt ?? new Date() }
      });
      result.stopped += 1;
      log.info(
        { event: "account.subscription_cancelled", userId: row.userId, subscriptionId: row.id, outcome },
        "Deleted account's Google Play subscription will not renew"
      );
    } catch (error) {
      result.failed += 1;
      log.warn(
        { err: error, event: "account.subscription_cancel_failed", userId: row.userId, subscriptionId: row.id },
        "Deleted account's Google Play subscription could not be cancelled; it will be retried"
      );
      // To the back of the retry queue, which is oldest-touched first: a row
      // Google keeps refusing must not hold the head of every pass.
      await prisma.subscriptionState
        .update({ where: { id: row.id }, data: { updatedAt: new Date() } })
        .catch(() => undefined);
    }
  }
  return result;
}

/**
 * Makes sure Google will not charge `purchaseToken` again: nothing to do when it
 * already expired or its owner turned renewal off, otherwise a cancellation.
 * A paused or on-hold subscription is cancelled whatever it says about
 * renewal, because Google resumes it on its own. Throws when Google could not
 * be asked or refused.
 */
async function stopRenewing(
  purchaseToken: string,
  sku: string | null,
  play: PlaySubscriptionCanceller
): Promise<"expired" | "not_renewing" | "cancelled"> {
  if (sku) {
    const verification = await play.verifier
      .verifyPurchase({ packageName: play.packageName, productId: sku, productType: "SUBSCRIPTION", purchaseToken })
      // A token Google files under another product (a plan change) is still
      // this account's to cancel; the cancellation itself is keyed by token.
      .catch((error: unknown) => (error instanceof GooglePlayProductMismatchError ? null : Promise.reject(error)));
    const status = verification?.subscription?.status;
    // A signup whose payment never cleared and was given up will never charge.
    if (status === "EXPIRED" || verification?.providerStatus === "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED") return "expired";
    if (status && status !== "PAUSED" && verification?.subscription?.autoRenewing === false) return "not_renewing";
  }
  await play.verifier.cancelSubscription({ packageName: play.packageName, purchaseToken });
  return "cancelled";
}

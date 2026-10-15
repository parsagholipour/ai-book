/**
 * Google Play purchases and subscriptions: turning a verified store receipt into
 * a purchase record, a credit grant, and — for subscriptions — the plan
 * entitlement and the subscription state row the renewal sweep reads back.
 *
 * Verification itself lives in the API (`apps/api/src/googlePlayBilling.ts`);
 * this module only records what it returned.
 */
import {
  DEFAULT_BILLING_PRODUCTS,
  RETIRED_BILLING_PRODUCT_SKUS,
  PLAN_ENTITLEMENT_TYPES,
  jsonRecord,
  type BillingOperation,
  type PlanEntitlementType,
  planEntitlementTypeForSubscriptionSku
} from "@book-maker/core";
import { prisma } from "./client.ts";
import { type BillingTx, hashPurchaseToken, jsonInput, runSerializable } from "./billingInternals.ts";
import { grantCreditsTx } from "./billingLedger.ts";
import { ensureCurrentPlanPeriodTx } from "./planPeriods.ts";
import { type PaymentLocalPrice, recordPurchasePaymentTx } from "./purchasePayments.ts";
import { paidPriceMicros } from "./subscriptionAllowance.ts";
import {
  type OrderPurchaseRecord,
  type PlannedAllowanceMonth,
  type RecordedOrderMonth,
  grantPlannedMonthTx,
  keepPaidPeriodTx,
  orderCreditsGranted,
  planRecordedOrderMonthTx,
  planVerifiedOrderMonthTx
} from "./subscriptionMonths.ts";

import { applyGooglePlayRefundTx, recordGooglePlayRefundTx, runGooglePlayTransaction } from "./googlePlayRefunds.ts";

export type GooglePlayPurchaseKind = "one_time" | "subscription";

export type GooglePlaySubscriptionGrantState =
  | "ACTIVE"
  | "GRACE_PERIOD"
  | "CANCELED"
  | "PAUSED"
  | "EXPIRED"
  | "INACTIVE";

export type VerifiedGooglePlayPurchase = {
  productSku: string;
  purchaseToken: string;
  kind: GooglePlayPurchaseKind;
  grantable: boolean;
  providerStatus: string;
  externalPurchaseId?: string | null | undefined;
  purchasedAt?: Date | null | undefined;
  quantity?: number | undefined;
  subscription?: {
    status: GooglePlaySubscriptionGrantState;
    currentPeriodStart?: Date | null | undefined;
    currentPeriodEnd?: Date | null | undefined;
    /** False once the reader has cancelled. Null when the provider did not say. */
    autoRenewing?: boolean | null | undefined;
    /**
     * Which phase of its offer the current period is: a free trial grants the
     * plan but no credits and no payment; an introductory price grants the
     * allowance at the offer's price. Null when Google did not say.
     */
    offerPhase?: "free_trial" | "introductory" | "base" | "proration" | null | undefined;
    /** The Play Console offer ID, when the subscription was bought through an offer. */
    offerId?: string | null | undefined;
    /** Google's base-plan recurring price in the buyer's currency, before tax and discounts. */
    recurringPrice?: { micros: number; currency: string } | null | undefined;
    /** When Google will resume a paused or on-hold subscription on its own. */
    resumesAt?: Date | null | undefined;
    /**
     * A plan change Play deferred to the end of the paid period (the app's
     * downgrade, `ReplacementMode.DEFERRED`). Until `takesEffectAt` this token
     * carries `fromProductSku`, which the linked token already paid for and was
     * granted; `productSku` is the plan it renews into. Nothing is granted for
     * it now, and the replaced plan keeps its entitlement and allowance.
     */
    deferredReplacement?: { fromProductSku: string; takesEffectAt: Date | null } | null | undefined;
  } | null | undefined;
  metadata?: Record<string, unknown> | undefined;
};

/**
 * What the app says Play charged, from Play's own product details — analytics
 * only, never a grant. Integer micros of an ISO 4217 currency.
 */
export type GooglePlayClientPrice = { micros: number; currency: string };

export type GooglePlayPurchaseRecordResult = {
  purchaseRecordId: string;
  status: string;
  creditsGranted: number;
  ledgerEntryId: string | null;
  subscriptionStatus: string | null;
  entitlementType: string | null;
  /** A plan change Play deferred: the plan it moves to and when. Nothing was granted for it. */
  scheduledChange?: { productSku: string; startsAt: Date | null } | undefined;
};

export async function ensureDefaultProductCatalog(): Promise<void> {
  for (const product of DEFAULT_BILLING_PRODUCTS) {
    await prisma.productCatalog.upsert({
      where: { sku: product.sku },
      create: {
        sku: product.sku,
        title: product.title,
        description: product.description,
        productType: product.productType,
        creditAmount: product.creditAmount,
        priceMicros: BigInt(product.priceMicros),
        currency: product.currency,
        metadata: jsonInput({
          launchAssumption: true,
          googlePlayVerificationPending: true
        })
      },
      update: {
        title: product.title,
        description: product.description,
        productType: product.productType,
        creditAmount: product.creditAmount,
        priceMicros: BigInt(product.priceMicros),
        currency: product.currency,
        active: true,
        metadata: jsonInput({
          launchAssumption: true,
          googlePlayVerificationPending: true
        })
      }
    });
  }
  await prisma.productCatalog.updateMany({
    where: { sku: { in: [...RETIRED_BILLING_PRODUCT_SKUS] }, active: true },
    data: { active: false }
  });
}

export async function recordVerifiedGooglePlayPurchase(options: {
  userId: string;
  verification: VerifiedGooglePlayPurchase;
  clientPrice?: GooglePlayClientPrice | undefined;
}): Promise<GooglePlayPurchaseRecordResult> {
  return runGooglePlayTransaction((tx) => recordVerifiedGooglePlayPurchaseTx(tx, options));
}

async function recordVerifiedGooglePlayPurchaseTx(tx: BillingTx, options: {
  userId: string;
  verification: VerifiedGooglePlayPurchase;
  clientPrice?: GooglePlayClientPrice | undefined;
}): Promise<GooglePlayPurchaseRecordResult> {
  const { userId, verification } = options;
  const deferred = verification.kind === "subscription" ? verification.subscription?.deferredReplacement ?? null : null;
  const tokenHash = hashPurchaseToken(verification.purchaseToken);
  const now = new Date();
  const product = await tx.productCatalog.findUnique({
    where: { sku: verification.productSku },
    select: {
      id: true,
      sku: true,
      title: true,
      productType: true,
      creditAmount: true,
      priceMicros: true,
      currency: true,
      active: true
    }
  });
  if (!product || !product.active) {
    throw new Error(`Unknown or inactive Google Play product: ${verification.productSku}`);
  }

  const existing = await tx.purchaseRecord.findFirst({
    where: { provider: "GOOGLE_PLAY", purchaseTokenHash: tokenHash },
    select: {
      id: true, userId: true, creditsGranted: true, status: true, externalPurchaseId: true, metadata: true,
      localPriceMicros: true, localCurrency: true, productId: true, purchaseTokenHash: true
    }
  });
  if (existing && existing.userId !== userId) {
    throw new Error("This Google Play purchase is already linked to another account.");
  }
  const grantIdempotencyKey = googlePlayGrantIdempotencyKey(verification, tokenHash);
  const paid = paidPriceMicros(product, verification);
  const localPrice = paymentLocalPrice(verification, options.clientPrice, existing, paid.amountSource);
  const recordPayment = (purchaseRecordId: string) => recordPurchasePaymentTx(tx, {
    userId, purchaseRecordId, tokenHash, idempotencyKey: grantIdempotencyKey,
    priceMicros: paid.priceMicros, amountSource: paid.amountSource, currency: product.currency, verification, now,
    localPrice
  });
  // Historical payment evidence survives even when the access-state guard
  // correctly ignores a stale receipt. The payment's own key/refund markers dedupe it.
  if (existing) await recordPayment(existing.id);
  // A verification started before a switch can arrive after its replacement.
  // Retirement is durable and must win over that stale ACTIVE response.
  if (existing && typeof jsonRecord(existing.metadata).replacedByPurchaseTokenHash === "string") {
    return { purchaseRecordId: existing.id, status: "REVOKED", creditsGranted: existing.creditsGranted,
      ledgerEntryId: null, subscriptionStatus: "EXPIRED", entitlementType: null };
  }
  if (existing && verification.kind === "subscription") {
    const stale = await staleSubscriptionVerificationResult(tx, existing, verification, tokenHash);
    if (stale) return stale;
  }
  // A cancellation learned during restore is the same terminal refund as RTDN.
  if (verification.kind === "one_time" && verification.providerStatus === "CANCELED") {
    await recordGooglePlayRefundTx(tx, {
      purchaseToken: verification.purchaseToken,
      orderId: verification.externalPurchaseId ?? "canceled",
      productType: 2
    });
  }
  const refund = await tx.googlePlayRefund.findFirst({
    where: {
      purchaseTokenHash: tokenHash,
      // Without a paid order ID, a subscription cannot prove it is a newer
      // renewal than an existing refund of this token.
      ...(verification.kind === "subscription" && verification.externalPurchaseId
        ? { orderId: verification.externalPurchaseId } : {})
    },
    orderBy: { refundableQuantity: "asc" }
  });
  if (existing && (refund?.refundableQuantity === 0 || (verification.kind === "one_time" && existing.status === "REVOKED"))) {
    return { purchaseRecordId: existing.id, status: "REVOKED", creditsGranted: existing.creditsGranted,
      ledgerEntryId: null, subscriptionStatus: null, entitlementType: null };
  }
  if (existing && verification.kind === "subscription" && !verification.grantable) {
    const kept = await keepPaidPeriodTx(tx, { userId, product, purchase: existing, tokenHash, now });
    if (kept) return kept;
  }
  const retired = verification.kind === "subscription" && verification.grantable && refund?.refundableQuantity !== 0
    ? await retireReplacedSubscriptionTx(tx, userId, verification, tokenHash, now, deferred !== null)
    : null;
  const purchaseStatus = purchaseRecordStatusForVerification(verification);
  const recordData = {
    productId: product.id,
    externalPurchaseId: verification.externalPurchaseId ?? null,
    status: purchaseStatus,
    amountMicros: product.priceMicros,
    currency: product.currency,
    // The app's latest report, kept where a later grant (a pending pack that
    // clears through RTDN) can still find it. Never cleared by a report-less
    // verification: the sweep and RTDN know nothing of the buyer's currency.
    ...(options.clientPrice
      ? { localPriceMicros: BigInt(options.clientPrice.micros), localCurrency: options.clientPrice.currency }
      : {}),
    purchasedAt: verification.purchasedAt ?? null,
    verifiedAt: now,
    metadata: jsonInput(verificationMetadata(verification, tokenHash))
  };
  const recordSelect = { id: true, status: true, creditsGranted: true } as const;
  let purchaseRecord;
  if (existing) {
    purchaseRecord = await tx.purchaseRecord.update({
      where: { id: existing.id },
      data: recordData,
      select: recordSelect
    });
  } else {
    purchaseRecord = await tx.purchaseRecord.create({
      data: { userId, provider: "GOOGLE_PLAY", purchaseTokenHash: tokenHash, ...recordData },
      select: recordSelect
    });
    await recordPayment(purchaseRecord.id);
  }

  if (refund?.refundableQuantity === 0 || (verification.kind === "one_time" && existing?.status === "REVOKED")) {
    await tx.purchaseRecord.update({ where: { id: purchaseRecord.id }, data: { status: "REVOKED" } });
    return { purchaseRecordId: purchaseRecord.id, status: "REVOKED", creditsGranted: purchaseRecord.creditsGranted,
      ledgerEntryId: null, subscriptionStatus: null, entitlementType: null };
  }

  // The month this verification grants: the order's own (`subscriptionMonths.ts`),
  // or — for a deferred downgrade — the old plan's, whose paid months the new
  // token carries. Planned before the state row is written, because the row is
  // due again when the next month starts, not only when Google's period ends.
  let planned: PlannedAllowanceMonth | null = null;
  let carried: RecordedOrderMonth | null = null;
  if (verification.kind === "subscription" && verification.grantable) {
    if (deferred) {
      carried = retired ? await planRecordedOrderMonthTx(tx, { record: retired.record, periodEnd: deferred.takesEffectAt, now }) : null;
    } else {
      planned = await planVerifiedOrderMonthTx(tx, {
        product, verification, purchaseRecordId: purchaseRecord.id, orderKey: grantIdempotencyKey,
        // The token's first paid order: nothing earlier recorded on it, or this same order again.
        firstOrder: !existing?.externalPurchaseId || existing.externalPurchaseId === (verification.externalPurchaseId ?? null),
        // A switch that took effect where the old plan's paid time ran out carried no time over.
        startsAtOldPlanEnd: hasDeferredReplacement(existing?.metadata) ||
          (retired?.replacedPeriodEnd != null && retired.replacedPeriodEnd <= now),
        now
      });
    }
  }

  // Recorded whether or not this verification grants anything: an expired or
  // canceled subscription has to update its state row too, or the renewal sweep
  // keeps polling a subscription Google has already closed.
  if (verification.kind === "subscription" && verification.subscription) {
    await upsertSubscriptionState(tx, {
      userId,
      productId: product.id,
      tokenHash,
      purchaseToken: verification.purchaseToken,
      status: verification.subscription.status,
      creditsPerPeriod: product.creditAmount,
      currentPeriodStart: verification.subscription.currentPeriodStart ?? null,
      currentPeriodEnd: verification.subscription.currentPeriodEnd ?? null,
      autoRenewing: verification.subscription.autoRenewing ?? null,
      resumesAt: verification.subscription.resumesAt ?? null,
      nextMonthAt: (deferred ? carried?.nextMonthAt : planned?.nextMonthAt) ?? null,
      metadata: verificationMetadata(verification, tokenHash)
    });
  }

  if (!verification.grantable) {
    if (verification.kind === "subscription") {
      await tx.userEntitlement.updateMany({
        where: { purchaseRecordId: purchaseRecord.id, status: "ACTIVE" },
        data: { status: "EXPIRED", expiresAt: now }
      });
      const account = await tx.userCreditAccount.findUnique({ where: { userId } });
      if (account?.planPeriodKey?.startsWith(`sub:${tokenHash}:`)) {
        await tx.userCreditAccount.update({ where: { userId }, data: { planPeriodEnd: now } });
        await ensureCurrentPlanPeriodTx(tx, userId, now);
      }
    }
    return {
      purchaseRecordId: purchaseRecord.id,
      status: purchaseRecord.status,
      creditsGranted: purchaseRecord.creditsGranted,
      ledgerEntryId: null,
      subscriptionStatus: verification.subscription?.status ?? null,
      entitlementType: null
    };
  }

  if (deferred) {
    // A downgrade Play deferred to renewal: the token carries the old plan
    // until then, and the old plan was paid for and granted under its own
    // token. The new plan is granted nothing now. The old plan's entitlement
    // moves onto this record — Google transfers the remaining time to this
    // token, and a later switch away from it must take that entitlement down
    // with it — and the allowance stays on the old period. A plan granted by
    // the month (the yearly one) keeps being granted its paid months from this
    // token: the old token is closed, so this row is the one the renewal sweep
    // polls, at each of those months and then at `takesEffectAt`, when the new
    // plan's first paid period grants as usual.
    if (retired) {
      await tx.userEntitlement.updateMany({
        where: { purchaseRecordId: retired.record.id, status: "ACTIVE", type: { in: PLAN_ENTITLEMENT_TYPES } },
        data: { purchaseRecordId: purchaseRecord.id }
      });
    }
    const carriedEntry = carried
      ? await grantPlannedMonthTx(tx, {
          userId, productId: carried.productId, purchaseRecordId: carried.purchaseRecordId, tokenHash: carried.tokenHash,
          description: carried.description, metadata: { ...carried.grantMetadata, carriedBy: "deferred_replacement" },
          planned: carried, now
        })
      : null;
    if (carried && retired) {
      await tx.purchaseRecord.update({ where: { id: carried.purchaseRecordId },
        data: { creditsGranted: orderCreditsGranted(carried, carriedEntry, retired.record.creditsGranted) } });
    }
    return {
      purchaseRecordId: purchaseRecord.id,
      status: purchaseRecord.status,
      creditsGranted: purchaseRecord.creditsGranted,
      ledgerEntryId: carried && !carried.alreadyGranted ? carriedEntry?.id ?? null : null,
      subscriptionStatus: verification.subscription?.status ?? null,
      entitlementType: null,
      scheduledChange: { productSku: product.sku, startsAt: deferred.takesEffectAt }
    };
  }

  const quantity = verification.kind === "one_time" ? Math.max(1, Math.floor(verification.quantity ?? 1)) : 1;
  const grantMetadata = {
    productSku: product.sku,
    provider: "GOOGLE_PLAY",
    purchaseTokenHash: tokenHash,
    providerStatus: verification.providerStatus,
    externalPurchaseId: verification.externalPurchaseId ?? null
  };

  const entitlementType =
    verification.kind === "subscription" ? planEntitlementTypeForSubscriptionSku(product.sku) : null;
  let subscriptionStatus: string | null = null;
  if (verification.kind === "subscription" && verification.subscription) {
    subscriptionStatus = verification.subscription.status;
    // Entitlement before credits: if the grant fails and the app retries, a user
    // who has already paid is at least on the right plan in the meantime.
    if (entitlementType && subscriptionEntitlementIsActive(verification.subscription.status)) {
      // A deferred change that has taken effect leaves the plan it replaced on
      // this record; that one has run out now.
      await tx.userEntitlement.updateMany({
        where: {
          purchaseRecordId: purchaseRecord.id,
          status: "ACTIVE",
          type: { in: PLAN_ENTITLEMENT_TYPES.filter((type) => type !== entitlementType) }
        },
        data: { status: "EXPIRED", expiresAt: now }
      });
      await upsertSubscriptionEntitlement(tx, {
        userId,
        type: entitlementType,
        source: "google_play_subscription",
        purchaseRecordId: purchaseRecord.id,
        expiresAt: verification.subscription.currentPeriodEnd ?? null,
        metadata: grantMetadata
      });
    }
  }

  // A subscription's credits are a month's allowance — they reset at the next
  // month rather than stacking up, and a period longer than a month is granted
  // one month at a time (`subscriptionMonths.ts`). Anything bought outright is
  // added to the pool that never expires.
  const amountCredits = product.creditAmount * quantity;
  const ledgerEntry =
    verification.kind === "subscription"
      ? planned
        ? await grantPlannedMonthTx(tx, {
            userId, productId: product.id, purchaseRecordId: purchaseRecord.id, tokenHash,
            description: `${product.title} plan credits`, metadata: grantMetadata, planned, now
          })
        : null
      : amountCredits <= 0
        ? null
        : await grantCreditsTx(tx, {
            userId,
            productId: product.id,
            purchaseRecordId: purchaseRecord.id,
            amountCredits,
            operation: "PURCHASE_CREDIT_GRANT" satisfies BillingOperation,
            idempotencyKey: grantIdempotencyKey,
            description: `${product.title} Google Play credit grant`,
            metadata: grantMetadata
          });

  // `creditsGranted` records what was actually deposited: a subscription
  // period that was adopted rather than re-granted deposits nothing
  // (`entry: null`), and stamping the full allowance onto it would overstate
  // delivered credits everywhere the record is read back. A subscription's is
  // what its current order's months have granted so far.
  const updatedPurchase = await tx.purchaseRecord.update({
    where: { id: purchaseRecord.id },
    data: {
      status: "GRANTED",
      creditsGranted: verification.kind === "subscription"
        ? orderCreditsGranted(planned, ledgerEntry, purchaseRecord.creditsGranted)
        : ledgerEntry ? amountCredits : purchaseRecord.creditsGranted
    },
    select: { id: true, status: true, creditsGranted: true }
  });

  if (refund) await applyGooglePlayRefundTx(tx, refund);

  return {
    purchaseRecordId: updatedPurchase.id,
    status: updatedPurchase.status,
    creditsGranted: updatedPurchase.creditsGranted,
    ledgerEntryId: ledgerEntry?.id ?? null,
    subscriptionStatus,
    entitlementType
  };
}

/** An older order cannot rewrite any part of the subscription that replaced it. */
async function staleSubscriptionVerificationResult(
  tx: BillingTx,
  purchase: { id: string; userId: string; status: string; creditsGranted: number; externalPurchaseId: string | null; metadata: unknown },
  verification: VerifiedGooglePlayPurchase,
  tokenHash: string
): Promise<GooglePlayPurchaseRecordResult | null> {
  // The current order may legitimately be cancelled, expire, or have its end
  // corrected in either direction. Those updates still belong to this period.
  if (verification.externalPurchaseId && verification.externalPurchaseId === purchase.externalPurchaseId) return null;

  const metadata = jsonRecord(purchase.metadata);
  const recordedEnd = jsonRecord(metadata.subscription).currentPeriodEnd;
  const reportedEnd = verification.subscription?.currentPeriodEnd;
  const earlierPeriod = typeof recordedEnd === "string" && reportedEnd && reportedEnd.getTime() < Date.parse(recordedEnd);
  // An old order's expiry can be missing or corrected past the new one. Its
  // recorded grant identifies its paid period even then. Conversely, period
  // bounds catch old receipts never recorded here.
  const recordedGrant = verification.externalPurchaseId && purchase.externalPurchaseId
    ? await tx.creditLedgerEntry.findUnique({
        where: { idempotencyKey: googlePlayGrantIdempotencyKey(verification, tokenHash) },
        select: { metadata: true }
      })
    : null;
  if (recordedGrant) {
    const account = await tx.userCreditAccount.findUnique({
      where: { userId: purchase.userId }, select: { planPeriodKey: true }
    });
    const grantedPeriod = jsonRecord(recordedGrant.metadata).planPeriodKey;
    // Before this guard existed, a stale receipt could overwrite the other
    // rows while the allowance stayed current. Let its owning receipt repair
    // those rows on restore; it must not be mistaken for another old order.
    if (typeof grantedPeriod === "string" && grantedPeriod === account?.planPeriodKey) return null;
  }
  if (!earlierPeriod && !recordedGrant) return null;

  // This read and the freshness decision run inside the same serializable
  // transaction as renewals and refunds. Return current state without touching
  // the order ID, expiry, entitlement, allowance, or any refund marker.
  const subscription = await tx.subscriptionState.findFirst({
    where: { provider: "GOOGLE_PLAY", externalSubscriptionId: tokenHash },
    select: { status: true }
  });
  return {
    purchaseRecordId: purchase.id,
    status: purchase.status,
    creditsGranted: purchase.creditsGranted,
    ledgerEntryId: null,
    subscriptionStatus: subscription?.status ?? null,
    entitlementType: subscription && subscriptionEntitlementIsActive(subscription.status) && typeof metadata.productSku === "string"
      ? planEntitlementTypeForSubscriptionSku(metadata.productSku) : null
  };
}

/**
 * Only Google's verified replacement link may retire a previous purchase.
 * Returns the retired record, and the paid end its token's state row held
 * before this retired it.
 *
 * An immediate switch ends the old plan now. A deferred one (`deferred`) only
 * closes the old token — Google reports it expired and moves its remaining
 * time onto the new one — while the old plan's entitlement and allowance run
 * to the end of the period they were paid for; the caller moves that
 * entitlement onto the new record.
 */
async function retireReplacedSubscriptionTx(
  tx: BillingTx, userId: string, verification: VerifiedGooglePlayPurchase, tokenHash: string, now: Date, deferred: boolean
): Promise<{ record: OrderPurchaseRecord; replacedPeriodEnd: Date | null } | null> {
  const linkedToken = verification.metadata?.linkedPurchaseToken;
  if (typeof linkedToken !== "string" || !linkedToken.trim()) return null;
  const oldHash = hashPurchaseToken(linkedToken);
  if (oldHash === tokenHash) throw new Error("A Google Play subscription cannot replace itself.");
  const previous = await tx.purchaseRecord.findFirst({
    where: { provider: "GOOGLE_PLAY", purchaseTokenHash: oldHash }
  });
  if (previous && previous.userId !== userId) {
    throw new Error("The replaced Google Play subscription is linked to another account.");
  }
  const metadata = jsonRecord(previous?.metadata);
  if (typeof metadata.replacedByPurchaseTokenHash === "string" && metadata.replacedByPurchaseTokenHash !== tokenHash) {
    throw new Error("This Google Play subscription has already been replaced.");
  }
  const retirement = {
    metadata: jsonInput({ ...metadata, replacedByPurchaseTokenHash: tokenHash })
  };
  // Replacing a plan is not a refund: keep the prior paid record's status and
  // amount for revenue accounting. Its marker closes future receipt grants.
  // The replacement can reach us before the old receipt was ever recorded.
  // Keep a token tombstone so a later restore cannot claim the retired plan.
  const retired = previous
    ? await tx.purchaseRecord.update({ where: { id: previous.id }, data: retirement })
    : await tx.purchaseRecord.create({ data: {
        userId, provider: "GOOGLE_PLAY", purchaseTokenHash: oldHash, currency: "USD", status: "REVOKED", ...retirement
      } });
  if (!deferred) {
    await tx.userEntitlement.updateMany({
      where: { purchaseRecordId: retired.id, status: "ACTIVE" }, data: { status: "EXPIRED", expiresAt: now }
    });
  }
  const subscription = await tx.subscriptionState.findFirst({
    where: { provider: "GOOGLE_PLAY", externalSubscriptionId: oldHash }
  });
  if (subscription) {
    // Deferred, the old row keeps the end of the period it paid for; the new
    // token's row carries the same date and is the one the sweep polls.
    await tx.subscriptionState.update({ where: { id: subscription.id }, data: {
      status: "EXPIRED", autoRenewing: false, nextCreditGrantAt: null, ...(deferred ? {} : { currentPeriodEnd: now })
    } });
  }
  return { record: retired, replacedPeriodEnd: subscription?.currentPeriodEnd ?? null };
}

/** Whether a record's last verification was a deferred plan change, before it took effect. */
function hasDeferredReplacement(metadata: unknown): boolean {
  const change = jsonRecord(jsonRecord(metadata).subscription).deferredReplacement;
  return change !== null && typeof change === "object";
}

export type EndSubscriptionResult = {
  ended: boolean;
  endedSubscriptionIds: string[];
};

/**
 * End a subscription now rather than at its period end, and land the account on
 * the free tier in the same transaction.
 *
 * Google owns cancellation for a real purchase — the app deep-links to the Play
 * subscription centre and the next verification tells us what happened. This is
 * for the mock verifier, which always answers ACTIVE: without it a dev account
 * that ever bought a plan can never see the free tier again.
 *
 * Three things hold a paid tier up and all three have to come down together:
 * the entitlement row `resolvePlanTier` reads, the plan period that stops
 * `ensureCurrentPlanPeriod` granting a free month, and the stored purchase
 * token — leaving that would let the very next refresh or renewal sweep
 * re-verify it and put the plan straight back.
 */
export async function endSubscriptionNow(userId: string, now: Date = new Date()): Promise<EndSubscriptionResult> {
  return runSerializable(async (tx) => {
    const subscriptions = await tx.subscriptionState.findMany({
      where: { userId, status: { in: ["ACTIVE", "GRACE_PERIOD", "CANCELED", "PAUSED"] } },
      select: { id: true, canceledAt: true }
    });
    const entitlements = await tx.userEntitlement.findMany({
      where: { userId, status: "ACTIVE", type: { in: PLAN_ENTITLEMENT_TYPES } },
      select: { id: true }
    });
    if (subscriptions.length === 0 && entitlements.length === 0) {
      return { ended: false, endedSubscriptionIds: [] };
    }

    for (const subscription of subscriptions) {
      await tx.subscriptionState.update({
        where: { id: subscription.id },
        data: {
          status: "EXPIRED",
          canceledAt: subscription.canceledAt ?? now,
          currentPeriodEnd: now,
          nextCreditGrantAt: null,
          autoRenewing: false,
          purchaseToken: null
        }
      });
    }
    await tx.userEntitlement.updateMany({
      where: { userId, status: "ACTIVE", type: { in: PLAN_ENTITLEMENT_TYPES } },
      data: { status: "EXPIRED", expiresAt: now }
    });
    // Cut the paid period short before asking for the free one: the free grant
    // is skipped while a live period is still owned by whoever granted it.
    await tx.userCreditAccount.updateMany({
      where: { userId },
      data: { planPeriodEnd: now, planPeriodKey: null }
    });
    await ensureCurrentPlanPeriodTx(tx, userId, now);

    return { ended: true, endedSubscriptionIds: subscriptions.map((subscription) => subscription.id) };
  });
}

export { hashPurchaseToken } from "./billingInternals.ts";

function purchaseRecordStatusForVerification(verification: VerifiedGooglePlayPurchase): "PENDING" | "VERIFIED" | "FAILED" {
  if (verification.grantable) {
    return "VERIFIED";
  }
  return verification.providerStatus === "PENDING" || verification.providerStatus === "SUBSCRIPTION_STATE_PENDING"
    ? "PENDING"
    : "FAILED";
}

/**
 * The buyer's own price for the payment this verification records. The app's
 * report wins; a pack pending when the app reported it is found again on its
 * record. A full-price subscription period nobody verified from the app (the
 * renewal sweep, RTDN) takes Google's recurring base-plan price, which is
 * what that period charged before tax. Never decides anything but analytics.
 */
function paymentLocalPrice(
  verification: VerifiedGooglePlayPurchase,
  clientPrice: GooglePlayClientPrice | undefined,
  existing: { localPriceMicros: bigint | null; localCurrency: string | null } | null,
  amountSource: string
): PaymentLocalPrice | null {
  if (clientPrice) {
    return { micros: BigInt(clientPrice.micros), currency: clientPrice.currency, source: "client" };
  }
  if (verification.kind === "one_time" && existing?.localPriceMicros != null && existing.localCurrency) {
    return { micros: existing.localPriceMicros, currency: existing.localCurrency, source: "client" };
  }
  const recurring = verification.subscription?.recurringPrice;
  if (verification.kind === "subscription" && amountSource === "catalog_snapshot" && recurring &&
    (verification.subscription?.offerPhase === "base" || verification.subscription?.offerPhase == null)) {
    return { micros: BigInt(recurring.micros), currency: recurring.currency, source: "play_recurring_price" };
  }
  return null;
}

function googlePlayGrantIdempotencyKey(verification: VerifiedGooglePlayPurchase, tokenHash: string): string {
  if (verification.kind === "subscription") {
    const periodKey =
      verification.externalPurchaseId ??
      verification.subscription?.currentPeriodEnd?.toISOString() ??
      verification.purchasedAt?.toISOString() ??
      "current";
    return `google-play:subscription:${tokenHash}:${periodKey}`;
  }
  return `google-play:purchase:${tokenHash}:credits`;
}

function subscriptionEntitlementIsActive(status: GooglePlaySubscriptionGrantState): boolean {
  return status === "ACTIVE" || status === "GRACE_PERIOD" || status === "CANCELED";
}

async function upsertSubscriptionState(tx: BillingTx, options: {
  userId: string;
  productId: string;
  tokenHash: string;
  purchaseToken: string;
  status: GooglePlaySubscriptionGrantState;
  creditsPerPeriod: number;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  autoRenewing: boolean | null;
  resumesAt: Date | null;
  /** When the order's next month starts, if one does before its period ends. */
  nextMonthAt?: Date | null | undefined;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const existing = await tx.subscriptionState.findFirst({
    where: {
      provider: "GOOGLE_PLAY",
      externalSubscriptionId: options.tokenHash
    },
    select: { canceledAt: true }
  });
  const cancelling = options.status === "CANCELED" || options.autoRenewing === false;
  const data = {
    userId: options.userId,
    productId: options.productId,
    provider: "GOOGLE_PLAY" as const,
    externalSubscriptionId: options.tokenHash,
    // Kept so the renewal sweep can re-verify without waiting for the app to
    // check in; the hash alone cannot be sent back to Google.
    purchaseToken: options.purchaseToken,
    status: options.status,
    creditsPerPeriod: options.creditsPerPeriod,
    currentPeriodStart: options.currentPeriodStart,
    currentPeriodEnd: options.currentPeriodEnd,
    autoRenewing: options.autoRenewing,
    // Null once Google says it is over: the sweep polls on this column, and a
    // dead subscription with a past date would be re-checked forever. A live
    // subscription whose verification carried no period end must NOT go null —
    // that drops a paying subscriber out of the sweep for good, so the next
    // sweep re-asks Google instead until an expiry is reported.
    // A paused or on-hold subscription is asked about again when Google says
    // it resumes, rather than every hour from a period end long past. A plan
    // granted by the month inside a longer period (a yearly plan, or a switch's
    // carried time) is asked about at each month's start: the sweep is what
    // grants months two to twelve.
    nextCreditGrantAt:
      options.status === "EXPIRED"
        ? null
        : options.status === "PAUSED" && options.resumesAt && options.resumesAt > new Date()
          ? options.resumesAt
          : (options.nextMonthAt ?? options.currentPeriodEnd ?? new Date()),
    // When it was first seen to be ending, not when we last looked: the sweep
    // re-verifies a cancelled subscription every hour until it expires.
    canceledAt: cancelling ? (existing?.canceledAt ?? new Date()) : null,
    metadata: jsonInput(options.metadata)
  };
  // Native upsert on the (provider, externalSubscriptionId) unique: two
  // concurrent verifications used to findFirst-nothing and create twice, after
  // which every later update maintained one row while the renewal sweep polled
  // the other — re-verifying a closed subscription forever.
  await tx.subscriptionState.upsert({
    where: {
      provider_externalSubscriptionId: {
        provider: "GOOGLE_PLAY",
        externalSubscriptionId: options.tokenHash
      }
    },
    create: data,
    update: data
  });
}

async function upsertSubscriptionEntitlement(tx: BillingTx, options: {
  userId: string;
  type: PlanEntitlementType;
  source: string;
  purchaseRecordId: string;
  expiresAt: Date | null;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const existing = await tx.userEntitlement.findFirst({
    where: {
      userId: options.userId,
      type: options.type,
      source: options.source,
      status: "ACTIVE"
    },
    select: { id: true }
  });
  const data = {
    purchaseRecordId: options.purchaseRecordId,
    expiresAt: options.expiresAt,
    metadata: jsonInput(options.metadata)
  };
  if (existing) {
    await tx.userEntitlement.update({
      where: { id: existing.id },
      data
    });
    return;
  }
  await tx.userEntitlement.create({
    data: {
      userId: options.userId,
      type: options.type,
      source: options.source,
      creditsCost: 0,
      purchaseRecordId: options.purchaseRecordId,
      expiresAt: options.expiresAt,
      metadata: jsonInput(options.metadata)
    }
  });
}

function verificationMetadata(verification: VerifiedGooglePlayPurchase, tokenHash: string): Record<string, unknown> {
  return {
    provider: "GOOGLE_PLAY",
    productSku: verification.productSku,
    purchaseKind: verification.kind,
    purchaseTokenHash: tokenHash,
    providerStatus: verification.providerStatus,
    externalPurchaseId: verification.externalPurchaseId ?? null,
    grantable: verification.grantable,
    quantity: verification.quantity ?? 1,
    subscription: verification.subscription
      ? {
          status: verification.subscription.status,
          currentPeriodStart: verification.subscription.currentPeriodStart?.toISOString() ?? null,
          currentPeriodEnd: verification.subscription.currentPeriodEnd?.toISOString() ?? null,
          ...(verification.subscription.deferredReplacement
            ? {
                deferredReplacement: {
                  fromProductSku: verification.subscription.deferredReplacement.fromProductSku,
                  takesEffectAt: verification.subscription.deferredReplacement.takesEffectAt?.toISOString() ?? null
                }
              }
            : {})
        }
      : null,
    ...verification.metadata
  };
}

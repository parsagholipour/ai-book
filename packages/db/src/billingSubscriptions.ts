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
  PLAN_ENTITLEMENT_TYPES,
  type BillingOperation,
  type PlanEntitlementType,
  planEntitlementTypeForSubscriptionSku
} from "@book-maker/core";
import { createHash } from "node:crypto";
import { Prisma, prisma } from "./client.ts";
import { jsonInput, runSerializable } from "./billingInternals.ts";
import { grantCredits } from "./billingLedger.ts";
import { ensureCurrentPlanPeriodTx, grantSubscriptionPlanPeriod } from "./planPeriods.ts";

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
  } | null | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type GooglePlayPurchaseRecordResult = {
  purchaseRecordId: string;
  status: string;
  creditsGranted: number;
  ledgerEntryId: string | null;
  subscriptionStatus: string | null;
  entitlementType: string | null;
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
}

export async function recordVerifiedGooglePlayPurchase(options: {
  userId: string;
  verification: VerifiedGooglePlayPurchase;
}): Promise<GooglePlayPurchaseRecordResult> {
  const { userId, verification } = options;
  const tokenHash = hashPurchaseToken(verification.purchaseToken);
  const now = new Date();
  const product = await prisma.productCatalog.findUnique({
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

  const existing = await prisma.purchaseRecord.findFirst({
    where: { provider: "GOOGLE_PLAY", purchaseTokenHash: tokenHash },
    select: { id: true, userId: true, creditsGranted: true }
  });
  if (existing && existing.userId !== userId) {
    throw new Error("This Google Play purchase is already linked to another account.");
  }
  const purchaseStatus = purchaseRecordStatusForVerification(verification);
  const recordData = {
    productId: product.id,
    externalPurchaseId: verification.externalPurchaseId ?? null,
    status: purchaseStatus,
    amountMicros: product.priceMicros,
    currency: product.currency,
    purchasedAt: verification.purchasedAt ?? null,
    verifiedAt: now,
    metadata: jsonInput(verificationMetadata(verification, tokenHash))
  };
  const recordSelect = { id: true, status: true, creditsGranted: true } as const;
  let purchaseRecord;
  if (existing) {
    purchaseRecord = await prisma.purchaseRecord.update({
      where: { id: existing.id },
      data: recordData,
      select: recordSelect
    });
  } else {
    try {
      purchaseRecord = await prisma.purchaseRecord.create({
        data: { userId, provider: "GOOGLE_PLAY", purchaseTokenHash: tokenHash, ...recordData },
        select: recordSelect
      });
    } catch (error) {
      // The token's unique index turns a concurrent verification — the Play
      // listener racing a restore — into a conflict instead of a duplicate
      // row. The loser adopts the winner's record, and the cross-account
      // guard runs again on the re-read: the first check raced too, and this
      // is what stops one token being linked to two accounts.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
        throw error;
      }
      const winner = await prisma.purchaseRecord.findFirst({
        where: { provider: "GOOGLE_PLAY", purchaseTokenHash: tokenHash },
        select: { id: true, userId: true }
      });
      if (!winner) {
        throw error;
      }
      if (winner.userId !== userId) {
        throw new Error("This Google Play purchase is already linked to another account.");
      }
      purchaseRecord = await prisma.purchaseRecord.update({
        where: { id: winner.id },
        data: recordData,
        select: recordSelect
      });
    }
  }

  // Recorded whether or not this verification grants anything: an expired or
  // canceled subscription has to update its state row too, or the renewal sweep
  // keeps polling a subscription Google has already closed.
  if (verification.kind === "subscription" && verification.subscription) {
    await upsertSubscriptionState({
      userId,
      productId: product.id,
      tokenHash,
      purchaseToken: verification.purchaseToken,
      status: verification.subscription.status,
      creditsPerPeriod: product.creditAmount,
      currentPeriodStart: verification.subscription.currentPeriodStart ?? null,
      currentPeriodEnd: verification.subscription.currentPeriodEnd ?? null,
      autoRenewing: verification.subscription.autoRenewing ?? null,
      metadata: verificationMetadata(verification, tokenHash)
    });
  }

  if (!verification.grantable) {
    return {
      purchaseRecordId: purchaseRecord.id,
      status: purchaseRecord.status,
      creditsGranted: purchaseRecord.creditsGranted,
      ledgerEntryId: null,
      subscriptionStatus: verification.subscription?.status ?? null,
      entitlementType: null
    };
  }

  const quantity = verification.kind === "one_time" ? Math.max(1, Math.floor(verification.quantity ?? 1)) : 1;
  const amountCredits = product.creditAmount * quantity;
  const grantIdempotencyKey = googlePlayGrantIdempotencyKey(verification, tokenHash);
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
      await upsertSubscriptionEntitlement({
        userId,
        type: entitlementType,
        source: "google_play_subscription",
        purchaseRecordId: purchaseRecord.id,
        expiresAt: verification.subscription.currentPeriodEnd ?? null,
        metadata: grantMetadata
      });
    }
  }

  // A subscription's credits are the period's allowance — they reset at the next
  // renewal rather than stacking up. Anything bought outright is added to the
  // pool that never expires.
  const ledgerEntry =
    amountCredits <= 0
      ? null
      : verification.kind === "subscription"
        ? await grantSubscriptionPlanPeriod({
            userId,
            productId: product.id,
            purchaseRecordId: purchaseRecord.id,
            tokenHash,
            allowance: amountCredits,
            periodStart: verification.subscription?.currentPeriodStart ?? null,
            periodEnd: verification.subscription?.currentPeriodEnd ?? null,
            idempotencyKey: grantIdempotencyKey,
            description: `${product.title} monthly credits`,
            metadata: grantMetadata,
            now
          })
        : await grantCredits({
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
  // delivered credits everywhere the record is read back.
  const updatedPurchase = await prisma.purchaseRecord.update({
    where: { id: purchaseRecord.id },
    data: {
      status: "GRANTED",
      creditsGranted: ledgerEntry ? amountCredits : purchaseRecord.creditsGranted
    },
    select: { id: true, status: true, creditsGranted: true }
  });

  return {
    purchaseRecordId: updatedPurchase.id,
    status: updatedPurchase.status,
    creditsGranted: updatedPurchase.creditsGranted,
    ledgerEntryId: ledgerEntry?.id ?? null,
    subscriptionStatus,
    entitlementType
  };
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

export function hashPurchaseToken(purchaseToken: string): string {
  return createHash("sha256").update(purchaseToken, "utf8").digest("hex");
}

function purchaseRecordStatusForVerification(verification: VerifiedGooglePlayPurchase): "PENDING" | "VERIFIED" | "FAILED" {
  if (verification.grantable) {
    return "VERIFIED";
  }
  return verification.providerStatus === "PENDING" || verification.providerStatus === "SUBSCRIPTION_STATE_PENDING"
    ? "PENDING"
    : "FAILED";
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

async function upsertSubscriptionState(options: {
  userId: string;
  productId: string;
  tokenHash: string;
  purchaseToken: string;
  status: GooglePlaySubscriptionGrantState;
  creditsPerPeriod: number;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  autoRenewing: boolean | null;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const existing = await prisma.subscriptionState.findFirst({
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
    nextCreditGrantAt:
      options.status === "EXPIRED" ? null : (options.currentPeriodEnd ?? new Date()),
    // When it was first seen to be ending, not when we last looked: the sweep
    // re-verifies a cancelled subscription every hour until it expires.
    canceledAt: cancelling ? (existing?.canceledAt ?? new Date()) : null,
    metadata: jsonInput(options.metadata)
  };
  // Native upsert on the (provider, externalSubscriptionId) unique: two
  // concurrent verifications used to findFirst-nothing and create twice, after
  // which every later update maintained one row while the renewal sweep polled
  // the other — re-verifying a closed subscription forever.
  await prisma.subscriptionState.upsert({
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

async function upsertSubscriptionEntitlement(options: {
  userId: string;
  type: PlanEntitlementType;
  source: string;
  purchaseRecordId: string;
  expiresAt: Date | null;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const existing = await prisma.userEntitlement.findFirst({
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
    await prisma.userEntitlement.update({
      where: { id: existing.id },
      data
    });
    return;
  }
  await prisma.userEntitlement.create({
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
          currentPeriodEnd: verification.subscription.currentPeriodEnd?.toISOString() ?? null
        }
      : null,
    ...verification.metadata
  };
}

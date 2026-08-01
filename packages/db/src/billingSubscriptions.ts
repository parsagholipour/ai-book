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
  type BillingOperation,
  type PlanEntitlementType,
  planEntitlementTypeForSubscriptionSku
} from "@book-maker/core";
import { createHash } from "node:crypto";
import { prisma } from "./client.ts";
import { jsonInput } from "./billingInternals.ts";
import { grantCredits } from "./billingLedger.ts";
import { grantSubscriptionPlanPeriod } from "./planPeriods.ts";

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
  const purchaseRecord = existing
    ? await prisma.purchaseRecord.update({
        where: { id: existing.id },
        data: {
          productId: product.id,
          externalPurchaseId: verification.externalPurchaseId ?? null,
          status: purchaseStatus,
          amountMicros: product.priceMicros,
          currency: product.currency,
          purchasedAt: verification.purchasedAt ?? null,
          verifiedAt: now,
          metadata: jsonInput(verificationMetadata(verification, tokenHash))
        },
        select: { id: true, status: true, creditsGranted: true }
      })
    : await prisma.purchaseRecord.create({
        data: {
          userId,
          productId: product.id,
          provider: "GOOGLE_PLAY",
          externalPurchaseId: verification.externalPurchaseId ?? null,
          purchaseTokenHash: tokenHash,
          status: purchaseStatus,
          amountMicros: product.priceMicros,
          currency: product.currency,
          purchasedAt: verification.purchasedAt ?? null,
          verifiedAt: now,
          metadata: jsonInput(verificationMetadata(verification, tokenHash))
        },
        select: { id: true, status: true, creditsGranted: true }
      });

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

  const updatedPurchase = await prisma.purchaseRecord.update({
    where: { id: purchaseRecord.id },
    data: {
      status: "GRANTED",
      creditsGranted: amountCredits
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
  metadata: Record<string, unknown>;
}): Promise<void> {
  const existing = await prisma.subscriptionState.findFirst({
    where: {
      provider: "GOOGLE_PLAY",
      externalSubscriptionId: options.tokenHash
    },
    select: { id: true }
  });
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
    // Null once Google says it is over: the sweep polls on this column, and a
    // dead subscription with a past date would be re-checked forever.
    nextCreditGrantAt: options.status === "EXPIRED" ? null : options.currentPeriodEnd,
    metadata: jsonInput(options.metadata)
  };
  if (existing) {
    await prisma.subscriptionState.update({
      where: { id: existing.id },
      data
    });
    return;
  }
  await prisma.subscriptionState.create({ data });
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

import {
  DEFAULT_BILLING_PRODUCTS,
  creditCostForOperation,
  type BillingOperation
} from "@book-maker/core";
import { createHash } from "node:crypto";
import { Prisma, prisma } from "./client.ts";
import { activeCreditPricingVersion } from "./creditPricing.ts";

export type CreditBalance = {
  availableCredits: number;
  reservedCredits: number;
  lifetimeCreditsGranted: number;
  lifetimeCreditsSpent: number;
};

export type CreditLedgerEntryRecord = {
  id: string;
  userId: string;
  projectId: string | null;
  operation: string;
  amountCredits: number;
  entryType: string;
  status: string;
  idempotencyKey: string;
};

export type UserEntitlementRecord = {
  id: string;
  userId: string;
  projectId: string | null;
  type: string;
  status: string;
  source: string;
  creditsCost: number;
  startsAt: Date;
  expiresAt: Date | null;
};

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

export class InsufficientCreditsError extends Error {
  readonly code = "INSUFFICIENT_CREDITS";
  readonly requiredCredits: number;
  readonly availableCredits: number;
  readonly reservedCredits: number;

  constructor(options: { requiredCredits: number; availableCredits: number; reservedCredits: number }) {
    super(`Insufficient credits: ${options.requiredCredits} required, ${options.availableCredits} available.`);
    this.name = "InsufficientCreditsError";
    this.requiredCredits = options.requiredCredits;
    this.availableCredits = options.availableCredits;
    this.reservedCredits = options.reservedCredits;
  }
}

type BillingTx = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

type LedgerContext = {
  userId: string;
  projectId?: string | null | undefined;
  generationJobId?: string | null | undefined;
  productId?: string | null | undefined;
  purchaseRecordId?: string | null | undefined;
  description?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
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
  const operation: BillingOperation =
    verification.kind === "subscription" ? "SUBSCRIPTION_CREDIT_GRANT" : "PURCHASE_CREDIT_GRANT";
  const grantIdempotencyKey = googlePlayGrantIdempotencyKey(verification, tokenHash);
  const ledgerEntry =
    amountCredits > 0
      ? await grantCredits({
          userId,
          productId: product.id,
          purchaseRecordId: purchaseRecord.id,
          amountCredits,
          operation,
          idempotencyKey: grantIdempotencyKey,
          description: `${product.title} Google Play credit grant`,
          metadata: {
            productSku: product.sku,
            provider: "GOOGLE_PLAY",
            purchaseTokenHash: tokenHash,
            providerStatus: verification.providerStatus,
            externalPurchaseId: verification.externalPurchaseId ?? null
          }
        })
      : null;

  const entitlementType = verification.kind === "subscription" ? entitlementTypeForSubscriptionSku(product.sku) : null;
  let subscriptionStatus: string | null = null;
  if (verification.kind === "subscription" && verification.subscription) {
    subscriptionStatus = verification.subscription.status;
    await upsertSubscriptionState({
      userId,
      productId: product.id,
      tokenHash,
      status: verification.subscription.status,
      creditsPerPeriod: product.creditAmount,
      currentPeriodStart: verification.subscription.currentPeriodStart ?? null,
      currentPeriodEnd: verification.subscription.currentPeriodEnd ?? null,
      metadata: verificationMetadata(verification, tokenHash)
    });
    if (entitlementType && subscriptionEntitlementIsActive(verification.subscription.status)) {
      await upsertSubscriptionEntitlement({
        userId,
        type: entitlementType,
        source: "google_play_subscription",
        purchaseRecordId: purchaseRecord.id,
        expiresAt: verification.subscription.currentPeriodEnd ?? null,
        metadata: {
          productSku: product.sku,
          provider: "GOOGLE_PLAY",
          purchaseTokenHash: tokenHash,
          providerStatus: verification.providerStatus,
          externalPurchaseId: verification.externalPurchaseId ?? null
        }
      });
    }
  }

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

export async function getCreditBalance(userId: string): Promise<CreditBalance> {
  const account = await prisma.userCreditAccount.upsert({
    where: { userId },
    create: { userId },
    update: {}
  });
  return serializeCreditBalance(account);
}

export async function listActiveUserEntitlements(userId: string, now = new Date()): Promise<UserEntitlementRecord[]> {
  return prisma.userEntitlement.findMany({
    where: activeEntitlementWhere(userId, now),
    orderBy: { createdAt: "desc" },
    select: entitlementSelect
  });
}

export async function grantCredits(options: LedgerContext & {
  amountCredits: number;
  operation?: BillingOperation | undefined;
  idempotencyKey: string;
}): Promise<CreditLedgerEntryRecord> {
  if (!Number.isInteger(options.amountCredits) || options.amountCredits <= 0) {
    throw new Error("Credit grants must be positive whole-credit amounts.");
  }

  return runSerializable(async (tx) => {
    const existing = await tx.creditLedgerEntry.findUnique({
      where: { idempotencyKey: options.idempotencyKey },
      select: ledgerSelect
    });
    if (existing) {
      return existing;
    }

    const account = await ensureCreditAccount(tx, options.userId);
    const nextAvailable = account.availableCredits + options.amountCredits;
    await tx.userCreditAccount.update({
      where: { userId: options.userId },
      data: {
        availableCredits: { increment: options.amountCredits },
        lifetimeCreditsGranted: { increment: options.amountCredits }
      }
    });

    return tx.creditLedgerEntry.create({
      data: ledgerData({
        ...options,
        operation: options.operation ?? "ADMIN_GRANT",
        entryType: "GRANT",
        status: "SETTLED",
        amountCredits: options.amountCredits,
        balanceAfterCredits: nextAvailable
      }),
      select: ledgerSelect
    });
  });
}

export async function reserveCredits(options: LedgerContext & {
  amountCredits: number;
  operation: BillingOperation;
  idempotencyKey: string;
}): Promise<CreditLedgerEntryRecord | null> {
  if (options.amountCredits === 0) {
    return null;
  }
  if (!Number.isInteger(options.amountCredits) || options.amountCredits < 0) {
    throw new Error("Credit reservations must be non-negative whole-credit amounts.");
  }

  return runSerializable(async (tx) => {
    const existing = await tx.creditLedgerEntry.findUnique({
      where: { idempotencyKey: options.idempotencyKey },
      select: ledgerSelect
    });
    if (existing) {
      return existing;
    }

    const account = await ensureCreditAccount(tx, options.userId);
    if (account.availableCredits < options.amountCredits) {
      throw new InsufficientCreditsError({
        requiredCredits: options.amountCredits,
        availableCredits: account.availableCredits,
        reservedCredits: account.reservedCredits
      });
    }

    const updated = await tx.userCreditAccount.updateMany({
      where: {
        userId: options.userId,
        availableCredits: { gte: options.amountCredits }
      },
      data: {
        availableCredits: { decrement: options.amountCredits },
        reservedCredits: { increment: options.amountCredits }
      }
    });
    if (updated.count !== 1) {
      const latest = await ensureCreditAccount(tx, options.userId);
      throw new InsufficientCreditsError({
        requiredCredits: options.amountCredits,
        availableCredits: latest.availableCredits,
        reservedCredits: latest.reservedCredits
      });
    }

    return tx.creditLedgerEntry.create({
      data: ledgerData({
        ...options,
        entryType: "RESERVE",
        status: "RESERVED",
        amountCredits: -options.amountCredits,
        balanceAfterCredits: account.availableCredits - options.amountCredits
      }),
      select: ledgerSelect
    });
  });
}

export async function commitReservedCredits(entryId: string): Promise<CreditLedgerEntryRecord> {
  return runSerializable(async (tx) => {
    const entry = await tx.creditLedgerEntry.findUnique({
      where: { id: entryId },
      select: ledgerSelect
    });
    if (!entry) {
      throw new Error("Credit reservation not found.");
    }
    if (entry.status === "SETTLED" && entry.entryType === "SPEND") {
      return entry;
    }
    if (entry.status !== "RESERVED" || entry.amountCredits >= 0) {
      throw new Error(`Credit reservation ${entryId} cannot be committed from status ${entry.status}.`);
    }

    const amountCredits = Math.abs(entry.amountCredits);
    const updated = await tx.userCreditAccount.updateMany({
      where: {
        userId: entry.userId,
        reservedCredits: { gte: amountCredits }
      },
      data: {
        reservedCredits: { decrement: amountCredits },
        lifetimeCreditsSpent: { increment: amountCredits }
      }
    });
    if (updated.count !== 1) {
      throw new Error(`Credit reservation ${entryId} is not reflected in the account balance.`);
    }
    const account = await ensureCreditAccount(tx, entry.userId);

    return tx.creditLedgerEntry.update({
      where: { id: entry.id },
      data: {
        entryType: "SPEND",
        status: "SETTLED",
        balanceAfterCredits: account.availableCredits
      },
      select: ledgerSelect
    });
  });
}

export async function spendCredits(options: LedgerContext & {
  amountCredits: number;
  operation: BillingOperation;
  idempotencyKey: string;
}): Promise<CreditLedgerEntryRecord | null> {
  const reservation = await reserveCredits(options);
  if (!reservation) {
    return null;
  }
  return commitReservedCredits(reservation.id);
}

export async function refundCreditLedgerEntry(entryId: string, reason: string): Promise<CreditLedgerEntryRecord | null> {
  return runSerializable(async (tx) => {
    const entry = await tx.creditLedgerEntry.findUnique({
      where: { id: entryId },
      select: ledgerSelect
    });
    if (!entry || entry.amountCredits >= 0) {
      return null;
    }

    const amountCredits = Math.abs(entry.amountCredits);
    if (entry.status === "RESERVED") {
      const updated = await tx.userCreditAccount.updateMany({
        where: {
          userId: entry.userId,
          reservedCredits: { gte: amountCredits }
        },
        data: {
          availableCredits: { increment: amountCredits },
          reservedCredits: { decrement: amountCredits }
        }
      });
      if (updated.count !== 1) {
        return null;
      }
      await revokeEntitlementsForLedgerEntryTx(tx, entry.id);
      return tx.creditLedgerEntry.update({
        where: { id: entry.id },
        data: {
          entryType: "RELEASE",
          status: "REFUNDED",
          description: reason
        },
        select: ledgerSelect
      });
    }

    if (entry.status !== "SETTLED") {
      return null;
    }

    const existingRefund = await tx.creditLedgerEntry.findUnique({
      where: { reversesEntryId: entry.id },
      select: ledgerSelect
    });
    if (existingRefund) {
      return existingRefund;
    }

    const account = await ensureCreditAccount(tx, entry.userId);
    await tx.userCreditAccount.update({
      where: { userId: entry.userId },
      data: {
        availableCredits: { increment: amountCredits },
        lifetimeCreditsSpent: { decrement: amountCredits }
      }
    });
    await revokeEntitlementsForLedgerEntryTx(tx, entry.id);

    return tx.creditLedgerEntry.create({
      data: {
        userId: entry.userId,
        ...(entry.projectId ? { projectId: entry.projectId } : {}),
        entryType: "REFUND",
        status: "SETTLED",
        operation: entry.operation as BillingOperation,
        amountCredits,
        balanceAfterCredits: account.availableCredits + amountCredits,
        idempotencyKey: `refund:${entry.id}`,
        reversesEntryId: entry.id,
        description: reason,
        metadata: jsonInput({ reason })
      },
      select: ledgerSelect
    });
  });
}

export async function refundLatestProjectOperationCredits(options: {
  projectId: string;
  operation: BillingOperation;
  reason: string;
}): Promise<CreditLedgerEntryRecord | null> {
  const entry = await prisma.creditLedgerEntry.findFirst({
    where: {
      projectId: options.projectId,
      operation: options.operation,
      amountCredits: { lt: 0 },
      status: { in: ["RESERVED", "SETTLED"] },
      reversedByEntry: null
    },
    orderBy: { createdAt: "desc" },
    select: { id: true }
  });
  if (!entry) {
    return null;
  }
  return refundCreditLedgerEntry(entry.id, options.reason);
}

export async function grantProjectEntitlement(options: {
  userId: string;
  projectId: string;
  type: "EXPORT_UNLOCK" | "PREMIUM_PRESET" | "PREMIUM_REVIEW" | "EXTRA_IMAGES";
  source: string;
  creditsCost: number;
  relatedLedgerEntryId?: string | null | undefined;
  purchaseRecordId?: string | null | undefined;
  expiresAt?: Date | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}): Promise<UserEntitlementRecord> {
  const existing = await prisma.userEntitlement.findFirst({
    where: {
      userId: options.userId,
      projectId: options.projectId,
      type: options.type,
      status: "ACTIVE",
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
    },
    select: entitlementSelect
  });
  if (existing) {
    return existing;
  }

  return prisma.userEntitlement.create({
    data: {
      userId: options.userId,
      projectId: options.projectId,
      type: options.type,
      source: options.source,
      creditsCost: options.creditsCost,
      ...(options.relatedLedgerEntryId ? { relatedLedgerEntryId: options.relatedLedgerEntryId } : {}),
      ...(options.purchaseRecordId ? { purchaseRecordId: options.purchaseRecordId } : {}),
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      metadata: jsonInput(options.metadata ?? {})
    },
    select: entitlementSelect
  });
}

export async function hasActiveProjectEntitlement(options: {
  userId: string;
  projectId: string;
  type: "EXPORT_UNLOCK" | "PREMIUM_PRESET" | "PREMIUM_REVIEW" | "EXTRA_IMAGES";
  now?: Date | undefined;
}): Promise<boolean> {
  const entitlement = await prisma.userEntitlement.findFirst({
    where: {
      ...activeEntitlementWhere(options.userId, options.now ?? new Date()),
      projectId: options.projectId,
      type: options.type
    },
    select: { id: true }
  });
  return Boolean(entitlement);
}

export async function hasActiveSubscriptionEntitlement(userId: string, now = new Date()): Promise<boolean> {
  const entitlement = await prisma.userEntitlement.findFirst({
    where: {
      ...activeEntitlementWhere(userId, now),
      type: { in: ["CREATOR_PLAN", "PRO_PLAN"] }
    },
    select: { id: true }
  });
  return Boolean(entitlement);
}

export async function ensureProjectExportEntitlementOrSpend(options: {
  userId: string;
  projectId: string;
  idempotencyKey: string;
}): Promise<{ entitlement: UserEntitlementRecord; chargedLedgerEntry: CreditLedgerEntryRecord | null }> {
  const existing = await prisma.userEntitlement.findFirst({
    where: {
      ...activeEntitlementWhere(options.userId, new Date()),
      projectId: options.projectId,
      type: "EXPORT_UNLOCK"
    },
    select: entitlementSelect
  });
  if (existing) {
    return { entitlement: existing, chargedLedgerEntry: null };
  }

  const amountCredits = creditCostForOperation("EXPORT_UNLOCK");
  const entry = await spendCredits({
    userId: options.userId,
    projectId: options.projectId,
    operation: "EXPORT_UNLOCK",
    amountCredits,
    idempotencyKey: options.idempotencyKey,
    description: "PDF/EPUB export unlock"
  });
  const entitlement = await grantProjectEntitlement({
    userId: options.userId,
    projectId: options.projectId,
    type: "EXPORT_UNLOCK",
    source: "credits",
    creditsCost: amountCredits,
    relatedLedgerEntryId: entry?.id ?? null,
    metadata: { operation: "EXPORT_UNLOCK" }
  });
  return { entitlement, chargedLedgerEntry: entry };
}

export async function revokeEntitlementsForLedgerEntry(ledgerEntryId: string): Promise<number> {
  const updated = await prisma.userEntitlement.updateMany({
    where: {
      relatedLedgerEntryId: ledgerEntryId,
      status: "ACTIVE"
    },
    data: {
      status: "REVOKED",
      consumedAt: new Date()
    }
  });
  return updated.count;
}

function activeEntitlementWhere(userId: string, now: Date): Prisma.UserEntitlementWhereInput {
  return {
    userId,
    status: "ACTIVE",
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
  };
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

function entitlementTypeForSubscriptionSku(sku: string): "CREATOR_PLAN" | "PRO_PLAN" | null {
  if (sku === "tomeza.creator_monthly") {
    return "CREATOR_PLAN";
  }
  if (sku === "tomeza.pro_monthly") {
    return "PRO_PLAN";
  }
  return null;
}

function subscriptionEntitlementIsActive(status: GooglePlaySubscriptionGrantState): boolean {
  return status === "ACTIVE" || status === "GRACE_PERIOD" || status === "CANCELED";
}

async function upsertSubscriptionState(options: {
  userId: string;
  productId: string;
  tokenHash: string;
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
    status: options.status,
    creditsPerPeriod: options.creditsPerPeriod,
    currentPeriodStart: options.currentPeriodStart,
    currentPeriodEnd: options.currentPeriodEnd,
    nextCreditGrantAt: options.currentPeriodEnd,
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
  type: "CREATOR_PLAN" | "PRO_PLAN";
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

export function hashPurchaseToken(purchaseToken: string): string {
  return createHash("sha256").update(purchaseToken, "utf8").digest("hex");
}

async function ensureCreditAccount(tx: BillingTx, userId: string): Promise<CreditBalance> {
  const account = await tx.userCreditAccount.upsert({
    where: { userId },
    create: { userId },
    update: {}
  });
  return serializeCreditBalance(account);
}

async function revokeEntitlementsForLedgerEntryTx(tx: BillingTx, ledgerEntryId: string): Promise<void> {
  await tx.userEntitlement.updateMany({
    where: {
      relatedLedgerEntryId: ledgerEntryId,
      status: "ACTIVE"
    },
    data: {
      status: "REVOKED",
      consumedAt: new Date()
    }
  });
}

function serializeCreditBalance(account: {
  availableCredits: number;
  reservedCredits: number;
  lifetimeCreditsGranted: number;
  lifetimeCreditsSpent: number;
}): CreditBalance {
  return {
    availableCredits: account.availableCredits,
    reservedCredits: account.reservedCredits,
    lifetimeCreditsGranted: account.lifetimeCreditsGranted,
    lifetimeCreditsSpent: account.lifetimeCreditsSpent
  };
}

function ledgerData(options: LedgerContext & {
  entryType: "GRANT" | "RESERVE" | "SPEND" | "REFUND" | "RELEASE" | "ADJUSTMENT";
  status: "RESERVED" | "SETTLED" | "REFUNDED" | "VOIDED";
  operation: BillingOperation;
  amountCredits: number;
  balanceAfterCredits: number;
  idempotencyKey: string;
}) {
  return {
    userId: options.userId,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.generationJobId ? { generationJobId: options.generationJobId } : {}),
    ...(options.productId ? { productId: options.productId } : {}),
    ...(options.purchaseRecordId ? { purchaseRecordId: options.purchaseRecordId } : {}),
    entryType: options.entryType,
    status: options.status,
    operation: options.operation,
    amountCredits: options.amountCredits,
    balanceAfterCredits: options.balanceAfterCredits,
    idempotencyKey: options.idempotencyKey,
    ...(options.description ? { description: options.description } : {}),
    // Which price list produced this amount. Stamped here rather than at each
    // charge site so no future one can forget it. Callers may override.
    metadata: jsonInput({ pricingVersion: activeCreditPricingVersion(), ...options.metadata })
  };
}

async function runSerializable<T>(callback: (tx: BillingTx) => Promise<T>): Promise<T> {
  return prisma.$transaction(callback, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable
  });
}

function jsonInput(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

const ledgerSelect = {
  id: true,
  userId: true,
  projectId: true,
  operation: true,
  amountCredits: true,
  entryType: true,
  status: true,
  idempotencyKey: true
} as const;

const entitlementSelect = {
  id: true,
  userId: true,
  projectId: true,
  type: true,
  status: true,
  source: true,
  creditsCost: true,
  startsAt: true,
  expiresAt: true
} as const;

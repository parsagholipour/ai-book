/**
 * Entitlements: the durable "this user may do X" rows credits buy. Project
 * entitlements are granted next to the ledger entry that paid for them, so a
 * refund can revoke them again. No new `EXPORT_UNLOCK` is written since
 * 2026-10-15 — every finished book downloads free — but the type stays, because
 * rows granted before then still exist and a refund still revokes them.
 */
import { PLAN_ENTITLEMENT_TYPES } from "@book-maker/core";
import { prisma } from "./client.ts";
import {
  type BillingTx,
  type UserEntitlementRecord,
  activeEntitlementWhere,
  entitlementSelect,
  jsonInput
} from "./billingInternals.ts";

export type ProjectEntitlementType = "EXPORT_UNLOCK" | "PREMIUM_PRESET" | "PREMIUM_REVIEW" | "EXTRA_IMAGES";

export async function listActiveUserEntitlements(userId: string, now = new Date()): Promise<UserEntitlementRecord[]> {
  return prisma.userEntitlement.findMany({
    where: activeEntitlementWhere(userId, now),
    orderBy: { createdAt: "desc" },
    select: entitlementSelect
  });
}

export async function grantProjectEntitlement(options: {
  userId: string;
  projectId: string;
  type: ProjectEntitlementType;
  source: string;
  creditsCost: number;
  relatedLedgerEntryId?: string | null | undefined;
  purchaseRecordId?: string | null | undefined;
  expiresAt?: Date | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}): Promise<UserEntitlementRecord> {
  return grantProjectEntitlementTx(prisma, options);
}

export async function grantProjectEntitlementTx(
  tx: BillingTx,
  options: {
    userId: string;
    projectId: string;
    type: ProjectEntitlementType;
    source: string;
    creditsCost: number;
    relatedLedgerEntryId?: string | null | undefined;
    purchaseRecordId?: string | null | undefined;
    expiresAt?: Date | null | undefined;
    metadata?: Record<string, unknown> | undefined;
  }
): Promise<UserEntitlementRecord> {
  const existing = await tx.userEntitlement.findFirst({
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

  return tx.userEntitlement.create({
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
  type: ProjectEntitlementType;
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

/** True on any paid plan. New tiers are covered by `PLAN_ENTITLEMENT_TYPES`. */
export async function hasActiveSubscriptionEntitlement(userId: string, now = new Date()): Promise<boolean> {
  const entitlement = await prisma.userEntitlement.findFirst({
    where: {
      ...activeEntitlementWhere(userId, now),
      type: { in: PLAN_ENTITLEMENT_TYPES }
    },
    select: { id: true }
  });
  return Boolean(entitlement);
}

import { PLAN_ENTITLEMENT_TYPES, jsonRecord } from "@book-maker/core";
import type { GooglePlayRefund } from "./generated/prisma/client.ts";
import { type BillingTx, effectivePlanCredits, hashPurchaseToken, jsonInput, runSerializable } from "./billingInternals.ts";
import { ensureCreditAccountRow } from "./planPeriods.ts";
import { refundPurchasePaymentsTx } from "./purchasePayments.ts";

export type GooglePlayRefundNotice = {
  purchaseToken: string;
  orderId: string;
  productType: 1 | 2;
  /** Omitted for a full refund; partial quantities must come from Google's API. */
  partialRefund?: { quantity: number; refundableQuantity: number } | undefined;
};

/** A concurrent first claim can hit a unique index. Retry the whole transaction,
 * never another query inside a PostgreSQL transaction that has already aborted. */
export async function runGooglePlayTransaction<T>(callback: (tx: BillingTx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runSerializable(callback);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code !== "P2002" || attempt >= 4) throw error;
    }
  }
}

export async function recordGooglePlayRefund(notice: GooglePlayRefundNotice): Promise<void> {
  await runGooglePlayTransaction((tx) => recordGooglePlayRefundTx(tx, notice));
}

export async function recordGooglePlayRefundTx(tx: BillingTx, notice: GooglePlayRefundNotice): Promise<void> {
  const partial = notice.partialRefund;
  if (partial && (notice.productType !== 2 || !Number.isSafeInteger(partial.quantity) || partial.quantity < 1 ||
    !Number.isSafeInteger(partial.refundableQuantity) || partial.refundableQuantity < 0 ||
    partial.refundableQuantity >= partial.quantity)) {
    throw new Error("Invalid Google Play refund quantity.");
  }
  const purchaseTokenHash = hashPurchaseToken(notice.purchaseToken);
  const key = { purchaseTokenHash, orderId: notice.orderId };
  const existing = await tx.googlePlayRefund.findUnique({ where: { purchaseTokenHash_orderId: key } });
  if (existing && (existing.productType !== notice.productType ||
    (partial && existing.quantity !== null && existing.quantity !== partial.quantity))) {
    throw new Error("Google Play refund does not match the recorded purchase.");
  }
  const refundableQuantity = Math.min(existing?.refundableQuantity ?? Infinity, partial?.refundableQuantity ?? 0);
  const data = { productType: notice.productType, refundableQuantity, quantity: partial?.quantity ?? existing?.quantity ?? null };
  const refund = await tx.googlePlayRefund.upsert({
    where: { purchaseTokenHash_orderId: key }, create: { ...key, ...data }, update: data
  });
  await applyGooglePlayRefundTx(tx, refund);
}

/** Reverse actual grants, never today's catalog price or a purchase's last-period summary.
 * Debits may make purchased credits negative: spent/refunded credits remain debt, which
 * purchases offset as they land and the next plan period boundary pays (`planDebt.ts`).
 * The durable marker, purchase state, ledger and balance commit together.
 *
 * One order can hold many grants: a plan is granted a month at a time, so a refunded
 * yearly order reverses every month it granted, each against its own month — the month
 * the account is still on gives back what is left of it, and an earlier month counts
 * what expired unspent at its end as never delivered. */
export async function applyGooglePlayRefundTx(tx: BillingTx, refund: GooglePlayRefund): Promise<void> {
  const purchase = await tx.purchaseRecord.findFirst({
    where: { provider: "GOOGLE_PLAY", purchaseTokenHash: refund.purchaseTokenHash }
  });
  if (!purchase) return; // Keep the marker: a later app verification must see it.
  await refundPurchasePaymentsTx(tx, purchase.id, refund);
  const grants = await tx.creditLedgerEntry.findMany({
    where: { purchaseRecordId: purchase.id, entryType: "GRANT", status: "SETTLED" }
  });
  for (const grant of grants) {
    if (refund.productType === 1 && jsonRecord(grant.metadata).externalPurchaseId !== refund.orderId) continue;
    const target = refund.refundableQuantity === 0 ? grant.amountCredits
      : Math.floor(grant.amountCredits * (refund.quantity! - refund.refundableQuantity) / refund.quantity!);
    const reversal = await tx.creditLedgerEntry.findUnique({ where: { reversesEntryId: grant.id } });
    const alreadyReversed = Math.abs(reversal?.amountCredits ?? 0);
    let amount = target - alreadyReversed;
    if (amount <= 0) continue;
    const account = await ensureCreditAccountRow(tx, purchase.userId);
    let fromPlan = 0;
    if (refund.productType === 1) {
      const grantPeriodKey = jsonRecord(grant.metadata).planPeriodKey;
      // The grant whose period the account is on holds what is left of the
      // allowance. Asked of the order alone, every month of a yearly order
      // "owned" it, and each one's reversal drained the live month again.
      const ownsCurrentPeriod = typeof grantPeriodKey === "string"
        ? grantPeriodKey === account.planPeriodKey
        : purchase.externalPurchaseId === refund.orderId &&
          account.planPeriodKey?.startsWith(`sub:${refund.purchaseTokenHash}:`);
      if (ownsCurrentPeriod) {
        fromPlan = Math.min(account.planCredits, amount);
      } else if (typeof grantPeriodKey === "string") {
        // Unused allowance already expired. Only the value actually retained or
        // spent becomes debt; a refund of July must not erase August's allowance.
        const expirations = await tx.creditLedgerEntry.findMany({
          where: { userId: purchase.userId, entryType: "ADJUSTMENT",
            metadata: { path: ["expiredPlanPeriodKey"], equals: grantPeriodKey } }
        });
        amount = Math.max(0, amount - expirations.reduce((sum, entry) => sum + Math.max(0, -entry.planCreditsDelta), 0));
      }
    }
    if (amount <= 0) continue;
    const balance = account.availableCredits - (amount - fromPlan) + Math.max(0, effectivePlanCredits(account) - fromPlan);
    const previousMetadata = jsonRecord(reversal?.metadata);
    const settlements = Array.isArray(previousMetadata.clawbackSettlements) ? previousMetadata.clawbackSettlements : [];
    const metadata = jsonInput({ ...previousMetadata,
      provider: "GOOGLE_PLAY", orderId: refund.orderId, purchaseTokenHash: refund.purchaseTokenHash,
      clawbackSettlements: [...settlements, { credits: -amount, planCredits: -fromPlan,
        balanceAfterCredits: balance, at: new Date().toISOString() }]
    });
    await tx.userCreditAccount.update({
      where: { userId: purchase.userId },
      data: { availableCredits: { decrement: amount - fromPlan }, planCredits: { decrement: fromPlan },
        lifetimeCreditsGranted: { decrement: amount } }
    });
    if (reversal) {
      await tx.creditLedgerEntry.update({ where: { id: reversal.id }, data: {
        amountCredits: { decrement: amount }, planCreditsDelta: { decrement: fromPlan }, metadata
      } });
    } else {
      await tx.creditLedgerEntry.create({ data: {
        userId: purchase.userId, purchaseRecordId: purchase.id, productId: purchase.productId,
        entryType: "ADJUSTMENT", status: "SETTLED", operation: grant.operation,
        amountCredits: -amount, planCreditsDelta: -fromPlan, balanceAfterCredits: balance,
        idempotencyKey: `google-play:refund:${grant.id}`, reversesEntryId: grant.id,
        description: "Credits reversed after a Google Play refund",
        metadata
      } });
    }
  }

  const full = refund.refundableQuantity === 0;
  const currentOrder = refund.productType === 2 || purchase.externalPurchaseId === refund.orderId;
  if (full && currentOrder) {
    await tx.purchaseRecord.update({ where: { id: purchase.id }, data: { status: "REVOKED" } });
    await tx.userEntitlement.updateMany({ where: { purchaseRecordId: purchase.id, status: "ACTIVE" },
      data: { status: "REVOKED", expiresAt: new Date() } });
    if (refund.productType === 1) {
      // A deferred downgrade moved this order's plan onto the token that
      // replaced it, to run out there; the refund takes it down there too. It
      // still names the order that paid for it.
      const plans = await tx.userEntitlement.findMany({
        where: { userId: purchase.userId, status: "ACTIVE", type: { in: PLAN_ENTITLEMENT_TYPES } },
        select: { id: true, metadata: true }
      });
      for (const plan of plans) {
        const paidBy = jsonRecord(plan.metadata);
        if (paidBy.purchaseTokenHash === refund.purchaseTokenHash && paidBy.externalPurchaseId === refund.orderId) {
          await tx.userEntitlement.update({ where: { id: plan.id }, data: { status: "REVOKED", expiresAt: new Date() } });
        }
      }
      const subscription = await tx.subscriptionState.findFirst({
        where: { provider: "GOOGLE_PLAY", externalSubscriptionId: refund.purchaseTokenHash }
      });
      if (subscription) await tx.subscriptionState.update({ where: { id: subscription.id },
        data: { status: "EXPIRED", nextCreditGrantAt: null, autoRenewing: false, currentPeriodEnd: new Date() } });
      const account = await tx.userCreditAccount.findUnique({ where: { userId: purchase.userId } });
      if (account?.planPeriodKey?.startsWith(`sub:${refund.purchaseTokenHash}:`)) {
        await tx.userCreditAccount.update({ where: { userId: purchase.userId }, data: { planPeriodEnd: new Date() } });
      }
    }
  }
}

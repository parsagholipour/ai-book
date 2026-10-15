import type { GooglePlayRefund } from "./generated/prisma/client.ts";
import type { BillingTx } from "./billingInternals.ts";
import type { VerifiedGooglePlayPurchase } from "./billingSubscriptions.ts";

/**
 * What an order charged in the buyer's own currency, before tax and Google's
 * cut. Analytics only (`PurchasePayment.localPriceMicros`): nothing decides a
 * grant or a refund from it. `source` is `client` (the app's report from Play's
 * product details) or `play_recurring_price` (Google's subscription record).
 */
export type PaymentLocalPrice = { micros: bigint; currency: string; source: "client" | "play_recurring_price" };

/** One immutable cash entry per paid order, separate from credit allowances and access. */
export async function recordPurchasePaymentTx(tx: BillingTx, options: {
  userId: string;
  purchaseRecordId: string;
  tokenHash: string;
  idempotencyKey: string;
  priceMicros: bigint | null;
  /** How `priceMicros` is known; defaults to the column's own `catalog_snapshot`. */
  amountSource?: string;
  currency: string;
  verification: VerifiedGooglePlayPurchase;
  now: Date;
  localPrice?: PaymentLocalPrice | null | undefined;
}): Promise<void> {
  const { verification } = options;
  // An unpriced catalog product may still grant access; it provides no cash amount to record.
  if (!verification.grantable || options.priceMicros === null) return;
  // Without an order, an extension of a subscription's expiry cannot prove a
  // new payment. Its access/credit logic still runs, but cash must not be invented.
  if (verification.kind === "subscription" && !verification.externalPurchaseId) return;
  const quantity = verification.kind === "one_time" ? Math.max(1, Math.floor(verification.quantity ?? 1)) : 1;
  const local = options.localPrice
    ? { localPriceMicros: options.localPrice.micros, localCurrency: options.localPrice.currency, localPriceSource: options.localPrice.source }
    : null;
  const payment = await tx.purchasePayment.upsert({
    where: { idempotencyKey: options.idempotencyKey },
    create: {
      userId: options.userId,
      purchaseRecordId: options.purchaseRecordId,
      idempotencyKey: options.idempotencyKey,
      orderId: verification.externalPurchaseId ?? null,
      amountMicros: options.priceMicros * BigInt(quantity),
      currency: options.currency,
      ...(options.amountSource ? { amountSource: options.amountSource } : {}),
      ...local,
      paidAt: verification.kind === "one_time" ? verification.purchasedAt ?? options.now : options.now
    },
    // Restore, cancel and catalog changes must never reprice or redate a payment.
    update: {}
  });
  // A payment the sweep or RTDN recorded first has no local price; the app's
  // later report fills it in. One already known is never replaced.
  if (local && payment.localPriceMicros == null) {
    await tx.purchasePayment.update({ where: { id: payment.id }, data: local });
  }
  // A stale verification can add historical cash without changing the current
  // subscription. Its earlier refund marker must still win over that late write.
  const refund = await tx.googlePlayRefund.findFirst({
    where: { purchaseTokenHash: options.tokenHash,
      ...(verification.kind === "subscription" ? { orderId: verification.externalPurchaseId! } : {}) },
    orderBy: { refundableQuantity: "asc" }
  });
  if (refund) await refundPurchasePaymentsTx(tx, options.purchaseRecordId, refund);
}

/** Keep gross cash, recording only the largest known cumulative refund beside it. */
export async function refundPurchasePaymentsTx(tx: BillingTx, purchaseRecordId: string, refund: GooglePlayRefund): Promise<void> {
  const payments = await tx.purchasePayment.findMany({
    where: { purchaseRecordId, ...(refund.productType === 1 ? { orderId: refund.orderId } : {}) }
  });
  for (const payment of payments) {
    const refundedAmountMicros = refund.refundableQuantity === 0 ? payment.amountMicros
      : payment.amountMicros * BigInt(refund.quantity! - refund.refundableQuantity) / BigInt(refund.quantity!);
    await tx.purchasePayment.updateMany({
      where: { id: payment.id, refundedAmountMicros: { lt: refundedAmountMicros } },
      data: { refundedAmountMicros }
    });
  }
}

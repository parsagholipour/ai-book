/**
 * Granting a subscription's allowance a month at a time: finding the month an
 * order owes now and granting it once.
 *
 * The layout itself is pure (`subscriptionAllowance.ts`). What lives here is
 * the ledger half: an order's schedule is read back off the grants its earlier
 * months wrote, so every month of one order counts from the same start however
 * Google reports the period later, and each month is one grant under
 * `allowanceMonthKey` — one per (order, month), which is what makes the app's
 * verify, the renewal sweep and RTDN racing over the same month harmless.
 *
 * Two callers grant a month without a live verification of the order's own
 * token, from what the order recorded: a deferred downgrade, whose new token
 * carries the old plan's paid months until they run out
 * (`billingSubscriptions.ts`), and a paid period kept after Google called its
 * token expired ({@link keepPaidPeriodTx}). Neither grants for an order a
 * refund has reversed.
 */
import { jsonRecord, planEntitlementTypeForSubscriptionSku } from "@book-maker/core";
import type { BillingTx, CreditLedgerEntryRecord } from "./billingInternals.ts";
import type { GooglePlayPurchaseRecordResult, VerifiedGooglePlayPurchase } from "./billingSubscriptions.ts";
import { grantSubscriptionPlanPeriodTx } from "./planPeriods.ts";
import {
  type AllowanceBasis,
  type AllowanceSchedule,
  allowanceMonthAt,
  allowanceMonthKey,
  allowanceMonthMetadata,
  allowanceScheduleFromMetadata,
  newAllowanceSchedule,
  wholePeriodCredits
} from "./subscriptionAllowance.ts";

/** The month an order owes now, and everything its grant needs. */
export type PlannedAllowanceMonth = {
  idempotencyKey: string;
  credits: number;
  basis: AllowanceBasis;
  periodStart: Date;
  /** Null only for a period Google reported no end for, which falls back to a month. */
  periodEnd: Date | null;
  /** When the order's next month starts; null when this is its last. */
  nextMonthAt: Date | null;
  /** Stamped on the grant: the schedule, the month, and why it is worth what it is. */
  metadata: Record<string, unknown>;
  /** What the order's months granted before this one. */
  orderGrantedCredits: number;
  /** This month was granted before; granting it again deposits nothing. */
  alreadyGranted: boolean;
};

/** A month an order owes on a record other than the verification's own, with the record it belongs to. */
export type RecordedOrderMonth = PlannedAllowanceMonth & {
  purchaseRecordId: string;
  productId: string | null;
  tokenHash: string;
  description: string;
  grantMetadata: Record<string, unknown>;
};

type OrderGrant = { idempotencyKey: string; amountCredits: number; metadata: unknown };

/**
 * The month a verified order owes now. The order's schedule is the one its
 * first granted month stored; an order not granted yet is laid out from this
 * verification. An order granted before schedules existed, or a period with no
 * end, is one grant for the whole period, as every grant used to be.
 */
export async function planVerifiedOrderMonthTx(tx: BillingTx, options: {
  product: { sku: string; creditAmount: number };
  verification: VerifiedGooglePlayPurchase;
  purchaseRecordId: string;
  orderKey: string;
  firstOrder: boolean;
  startsAtOldPlanEnd: boolean;
  now: Date;
}): Promise<PlannedAllowanceMonth> {
  const grants = await orderGrantsTx(tx, options.purchaseRecordId, options.orderKey);
  const end = options.verification.subscription?.currentPeriodEnd ?? null;
  const schedule = grants.schedule ?? (grants.rows.some((row) => row.idempotencyKey === options.orderKey)
    ? null
    : newAllowanceSchedule(options.product, options.verification, options));
  if (!schedule) {
    const whole = wholePeriodCredits(options.product, options.verification);
    return {
      idempotencyKey: options.orderKey,
      credits: whole.credits,
      basis: whole.basis,
      periodStart: options.verification.subscription?.currentPeriodStart ?? options.now,
      periodEnd: end,
      nextMonthAt: null,
      metadata: whole.basis !== "full" ? { allowanceBasis: whole.basis } : {},
      orderGrantedCredits: grants.grantedCredits,
      alreadyGranted: grants.rows.some((row) => row.idempotencyKey === options.orderKey)
    };
  }
  return plannedMonth(schedule, grants, options.now, end);
}

/**
 * The month `record`'s current order owes now, from the schedule its granted
 * months stored, up to `periodEnd` — the order's paid end as now known. Null
 * when there is nothing to grant from records: the order was refunded or
 * revoked, never granted under a schedule, or its paid time is over.
 */
export async function planRecordedOrderMonthTx(tx: BillingTx, options: {
  record: OrderPurchaseRecord;
  periodEnd: Date | null;
  now: Date;
}): Promise<RecordedOrderMonth | null> {
  const { record } = options;
  const tokenHash = record.purchaseTokenHash;
  if (record.status === "REVOKED" || !tokenHash) return null;
  const refund = await tx.googlePlayRefund.findFirst({
    where: { purchaseTokenHash: tokenHash, ...(record.externalPurchaseId ? { orderId: record.externalPurchaseId } : {}) },
    orderBy: { refundableQuantity: "asc" }
  });
  if (refund?.refundableQuantity === 0) return null;
  const rows = await tx.creditLedgerEntry.findMany({
    where: { purchaseRecordId: record.id, entryType: "GRANT" },
    select: { idempotencyKey: true, amountCredits: true, metadata: true }
  });
  // The record's current order: the grants that name it, newest layout first.
  const schedule = rows
    .filter((row) => (jsonRecord(row.metadata).externalPurchaseId ?? null) === (record.externalPurchaseId ?? null))
    .map((row) => allowanceScheduleFromMetadata(row.metadata))
    .filter((candidate): candidate is AllowanceSchedule => candidate !== null)
    .sort((left, right) => right.end.getTime() - left.end.getTime())[0];
  const end = options.periodEnd ?? schedule?.end ?? null;
  if (!schedule || !end || end <= options.now) return null;
  const productSku = jsonRecord(record.metadata).productSku;
  const product = typeof productSku === "string"
    ? await tx.productCatalog.findUnique({ where: { sku: productSku }, select: { title: true } })
    : null;
  return {
    ...plannedMonth(schedule, orderRows(rows, schedule.orderKey), options.now, end),
    purchaseRecordId: record.id,
    productId: record.productId,
    tokenHash,
    description: `${product?.title ?? "Plan"} plan credits`,
    grantMetadata: {
      productSku: typeof productSku === "string" ? productSku : null,
      provider: "GOOGLE_PLAY",
      purchaseTokenHash: tokenHash,
      externalPurchaseId: record.externalPurchaseId
    }
  };
}

/** Grant a planned month into the allowance pool. A month with nothing in it grants nothing. */
export async function grantPlannedMonthTx(tx: BillingTx, options: {
  userId: string;
  productId: string | null;
  purchaseRecordId: string;
  tokenHash: string;
  description: string;
  metadata: Record<string, unknown>;
  planned: PlannedAllowanceMonth;
  now: Date;
}): Promise<CreditLedgerEntryRecord | null> {
  const { planned } = options;
  if (planned.credits <= 0) return null;
  return grantSubscriptionPlanPeriodTx(tx, {
    userId: options.userId,
    productId: options.productId,
    purchaseRecordId: options.purchaseRecordId,
    tokenHash: options.tokenHash,
    allowance: planned.credits,
    periodStart: planned.periodStart,
    periodEnd: planned.periodEnd,
    idempotencyKey: planned.idempotencyKey,
    description: options.description,
    metadata: { ...options.metadata, ...planned.metadata },
    now: options.now
  });
}

/**
 * The record's credits granted, counting what this grant deposited: an
 * order's months add up, and a month granted before adds nothing.
 */
export function orderCreditsGranted(
  planned: PlannedAllowanceMonth | null,
  entry: CreditLedgerEntryRecord | null,
  recorded: number
): number {
  return planned && entry && !planned.alreadyGranted ? planned.orderGrantedCredits + planned.credits : recorded;
}

/** The purchase record an order's months are granted under. */
export type OrderPurchaseRecord = {
  id: string;
  productId: string | null;
  purchaseTokenHash: string | null;
  externalPurchaseId: string | null;
  status: string;
  creditsGranted: number;
  metadata: unknown;
};

/** A plan that keeps being live on *this* token through Google's report: active, in grace, or cancelled but running out. */
const LIVE_SUBSCRIPTION_STATES: readonly string[] = ["ACTIVE", "GRACE_PERIOD", "CANCELED"];

/**
 * A paid period outlives a token Google calls expired. Returns null — so the
 * caller ends the plan as before — unless all of this holds: the token's row
 * last recorded it live with a paid end still ahead, and no refund or
 * revocation stands against its order (those return earlier, as REVOKED).
 *
 * The case it exists for is a downgrade Play deferred: Google reports the old
 * token expired the moment the new one is issued, and the reader keeps what the
 * old plan paid for until the renewal date. The new token's verification
 * retires the old one so its "expired" changes nothing — but when the old
 * token's report came first (an RTDN, the cancel sheet's refresh re-checking
 * the stored token, a verify of the new token that failed first), the old plan
 * was expired *now*, the account dropped to free, and the new token then had
 * no live plan to carry: a Max subscriber lost about 50,000 unspent credits and
 * sat on free until the renewal date (launch review 2026-10-15, C6). Whichever
 * order Google's two reports arrive in now ends in the same state.
 *
 * The plan, its entitlement and its allowance stand; the row is recorded as
 * cancelled — running out, not over — with its paid end kept, so the sweep asks
 * again when the order's next month is due or the paid end has passed. A
 * genuine end still ends it: a lapsed renewal or a payment failure past grace
 * is reported after the recorded end, a refund or revocation leaves its marker,
 * and an account deletion's cancel runs the period out. Meanwhile the order's
 * months keep being granted from what it recorded, because they were paid for.
 */
export async function keepPaidPeriodTx(tx: BillingTx, options: {
  userId: string;
  product: { sku: string };
  purchase: OrderPurchaseRecord;
  tokenHash: string;
  now: Date;
}): Promise<GooglePlayPurchaseRecordResult | null> {
  const { purchase, now } = options;
  if (purchase.status === "REVOKED") return null;
  const state = await tx.subscriptionState.findFirst({
    where: { provider: "GOOGLE_PLAY", externalSubscriptionId: options.tokenHash },
    select: { id: true, status: true, currentPeriodEnd: true }
  });
  const paidEnd = state?.currentPeriodEnd ?? null;
  if (!state || !LIVE_SUBSCRIPTION_STATES.includes(state.status) || !paidEnd || paidEnd <= now) return null;
  const month = await planRecordedOrderMonthTx(tx, { record: purchase, periodEnd: paidEnd, now });
  await tx.subscriptionState.update({
    where: { id: state.id },
    data: { status: "CANCELED", autoRenewing: false, nextCreditGrantAt: month?.nextMonthAt ?? paidEnd }
  });
  const entry = month
    ? await grantPlannedMonthTx(tx, {
        userId: options.userId, productId: month.productId, purchaseRecordId: month.purchaseRecordId, tokenHash: month.tokenHash,
        description: month.description, metadata: { ...month.grantMetadata, carriedBy: "paid_period_kept" }, planned: month, now
      })
    : null;
  const creditsGranted = orderCreditsGranted(month, entry, purchase.creditsGranted);
  if (creditsGranted !== purchase.creditsGranted) {
    await tx.purchaseRecord.update({ where: { id: purchase.id }, data: { creditsGranted } });
  }
  return {
    purchaseRecordId: purchase.id,
    status: purchase.status,
    creditsGranted,
    ledgerEntryId: month && !month.alreadyGranted ? entry?.id ?? null : null,
    subscriptionStatus: "CANCELED",
    entitlementType: planEntitlementTypeForSubscriptionSku(options.product.sku)
  };
}

function plannedMonth(
  schedule: AllowanceSchedule,
  grants: { rows: OrderGrant[]; grantedCredits: number },
  now: Date,
  end: Date | null
): PlannedAllowanceMonth {
  const month = allowanceMonthAt(schedule, now, end);
  const idempotencyKey = allowanceMonthKey(schedule.orderKey, month.index);
  return {
    idempotencyKey,
    credits: month.credits,
    basis: month.basis,
    periodStart: month.start,
    periodEnd: month.end,
    nextMonthAt: month.last ? null : month.end,
    metadata: allowanceMonthMetadata(schedule, month),
    orderGrantedCredits: grants.grantedCredits,
    alreadyGranted: grants.rows.some((row) => row.idempotencyKey === idempotencyKey)
  };
}

/**
 * The grants one order's months wrote, the schedule they stored, and what they
 * granted. Read by the record's own index and narrowed by key in code: one
 * order id can be the prefix of the next (Google's renewals append `..0`, `..1`).
 */
async function orderGrantsTx(
  tx: BillingTx,
  purchaseRecordId: string,
  orderKey: string
): Promise<{ rows: OrderGrant[]; schedule: AllowanceSchedule | null; grantedCredits: number }> {
  const candidates = await tx.creditLedgerEntry.findMany({
    where: { purchaseRecordId, entryType: "GRANT", idempotencyKey: { startsWith: orderKey } },
    select: { idempotencyKey: true, amountCredits: true, metadata: true }
  });
  const grants = orderRows(candidates, orderKey);
  const schedule = grants.rows
    .map((row) => allowanceScheduleFromMetadata(row.metadata))
    .find((candidate): candidate is AllowanceSchedule => candidate?.orderKey === orderKey) ?? null;
  return { ...grants, schedule };
}

function orderRows(rows: OrderGrant[], orderKey: string): { rows: OrderGrant[]; grantedCredits: number } {
  const own = rows.filter((row) => row.idempotencyKey === orderKey || row.idempotencyKey.startsWith(`${orderKey}:month:`));
  return { rows: own, grantedCredits: own.reduce((sum, row) => sum + Math.max(0, row.amountCredits), 0) };
}

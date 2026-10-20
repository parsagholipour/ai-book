/**
 * Paid monthly allowances and calendar usage limits.
 *
 * Free periods carry zero credits; free accounts spend their one-time welcome
 * gift or purchases. Calendar periods still anchor usage ceilings. Before a
 * balance read or reservation, retire legacy free allowances and expire lapsed
 * paid allowances without touching the non-expiring purchased/welcome pool.
 *
 * Google Play verification and renewal grant paid subscription periods. Live
 * paid periods stay intact. Period adoption and legacy retirement run inside
 * the caller's serializable transaction, and so does settling a store refund's
 * debt out of the allowance at a period boundary (`planDebt.ts`).
 */
import {
  PLAN_ENTITLEMENT_TYPES,
  PLAN_TIER_ORDER,
  type PlanTier,
  creditPricing,
  highestPlanTier,
  jsonRecord,
  planTierForEntitlementType
} from "@book-maker/core";
import { prisma } from "./client.ts";
import {
  type BillingTx,
  type CreditLedgerEntryRecord,
  type PlanAccountRow,
  accountSelect,
  activeEntitlementWhere,
  effectivePlanCredits,
  jsonInput,
  ledgerSelect,
  planPeriodKeyFromMetadata,
  runSerializable
} from "./billingInternals.ts";
import { activeCreditPricingVersion } from "./creditPricing.ts";
import { ensureWelcomeCreditsTx } from "./welcomeCredits.ts";
import { retireFreePlanCreditsTx } from "./freePlanCredits.ts";
import { planDebtSettlementTx, recordPlanDebtSettlementTx } from "./planDebt.ts";
import { addMonths } from "./subscriptionAllowance.ts";

/** Monthly usage counters. See `UsageCounter` in the schema. */
export const ILLUSTRATED_BOOK_COUNTER = "illustrated_books";
export const MANUSCRIPT_IMPORT_COUNTER = "manuscript_imports";

export type PlanPeriodBounds = {
  key: string;
  start: Date;
  end: Date;
};

export type PlanSummary = {
  tier: PlanTier;
  source: "free" | "google_play";
  status: string | null;
  /** When the plan renews. Null once it has been cancelled — see `endsAt`. */
  renewsAt: Date | null;
  /** True while a cancelled plan is still running out its paid period. */
  cancelAtPeriodEnd: boolean;
  /** When a cancelled plan drops to free. Null while it is still renewing. */
  endsAt: Date | null;
  productSku: string | null;
  /** Identifies the owned Play purchase without exposing its raw token. */
  purchaseTokenHash: string | null;
  /**
   * A downgrade Play deferred to the end of the paid period: the plan the
   * reader moves to, and when. Until then `productSku` names the plan being
   * run out — the one Play still files the token under — so a further switch
   * from the app matches what Play holds. Absent when nothing is scheduled.
   */
  pendingChange?: { productSku: string; startsAt: Date | null } | undefined;
};

export type MonthlyQuota = {
  used: number;
  limit: number;
  periodKey: string;
  resetsAt: Date;
};

export type ImageQuota = MonthlyQuota;

export type { PlanAccountRow };
export { effectivePlanCredits };

/** UTC calendar month, the anchor for free periods and monthly usage counters. */
export function calendarPeriodKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function calendarPeriodBounds(now: Date): PlanPeriodBounds {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { key: `free:${calendarPeriodKey(now)}`, start, end };
}

export function subscriptionPeriodKey(tokenHash: string, periodEnd: Date): string {
  return `sub:${tokenHash}:${periodEnd.toISOString()}`;
}

export async function ensureCreditAccountRow(tx: BillingTx, userId: string): Promise<PlanAccountRow> {
  return tx.userCreditAccount.upsert({
    where: { userId },
    create: { userId },
    update: {},
    select: accountSelect
  });
}

export async function resolvePlanTierTx(tx: BillingTx, userId: string, now: Date = new Date()): Promise<PlanTier> {
  const entitlements = await tx.userEntitlement.findMany({
    where: {
      ...activeEntitlementWhere(userId, now),
      type: { in: PLAN_ENTITLEMENT_TYPES }
    },
    select: { type: true }
  });
  return highestPlanTier(entitlements.map((entitlement) => planTierForEntitlementType(entitlement.type)));
}

export async function resolvePlanTier(userId: string, now: Date = new Date()): Promise<PlanTier> {
  return resolvePlanTierTx(prisma, userId, now);
}

/**
 * Bring the account onto the current period, writing off a lapsed allowance
 * when one is owed. Safe to call on every request: it is a no-op once the
 * period matches. Also settles a pending welcome grant.
 */
export async function ensureCurrentPlanPeriodTx(
  tx: BillingTx,
  userId: string,
  now: Date = new Date()
): Promise<PlanAccountRow> {
  const account = await ensureCreditAccountRow(tx, userId);
  const welcomed = await ensureWelcomeCreditsTx(tx, account, now, {
    onPaidPlan: async () => (await resolvePlanTierTx(tx, userId, now)) !== "free"
  });
  const settled = await retireFreePlanCreditsTx(tx, welcomed);
  // A period that has not run out is owned by whoever granted it. That covers
  // paid periods mid-month and this month's zero-credit free period, and it
  // stops a subscription's allowance being overwritten in the window between
  // the credit grant and the entitlement row that proves it is paid.
  if (settled.planPeriodEnd && settled.planPeriodEnd > now) {
    return settled;
  }
  if ((await resolvePlanTierTx(tx, userId, now)) !== "free") {
    // A store plan's next month comes from its verification or the renewal
    // sweep. A comp has neither, so its next month is granted here.
    return ensureOperatorCompMonthTx(tx, userId, settled, now);
  }

  const period = calendarPeriodBounds(now);
  if (settled.planPeriodKey === period.key) {
    return settled;
  }
  const applied = await applyPlanPeriodTx(tx, {
    userId,
    account: settled,
    period,
    allowance: 0,
    operation: "PLAN_ALLOWANCE_GRANT",
    idempotencyKey: `plan-period:${userId}:${period.key}`,
    description: "Free plan period (no credit allowance)",
    metadata: { planTier: "free", planPeriodKey: period.key }
  });
  return applied.account;
}

export async function ensureCurrentPlanPeriod(userId: string, now: Date = new Date()): Promise<PlanAccountRow> {
  return runSerializable((tx) => ensureCurrentPlanPeriodTx(tx, userId, now));
}

/** `UserEntitlement.source` of a plan an operator gave away (`operatorPlanComps.ts`). */
export const OPERATOR_COMP_SOURCE = "operator_comp";

/** The monthly product whose catalog allowance a comped tier grants each month. */
export const OPERATOR_COMP_SKU_BY_TIER: Record<Exclude<PlanTier, "free">, string> = {
  creator: "tomeza.creator_monthly",
  pro: "tomeza.pro_monthly",
  max: "tomeza.max_monthly"
};

/**
 * Put the account on the month of its operator comp that `now` falls in.
 *
 * A comp is a plan entitlement with no store order behind it, so neither a
 * verification nor the renewal sweep grants its months. This does, lazily, the
 * way welcome credits are: `ensureCurrentPlanPeriodTx` calls it once the last
 * month has run out, and `grantOperatorPlanComp` calls it for the first. Months
 * are counted from the entitlement's `startsAt` and each is one
 * `PLAN_ALLOWANCE_GRANT` keyed on (entitlement, month) — valued at nothing by
 * the dashboard, like every allowance nobody paid for — so concurrent reads
 * grant it once and the month's unused credits lapse at the next one.
 *
 * A store plan held beside the comp owns the pool: while one is active this
 * grants nothing, and the store's own grants reset the pool as they always do.
 */
export async function ensureOperatorCompMonthTx(
  tx: BillingTx,
  userId: string,
  account: PlanAccountRow,
  now: Date
): Promise<PlanAccountRow> {
  const plans = await tx.userEntitlement.findMany({
    where: { ...activeEntitlementWhere(userId, now), type: { in: PLAN_ENTITLEMENT_TYPES } },
    select: { id: true, type: true, source: true, startsAt: true }
  });
  if (plans.some((plan) => plan.source !== OPERATOR_COMP_SOURCE)) {
    return account;
  }
  // `grantOperatorPlanComp` keeps one comp live; the highest tier wins anyway.
  const comp = plans
    .map((plan) => ({ ...plan, tier: planTierForEntitlementType(plan.type) }))
    .sort((a, b) => PLAN_TIER_ORDER.indexOf(b.tier) - PLAN_TIER_ORDER.indexOf(a.tier))[0];
  if (!comp || comp.tier === "free") {
    return account;
  }
  const tier = comp.tier;
  const product = await tx.productCatalog.findUnique({
    where: { sku: OPERATOR_COMP_SKU_BY_TIER[tier] },
    select: { creditAmount: true, title: true }
  });
  if (!product) {
    return account;
  }

  const month = operatorCompMonthIndex(comp.startsAt, now);
  const applied = await applyPlanPeriodTx(tx, {
    userId,
    account,
    period: {
      key: `comp:${comp.id}:${month}`,
      start: addMonths(comp.startsAt, month),
      end: addMonths(comp.startsAt, month + 1)
    },
    allowance: product.creditAmount,
    operation: "PLAN_ALLOWANCE_GRANT",
    idempotencyKey: `operator-comp:${comp.id}:month:${month}`,
    description: `${product.title} plan credits (complimentary)`,
    metadata: { planTier: tier, operatorCompEntitlementId: comp.id, allowanceMonth: month }
  });
  return applied.account;
}

/** Whole months from `startsAt` to `now`: 0 in the comp's first month. */
function operatorCompMonthIndex(startsAt: Date, now: Date): number {
  let month = (now.getUTCFullYear() - startsAt.getUTCFullYear()) * 12 + now.getUTCMonth() - startsAt.getUTCMonth();
  if (addMonths(startsAt, month) > now) {
    month -= 1;
  }
  return Math.max(0, month);
}

/**
 * Start a subscription's period: reset the allowance pool to the plan's monthly
 * credits. Called from the Google Play verify and renewal paths, which supply
 * the period bounds Google reported.
 */
type SubscriptionPlanPeriodOptions = {
  userId: string;
  productId?: string | null | undefined;
  purchaseRecordId: string;
  tokenHash: string;
  allowance: number;
  periodStart: Date | null;
  periodEnd: Date | null;
  idempotencyKey: string;
  description: string;
  metadata: Record<string, unknown>;
  now?: Date | undefined;
};

export async function grantSubscriptionPlanPeriod(options: SubscriptionPlanPeriodOptions): Promise<CreditLedgerEntryRecord | null> {
  return runSerializable((tx) => grantSubscriptionPlanPeriodTx(tx, options));
}

export async function grantSubscriptionPlanPeriodTx(tx: BillingTx, options: SubscriptionPlanPeriodOptions): Promise<CreditLedgerEntryRecord | null> {
  const now = options.now ?? new Date();
  // Google says active but reported no expiry: give the allowance a month rather
  // than a period that has already elapsed, which would read as zero credits to
  // someone who just paid. The next verification corrects it.
  const periodEnd = options.periodEnd ?? new Date(now.getTime() + FALLBACK_PERIOD_MS);
  const period: PlanPeriodBounds = {
    key: subscriptionPeriodKey(options.tokenHash, periodEnd),
    start: options.periodStart ?? now,
    end: periodEnd
  };

  const account = await ensureCreditAccountRow(tx, options.userId);
  const applied = await applyPlanPeriodTx(tx, {
    userId: options.userId,
    account,
    period,
    allowance: options.allowance,
    operation: "SUBSCRIPTION_CREDIT_GRANT",
    idempotencyKey: options.idempotencyKey,
    description: options.description,
    metadata: { ...options.metadata, planPeriodKey: period.key },
    productId: options.productId ?? undefined,
    purchaseRecordId: options.purchaseRecordId
  });
  return applied.entry;
}

export async function getPlanSummary(userId: string, now: Date = new Date()): Promise<PlanSummary> {
  const tier = await resolvePlanTier(userId, now);
  if (tier === "free") {
    return { tier, source: "free", status: null, renewsAt: null, cancelAtPeriodEnd: false, endsAt: null, productSku: null, purchaseTokenHash: null };
  }
  const subscription = await prisma.subscriptionState.findFirst({
    where: { userId, status: { in: ["ACTIVE", "GRACE_PERIOD", "CANCELED"] } },
    orderBy: { currentPeriodEnd: "desc" },
    select: {
      status: true,
      currentPeriodEnd: true,
      autoRenewing: true,
      externalSubscriptionId: true,
      metadata: true,
      product: { select: { sku: true } }
    }
  });
  // Play moves a cancelled subscription to CANCELED, but reports auto-renew off
  // first, so either answer means the same thing: this period is the last one.
  const cancelAtPeriodEnd = subscription?.status === "CANCELED" || subscription?.autoRenewing === false;
  const periodEnd = subscription?.currentPeriodEnd ?? null;
  const pendingChange = subscription ? deferredChange(subscription.metadata, subscription.product?.sku ?? null, now) : null;
  return {
    tier,
    source: "google_play",
    status: subscription?.status ?? null,
    renewsAt: cancelAtPeriodEnd ? null : periodEnd,
    cancelAtPeriodEnd,
    endsAt: cancelAtPeriodEnd ? periodEnd : null,
    productSku: pendingChange?.fromProductSku ?? subscription?.product?.sku ?? null,
    purchaseTokenHash: subscription?.externalSubscriptionId ?? null,
    ...(pendingChange ? { pendingChange: { productSku: pendingChange.productSku, startsAt: pendingChange.startsAt } } : {})
  };
}

/** The deferred plan change a subscription row's last verification recorded, while it is still ahead. */
function deferredChange(
  metadata: unknown,
  productSku: string | null,
  now: Date
): { fromProductSku: string; productSku: string; startsAt: Date | null } | null {
  const change = jsonRecord(jsonRecord(jsonRecord(metadata).subscription).deferredReplacement);
  if (!productSku || typeof change.fromProductSku !== "string") return null;
  const startsAt = typeof change.takesEffectAt === "string" ? new Date(change.takesEffectAt) : null;
  if (startsAt && !(startsAt > now)) return null;
  return { fromProductSku: change.fromProductSku, productSku, startsAt };
}

/**
 * The free tier's illustrated-book budget, or `null` when the plan has no image
 * limit at all. Callers treat `null` as unlimited rather than as "unknown".
 */
export async function getImageQuota(userId: string, now: Date = new Date()): Promise<ImageQuota | null> {
  return getMonthlyQuota(ILLUSTRATED_BOOK_COUNTER, creditPricing().freeIllustratedBooksPerMonth, userId, now);
}

/**
 * The longest book this account may have generated, or `null` on any paid plan,
 * which is held only to the 600-page ceiling every request schema enforces.
 *
 * Not a monthly counter like the two quotas beside it: nothing is claimed, so a
 * refused request has nothing to hand back and every door simply asks again.
 * Callers treat `null` as "no free-tier cap" rather than as "unknown", the same
 * as {@link getImageQuota}.
 */
export async function getBookPageLimit(userId: string, now: Date = new Date()): Promise<number | null> {
  const tier = await resolvePlanTier(userId, now);
  return tier === "free" ? creditPricing().freeMaxBookPages : null;
}

/**
 * The free tier's manuscript-import budget; `null` means unlimited (any paid
 * plan). Same semantics as {@link getImageQuota}.
 */
export async function getImportQuota(userId: string, now: Date = new Date()): Promise<MonthlyQuota | null> {
  return getMonthlyQuota(MANUSCRIPT_IMPORT_COUNTER, creditPricing().freeManuscriptImportsPerMonth, userId, now);
}

async function getMonthlyQuota(
  kind: string,
  limit: number,
  userId: string,
  now: Date
): Promise<MonthlyQuota | null> {
  const tier = await resolvePlanTier(userId, now);
  if (tier !== "free") {
    return null;
  }
  const periodKey = calendarPeriodKey(now);
  const counter = await prisma.usageCounter.findUnique({
    where: { userId_kind_periodKey: { userId, kind, periodKey } },
    select: { used: true }
  });
  return {
    used: counter?.used ?? 0,
    limit,
    periodKey,
    resetsAt: calendarPeriodBounds(now).end
  };
}

export type ConsumeUsageResult = {
  allowed: boolean;
  used: number;
  limit: number;
  periodKey: string;
  resetsAt: Date;
};

/**
 * Claim one illustrated-book generation against the month's budget.
 *
 * The conditional increment is the limit: two requests racing the last slot both
 * hit the same row, and only one of them sees `used < limit`.
 */
export async function consumeIllustratedBookUse(options: {
  userId: string;
  limit: number;
  now?: Date | undefined;
}): Promise<ConsumeUsageResult> {
  return consumeMonthlyUse(prisma, ILLUSTRATED_BOOK_COUNTER, options);
}

export async function consumeIllustratedBookUseTx(
  tx: BillingTx,
  options: { userId: string; limit: number; now?: Date | undefined }
): Promise<ConsumeUsageResult> {
  return consumeMonthlyUse(tx, ILLUSTRATED_BOOK_COUNTER, options);
}

/** Claim one manuscript import against the free tier's monthly budget. */
export async function consumeManuscriptImportUse(options: {
  userId: string;
  limit: number;
  now?: Date | undefined;
}): Promise<ConsumeUsageResult> {
  return consumeMonthlyUse(prisma, MANUSCRIPT_IMPORT_COUNTER, options);
}

/**
 * Transaction-aware form, so an import can claim its slot inside the same
 * transaction that creates the project and queues the job — a crash then rolls
 * the claim back with everything else instead of burning the month's slot on
 * an import that never existed.
 */
export async function consumeManuscriptImportUseTx(
  tx: BillingTx,
  options: { userId: string; limit: number; now?: Date | undefined }
): Promise<ConsumeUsageResult> {
  return consumeMonthlyUse(tx, MANUSCRIPT_IMPORT_COUNTER, options);
}

async function consumeMonthlyUse(
  tx: BillingTx,
  kind: string,
  options: { userId: string; limit: number; now?: Date | undefined }
): Promise<ConsumeUsageResult> {
  const now = options.now ?? new Date();
  const periodKey = calendarPeriodKey(now);
  const resetsAt = calendarPeriodBounds(now).end;
  const where = { userId: options.userId, kind, periodKey };

  if (options.limit <= 0) {
    return { allowed: false, used: 0, limit: options.limit, periodKey, resetsAt };
  }

  await ensureUsageCounterRow(tx, where);
  const claimed = await tx.usageCounter.updateMany({
    where: { ...where, used: { lt: options.limit } },
    data: { used: { increment: 1 } }
  });
  const counter = await tx.usageCounter.findUnique({
    where: { userId_kind_periodKey: where },
    select: { used: true }
  });
  return {
    allowed: claimed.count === 1,
    used: counter?.used ?? options.limit,
    limit: options.limit,
    periodKey,
    resetsAt
  };
}

export async function releaseIllustratedBookUseTx(tx: BillingTx, userId: string, periodKey: string): Promise<void> {
  await tx.usageCounter.updateMany({
    where: { userId, kind: ILLUSTRATED_BOOK_COUNTER, periodKey, used: { gt: 0 } },
    data: { used: { decrement: 1 } }
  });
}

/** Hand a slot back when the generation it was claimed for never happened. */
export async function releaseIllustratedBookUse(userId: string, periodKey: string): Promise<void> {
  await releaseIllustratedBookUseTx(prisma, userId, periodKey);
}

/** Hand an import slot back when the import it was claimed for failed. */
export async function releaseManuscriptImportUse(userId: string, periodKey: string): Promise<void> {
  await prisma.usageCounter.updateMany({
    where: { userId, kind: MANUSCRIPT_IMPORT_COUNTER, periodKey, used: { gt: 0 } },
    data: { used: { decrement: 1 } }
  });
}

const FALLBACK_PERIOD_MS = 31 * 24 * 60 * 60 * 1000;

/**
 * Reset the allowance pool to a new period.
 *
 * The outgoing balance is written off as its own ADJUSTMENT rather than silently
 * overwritten, so `SUM("planCreditsDelta")` still reconciles against the pool and
 * a support question about vanished credits has an answer. The grant's
 * idempotency key is the period, which is what makes concurrent API instances —
 * and a renewal sweep racing the app's own verification — harmless.
 *
 * Resetting the allowance never touched a negative purchased pool, so a store
 * refund's debt used to sit beside every new allowance, hide that much of it,
 * and outlive it. The boundary now settles the debt first (`planDebt.ts`): the
 * outgoing remainder pays what it was hiding instead of expiring, and the new
 * allowance pays the rest, so only what is left of either expires or is spendable.
 *
 * A free period is still *adopted* when the account is sitting on a different
 * one. That is the case a cancellation makes reachable:
 * someone who entered a free period on the 1st, subscribed on the 5th and
 * cancelled on the 20th already owns this month's free key, and returning early
 * would leave them holding the subscription's allowance on the free tier. The
 * allowance is not granted twice. Free periods always have zero allowance,
 * including when adopting a period granted before free credits were disabled.
 * An already-granted paid receipt only owns its recorded period; replaying it
 * after a switch or renewal must leave the current allowance and period alone.
 */
async function applyPlanPeriodTx(
  tx: BillingTx,
  options: {
    userId: string;
    account: PlanAccountRow;
    period: PlanPeriodBounds;
    allowance: number;
    operation: "PLAN_ALLOWANCE_GRANT" | "SUBSCRIPTION_CREDIT_GRANT";
    idempotencyKey: string;
    description: string;
    metadata: Record<string, unknown>;
    productId?: string | undefined;
    purchaseRecordId?: string | undefined;
  }
): Promise<{ account: PlanAccountRow; entry: CreditLedgerEntryRecord | null }> {
  const existing = await tx.creditLedgerEntry.findUnique({
    where: { idempotencyKey: options.idempotencyKey },
    select: { ...ledgerSelect, metadata: true }
  });
  // Already sitting on this exact period: it has been granted — under this key
  // or another. The grant key and the period key are derived from different
  // fields (Google's `latestOrderId` versus the reported period end), so they
  // can disagree: an orderId that drifts between the app's verify and the
  // sweep's mints a second grant key for a period already granted, and writing
  // here would first forfeit what is left of it and then re-grant the full
  // allowance — resetting a part-spent month to full.
  if (options.account.planPeriodKey === options.period.key) {
    return { account: options.account, entry: existing ?? null };
  }

  const allowance = Math.max(0, Math.floor(options.allowance));

  if (existing) {
    const grantedPeriodKey = planPeriodKeyFromMetadata(existing.metadata);
    if (options.operation === "SUBSCRIPTION_CREDIT_GRANT" && grantedPeriodKey !== options.account.planPeriodKey) {
      // A restore can deliver an older paid receipt after another plan or
      // renewal took over. It grants nothing and cannot adopt or slide the
      // current pool onto its own period, even if its reported expiry changed.
      return { account: options.account, entry: existing };
    }
    if (grantedPeriodKey !== null && grantedPeriodKey !== options.period.key) {
      // The same grant key re-applied to a *recomputed* period: the mock
      // verifier's moving month-end, or a real verification whose missing
      // `expiryTime` fell back to now + 31 days. That is the same purchase
      // cycle with shifted boundaries, not a new cycle — a new cycle arrives
      // under a new grant key and takes the fresh-grant path below. Slide the
      // period and keep the pool: the adoption write this used to fall into
      // wiped a live subscription's remaining allowance on every refresh,
      // restore, or re-verify.
      const account = await tx.userCreditAccount.update({
        where: { userId: options.userId },
        data: {
          planCreditsPerPeriod: allowance,
          planPeriodStart: options.period.start,
          planPeriodEnd: options.period.end,
          planPeriodKey: options.period.key
        },
        select: accountSelect
      });
      // Refunds later subtract unused allowance expired under this period key.
      // Keep the original grant attached to corrected provider period bounds.
      await tx.creditLedgerEntry.update({
        where: { id: existing.id },
        data: { metadata: jsonInput({ ...jsonRecord(existing.metadata), planPeriodKey: options.period.key }) }
      });
      return { account, entry: existing };
    }
  }

  const granted = existing ? 0 : allowance;
  // Store-refund debt is settled at the boundary, before anything expires:
  // first from the remainder the debt was hiding, then from the new allowance.
  const settlement = await planDebtSettlementTx(tx, {
    userId: options.userId,
    account: options.account,
    periodKey: options.period.key,
    granted
  });
  const fromRemainder = settlement.fromRemainder.credits;
  const fromAllowance = settlement.fromAllowance.credits;
  const forfeited = Math.max(0, options.account.planCredits) - fromRemainder;
  const purchasedAfterRemainder = options.account.availableCredits + fromRemainder;
  if (fromRemainder > 0) {
    await recordPlanDebtSettlementTx(tx, {
      userId: options.userId,
      operation: options.operation,
      source: "remainder",
      part: settlement.fromRemainder,
      paidFromPlanPeriodKey: options.account.planPeriodKey,
      debtBeforeCredits: settlement.debtCredits,
      balanceAfterCredits: purchasedAfterRemainder + forfeited
    });
  }
  if (forfeited > 0) {
    await tx.creditLedgerEntry.create({
      data: {
        userId: options.userId,
        entryType: "ADJUSTMENT",
        status: "SETTLED",
        operation: options.operation,
        amountCredits: -forfeited,
        planCreditsDelta: -forfeited,
        balanceAfterCredits: purchasedAfterRemainder,
        // The outgoing period names the adopting write, because the grant's own
        // `:expired` key may already have been spent when it ran for real.
        idempotencyKey: existing
          ? `${options.idempotencyKey}:adopted:${options.account.planPeriodKey ?? "none"}`
          : `${options.idempotencyKey}:expired`,
        description: "Unused monthly allowance expired",
        // Same pricing-version stamp `ledgerData` gives every other entry:
        // allowance sizes are operator-editable, so a row without the version
        // cannot be reconciled against the prices in force when it was cut.
        metadata: jsonInput({
          pricingVersion: activeCreditPricingVersion(),
          expiredPlanPeriodKey: options.account.planPeriodKey,
          replacedByPlanPeriodKey: options.period.key
        })
      },
      select: { id: true }
    });
  }

  const account = await tx.userCreditAccount.update({
    where: { userId: options.userId },
    data: {
      planCredits: granted - fromAllowance,
      ...(fromRemainder + fromAllowance > 0 ? { availableCredits: { increment: fromRemainder + fromAllowance } } : {}),
      // The period's size, not what is left of it. Zero for free periods.
      planCreditsPerPeriod: allowance,
      planPeriodStart: options.period.start,
      planPeriodEnd: options.period.end,
      planPeriodKey: options.period.key,
      lifetimeCreditsGranted: { increment: granted }
    },
    select: accountSelect
  });
  // Settling the debt moves credits between pools, so the total right after the
  // grant is the same whether or not any of it went to the debt.
  const balanceAfterGrant = purchasedAfterRemainder + granted;

  const entry =
    granted <= 0
      ? existing
      : await tx.creditLedgerEntry.create({
          data: {
            userId: options.userId,
            ...(options.productId ? { productId: options.productId } : {}),
            ...(options.purchaseRecordId ? { purchaseRecordId: options.purchaseRecordId } : {}),
            entryType: "GRANT",
            status: "SETTLED",
            operation: options.operation,
            // The whole allowance, including any part that pays a debt below: a
            // refund of this period reverses all of it, and that is what brings
            // the debt it paid back.
            amountCredits: granted,
            planCreditsDelta: granted,
            balanceAfterCredits: balanceAfterGrant,
            idempotencyKey: options.idempotencyKey,
            description: options.description,
            metadata: jsonInput({ pricingVersion: activeCreditPricingVersion(), ...options.metadata })
          },
          select: ledgerSelect
        });

  if (fromAllowance > 0) {
    await recordPlanDebtSettlementTx(tx, {
      userId: options.userId,
      operation: options.operation,
      source: "allowance",
      part: settlement.fromAllowance,
      paidFromPlanPeriodKey: options.period.key,
      debtBeforeCredits: settlement.debtCredits - fromRemainder,
      balanceAfterCredits: balanceAfterGrant
    });
  }

  return { account, entry };
}

async function ensureUsageCounterRow(
  tx: BillingTx,
  where: { userId: string; kind: string; periodKey: string }
): Promise<void> {
  // Native upsert rather than create-and-swallow-P2002: `tx` is routinely a
  // caller's open transaction, and inside one a unique violation aborts the
  // whole Postgres transaction even when the error is caught — the loser's
  // claim, and every statement after it, would fail with 25P02. ON CONFLICT
  // resolves the same race without raising.
  await tx.usageCounter.upsert({
    where: { userId_kind_periodKey: where },
    create: { ...where, used: 0 },
    update: {}
  });
}

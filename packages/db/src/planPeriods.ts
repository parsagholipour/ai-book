/**
 * Monthly allowances and the limits that ride on them.
 *
 * Every user is on a plan period: free users get a calendar month of credits,
 * subscribers get their Google Play billing period. The allowance is a *reset*,
 * not a top-up — an unused month does not accumulate — and it lives in its own
 * pool so purchased credits, which never expire, cannot be spent by it or lost
 * with it.
 *
 * Free periods are granted lazily rather than by a cron: `ensureCurrentPlanPeriod`
 * runs at the top of every reservation and before the billing payload is
 * serialized, so anyone who can spend or look has already been granted. The
 * period-keyed ledger idempotency key makes concurrent API instances safe.
 *
 * Subscription periods are *not* granted here — the Google Play verify and
 * renewal paths own them, because only they know the real period bounds. This
 * module will never overwrite a plan period that is still live.
 */
import {
  PLAN_ENTITLEMENT_TYPES,
  type PlanTier,
  creditPricing,
  highestPlanTier,
  planTierForEntitlementType
} from "@book-maker/core";
import { Prisma, prisma } from "./client.ts";
import {
  type BillingTx,
  type CreditLedgerEntryRecord,
  activeEntitlementWhere,
  jsonInput,
  ledgerSelect,
  runSerializable
} from "./billingInternals.ts";

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
};

export type MonthlyQuota = {
  used: number;
  limit: number;
  periodKey: string;
  resetsAt: Date;
};

export type ImageQuota = MonthlyQuota;

export type PlanAccountRow = {
  userId: string;
  availableCredits: number;
  reservedCredits: number;
  lifetimeCreditsGranted: number;
  lifetimeCreditsSpent: number;
  planCredits: number;
  planCreditsPerPeriod: number;
  planPeriodStart: Date | null;
  planPeriodEnd: Date | null;
  planPeriodKey: string | null;
};

/** UTC calendar month, the anchor for free allowances and every usage counter. */
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

/** Spendable allowance right now: an allowance past its period is already gone. */
export function effectivePlanCredits(
  account: Pick<PlanAccountRow, "planCredits" | "planPeriodEnd">,
  now: Date = new Date()
): number {
  if (!account.planPeriodEnd || account.planPeriodEnd <= now) {
    return 0;
  }
  return Math.max(0, account.planCredits);
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
 * Bring the account onto the current period, granting the free month when one is
 * owed. Safe to call on every request: it is a no-op once the period matches.
 */
export async function ensureCurrentPlanPeriodTx(
  tx: BillingTx,
  userId: string,
  now: Date = new Date()
): Promise<PlanAccountRow> {
  const account = await ensureCreditAccountRow(tx, userId);
  // A period that has not run out is owned by whoever granted it. That covers
  // paid periods mid-month and this month's free grant alike, and it is what
  // stops a subscription's allowance being overwritten in the window between
  // the credit grant and the entitlement row that proves it is paid.
  if (account.planPeriodEnd && account.planPeriodEnd > now) {
    return account;
  }
  if ((await resolvePlanTierTx(tx, userId, now)) !== "free") {
    return account;
  }

  const period = calendarPeriodBounds(now);
  if (account.planPeriodKey === period.key) {
    return account;
  }
  const applied = await applyPlanPeriodTx(tx, {
    userId,
    account,
    period,
    allowance: creditPricing().freeMonthlyCredits,
    operation: "PLAN_ALLOWANCE_GRANT",
    idempotencyKey: `plan-period:${userId}:${period.key}`,
    description: "Free monthly allowance",
    metadata: { planTier: "free", planPeriodKey: period.key }
  });
  return applied.account;
}

export async function ensureCurrentPlanPeriod(userId: string, now: Date = new Date()): Promise<PlanAccountRow> {
  return runSerializable((tx) => ensureCurrentPlanPeriodTx(tx, userId, now));
}

/**
 * Start a subscription's period: reset the allowance pool to the plan's monthly
 * credits. Called from the Google Play verify and renewal paths, which supply
 * the period bounds Google reported.
 */
export async function grantSubscriptionPlanPeriod(options: {
  userId: string;
  productId: string;
  purchaseRecordId: string;
  tokenHash: string;
  allowance: number;
  periodStart: Date | null;
  periodEnd: Date | null;
  idempotencyKey: string;
  description: string;
  metadata: Record<string, unknown>;
  now?: Date | undefined;
}): Promise<CreditLedgerEntryRecord | null> {
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

  return runSerializable(async (tx) => {
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
      productId: options.productId,
      purchaseRecordId: options.purchaseRecordId
    });
    return applied.entry;
  });
}

export async function getPlanSummary(userId: string, now: Date = new Date()): Promise<PlanSummary> {
  const tier = await resolvePlanTier(userId, now);
  if (tier === "free") {
    return { tier, source: "free", status: null, renewsAt: null, cancelAtPeriodEnd: false, endsAt: null, productSku: null };
  }
  const subscription = await prisma.subscriptionState.findFirst({
    where: { userId, status: { in: ["ACTIVE", "GRACE_PERIOD", "CANCELED"] } },
    orderBy: { currentPeriodEnd: "desc" },
    select: {
      status: true,
      currentPeriodEnd: true,
      autoRenewing: true,
      product: { select: { sku: true } }
    }
  });
  // Play moves a cancelled subscription to CANCELED, but reports auto-renew off
  // first, so either answer means the same thing: this period is the last one.
  const cancelAtPeriodEnd = subscription?.status === "CANCELED" || subscription?.autoRenewing === false;
  const periodEnd = subscription?.currentPeriodEnd ?? null;
  return {
    tier,
    source: "google_play",
    status: subscription?.status ?? null,
    renewsAt: cancelAtPeriodEnd ? null : periodEnd,
    cancelAtPeriodEnd,
    endsAt: cancelAtPeriodEnd ? periodEnd : null,
    productSku: subscription?.product?.sku ?? null
  };
}

/**
 * The free tier's illustrated-book budget, or `null` when the plan has no image
 * limit at all. Callers treat `null` as unlimited rather than as "unknown".
 */
export async function getImageQuota(userId: string, now: Date = new Date()): Promise<ImageQuota | null> {
  return getMonthlyQuota(ILLUSTRATED_BOOK_COUNTER, creditPricing().freeIllustratedBooksPerMonth, userId, now);
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
  return consumeMonthlyUse(ILLUSTRATED_BOOK_COUNTER, options);
}

/** Claim one manuscript import against the free tier's monthly budget. */
export async function consumeManuscriptImportUse(options: {
  userId: string;
  limit: number;
  now?: Date | undefined;
}): Promise<ConsumeUsageResult> {
  return consumeMonthlyUse(MANUSCRIPT_IMPORT_COUNTER, options);
}

async function consumeMonthlyUse(
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

  await ensureUsageCounterRow(where);
  const claimed = await prisma.usageCounter.updateMany({
    where: { ...where, used: { lt: options.limit } },
    data: { used: { increment: 1 } }
  });
  const counter = await prisma.usageCounter.findUnique({
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

const accountSelect = {
  userId: true,
  availableCredits: true,
  reservedCredits: true,
  lifetimeCreditsGranted: true,
  lifetimeCreditsSpent: true,
  planCredits: true,
  planCreditsPerPeriod: true,
  planPeriodStart: true,
  planPeriodEnd: true,
  planPeriodKey: true
} as const;

/**
 * Reset the allowance pool to a new period.
 *
 * The outgoing balance is written off as its own ADJUSTMENT rather than silently
 * overwritten, so `SUM("planCreditsDelta")` still reconciles against the pool and
 * a support question about vanished credits has an answer. The grant's
 * idempotency key is the period, which is what makes concurrent API instances —
 * and a renewal sweep racing the app's own verification — harmless.
 *
 * A period whose grant already happened is still *adopted* when the account is
 * sitting on a different one. That is the case a cancellation makes reachable:
 * someone who took their free month on the 1st, subscribed on the 5th and
 * cancelled on the 20th already owns this month's free key, and returning early
 * would leave them holding the subscription's allowance on the free tier. The
 * allowance is not granted twice — they move onto the period with nothing left
 * of it, which is exactly what "you already had your free month" means.
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
    select: ledgerSelect
  });
  // Granted *and* already on the period: a duplicate call, or the losing side of
  // a race the winner has finished. Writing here would forfeit the allowance the
  // winner just deposited.
  if (existing && options.account.planPeriodKey === options.period.key) {
    return { account: options.account, entry: existing };
  }

  const allowance = Math.max(0, Math.floor(options.allowance));
  const granted = existing ? 0 : allowance;
  const forfeited = Math.max(0, options.account.planCredits);
  if (forfeited > 0) {
    await tx.creditLedgerEntry.create({
      data: {
        userId: options.userId,
        entryType: "ADJUSTMENT",
        status: "SETTLED",
        operation: options.operation,
        amountCredits: -forfeited,
        planCreditsDelta: -forfeited,
        balanceAfterCredits: options.account.availableCredits,
        // The outgoing period names the adopting write, because the grant's own
        // `:expired` key may already have been spent when it ran for real.
        idempotencyKey: existing
          ? `${options.idempotencyKey}:adopted:${options.account.planPeriodKey ?? "none"}`
          : `${options.idempotencyKey}:expired`,
        description: "Unused monthly allowance expired",
        metadata: jsonInput({
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
      planCredits: granted,
      // The period's size, not what is left of it: an adopted period reads as
      // "0 of 1,000 monthly credits left" rather than as having no allowance.
      planCreditsPerPeriod: allowance,
      planPeriodStart: options.period.start,
      planPeriodEnd: options.period.end,
      planPeriodKey: options.period.key,
      lifetimeCreditsGranted: { increment: granted }
    },
    select: accountSelect
  });

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
            amountCredits: granted,
            planCreditsDelta: granted,
            balanceAfterCredits: account.availableCredits + granted,
            idempotencyKey: options.idempotencyKey,
            description: options.description,
            metadata: jsonInput(options.metadata)
          },
          select: ledgerSelect
        });

  return { account, entry };
}

async function ensureUsageCounterRow(where: { userId: string; kind: string; periodKey: string }): Promise<void> {
  const existing = await prisma.usageCounter.findUnique({
    where: { userId_kind_periodKey: where },
    select: { id: true }
  });
  if (existing) {
    return;
  }
  try {
    await prisma.usageCounter.create({ data: { ...where, used: 0 } });
  } catch (error) {
    // Another request created the same period's row first, which is the outcome
    // we wanted anyway.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
      throw error;
    }
  }
}

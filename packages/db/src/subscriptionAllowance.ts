/**
 * What one verified subscription period is worth: the credits each month of it
 * grants and the cash it brought in.
 *
 * **A plan's allowance is granted a month at a time, whatever its billing
 * period.** The yearly plan used to grant its 72,000 credits the day it was
 * bought, so a reader could spend the year in days and refund inside Play's
 * window (launch review, 2026-10-15). An order's paid period is now laid out
 * in calendar months from its start, once, when its first month is granted —
 * the {@link AllowanceSchedule}, stored on every month's grant so a later month
 * never re-derives a boundary from a period end Google may since have moved.
 * Each month grants once, under its own key, and lapses at its end like any
 * monthly allowance. A monthly plan's ordinary period is one month, so nothing
 * changed for it; what changed is a period *longer* than a month, which a plan
 * switch makes: Google adds the old plan's unused value to the new plan's
 * first period as extra time — up to four months of Pro for a year of Creator
 * — and that period used to grant one month's allowance for all of it.
 *
 * What a month grants follows the phase the order paid for:
 *
 * - **An intro period** grants the offer's own `creditAmount`
 *   (`SUBSCRIPTION_INTRO_OFFERS`), not the plan's: the $9.99 first month of
 *   Creator granted all 6,000 credits, $0.00142 a credit after Play's cut.
 * - **A short month of a plan switch** grants its share of a whole month. A
 *   switch Google prorates — `prorationPeriod`, or any replacement
 *   (`linkedPurchaseToken`) whose first period is shorter than a month — was
 *   granted the new plan's whole allowance at once, so an upgrade charged a
 *   few days' difference bought a month of Max. The tail a switch's carried
 *   time leaves after its last whole month is a share of a month too.
 * - **A fresh order's own short period** is Google's to set and is granted in
 *   full: Play's test cycles run a "month" in five minutes.
 *
 * A free trial grants nothing, as it always did: the plan's perks apply and the
 * allowance waits for the first paid period.
 */
import { DEFAULT_BILLING_PRODUCTS, SUBSCRIPTION_INTRO_OFFERS, billingPeriodMonths, jsonRecord } from "@book-maker/core";
import type { VerifiedGooglePlayPurchase } from "./billingSubscriptions.ts";

export type AllowanceBasis = "full" | "free_trial" | "intro_offer" | "prorated";

/** The months one paid order is granted in. */
export type AllowanceSchedule = {
  /** The grant key of the order's first month; later months append `:month:<n>`. */
  orderKey: string;
  /** Month 1 starts here. */
  start: Date;
  /** The paid end the months were laid out against when the order was first granted. */
  end: Date;
  /** What a whole month of this order grants. */
  monthlyCredits: number;
  basis: Exclude<AllowanceBasis, "prorated">;
  /** Whether a short first month is granted its share (a plan switch) or in full (Google's own period). */
  prorateShortMonths: boolean;
};

/** One month of a schedule: when it runs and what it grants. */
export type AllowanceMonth = {
  /** 1-based, counted from the schedule's start. */
  index: number;
  start: Date;
  /** The next month's start, or the paid period's end as Google now reports it for the last month. */
  end: Date;
  /** No later month of this order follows. */
  last: boolean;
  credits: number;
  basis: AllowanceBasis;
  /** The share of a whole month a short month covers. */
  coveredFraction?: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Slack for clock and rounding differences between Google's period and ours: a
 * month short by less is whole, and a tail past the last whole month shorter
 * than this is absorbed by it rather than becoming a month of its own.
 */
const MONTH_SLACK_MS = DAY_MS;
/** A schedule never runs longer than this, whatever a malformed period end says. */
const MAX_MONTHS = 120;

/** Calendar months in one billing period of `sku`, or null for a product with none. */
export function billingMonthsForSku(sku: string): number | null {
  return billingPeriodMonths(DEFAULT_BILLING_PRODUCTS.find((product) => product.sku === sku)?.billingPeriod ?? null);
}

/** The key one month of an order is granted under. Month 1 keeps the order's own key. */
export function allowanceMonthKey(orderKey: string, index: number): string {
  return index <= 1 ? orderKey : `${orderKey}:month:${index}`;
}

/**
 * Lay out the months of an order this verification is the first to grant.
 *
 * Month 1 starts one billing period before the paid end: a renewal starts
 * where the last period ended, and Google reports no other start — its
 * `startTime` is when the subscription began, years ago for a renewal. (A
 * fresh order's own period shorter than that, a test cycle, is then the last
 * month of a layout that began before it, and granted whole.) A plan switch's
 * first order instead starts when the switch did: its period also holds the
 * time Google carried over from the plan it replaced, and that time is months
 * of this plan too. A switch that took effect when the old plan's paid time ran
 * out (a deferred downgrade, `startsAtOldPlanEnd`) carried nothing, and starts
 * one period back like a renewal.
 *
 * Null without a period end: nothing can be laid out, and the caller grants
 * one month against the fallback period instead.
 */
export function newAllowanceSchedule(
  product: { sku: string; creditAmount: number },
  verification: VerifiedGooglePlayPurchase,
  options: { orderKey: string; firstOrder: boolean; startsAtOldPlanEnd: boolean }
): AllowanceSchedule | null {
  const subscription = verification.subscription;
  const end = subscription?.currentPeriodEnd ?? null;
  if (!end) return null;
  const months = billingMonthsForSku(product.sku) ?? 1;
  const reportedStart = subscription?.currentPeriodStart ?? null;
  const isSwitch = subscription?.offerPhase === "proration" || isReplacement(verification);
  const switchStart = isSwitch && options.firstOrder && !options.startsAtOldPlanEnd && reportedStart && reportedStart < end
    ? reportedStart
    : null;
  return {
    orderKey: options.orderKey,
    start: switchStart ?? addMonths(end, -months),
    end,
    ...periodMonthlyCredits(product, verification, months),
    prorateShortMonths: isSwitch
  };
}

/**
 * The month of `schedule` that `now` falls in, clamped to its first and last
 * months. `currentEnd` is the paid end Google reports now: the last month runs
 * to it, so a corrected or grace-extended end slides that month rather than
 * opening another, and no month runs past it.
 */
export function allowanceMonthAt(schedule: AllowanceSchedule, now: Date, currentEnd: Date | null): AllowanceMonth {
  const count = monthCount(schedule.start, schedule.end);
  let index = 1;
  while (index < count && addMonths(schedule.start, index).getTime() <= now.getTime()) index += 1;
  const start = addMonths(schedule.start, index - 1);
  const wholeEnd = addMonths(schedule.start, index);
  const last = index === count;
  const laidOutEnd = last ? schedule.end : wholeEnd;
  const coveredEnd = currentEnd && currentEnd < laidOutEnd ? currentEnd : laidOutEnd;
  const end = last ? (currentEnd ?? schedule.end) : coveredEnd;
  const covered = coveredEnd.getTime() - start.getTime();
  const whole = wholeEnd.getTime() - start.getTime();
  if (covered + MONTH_SLACK_MS >= whole || (index === 1 && !schedule.prorateShortMonths) || schedule.monthlyCredits <= 0) {
    return { index, start, end, last, credits: schedule.monthlyCredits, basis: schedule.basis };
  }
  const fraction = Math.max(0, covered) / whole;
  return {
    index, start, end, last,
    credits: Math.floor(schedule.monthlyCredits * fraction),
    basis: "prorated",
    coveredFraction: fraction
  };
}

/**
 * What one month grants for an order with nothing to lay out: no period end,
 * or an order granted before schedules existed, whose single grant stands for
 * its whole period. A month's allowance, in full.
 */
export function wholePeriodCredits(
  product: { sku: string; creditAmount: number },
  verification: VerifiedGooglePlayPurchase
): { credits: number; basis: AllowanceSchedule["basis"] } {
  const period = periodMonthlyCredits(product, verification, billingMonthsForSku(product.sku) ?? 1);
  return { credits: period.monthlyCredits, basis: period.basis };
}

/** The schedule a grant's metadata recorded, or null for a grant from before schedules. */
export function allowanceScheduleFromMetadata(metadata: unknown): AllowanceSchedule | null {
  const stored = jsonRecord(jsonRecord(metadata).allowanceSchedule);
  const start = typeof stored.start === "string" ? new Date(stored.start) : null;
  const end = typeof stored.end === "string" ? new Date(stored.end) : null;
  const basis = stored.basis;
  if (typeof stored.orderKey !== "string" || !start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) ||
    typeof stored.monthlyCredits !== "number" || (basis !== "full" && basis !== "free_trial" && basis !== "intro_offer")) {
    return null;
  }
  return {
    orderKey: stored.orderKey, start, end, monthlyCredits: stored.monthlyCredits, basis,
    prorateShortMonths: stored.prorateShortMonths === true
  };
}

/** What a month's grant records about where it sits, for the next month and for the audit trail. */
export function allowanceMonthMetadata(schedule: AllowanceSchedule, month: AllowanceMonth): Record<string, unknown> {
  return {
    allowanceSchedule: {
      orderKey: schedule.orderKey,
      start: schedule.start.toISOString(),
      end: schedule.end.toISOString(),
      monthlyCredits: schedule.monthlyCredits,
      basis: schedule.basis,
      prorateShortMonths: schedule.prorateShortMonths
    },
    allowanceMonth: month.index,
    ...(month.basis !== "full" ? { allowanceBasis: month.basis } : {}),
    ...(month.coveredFraction !== undefined ? { coveredFraction: month.coveredFraction } : {})
  };
}

/**
 * The cash one verified period brought in. A trial brought in nothing; an
 * introductory period the offer's price when `SUBSCRIPTION_INTRO_OFFERS` knows
 * the offer, and otherwise the catalog price marked as an estimate.
 */
export function paidPriceMicros(
  product: { sku: string; priceMicros: bigint | null },
  verification: VerifiedGooglePlayPurchase
): { priceMicros: bigint | null; amountSource: string } {
  const phase = verification.subscription?.offerPhase;
  if (phase === "free_trial") {
    return { priceMicros: null, amountSource: "free_trial" };
  }
  if (phase === "introductory") {
    const offer = introOffer(product.sku, verification.subscription?.offerId);
    return offer
      ? { priceMicros: BigInt(offer.priceMicros), amountSource: "intro_offer" }
      : { priceMicros: product.priceMicros, amountSource: "catalog_snapshot_unknown_offer" };
  }
  return { priceMicros: product.priceMicros, amountSource: "catalog_snapshot" };
}

/**
 * `start` plus an ISO 8601 period of days, weeks, months or years, in UTC. A
 * month from the 31st lands on the last day of a shorter month, which is how
 * Google bills it, rather than spilling into the month after.
 */
export function addBillingPeriod(start: Date, period: string): Date | null {
  const match = /^P(\d+)([DWMY])$/.exec(period);
  if (!match) return null;
  const count = Number(match[1]);
  const unit = match[2];
  if (unit === "D" || unit === "W") {
    return new Date(start.getTime() + count * (unit === "W" ? 7 : 1) * DAY_MS);
  }
  return addMonths(start, unit === "Y" ? count * 12 : count);
}

/**
 * `start` moved by whole calendar months (back, when negative), in UTC, the day
 * clamped to the last day of a shorter month. Counted from `start` every time,
 * never step by step, so month 3 of a schedule from the 31st is still the 31st.
 */
export function addMonths(start: Date, months: number): Date {
  const target = new Date(start.getTime());
  const day = target.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

/** How many months `start` → `end` is laid out in: whole months, and a tail longer than the slack. */
function monthCount(start: Date, end: Date): number {
  let count = 1;
  while (count < MAX_MONTHS && addMonths(start, count).getTime() + MONTH_SLACK_MS < end.getTime()) count += 1;
  return count;
}

/** What a whole month of the period grants: nothing in a trial, the offer's share in an intro, the plan's otherwise. */
function periodMonthlyCredits(
  product: { sku: string; creditAmount: number },
  verification: VerifiedGooglePlayPurchase,
  months: number
): { monthlyCredits: number; basis: AllowanceSchedule["basis"] } {
  const subscription = verification.subscription;
  if (subscription?.offerPhase === "free_trial") {
    return { monthlyCredits: 0, basis: "free_trial" };
  }
  const offer = subscription?.offerPhase === "introductory" ? introOffer(product.sku, subscription.offerId) : null;
  const periodCredits = offer ? offer.creditAmount : product.creditAmount;
  return { monthlyCredits: Math.floor(periodCredits / Math.max(1, months)), basis: offer ? "intro_offer" : "full" };
}

function introOffer(sku: string, offerId: string | null | undefined) {
  return SUBSCRIPTION_INTRO_OFFERS.find((entry) => entry.sku === sku && entry.offerId === offerId) ?? null;
}

/** Google links a token to the one it replaced: an upgrade, a downgrade, a re-signup. */
function isReplacement(verification: VerifiedGooglePlayPurchase): boolean {
  const linked = jsonRecord(verification.metadata).linkedPurchaseToken;
  return typeof linked === "string" && linked.trim().length > 0;
}

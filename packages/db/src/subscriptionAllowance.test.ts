import { describe, expect, it } from "vitest";
import {
  addBillingPeriod,
  addMonths,
  allowanceMonthAt,
  allowanceMonthKey,
  allowanceMonthMetadata,
  allowanceScheduleFromMetadata,
  newAllowanceSchedule,
  type AllowanceSchedule
} from "./subscriptionAllowance.ts";
import type { VerifiedGooglePlayPurchase } from "./billingSubscriptions.ts";

const CREATOR = { sku: "tomeza.creator_monthly", creditAmount: 6_000 };
const YEARLY = { sku: "tomeza.creator_yearly", creditAmount: 72_000 };
const NOW = new Date("2026-10-04T00:00:00Z");
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

function verification(
  subscription: NonNullable<VerifiedGooglePlayPurchase["subscription"]>,
  linkedPurchaseToken: string | null = null,
  productSku = CREATOR.sku
) {
  return {
    productSku, purchaseToken: "token", kind: "subscription", grantable: true,
    providerStatus: "SUBSCRIPTION_STATE_ACTIVE", subscription, metadata: { linkedPurchaseToken }
  } satisfies VerifiedGooglePlayPurchase;
}

function schedule(
  product: { sku: string; creditAmount: number },
  subscription: NonNullable<VerifiedGooglePlayPurchase["subscription"]>,
  options: { linked?: string; firstOrder?: boolean; startsAtOldPlanEnd?: boolean } = {}
): AllowanceSchedule {
  const laidOut = newAllowanceSchedule(product, verification(subscription, options.linked ?? null, product.sku), {
    orderKey: "order", firstOrder: options.firstOrder ?? true, startsAtOldPlanEnd: options.startsAtOldPlanEnd ?? false
  });
  if (!laidOut) throw new Error("no schedule");
  return laidOut;
}

describe("a billing period", () => {
  it("lands a month from the 31st on the last day of a shorter month, as Google bills it", () => {
    expect(addBillingPeriod(new Date("2026-01-31T10:00:00Z"), "P1M")?.toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(addBillingPeriod(new Date("2028-02-29T00:00:00Z"), "P1Y")?.toISOString()).toBe("2029-02-28T00:00:00.000Z");
    expect(addBillingPeriod(new Date("2026-10-04T00:00:00Z"), "P1W")?.toISOString()).toBe("2026-10-11T00:00:00.000Z");
    expect(addBillingPeriod(NOW, "monthly")).toBeNull();
  });

  it("counts every month from the start, never from the month before, and back as well as forward", () => {
    expect(addMonths(day("2026-01-31"), 3).toISOString()).toBe("2026-04-30T00:00:00.000Z");
    expect(addMonths(day("2026-01-31"), 2).toISOString()).toBe("2026-03-31T00:00:00.000Z");
    expect(addMonths(day("2027-10-04"), -12).toISOString()).toBe("2026-10-04T00:00:00.000Z");
  });
});

describe("a monthly plan's period", () => {
  const month = { status: "ACTIVE", currentPeriodStart: NOW, currentPeriodEnd: day("2026-11-04") } as const;

  it("is one month: the plan's allowance at full price, nothing for a trial, and the offer's for the intro", () => {
    const at = (subscription: NonNullable<VerifiedGooglePlayPurchase["subscription"]>) =>
      allowanceMonthAt(schedule(CREATOR, subscription), NOW, subscription.currentPeriodEnd ?? null);
    expect(at({ ...month, offerPhase: "base" })).toMatchObject({ index: 1, last: true, credits: 6_000, basis: "full" });
    expect(at({ ...month, offerPhase: "free_trial" })).toMatchObject({ credits: 0, basis: "free_trial" });
    expect(at({ ...month, offerPhase: "introductory", offerId: "creator-intro-first-month" }))
      .toMatchObject({ credits: 4_000, basis: "intro_offer" });
  });

  it("is a renewal one period back from its end, whenever the subscription began", () => {
    const renewal = { ...month, currentPeriodStart: day("2025-03-04"), currentPeriodEnd: day("2026-11-04") };
    const laidOut = schedule(CREATOR, renewal, { firstOrder: false });
    expect(laidOut.start).toEqual(day("2026-10-04"));
    expect(allowanceMonthAt(laidOut, NOW, renewal.currentPeriodEnd)).toMatchObject({ index: 1, last: true, credits: 6_000 });
  });

  it("prorates a short proration period, or a short first period of any replacement", () => {
    const short = { ...month, currentPeriodEnd: new Date("2026-10-19T12:00:00Z") };
    expect(allowanceMonthAt(schedule(CREATOR, { ...short, offerPhase: "proration" }), NOW, short.currentPeriodEnd))
      .toMatchObject({ credits: Math.floor(6_000 * 15.5 / 31), basis: "prorated" });
    expect(allowanceMonthAt(schedule(CREATOR, { ...short, offerPhase: "base" }, { linked: "old-token" }), NOW, short.currentPeriodEnd))
      .toMatchObject({ basis: "prorated" });
    // A brand-new subscription's period is Google's to set (a test cycle is five minutes); only a switch is prorated.
    expect(allowanceMonthAt(schedule(CREATOR, { ...short, offerPhase: "base" }), NOW, short.currentPeriodEnd))
      .toMatchObject({ credits: 6_000, basis: "full" });
  });

  it("grants a switch's carried time a month at a time: the first month whole, then its share of the tail", () => {
    // Upgraded with Google adding 16 days of the old plan's value on top.
    const carried = { ...month, currentPeriodEnd: day("2026-11-20"), offerPhase: "proration" as const };
    const laidOut = schedule(CREATOR, carried, { linked: "old-token" });
    expect(allowanceMonthAt(laidOut, NOW, carried.currentPeriodEnd))
      .toMatchObject({ index: 1, last: false, end: day("2026-11-04"), credits: 6_000, basis: "full" });
    expect(allowanceMonthAt(laidOut, day("2026-11-04"), carried.currentPeriodEnd))
      .toMatchObject({ index: 2, last: true, end: day("2026-11-20"), credits: Math.floor(6_000 * 16 / 30), basis: "prorated" });
  });

  it("absorbs a tail shorter than a day into the last month, and lets the last month run to a moved end", () => {
    const jitter = { ...month, currentPeriodEnd: new Date("2026-11-04T06:00:00Z") };
    const laidOut = schedule(CREATOR, jitter, { linked: "old-token" });
    expect(allowanceMonthAt(laidOut, NOW, jitter.currentPeriodEnd)).toMatchObject({ index: 1, last: true, credits: 6_000 });
    // A grace period moves Google's end: the last month slides, no month opens.
    const graceEnd = day("2026-11-11");
    expect(allowanceMonthAt(laidOut, day("2026-11-05"), graceEnd)).toMatchObject({ index: 1, last: true, end: graceEnd });
  });
});

describe("the yearly plan's period", () => {
  const year = { status: "ACTIVE", currentPeriodStart: NOW, currentPeriodEnd: day("2027-10-04"), offerPhase: "base" } as const;

  it("is twelve months of 6,000, each starting on the purchase's day of the month", () => {
    const laidOut = schedule(YEARLY, year);
    expect(laidOut).toMatchObject({ start: NOW, end: day("2027-10-04"), monthlyCredits: 6_000, basis: "full" });
    expect(allowanceMonthAt(laidOut, NOW, year.currentPeriodEnd))
      .toMatchObject({ index: 1, start: NOW, end: day("2026-11-04"), last: false, credits: 6_000 });
    expect(allowanceMonthAt(laidOut, new Date("2027-02-10T00:00:00Z"), year.currentPeriodEnd))
      .toMatchObject({ index: 5, start: day("2027-02-04"), end: day("2027-03-04"), credits: 6_000 });
    expect(allowanceMonthAt(laidOut, day("2027-09-30"), year.currentPeriodEnd))
      .toMatchObject({ index: 12, start: day("2027-09-04"), end: day("2027-10-04"), last: true, credits: 6_000 });
  });

  it("never runs a month past the paid end, and clips the last month to it", () => {
    const laidOut = schedule(YEARLY, year);
    // Google's end corrected ten days early: month 12 is cut there and grants its share.
    const early = day("2027-09-24");
    expect(allowanceMonthAt(laidOut, day("2027-09-05"), early))
      .toMatchObject({ index: 12, end: early, credits: Math.floor(6_000 * 20 / 30), basis: "prorated" });
    // A month never ends after the paid end, even one that is not the last.
    expect(allowanceMonthAt(laidOut, day("2027-08-05"), day("2027-08-20"))).toMatchObject({ index: 11, end: day("2027-08-20") });
  });

  it("starts a deferred downgrade's first year where the old plan's paid time ran out", () => {
    const deferred = { ...year, currentPeriodStart: day("2026-09-20"), currentPeriodEnd: day("2027-10-04") };
    const laidOut = schedule(YEARLY, deferred, { linked: "max-token", startsAtOldPlanEnd: true });
    expect(laidOut.start).toEqual(NOW);
    expect(allowanceMonthAt(laidOut, NOW, deferred.currentPeriodEnd)).toMatchObject({ index: 1, credits: 6_000 });
  });

  it("round-trips through a grant's metadata and keys every month after the first apart", () => {
    const laidOut = schedule(YEARLY, year);
    const month = allowanceMonthAt(laidOut, day("2027-01-05"), year.currentPeriodEnd);
    expect(allowanceScheduleFromMetadata(allowanceMonthMetadata(laidOut, month))).toEqual(laidOut);
    expect(allowanceMonthMetadata(laidOut, month)).toMatchObject({ allowanceMonth: 4 });
    expect(allowanceScheduleFromMetadata({ planPeriodKey: "sub:x:y" })).toBeNull();
    expect(allowanceMonthKey("order", 1)).toBe("order");
    expect(allowanceMonthKey("order", 4)).toBe("order:month:4");
  });
});

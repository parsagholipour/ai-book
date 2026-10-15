import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CREDIT_COSTS, setCreditPricing } from "@book-maker/core";
import type { VerifiedGooglePlayPurchase } from "./billing.ts";
import { addMonths } from "./subscriptionAllowance.ts";

const db = await vi.hoisted(async () => (await import("./testing/billingTestDb.js")).createBillingTestDb());
vi.mock("./client.ts", () => ({ prisma: db.prisma, Prisma: db.Prisma }));
const {
  getCreditBalance, getPlanSummary, grantCredits, recordGooglePlayRefund, recordVerifiedGooglePlayPurchase,
  resolvePlanTier, spendCredits
} = await import("./billing.ts");

/**
 * The yearly plan grants 6,000 credits each month of its paid year, each
 * month's lapsing at its end (launch review 2026-10-15). Google tells nothing
 * at a month boundary, so these drive the real recording path the way the
 * renewal sweep does: every due state row is re-verified with what Google
 * answers for its token at that moment.
 */
const YEAR_START = new Date("2026-10-04T00:00:00Z");
const YEAR_END = new Date("2027-10-04T00:00:00Z");
const month = (index: number) => addMonths(YEAR_START, index - 1);
const minuteAfter = (date: Date) => new Date(date.getTime() + 60_000);

beforeEach(() => {
  db.reset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(YEAR_START);
  setCreditPricing({ ...DEFAULT_CREDIT_COSTS, welcomeCreditsEnabled: 0, freeMonthlyCredits: 0 });
  db.state.products.set("tomeza.creator_yearly", {
    id: "product-creator-yearly", sku: "tomeza.creator_yearly", title: "Creator yearly", productType: "SUBSCRIPTION",
    creditAmount: 72_000, priceMicros: 179_990_000n, currency: "USD", active: true
  });
  db.state.products.set("tomeza.pro_monthly", {
    id: "product-pro", sku: "tomeza.pro_monthly", title: "Pro", productType: "SUBSCRIPTION",
    creditAmount: 15_000, priceMicros: 39_990_000n, currency: "USD", active: true
  });
  google.clear();
});
afterEach(() => vi.useRealTimers());

type Answer = Partial<Omit<VerifiedGooglePlayPurchase, "subscription">> & {
  subscription?: Partial<NonNullable<VerifiedGooglePlayPurchase["subscription"]>>;
};

function subscription(sku: string, token: string, order: string | null, answer: Answer & { linked?: string } = {}): VerifiedGooglePlayPurchase {
  const { subscription: period, linked, ...rest } = answer;
  return {
    productSku: sku, purchaseToken: token, kind: "subscription", grantable: true,
    providerStatus: "SUBSCRIPTION_STATE_ACTIVE", externalPurchaseId: order,
    subscription: { status: "ACTIVE", autoRenewing: true, currentPeriodStart: YEAR_START, currentPeriodEnd: YEAR_END, offerPhase: "base", ...period },
    metadata: { linkedPurchaseToken: linked ?? null },
    ...rest
  };
}
const yearly = (answer: Answer & { linked?: string } = {}) =>
  subscription("tomeza.creator_yearly", "yearly-token", "order-yearly", answer);
const expiredYearly = (end: Date) =>
  yearly({ grantable: false, providerStatus: "SUBSCRIPTION_STATE_EXPIRED", subscription: { status: "EXPIRED", currentPeriodEnd: end } });

const record = (verification: VerifiedGooglePlayPurchase) =>
  recordVerifiedGooglePlayPurchase({ userId: "user-a", verification });

/** What Google answers for each token right now. */
const google = new Map<string, () => VerifiedGooglePlayPurchase>();

/** The renewal sweep at `now`: every due row is re-verified with Google's answer for its token. */
async function sweep(now: Date): Promise<number> {
  vi.setSystemTime(now);
  const due = [...db.state.subscriptions.values()].filter((row) =>
    row.purchaseToken && ["ACTIVE", "GRACE_PERIOD", "CANCELED", "PAUSED"].includes(row.status) &&
    row.nextCreditGrantAt !== null && row.nextCreditGrantAt <= now);
  for (const row of due) {
    const answer = google.get(row.purchaseToken!);
    if (answer) await record(answer());
  }
  return due.length;
}

const grants = () => [...db.state.ledger.values()].filter((entry) =>
  entry.entryType === "GRANT" && entry.operation === "SUBSCRIPTION_CREDIT_GRANT");
const stateOf = (token: string) => [...db.state.subscriptions.values()].find((row) => row.purchaseToken === token);
const planCredits = async () => (await getCreditBalance("user-a")).planCredits;

describe("the yearly plan, granted a month at a time", () => {
  it("grants 6,000 at purchase and 6,000 at each month the sweep wakes for, twelve times in the paid year", async () => {
    await grantCredits({ userId: "user-a", amountCredits: 1_000, idempotencyKey: "pack" });
    google.set("yearly-token", () => yearly());
    const bought = await record(yearly());
    expect(bought).toMatchObject({ status: "GRANTED", creditsGranted: 6_000, entitlementType: "CREATOR_PLAN" });
    expect(await getCreditBalance("user-a")).toMatchObject({
      planCredits: 6_000, planCreditsPerPeriod: 6_000, planPeriodEnd: month(2), purchasedCredits: 1_000
    });
    // The plan runs the year; the allowance runs the month, and the sweep is due when the next one starts.
    expect(await getPlanSummary("user-a")).toMatchObject({ tier: "creator", productSku: "tomeza.creator_yearly", renewsAt: YEAR_END });
    expect(stateOf("yearly-token")).toMatchObject({ currentPeriodEnd: YEAR_END, nextCreditGrantAt: month(2) });
    await spendCredits({ userId: "user-a", amountCredits: 2_000, operation: "FULL_BOOK_GENERATION", idempotencyKey: "book-1" });

    for (let index = 2; index <= 12; index += 1) {
      expect(await sweep(new Date(month(index).getTime() - 60_000))).toBe(0);
      await sweep(minuteAfter(month(index)));
      expect(await planCredits()).toBe(6_000);
      expect(stateOf("yearly-token")?.nextCreditGrantAt).toEqual(index < 12 ? month(index + 1) : YEAR_END);
    }
    expect(grants().map((grant) => grant.amountCredits)).toEqual(Array(12).fill(6_000));
    expect(grants().map((grant) => grant.idempotencyKey.replace(/^.*order-yearly/, "")))
      .toEqual(["", ...Array.from({ length: 11 }, (_, index) => `:month:${index + 2}`)]);
    expect([...db.state.purchases.values()][0]?.creditsGranted).toBe(72_000);
    // Each month's leftover lapsed at its end, exactly like a monthly plan's.
    expect([...db.state.ledger.values()].filter((entry) => entry.description === "Unused monthly allowance expired")
      .map((entry) => entry.amountCredits)).toEqual([-4_000, ...Array(10).fill(-6_000)]);
    // The pool that never expires is not touched by any of it.
    expect((await getCreditBalance("user-a")).purchasedCredits).toBe(1_000);
    // Nothing more inside the year, then the renewal is the next year's first month.
    expect(await sweep(new Date(YEAR_END.getTime() - 60_000))).toBe(0);
    google.set("yearly-token", () => yearly({ externalPurchaseId: "order-yearly..0", subscription: { currentPeriodEnd: addMonths(YEAR_END, 12) } }));
    await sweep(minuteAfter(YEAR_END));
    expect(grants()).toHaveLength(13);
    expect(stateOf("yearly-token")?.nextCreditGrantAt).toEqual(addMonths(YEAR_END, 1));
  });

  it("grants a month once however many verifications race over it, and nothing more inside it", async () => {
    await record(yearly());
    vi.setSystemTime(new Date("2026-12-10T00:00:00Z"));
    // The app's verify, the sweep and an RTDN, all in month 3.
    await Promise.all([record(yearly()), record(yearly()), record(yearly())]);
    await spendCredits({ userId: "user-a", amountCredits: 500, operation: "FULL_BOOK_GENERATION", idempotencyKey: "book" });
    await record(yearly());
    expect(grants().map((grant) => grant.idempotencyKey.replace(/^.*order-yearly/, ""))).toEqual(["", ":month:3"]);
    expect(await planCredits()).toBe(5_500);
  });

  it("clips the paid year's last month to the period end Google reports", async () => {
    await record(yearly());
    const correctedEnd = new Date("2027-09-24T00:00:00Z");
    google.set("yearly-token", () => yearly({ subscription: { currentPeriodEnd: correctedEnd } }));
    await sweep(minuteAfter(month(12)));
    // September 4 → 24 of a 30-day month.
    expect(grants().at(-1)?.amountCredits).toBe(4_000);
    expect(await getCreditBalance("user-a")).toMatchObject({ planCredits: 4_000, planPeriodEnd: correctedEnd });
    expect(stateOf("yearly-token")?.nextCreditGrantAt).toEqual(correctedEnd);
  });

  it("keeps granting a cancelled plan every month until its paid year ends, then nothing", async () => {
    await record(yearly());
    const cancelled = () => yearly({ providerStatus: "SUBSCRIPTION_STATE_CANCELED", subscription: { status: "CANCELED", autoRenewing: false } });
    vi.setSystemTime(new Date("2026-11-10T00:00:00Z"));
    await record(cancelled());
    expect(await getPlanSummary("user-a")).toMatchObject({ cancelAtPeriodEnd: true, endsAt: YEAR_END });
    google.set("yearly-token", cancelled);
    for (let index = 3; index <= 12; index += 1) await sweep(minuteAfter(month(index)));
    expect(grants()).toHaveLength(12);
    expect(await planCredits()).toBe(6_000);

    google.set("yearly-token", () => expiredYearly(YEAR_END));
    await sweep(minuteAfter(YEAR_END));
    expect(await resolvePlanTier("user-a")).toBe("free");
    expect(await planCredits()).toBe(0);
    expect(stateOf("yearly-token")).toMatchObject({ status: "EXPIRED", nextCreditGrantAt: null });
    expect(await sweep(minuteAfter(addMonths(YEAR_END, 1)))).toBe(0);
    expect(grants()).toHaveLength(12);
  });

  it("reverses every month a refunded order granted, keeps what was spent as debt, and grants no more", async () => {
    google.set("yearly-token", () => yearly());
    await record(yearly());
    await spendCredits({ userId: "user-a", amountCredits: 4_000, operation: "FULL_BOOK_GENERATION", idempotencyKey: "m1" });
    await sweep(minuteAfter(month(2)));
    await spendCredits({ userId: "user-a", amountCredits: 6_000, operation: "FULL_BOOK_GENERATION", idempotencyKey: "m2" });
    await sweep(minuteAfter(month(3)));
    await spendCredits({ userId: "user-a", amountCredits: 1_000, operation: "FULL_BOOK_GENERATION", idempotencyKey: "m3" });

    await recordGooglePlayRefund({ purchaseToken: "yearly-token", orderId: "order-yearly", productType: 1 });
    // Month 1's 2,000 lapsed unspent and month 3's 5,000 is still unspent: only the 11,000 spent is owed.
    expect(await getCreditBalance("user-a")).toMatchObject({ planCredits: 0, purchasedCredits: -11_000 });
    expect([...db.state.ledger.values()].filter((entry) => entry.reversesEntryId).map((entry) => entry.amountCredits))
      .toEqual([-4_000, -6_000, -6_000]);
    expect(await resolvePlanTier("user-a")).toBe("free");
    expect(stateOf("yearly-token")).toMatchObject({ status: "EXPIRED", nextCreditGrantAt: null });

    expect(await sweep(minuteAfter(month(4)))).toBe(0);
    expect(await record(yearly())).toMatchObject({ status: "REVOKED", ledgerEntryId: null });
    expect(grants()).toHaveLength(3);
  });
});

describe("a plan switch to or from the yearly plan", () => {
  it("forfeits only the month in hand when upgrading to Pro, and grants Pro's carried time month by month", async () => {
    google.set("yearly-token", () => yearly());
    await record(yearly());
    for (let index = 2; index <= 4; index += 1) await sweep(minuteAfter(month(index)));
    vi.setSystemTime(new Date("2027-01-10T00:00:00Z"));
    await spendCredits({ userId: "user-a", amountCredits: 1_000, operation: "FULL_BOOK_GENERATION", idempotencyKey: "book" });

    // Charged Pro's full price; Google adds the year's unused value as about four more months of Pro.
    const pro = () => subscription("tomeza.pro_monthly", "pro-token", "order-pro", {
      linked: "yearly-token",
      subscription: { currentPeriodStart: new Date("2027-01-10T00:00:00Z"), currentPeriodEnd: new Date("2027-05-22T00:00:00Z") }
    });
    expect(await record(pro())).toMatchObject({ creditsGranted: 15_000, entitlementType: "PRO_PLAN" });
    expect(await resolvePlanTier("user-a")).toBe("pro");
    expect([...db.state.ledger.values()].filter((entry) => entry.description === "Unused monthly allowance expired")
      .map((entry) => entry.amountCredits).at(-1)).toBe(-5_000);
    expect(stateOf("yearly-token")).toMatchObject({ status: "EXPIRED", nextCreditGrantAt: null });

    google.set("pro-token", pro);
    for (const due of ["2027-02-10", "2027-03-10", "2027-04-10", "2027-05-10"]) await sweep(minuteAfter(new Date(`${due}T00:00:00Z`)));
    // May 10 → 22 of a 31-day month.
    expect(grants().filter((grant) => grant.amountCredits !== 6_000).map((grant) => grant.amountCredits))
      .toEqual([15_000, 15_000, 15_000, 15_000, Math.floor(15_000 * 12 / 31)]);
    expect(grants().filter((grant) => grant.amountCredits === 6_000)).toHaveLength(4);
  });

  it("keeps granting the paid year's months from the new token after a deferred downgrade, then switches at the renewal", async () => {
    google.set("yearly-token", () => yearly());
    await record(yearly());
    for (let index = 2; index <= 4; index += 1) await sweep(minuteAfter(month(index)));
    vi.setSystemTime(new Date("2027-01-10T00:00:00Z"));
    const downgrade = () => subscription("tomeza.creator_monthly", "creator-token", null, {
      linked: "yearly-token",
      subscription: {
        currentPeriodStart: new Date("2027-01-10T00:00:00Z"), currentPeriodEnd: YEAR_END, offerPhase: null,
        deferredReplacement: { fromProductSku: "tomeza.creator_yearly", takesEffectAt: YEAR_END }
      }
    });
    expect(await record(downgrade())).toMatchObject({ creditsGranted: 0, scheduledChange: { productSku: "tomeza.creator_monthly", startsAt: YEAR_END } });
    expect(await getPlanSummary("user-a")).toMatchObject({
      productSku: "tomeza.creator_yearly", pendingChange: { productSku: "tomeza.creator_monthly", startsAt: YEAR_END }
    });
    // The old token is closed; the new one is polled at the year's next month.
    expect(stateOf("yearly-token")).toMatchObject({ status: "EXPIRED", nextCreditGrantAt: null });
    expect(stateOf("creator-token")?.nextCreditGrantAt).toEqual(month(5));

    google.set("creator-token", downgrade);
    for (let index = 5; index <= 12; index += 1) {
      await sweep(minuteAfter(month(index)));
      expect(await planCredits()).toBe(6_000);
    }
    expect(grants().filter((grant) => grant.purchaseRecordId === "purchase-1")).toHaveLength(12);
    expect(stateOf("creator-token")?.nextCreditGrantAt).toEqual(YEAR_END);

    google.set("creator-token", () => subscription("tomeza.creator_monthly", "creator-token", "order-creator-1", {
      linked: "yearly-token",
      subscription: { currentPeriodStart: new Date("2027-01-10T00:00:00Z"), currentPeriodEnd: addMonths(YEAR_END, 1) }
    }));
    await sweep(minuteAfter(YEAR_END));
    expect(await resolvePlanTier("user-a")).toBe("creator");
    expect(await getCreditBalance("user-a")).toMatchObject({ planCredits: 6_000, planPeriodEnd: addMonths(YEAR_END, 1) });
    expect(await getPlanSummary("user-a")).toMatchObject({ productSku: "tomeza.creator_monthly", renewsAt: addMonths(YEAR_END, 1) });
    expect(grants()).toHaveLength(13);
  });

  it("stops the carried months and takes the plan down when the yearly order is refunded during the downgrade", async () => {
    await record(yearly());
    vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    const downgrade = () => subscription("tomeza.creator_monthly", "creator-token", null, {
      linked: "yearly-token",
      subscription: {
        currentPeriodStart: new Date("2026-10-20T00:00:00Z"), currentPeriodEnd: YEAR_END, offerPhase: null,
        deferredReplacement: { fromProductSku: "tomeza.creator_yearly", takesEffectAt: YEAR_END }
      }
    });
    await record(downgrade());
    await recordGooglePlayRefund({ purchaseToken: "yearly-token", orderId: "order-yearly", productType: 1 });
    expect(await resolvePlanTier("user-a")).toBe("free");
    expect(await planCredits()).toBe(0);

    google.set("creator-token", downgrade);
    await sweep(minuteAfter(month(2)));
    expect(await resolvePlanTier("user-a")).toBe("free");
    expect(grants()).toHaveLength(1);
  });

  it("starts the year of a downgrade to the yearly plan where the old plan's paid time ran out", async () => {
    const max = subscription("tomeza.max_monthly", "max-token", "order-max", { subscription: { currentPeriodEnd: new Date("2026-11-04T00:00:00Z") } });
    await record(max);
    vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    const takesEffectAt = new Date("2026-11-04T00:00:00Z");
    await record(yearly({
      externalPurchaseId: null, linked: "max-token",
      subscription: {
        currentPeriodStart: new Date("2026-10-20T00:00:00Z"), currentPeriodEnd: takesEffectAt, offerPhase: null,
        deferredReplacement: { fromProductSku: "tomeza.max_monthly", takesEffectAt }
      }
    }));
    expect(await resolvePlanTier("user-a")).toBe("max");

    vi.setSystemTime(new Date("2026-11-04T01:00:00Z"));
    const firstYear = await record(yearly({
      linked: "max-token",
      subscription: { currentPeriodStart: new Date("2026-10-20T00:00:00Z"), currentPeriodEnd: new Date("2027-11-04T00:00:00Z") }
    }));
    expect(firstYear).toMatchObject({ creditsGranted: 6_000, entitlementType: "CREATOR_PLAN" });
    expect(await resolvePlanTier("user-a")).toBe("creator");
    expect(await getCreditBalance("user-a")).toMatchObject({ planCredits: 6_000, planPeriodEnd: new Date("2026-12-04T00:00:00Z") });
    expect(stateOf("yearly-token")?.nextCreditGrantAt).toEqual(new Date("2026-12-04T00:00:00Z"));
  });

  it("starts the year at an upgrade from Creator monthly, and grants the carried tail its share of a month", async () => {
    await record(subscription("tomeza.creator_monthly", "creator-token", "order-creator", { subscription: { currentPeriodEnd: new Date("2026-11-04T00:00:00Z") } }));
    const switchedAt = new Date("2026-10-19T00:00:00Z");
    vi.setSystemTime(switchedAt);
    // Full price now; the old month's sixteen unused days are added to the year as about twelve.
    const upgraded = () => yearly({ linked: "creator-token", subscription: { currentPeriodStart: switchedAt, currentPeriodEnd: new Date("2027-10-31T00:00:00Z") } });
    expect(await record(upgraded())).toMatchObject({ creditsGranted: 6_000 });
    expect(await getCreditBalance("user-a")).toMatchObject({ planCredits: 6_000, planPeriodEnd: new Date("2026-11-19T00:00:00Z") });

    google.set("yearly-token", upgraded);
    await sweep(minuteAfter(new Date("2027-10-19T00:00:00Z")));
    // October 19 → 31 of a 31-day month.
    expect(grants().at(-1)).toMatchObject({ amountCredits: Math.floor(6_000 * 12 / 31) });
    expect(grants().at(-1)?.idempotencyKey).toMatch(/:month:13$/);
  });

  it("keeps granting the paid year's months when the old token's expiry is recorded before the downgrade's new token", async () => {
    google.set("yearly-token", () => yearly());
    await record(yearly());
    for (let index = 2; index <= 4; index += 1) await sweep(minuteAfter(month(index)));
    vi.setSystemTime(new Date("2027-01-10T00:00:00Z"));
    google.set("yearly-token", () => expiredYearly(new Date("2027-01-10T00:00:00Z")));
    await record(expiredYearly(new Date("2027-01-10T00:00:00Z")));
    expect(await resolvePlanTier("user-a")).toBe("creator");
    expect(stateOf("yearly-token")).toMatchObject({ status: "CANCELED", currentPeriodEnd: YEAR_END, nextCreditGrantAt: month(5) });

    // The new token has not been recorded by the next month: the old row is still polled, and its month is paid for.
    await sweep(minuteAfter(month(5)));
    expect(await planCredits()).toBe(6_000);
    expect(grants()).toHaveLength(5);

    vi.setSystemTime(new Date("2027-02-10T00:00:00Z"));
    const downgrade = () => subscription("tomeza.creator_monthly", "creator-token", null, {
      linked: "yearly-token",
      subscription: {
        currentPeriodStart: new Date("2027-01-10T00:00:00Z"), currentPeriodEnd: YEAR_END, offerPhase: null,
        deferredReplacement: { fromProductSku: "tomeza.creator_yearly", takesEffectAt: YEAR_END }
      }
    });
    await record(downgrade());
    expect(stateOf("yearly-token")).toMatchObject({ status: "EXPIRED", nextCreditGrantAt: null });
    expect(stateOf("creator-token")?.nextCreditGrantAt).toEqual(month(6));
    google.set("creator-token", downgrade);
    await sweep(minuteAfter(month(6)));
    expect(grants()).toHaveLength(6);
    expect(await resolvePlanTier("user-a")).toBe("creator");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CREDIT_COSTS, resetCreditPricing, setCreditPricing } from "@book-maker/core";

const fakeDb = await vi.hoisted(async () => (await import("./testing/billingTestDb.js")).createBillingTestDb());

vi.mock("./client.ts", () => ({
  prisma: fakeDb.prisma,
  Prisma: fakeDb.Prisma
}));

const {
  commitReservedCredits,
  consumeIllustratedBookUse,
  endSubscriptionNow,
  ensureCurrentPlanPeriod,
  getBookPageLimit,
  getCreditBalance,
  getImageQuota,
  getPlanSummary,
  grantCredits,
  refundCreditLedgerEntry,
  refundCreditLedgerEntryPortion,
  releaseIllustratedBookUse,
  reserveCredits,
  resolvePlanTier
} = await import("./billing.js");

/** A live period we seed so pool-mechanics tests do not depend on a free grant. */
const ALLOWANCE = 1000;
const JUNE = new Date("2026-06-15T12:00:00.000Z");
const JULY = new Date("2026-07-04T12:00:00.000Z");
const JUNE_START = new Date("2026-06-01T00:00:00.000Z");
const JULY_START = new Date("2026-07-01T00:00:00.000Z");

function seedLivePaidPeriod(
  userId: string,
  options: { planCredits?: number; purchased?: number } = {}
): void {
  const existing = fakeDb.state.accounts.get(userId);
  const planCredits = options.planCredits ?? ALLOWANCE;
  const purchased = options.purchased ?? existing?.availableCredits ?? 0;
  fakeDb.state.accounts.set(userId, {
    userId,
    availableCredits: purchased,
    reservedCredits: existing?.reservedCredits ?? 0,
    lifetimeCreditsGranted: existing?.lifetimeCreditsGranted ?? planCredits + purchased,
    lifetimeCreditsSpent: existing?.lifetimeCreditsSpent ?? 0,
    planCredits,
    planCreditsPerPeriod: ALLOWANCE,
    planPeriodStart: JUNE_START,
    planPeriodEnd: JULY_START,
    planPeriodKey: "sub:test:2026-07-01"
  });
}

describe("monthly plan allowance", () => {
  beforeEach(() => {
    fakeDb.reset();
    resetCreditPricing();
  });

  it("retires an already-granted free allowance once while preserving welcome/purchased credits and holds", async () => {
    seedLivePaidPeriod("user-a", { planCredits: 600, purchased: 750 });
    const legacy = fakeDb.state.accounts.get("user-a")!;
    legacy.planPeriodKey = "free:2026-06";
    legacy.reservedCredits = 100;
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, freeMonthlyCredits: 1000 });

    await ensureCurrentPlanPeriod("user-a", JUNE);
    await ensureCurrentPlanPeriod("user-a", JUNE);
    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      availableCredits: 750, purchasedCredits: 750, planCredits: 0, planCreditsPerPeriod: 0, reservedCredits: 100
    });
    const adjustments = [...fakeDb.state.ledger.values()].filter((entry) => entry.entryType === "ADJUSTMENT");
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]).toMatchObject({ amountCredits: -600, planCreditsDelta: -600, balanceAfterCredits: 750 });

    // A late refund of previously admitted work cannot revive the old allowance.
    fakeDb.state.accounts.get("user-a")!.planCredits = 600;
    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({ availableCredits: 750, planCredits: 0 });
    expect([...fakeDb.state.ledger.values()].filter((entry) => entry.entryType === "ADJUSTMENT")).toHaveLength(2);
  });

  it("never grants a free monthly allowance, including after month rollover", async () => {
    await ensureCurrentPlanPeriod("user-a", JUNE);
    await ensureCurrentPlanPeriod("user-a", new Date("2026-06-28T09:00:00.000Z"));

    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      availableCredits: DEFAULT_CREDIT_COSTS.freeMonthlyCredits,
      planCredits: DEFAULT_CREDIT_COSTS.freeMonthlyCredits,
      planCreditsPerPeriod: DEFAULT_CREDIT_COSTS.freeMonthlyCredits,
      purchasedCredits: 0
    });
    const grants = [...fakeDb.state.ledger.values()].filter(
      (entry) => entry.operation === "PLAN_ALLOWANCE_GRANT" && entry.entryType === "GRANT"
    );
    expect(grants).toHaveLength(0);
    expect(await getCreditBalance("user-a", JULY)).toMatchObject({ availableCredits: 0, planCredits: 0 });
    expect(await resolvePlanTier("user-a", JUNE)).toBe("free");
  });

  it("expires a paid allowance without granting a free replacement", async () => {
    seedLivePaidPeriod("user-a");
    await reserveCredits({
      userId: "user-a",
      operation: "EXPORT_UNLOCK",
      amountCredits: 400,
      idempotencyKey: "reserve:june",
      now: JUNE
    });
    await ensureCurrentPlanPeriod("user-a", JULY);

    // Unused paid credits expire; the free plan has no replacement grant.
    expect(await getCreditBalance("user-a", JULY)).toMatchObject({
      planCredits: 0,
      availableCredits: 0
    });
    const forfeiture = [...fakeDb.state.ledger.values()].find((entry) => entry.entryType === "ADJUSTMENT");
    expect(forfeiture).toMatchObject({ amountCredits: -(ALLOWANCE - 400), planCreditsDelta: -(ALLOWANCE - 400) });
  });

  it("treats a lapsed subscriber's leftover allowance as already gone", async () => {
    // A paid period that ran out before the renewal was verified. The entitlement
    // is still active, so nothing re-grants — and last period's credits must not
    // be spendable in the meantime.
    fakeDb.state.accounts.set("user-a", {
      userId: "user-a",
      availableCredits: 200,
      reservedCredits: 0,
      lifetimeCreditsGranted: 6000,
      lifetimeCreditsSpent: 0,
      planCredits: 5000,
      planCreditsPerPeriod: 6000,
      planPeriodStart: new Date("2026-05-15T00:00:00.000Z"),
      planPeriodEnd: new Date("2026-06-15T00:00:00.000Z"),
      planPeriodKey: "sub:token:2026-06-15T00:00:00.000Z"
    });
    fakeDb.state.entitlements.set("entitlement-plan", {
      id: "entitlement-plan",
      userId: "user-a",
      projectId: null,
      type: "CREATOR_PLAN",
      status: "ACTIVE",
      source: "google_play_subscription",
      creditsCost: 0,
      relatedLedgerEntryId: null,
      purchaseRecordId: null,
      startsAt: new Date("2026-05-15T00:00:00.000Z"),
      expiresAt: new Date("2026-06-20T00:00:00.000Z")
    });

    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      planCredits: 0,
      purchasedCredits: 200,
      availableCredits: 200
    });
  });

  it("spends the allowance before purchased credits", async () => {
    seedLivePaidPeriod("user-a");
    await grantCredits({ userId: "user-a", amountCredits: 500, idempotencyKey: "grant:purchased" });
    const reservation = await reserveCredits({
      userId: "user-a",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: ALLOWANCE + 200,
      idempotencyKey: "reserve:straddle",
      now: JUNE
    });

    // The allowance goes first, because it is the pool that expires.
    expect(reservation).toMatchObject({ amountCredits: -(ALLOWANCE + 200), planCreditsDelta: -ALLOWANCE });
    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      planCredits: 0,
      purchasedCredits: 300,
      availableCredits: 300,
      reservedCredits: ALLOWANCE + 200
    });
  });

  it("returns a same-period refund to the pool it came from", async () => {
    seedLivePaidPeriod("user-a");
    const reservation = await reserveCredits({
      userId: "user-a",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: 600,
      idempotencyKey: "reserve:same-period",
      now: JUNE
    });
    const spend = await commitReservedCredits(reservation!.id);
    await refundCreditLedgerEntry(spend.id, "Generation failed", JUNE);

    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      planCredits: ALLOWANCE,
      purchasedCredits: 0
    });
  });

  it("puts a straddling settled charge back into both pools it was drawn from", async () => {
    // The allowance share is only *part* of this charge, so only that part may
    // return to the allowance; the rest was purchased and goes back to the pool
    // that cannot expire. The settled reversal derives that split itself — it is
    // cumulative, so it has to — and this pins the answer it gives when nothing
    // has been given back yet.
    seedLivePaidPeriod("user-a");
    await grantCredits({ userId: "user-a", amountCredits: 500, idempotencyKey: "grant:straddle-refund" });
    const reservation = await reserveCredits({
      userId: "user-a",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: ALLOWANCE + 200,
      idempotencyKey: "reserve:straddle-refund",
      now: JUNE
    });
    const spend = await commitReservedCredits(reservation!.id);
    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      planCredits: 0,
      purchasedCredits: 300,
      lifetimeCreditsSpent: ALLOWANCE + 200
    });

    const reversal = await refundCreditLedgerEntry(spend.id, "Generation failed", JUNE);

    expect(reversal).toMatchObject({
      entryType: "REFUND",
      amountCredits: ALLOWANCE + 200,
      planCreditsDelta: ALLOWANCE,
      // The spendable balance the moment this row was written: 300 purchased,
      // plus everything coming back.
      balanceAfterCredits: ALLOWANCE + 500
    });
    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      planCredits: ALLOWANCE,
      purchasedCredits: 500,
      availableCredits: ALLOWANCE + 500,
      lifetimeCreditsSpent: 0
    });
  });

  it("releases a held reservation back to the allowance within the period", async () => {
    seedLivePaidPeriod("user-a");
    const reservation = await reserveCredits({
      userId: "user-a",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: 250,
      idempotencyKey: "reserve:held",
      now: JUNE
    });
    const released = await refundCreditLedgerEntry(reservation!.id, "Could not be queued", JUNE);

    expect(released).toMatchObject({ entryType: "RELEASE", planCreditsDelta: 0 });
    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      planCredits: ALLOWANCE,
      reservedCredits: 0
    });
  });

  it("routes a refund to the purchased pool once the period has rolled over", async () => {
    seedLivePaidPeriod("user-a");
    const reservation = await reserveCredits({
      userId: "user-a",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: 600,
      idempotencyKey: "reserve:old-period",
      now: JUNE
    });
    const spend = await commitReservedCredits(reservation!.id);
    await ensureCurrentPlanPeriod("user-a", JULY);
    await refundCreditLedgerEntry(spend.id, "Generation failed", JULY);

    // No free July allowance; the paid June refund lands where it cannot expire.
    expect(await getCreditBalance("user-a", JULY)).toMatchObject({
      planCredits: 0,
      purchasedCredits: 600,
      availableCredits: 600
    });
  });

  it("keeps cumulative partial top-ups in the correct period pools", async () => {
    seedLivePaidPeriod("user-a");
    await grantCredits({ userId: "user-a", amountCredits: 200, idempotencyKey: "grant:partial-periods" });
    const reservation = await reserveCredits({
      userId: "user-a",
      operation: "PAGE_REGENERATION",
      amountCredits: ALLOWANCE + 200,
      idempotencyKey: "reserve:partial-periods",
      now: JUNE
    });
    const spend = await commitReservedCredits(reservation!.id);

    await refundCreditLedgerEntryPortion({
      entryId: spend.id,
      amountCredits: 400,
      reason: "June shortfall",
      idempotencyKey: "shortfall:june",
      now: JUNE
    });
    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      planCredits: 400,
      purchasedCredits: 0,
      lifetimeCreditsSpent: ALLOWANCE - 200
    });

    await ensureCurrentPlanPeriod("user-a", JULY);
    await refundCreditLedgerEntry(spend.id, "Later full failure", JULY);
    expect(await getCreditBalance("user-a", JULY)).toMatchObject({
      planCredits: 0,
      purchasedCredits: ALLOWANCE - 200,
      lifetimeCreditsSpent: 0
    });
  });

  it("refunds pre-migration entries entirely to the purchased pool", async () => {
    seedLivePaidPeriod("user-a");
    await grantCredits({ userId: "user-a", amountCredits: 900, idempotencyKey: "grant:legacy" });
    const legacy = await reserveCredits({
      userId: "user-a",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: 300,
      idempotencyKey: "reserve:legacy",
      now: JUNE
    });
    // A row written before the pools existed carries no allowance portion.
    const stored = fakeDb.state.ledger.get(legacy!.id)!;
    stored.planCreditsDelta = 0;
    stored.metadata = {};

    // All of it goes to the purchased pool and the live allowance is left exactly
    // as it was, which is the right reading of "this never touched the allowance".
    await refundCreditLedgerEntry(legacy!.id, "Released", JUNE);
    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      purchasedCredits: 1200,
      planCredits: ALLOWANCE - 300
    });
  });
});

describe("ending a subscription", () => {
  beforeEach(() => {
    fakeDb.reset();
    resetCreditPricing();
  });

  const CANCEL_DAY = new Date("2026-06-20T09:00:00.000Z");
  const SUB_PERIOD_KEY = "sub:token-hash:2026-07-05T00:00:00.000Z";

  /** A live Creator subscription: state row, entitlement, and its plan period. */
  function subscribe(options: { planCredits: number }) {
    fakeDb.state.subscriptions.set("subscription-1", {
      id: "subscription-1",
      userId: "user-a",
      productId: "product-creator",
      provider: "GOOGLE_PLAY",
      externalSubscriptionId: "token-hash",
      purchaseToken: "raw-play-token",
      status: "ACTIVE",
      creditsPerPeriod: 6000,
      currentPeriodStart: new Date("2026-06-05T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-07-05T00:00:00.000Z"),
      nextCreditGrantAt: new Date("2026-07-05T00:00:00.000Z"),
      autoRenewing: true,
      canceledAt: null,
      metadata: {}
    });
    fakeDb.state.entitlements.set("entitlement-plan", {
      id: "entitlement-plan",
      userId: "user-a",
      projectId: null,
      type: "CREATOR_PLAN",
      status: "ACTIVE",
      source: "google_play_subscription",
      creditsCost: 0,
      relatedLedgerEntryId: null,
      purchaseRecordId: null,
      startsAt: new Date("2026-06-05T00:00:00.000Z"),
      expiresAt: new Date("2026-07-05T00:00:00.000Z")
    });
    const existing = fakeDb.state.accounts.get("user-a");
    fakeDb.state.accounts.set("user-a", {
      userId: "user-a",
      availableCredits: existing?.availableCredits ?? 0,
      reservedCredits: 0,
      lifetimeCreditsGranted: existing?.lifetimeCreditsGranted ?? 0,
      lifetimeCreditsSpent: 0,
      planCredits: options.planCredits,
      planCreditsPerPeriod: 6000,
      planPeriodStart: new Date("2026-06-05T00:00:00.000Z"),
      planPeriodEnd: new Date("2026-07-05T00:00:00.000Z"),
      planPeriodKey: SUB_PERIOD_KEY
    });
  }

  it("drops the plan, the token and the paid allowance in one move", async () => {
    subscribe({ planCredits: 5200 });
    await grantCredits({ userId: "user-a", amountCredits: 800, idempotencyKey: "grant:purchased" });

    const result = await endSubscriptionNow("user-a", CANCEL_DAY);

    expect(result).toMatchObject({ ended: true, endedSubscriptionIds: ["subscription-1"] });
    expect(await resolvePlanTier("user-a", CANCEL_DAY)).toBe("free");
    // The token is what the mock verifier would answer ACTIVE to forever, so the
    // next refresh or renewal sweep must find nothing to re-verify.
    expect(fakeDb.state.subscriptions.get("subscription-1")).toMatchObject({
      status: "EXPIRED",
      purchaseToken: null,
      autoRenewing: false,
      canceledAt: CANCEL_DAY,
      nextCreditGrantAt: null
    });
    expect(fakeDb.state.entitlements.get("entitlement-plan")).toMatchObject({ status: "EXPIRED", expiresAt: CANCEL_DAY });
    // Cancellation adopts a zero-credit free period. Purchased credits survive.
    expect(await getCreditBalance("user-a", CANCEL_DAY)).toMatchObject({
      planCredits: DEFAULT_CREDIT_COSTS.freeMonthlyCredits,
      planCreditsPerPeriod: DEFAULT_CREDIT_COSTS.freeMonthlyCredits,
      purchasedCredits: 800
    });
    const forfeiture = [...fakeDb.state.ledger.values()].find((entry) => entry.entryType === "ADJUSTMENT");
    expect(forfeiture).toMatchObject({ amountCredits: -5200, planCreditsDelta: -5200 });
  });

  it("returns to an existing free period with no recurring credits after cancellation", async () => {
    // Free on the 1st, subscribed on the 5th, cancelling on the 20th:
    // returning to the same free period also expires the Creator allowance.
    await ensureCurrentPlanPeriod("user-a", new Date("2026-06-01T08:00:00.000Z"));
    subscribe({ planCredits: 5200 });

    await endSubscriptionNow("user-a", CANCEL_DAY);

    expect(await getCreditBalance("user-a", CANCEL_DAY)).toMatchObject({
      planCredits: 0,
      planCreditsPerPeriod: DEFAULT_CREDIT_COSTS.freeMonthlyCredits,
      availableCredits: 0
    });
    const grants = [...fakeDb.state.ledger.values()].filter((entry) => entry.operation === "PLAN_ALLOWANCE_GRANT" && entry.entryType === "GRANT");
    expect(grants).toHaveLength(0);
    expect(await getCreditBalance("user-a", JULY)).toMatchObject({
      planCredits: DEFAULT_CREDIT_COSTS.freeMonthlyCredits
    });
  });

  it("reports nothing to end when the account is already free", async () => {
    expect(await endSubscriptionNow("user-a", CANCEL_DAY)).toEqual({ ended: false, endedSubscriptionIds: [] });
  });

  it("reads a cancelled plan as ending rather than renewing", async () => {
    subscribe({ planCredits: 5200 });
    fakeDb.state.subscriptions.get("subscription-1")!.autoRenewing = false;

    expect(await getPlanSummary("user-a", CANCEL_DAY)).toMatchObject({
      tier: "creator",
      cancelAtPeriodEnd: true,
      renewsAt: null,
      endsAt: new Date("2026-07-05T00:00:00.000Z"),
      productSku: "tomeza.creator_monthly"
    });

    // Still renewing while Google says nothing about a cancellation.
    fakeDb.state.subscriptions.get("subscription-1")!.autoRenewing = true;
    expect(await getPlanSummary("user-a", CANCEL_DAY)).toMatchObject({
      cancelAtPeriodEnd: false,
      renewsAt: new Date("2026-07-05T00:00:00.000Z"),
      endsAt: null
    });
  });
});

describe("illustrated book quota", () => {
  beforeEach(() => {
    fakeDb.reset();
    resetCreditPricing();
  });

  const LIMIT = DEFAULT_CREDIT_COSTS.freeIllustratedBooksPerMonth;

  it("allows the free monthly limit and then refuses", async () => {
    for (let attempt = 1; attempt <= LIMIT; attempt += 1) {
      const result = await consumeIllustratedBookUse({ userId: "user-a", limit: LIMIT, now: JUNE });
      expect(result).toMatchObject({ allowed: true, used: attempt, limit: LIMIT });
    }

    const exhausted = await consumeIllustratedBookUse({ userId: "user-a", limit: LIMIT, now: JUNE });
    expect(exhausted).toMatchObject({ allowed: false, used: LIMIT, limit: LIMIT });
    expect(await getImageQuota("user-a", JUNE)).toMatchObject({
      used: LIMIT,
      limit: LIMIT,
      periodKey: "2026-06",
      resetsAt: new Date("2026-07-01T00:00:00.000Z")
    });
  });

  it("starts over the next month", async () => {
    await consumeIllustratedBookUse({ userId: "user-a", limit: LIMIT, now: JUNE });
    expect(await getImageQuota("user-a", JULY)).toMatchObject({ used: 0, periodKey: "2026-07" });
  });

  it.each([
    { operation: "FULL_BOOK_GENERATION", committed: false },
    { operation: "BOOK_REPLAN", committed: true }
  ] as const)("hands the slot back when $operation is refunded", async ({ operation, committed }) => {
    seedLivePaidPeriod("user-a");
    const claim = await consumeIllustratedBookUse({ userId: "user-a", limit: LIMIT, now: JUNE });
    const reservation = await reserveCredits({
      userId: "user-a",
      projectId: "project-1",
      operation,
      amountCredits: 500,
      idempotencyKey: "reserve:illustrated",
      metadata: { imageQuota: { periodKey: claim.periodKey } },
      now: JUNE
    });

    if (committed) await commitReservedCredits(reservation!.id);
    await refundCreditLedgerEntry(reservation!.id, "Generation failed", JUNE);
    await refundCreditLedgerEntry(reservation!.id, "Repeated failure delivery", JUNE);
    expect(await getImageQuota("user-a", JUNE)).toMatchObject({ used: 0 });
  });

  it("keeps an indivisible quota slot until a partial refund is topped up", async () => {
    seedLivePaidPeriod("user-a");
    const claim = await consumeIllustratedBookUse({ userId: "user-a", limit: LIMIT, now: JUNE });
    const reservation = await reserveCredits({
      userId: "user-a",
      projectId: "project-1",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: 500,
      idempotencyKey: "reserve:illustrated-partial",
      metadata: { imageQuota: { periodKey: claim.periodKey } },
      now: JUNE
    });
    const spend = await commitReservedCredits(reservation!.id);

    await refundCreditLedgerEntryPortion({
      entryId: spend.id,
      amountCredits: 200,
      reason: "Partial delivery",
      idempotencyKey: "partial:illustrated",
      now: JUNE
    });
    expect(await getImageQuota("user-a", JUNE)).toMatchObject({ used: 1 });

    await refundCreditLedgerEntry(spend.id, "Full failure", JUNE);
    expect(await getImageQuota("user-a", JUNE)).toMatchObject({ used: 0 });
  });

  it("releases at most down to zero", async () => {
    await releaseIllustratedBookUse("user-a", "2026-06");
    expect(await getImageQuota("user-a", JUNE)).toMatchObject({ used: 0 });
  });
});

describe("book page limit", () => {
  beforeEach(() => {
    fakeDb.reset();
    resetCreditPricing();
  });

  it("caps a free account at the operator's page limit", async () => {
    expect(await getBookPageLimit("user-a", JUNE)).toBe(DEFAULT_CREDIT_COSTS.freeMaxBookPages);
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, freeMaxBookPages: 45 });
    expect(await getBookPageLimit("user-a", JUNE)).toBe(45);
  });

  it("lifts the cap on a paid plan, and only while the plan lasts", async () => {
    fakeDb.state.entitlements.set("entitlement-plan", {
      id: "entitlement-plan",
      userId: "user-a",
      projectId: null,
      type: "CREATOR_PLAN",
      status: "ACTIVE",
      source: "google_play_subscription",
      creditsCost: 0,
      relatedLedgerEntryId: null,
      purchaseRecordId: null,
      startsAt: new Date("2026-05-15T00:00:00.000Z"),
      expiresAt: new Date("2026-06-20T00:00:00.000Z")
    });

    expect(await getBookPageLimit("user-a", JUNE)).toBeNull();
    expect(await getBookPageLimit("user-a", JULY)).toBe(DEFAULT_CREDIT_COSTS.freeMaxBookPages);
  });
});

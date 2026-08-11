import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CREDIT_COSTS, creditCostForOperation, resetCreditPricing, setCreditPricing } from "@book-maker/core";

const fakeDb = await vi.hoisted(async () => (await import("./testing/billingTestDb.js")).createBillingTestDb());

vi.mock("./client.ts", () => ({
  prisma: fakeDb.prisma,
  Prisma: fakeDb.Prisma
}));

const {
  InsufficientCreditsError,
  commitReservedCredits,
  ensureProjectExportEntitlementOrSpend,
  getCreditBalance,
  getImageQuota,
  getPlanSummary,
  grantCredits,
  grantProjectEntitlement,
  hasActiveProjectEntitlement,
  hasActiveSubscriptionEntitlement,
  recordVerifiedGooglePlayPurchase,
  refundCreditLedgerEntry,
  refundLatestProjectOperationCredits,
  releaseReservationsByKeyPrefix,
  reserveCredits,
  resolvePlanTier,
  spendCredits
} = await import("./billing.js");

const JUNE = new Date("2026-06-15T12:00:00.000Z");

describe("credit ledger operations", () => {
  beforeEach(() => {
    fakeDb.reset();
    // These cover the ledger mechanics, so the free allowance is switched off to
    // keep the arithmetic about the amounts each test sets up. The allowance has
    // its own suite in planPeriods.test.ts.
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, freeMonthlyCredits: 0 });
  });

  it("grants, reserves, commits, and refunds credits atomically", async () => {
    await grantCredits({
      userId: "user-a",
      amountCredits: 1000,
      idempotencyKey: "grant:user-a:initial"
    });

    const reservation = await reserveCredits({
      userId: "user-a",
      projectId: "project-1",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: 300,
      idempotencyKey: "reserve:project-1"
    });
    expect(await getCreditBalance("user-a")).toMatchObject({ availableCredits: 700, reservedCredits: 300 });

    const spend = await commitReservedCredits(reservation!.id);
    expect(spend.entryType).toBe("SPEND");
    expect(await getCreditBalance("user-a")).toMatchObject({ availableCredits: 700, reservedCredits: 0, lifetimeCreditsSpent: 300 });

    await refundCreditLedgerEntry(spend.id, "Generation failed");
    expect(await getCreditBalance("user-a")).toMatchObject({ availableCredits: 1000, reservedCredits: 0, lifetimeCreditsSpent: 0 });
  });

  it("releases only the still-RESERVED holds under a key prefix", async () => {
    // The voice-call shape: holds keyed hold:0, hold:1, … where the pointer
    // recording a hold can be lost to a crash. Releasing by prefix frees the
    // orphan with the tracked ones, while a hold already committed to a spend
    // — and every entry of any other call — is left alone.
    await grantCredits({ userId: "user-a", amountCredits: 1000, idempotencyKey: "grant:user-a" });

    const committed = await reserveCredits({
      userId: "user-a",
      operation: "VOICE_CALL_MINUTE",
      amountCredits: 100,
      idempotencyKey: "mobile:voice-call:call-1:hold:0"
    });
    await commitReservedCredits(committed!.id);
    await reserveCredits({
      userId: "user-a",
      operation: "VOICE_CALL_MINUTE",
      amountCredits: 200,
      idempotencyKey: "mobile:voice-call:call-1:hold:1"
    });
    await reserveCredits({
      userId: "user-a",
      operation: "VOICE_CALL_MINUTE",
      amountCredits: 300,
      idempotencyKey: "mobile:voice-call:call-2:hold:0"
    });

    const released = await releaseReservationsByKeyPrefix("mobile:voice-call:call-1:hold:", "Call ended");

    expect(released).toBe(1);
    // 1000 - 100 spent; call-1's 200 hold released; call-2's 300 still held.
    expect(await getCreditBalance("user-a")).toMatchObject({
      availableCredits: 600,
      reservedCredits: 300,
      lifetimeCreditsSpent: 100
    });
    // Idempotent: nothing under the prefix is RESERVED any more.
    expect(await releaseReservationsByKeyPrefix("mobile:voice-call:call-1:hold:", "Call ended")).toBe(0);
  });

  it("prevents double spend and treats duplicate idempotency keys as one reservation", async () => {
    await grantCredits({ userId: "user-a", amountCredits: 500, idempotencyKey: "grant:user-a" });

    const first = await reserveCredits({
      userId: "user-a",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: 400,
      idempotencyKey: "reserve:same"
    });
    const duplicate = await reserveCredits({
      userId: "user-a",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: 400,
      idempotencyKey: "reserve:same"
    });

    expect(duplicate?.id).toBe(first?.id);
    expect(await getCreditBalance("user-a")).toMatchObject({ availableCredits: 100, reservedCredits: 400 });
    await expect(
      reserveCredits({
        userId: "user-a",
        operation: "FULL_BOOK_GENERATION",
        amountCredits: 200,
        idempotencyKey: "reserve:too-much"
      })
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it("spends export unlock credits once and then allows the entitlement", async () => {
    await grantCredits({ userId: "user-a", amountCredits: 200, idempotencyKey: "grant:user-a" });

    expect(await hasActiveProjectEntitlement({ userId: "user-a", projectId: "project-1", type: "EXPORT_UNLOCK" })).toBe(false);
    const unlocked = await ensureProjectExportEntitlementOrSpend({
      userId: "user-a",
      projectId: "project-1",
      idempotencyKey: "export:project-1"
    });
    const second = await ensureProjectExportEntitlementOrSpend({
      userId: "user-a",
      projectId: "project-1",
      idempotencyKey: "export:project-1"
    });

    expect(unlocked.chargedLedgerEntry?.amountCredits).toBe(-creditCostForOperation("EXPORT_UNLOCK"));
    expect(second.chargedLedgerEntry).toBeNull();
    expect(await hasActiveProjectEntitlement({ userId: "user-a", projectId: "project-1", type: "EXPORT_UNLOCK" })).toBe(true);
    expect(await getCreditBalance("user-a")).toMatchObject({ availableCredits: 50, reservedCredits: 0 });
  });

  it("stamps the price list every entry was written under", async () => {
    // Prices are operator-editable and live, so an amount alone cannot say which
    // price list produced it. Stamped once at the point every entry is built, so
    // a new charge site cannot forget to.
    await grantCredits({ userId: "user-a", amountCredits: 500, idempotencyKey: "grant:stamp" });
    await spendCredits({
      userId: "user-a",
      operation: "EXPORT_UNLOCK",
      amountCredits: 150,
      idempotencyKey: "spend:stamp",
      metadata: { reason: "manual" }
    });

    for (const call of fakeDb.prisma.creditLedgerEntry.create.mock.calls) {
      expect(call[0].data.metadata).toHaveProperty("pricingVersion");
    }
    const spendCall = fakeDb.prisma.creditLedgerEntry.create.mock.calls.at(-1);
    // Caller metadata survives alongside it.
    expect(spendCall?.[0].data.metadata).toMatchObject({ reason: "manual" });
  });

  it("refunds failed project generation once and revokes ledger-backed entitlements", async () => {
    await grantCredits({ userId: "user-a", amountCredits: 1000, idempotencyKey: "grant:user-a" });
    const spend = await spendCredits({
      userId: "user-a",
      projectId: "project-1",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: 800,
      idempotencyKey: "spend:project-1"
    });
    await grantProjectEntitlement({
      userId: "user-a",
      projectId: "project-1",
      type: "EXPORT_UNLOCK",
      source: "full_generation_credits",
      creditsCost: 800,
      relatedLedgerEntryId: spend?.id
    });

    const refund = await refundLatestProjectOperationCredits({
      projectId: "project-1",
      operation: "FULL_BOOK_GENERATION",
      reason: "Worker failed"
    });
    const secondRefund = await refundLatestProjectOperationCredits({
      projectId: "project-1",
      operation: "FULL_BOOK_GENERATION",
      reason: "Worker failed again"
    });

    expect(refund?.entryType).toBe("REFUND");
    expect(secondRefund).toBeNull();
    expect(await getCreditBalance("user-a")).toMatchObject({ availableCredits: 1000, lifetimeCreditsSpent: 0 });
    expect(await hasActiveProjectEntitlement({ userId: "user-a", projectId: "project-1", type: "EXPORT_UNLOCK" })).toBe(false);
  });
});

describe("google play purchases", () => {
  beforeEach(() => {
    fakeDb.reset();
    resetCreditPricing();
  });

  const creatorVerification = {
    productSku: "tomeza.creator_monthly",
    purchaseToken: "creator-sub-token",
    kind: "subscription" as const,
    grantable: true,
    providerStatus: "SUBSCRIPTION_STATE_ACTIVE",
    externalPurchaseId: "GPA.5555-6666-7777-88888",
    purchasedAt: new Date("2026-06-15T00:00:00.000Z"),
    subscription: {
      status: "ACTIVE" as const,
      currentPeriodStart: new Date("2026-06-15T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-07-15T00:00:00.000Z")
    }
  };

  const oneTimeVerification = {
    productSku: "tomeza.one_book_export",
    purchaseToken: "same-google-token",
    kind: "one_time" as const,
    grantable: true,
    providerStatus: "PURCHASED",
    externalPurchaseId: "GPA.1111-2222-3333-44444",
    purchasedAt: new Date("2026-06-15T12:00:00.000Z"),
    quantity: 1
  };

  it("records verified purchases and does not double-grant duplicate tokens", async () => {
    const first = await recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: oneTimeVerification });
    const duplicate = await recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: oneTimeVerification });

    expect(first.purchaseRecordId).toBe(duplicate.purchaseRecordId);
    expect(first.ledgerEntryId).toBe(duplicate.ledgerEntryId);
    // Bought outright, so it lands in the pool that never expires.
    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      availableCredits: 1000 + DEFAULT_CREDIT_COSTS.freeMonthlyCredits,
      purchasedCredits: 1000,
      lifetimeCreditsGranted: 1000 + DEFAULT_CREDIT_COSTS.freeMonthlyCredits
    });
    expect([...fakeDb.state.ledger.values()].filter((entry) => entry.operation === "PURCHASE_CREDIT_GRANT")).toHaveLength(1);
  });

  it("stores subscription state and grants one allowance per verified period", async () => {
    const first = await recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: creatorVerification });
    const duplicate = await recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: creatorVerification });

    expect(first.purchaseRecordId).toBe(duplicate.purchaseRecordId);
    expect(first.ledgerEntryId).toBe(duplicate.ledgerEntryId);
    expect(first.entitlementType).toBe("CREATOR_PLAN");
    // Subscription credits are the period's allowance, not a permanent balance.
    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      availableCredits: 6000,
      planCredits: 6000,
      planCreditsPerPeriod: 6000,
      purchasedCredits: 0
    });
    expect([...fakeDb.state.subscriptions.values()]).toHaveLength(1);
    expect([...fakeDb.state.subscriptions.values()][0]).toMatchObject({
      purchaseToken: "creator-sub-token",
      nextCreditGrantAt: new Date("2026-07-15T00:00:00.000Z")
    });
    expect([...fakeDb.state.ledger.values()].filter((entry) => entry.operation === "SUBSCRIPTION_CREDIT_GRANT")).toHaveLength(1);
    expect(await resolvePlanTier("user-a", JUNE)).toBe("creator");
  });

  it("slides the period instead of wiping the allowance when the same purchase re-verifies with a recomputed end", async () => {
    await recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: creatorVerification });
    await spendCredits({
      userId: "user-a",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: 400,
      idempotencyKey: "spend:book-1",
      now: JUNE
    });

    // The mock verifier answers every refresh and restore with a *moving*
    // period end for the same order id — the shape that used to write the
    // remaining allowance off as "expired" on every tap of refresh, for a
    // subscription that was active and uncancelled. A missing expiryTime's
    // now+31d fallback produces the same shape in production.
    await recordVerifiedGooglePlayPurchase({
      userId: "user-a",
      verification: {
        ...creatorVerification,
        subscription: {
          status: "ACTIVE" as const,
          currentPeriodStart: new Date("2026-06-15T00:00:00.000Z"),
          currentPeriodEnd: new Date("2026-07-20T00:00:00.000Z")
        }
      }
    });

    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      planCredits: 5600,
      availableCredits: 5600
    });
    expect(
      [...fakeDb.state.ledger.values()].filter((entry) => entry.operation === "SUBSCRIPTION_CREDIT_GRANT")
    ).toHaveLength(1);
    expect(
      [...fakeDb.state.ledger.values()].filter((entry) => entry.description === "Unused monthly allowance expired")
    ).toHaveLength(0);
  });

  it("neither re-grants nor forfeits when the order id drifts within one period", async () => {
    await recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: creatorVerification });
    await spendCredits({
      userId: "user-a",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: 400,
      idempotencyKey: "spend:book-1",
      now: JUNE
    });

    // Google's deprecated latestOrderId can change between the app's verify
    // and the sweep's for the same period. A fresh grant key for a period the
    // account is already on used to forfeit the remainder and re-grant the
    // full allowance — resetting a part-spent month to full.
    await recordVerifiedGooglePlayPurchase({
      userId: "user-a",
      verification: { ...creatorVerification, externalPurchaseId: "GPA.a-different-order-id" }
    });

    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      planCredits: 5600,
      availableCredits: 5600
    });
    expect(
      [...fakeDb.state.ledger.values()].filter((entry) => entry.operation === "SUBSCRIPTION_CREDIT_GRANT")
    ).toHaveLength(1);
  });

  it("does not stack allowances across renewals", async () => {
    await recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: creatorVerification });
    await recordVerifiedGooglePlayPurchase({
      userId: "user-a",
      verification: {
        ...creatorVerification,
        externalPurchaseId: "GPA.5555-6666-7777-88889",
        subscription: {
          status: "ACTIVE" as const,
          currentPeriodStart: new Date("2026-07-15T00:00:00.000Z"),
          currentPeriodEnd: new Date("2026-08-15T00:00:00.000Z")
        }
      }
    });

    expect(await getCreditBalance("user-a", new Date("2026-07-16T00:00:00.000Z"))).toMatchObject({
      planCredits: 6000,
      availableCredits: 6000
    });
  });

  it("puts a Max subscriber on the top tier with no image limit", async () => {
    await recordVerifiedGooglePlayPurchase({
      userId: "user-a",
      verification: {
        ...creatorVerification,
        productSku: "tomeza.max_monthly",
        purchaseToken: "max-sub-token",
        externalPurchaseId: "GPA.9999"
      }
    });

    expect(await resolvePlanTier("user-a", JUNE)).toBe("max");
    expect(await hasActiveSubscriptionEntitlement("user-a", JUNE)).toBe(true);
    expect(await getImageQuota("user-a", JUNE)).toBeNull();
    expect(await getPlanSummary("user-a", JUNE)).toMatchObject({
      tier: "max",
      source: "google_play",
      status: "ACTIVE",
      productSku: "tomeza.max_monthly"
    });
  });

  it("records an expired subscription and stops the renewal sweep polling it", async () => {
    await recordVerifiedGooglePlayPurchase({ userId: "user-a", verification: creatorVerification });
    const result = await recordVerifiedGooglePlayPurchase({
      userId: "user-a",
      verification: {
        ...creatorVerification,
        grantable: false,
        providerStatus: "SUBSCRIPTION_STATE_EXPIRED",
        subscription: { status: "EXPIRED" as const, currentPeriodEnd: new Date("2026-07-15T00:00:00.000Z") }
      }
    });

    expect(result.ledgerEntryId).toBeNull();
    expect([...fakeDb.state.subscriptions.values()][0]).toMatchObject({
      status: "EXPIRED",
      nextCreditGrantAt: null
    });
  });
});

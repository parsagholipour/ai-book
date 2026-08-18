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
  refundCreditLedgerEntryPortion,
  refundLatestProjectOperationCredits,
  refundedLedgerEntryIds,
  releaseReservationsByKeyPrefix,
  reserveCredits,
  resolvePlanTier,
  spendCredits
} = await import("./billing.js");

const JUNE = new Date("2026-06-15T12:00:00.000Z");
const NEXT_DAY = new Date("2026-06-16T12:00:00.000Z");

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

  it("replays a partial settlement once, then tops up only the remainder on full failure", async () => {
    // The page-priced shortfall: an insert charged for five pages that wrote
    // two. Only the three missing pages come back, and the charge keeps its one
    // cumulative reversal. A redelivery finds its claim key; a later failure
    // grows that same row by the remaining 80 rather than paying 120 twice.
    await grantCredits({ userId: "user-a", amountCredits: 1000, idempotencyKey: "grant:user-a" });
    const spend = await spendCredits({
      userId: "user-a",
      projectId: "project-1",
      operation: "PAGE_REGENERATION",
      amountCredits: 200,
      idempotencyKey: "attempt:insert-5"
    });

    const refund = await refundCreditLedgerEntryPortion({
      entryId: spend!.id,
      amountCredits: 120,
      reason: "Structural edit wrote 2 of 5 paid pages",
      idempotencyKey: "edit-shortfall:operation-1"
    });

    expect(refund).toMatchObject({ entryType: "REFUND", amountCredits: 120 });
    expect(await getCreditBalance("user-a")).toMatchObject({
      availableCredits: 920,
      reservedCredits: 0,
      lifetimeCreditsSpent: 80
    });

    // Redelivery of the same settlement.
    const replayed = await refundCreditLedgerEntryPortion({
      entryId: spend!.id,
      amountCredits: 120,
      reason: "Structural edit wrote 2 of 5 paid pages",
      idempotencyKey: "edit-shortfall:operation-1"
    });
    expect(replayed?.id).toBe(refund?.id);
    expect(replayed?.amountCredits).toBe(120);
    expect(await refundedLedgerEntryIds([spend!.id])).toEqual(new Set());

    // A full refund arriving afterwards — failEditOperation or the attempt
    // reconciler — tops up the unpaid 80 exactly once.
    await refundLatestProjectOperationCredits({
      projectId: "project-1",
      operation: "PAGE_REGENERATION",
      reason: "Edit failed"
    });
    await refundCreditLedgerEntry(spend!.id, "Edit failed again");
    expect(await getCreditBalance("user-a")).toMatchObject({ availableCredits: 1000, lifetimeCreditsSpent: 0 });
    expect(await refundedLedgerEntryIds([spend!.id])).toEqual(new Set([spend!.id]));
    const reversals = [...fakeDb.state.ledger.values()].filter((entry) => entry.reversesEntryId === spend!.id);
    expect(reversals).toHaveLength(1);
    expect(reversals[0]).toMatchObject({ amountCredits: 200 });
  });

  it("keeps the reversal's own stamp and both settlements' reasons when a partial is topped up", async () => {
    // The audit trail across a two-step reversal. The row is cumulative in
    // amount only: `balanceAfterCredits` names the balance at the moment the
    // row was written, so the top-up must not restate it — and the reason the
    // partial settlement gave is the only record of why part of the charge came
    // back, so it must survive the reason the failure gives later.
    await grantCredits({ userId: "user-a", amountCredits: 1000, idempotencyKey: "grant:user-a" });
    const spend = await spendCredits({
      userId: "user-a",
      projectId: "project-1",
      operation: "PAGE_REGENERATION",
      amountCredits: 200,
      idempotencyKey: "attempt:insert-5",
      now: JUNE
    });

    await refundCreditLedgerEntryPortion({
      entryId: spend!.id,
      amountCredits: 120,
      reason: "Structural edit wrote 2 of 5 paid pages",
      idempotencyKey: "edit-shortfall:operation-1",
      now: JUNE
    });

    // Something else moves the balance between the two settlements, which is
    // what makes a rewritten stamp unexplainable by any adjacent row.
    const later = await spendCredits({
      userId: "user-a",
      operation: "FULL_BOOK_GENERATION",
      amountCredits: 300,
      idempotencyKey: "attempt:other-book",
      now: NEXT_DAY
    });
    await refundCreditLedgerEntry(spend!.id, "Edit failed", NEXT_DAY);

    const reversal = [...fakeDb.state.ledger.values()].find((entry) => entry.reversesEntryId === spend!.id)!;
    const settlements = (reversal.metadata as { refundSettlements?: unknown[] }).refundSettlements;

    // The money is unchanged: one reversal, cumulative to exactly the charge.
    expect(
      [...fakeDb.state.ledger.values()].filter((entry) => entry.reversesEntryId === spend!.id)
    ).toHaveLength(1);
    expect(reversal).toMatchObject({ entryType: "REFUND", amountCredits: 200 });
    expect(await getCreditBalance("user-a")).toMatchObject({
      availableCredits: 700,
      reservedCredits: 0,
      lifetimeCreditsSpent: 300
    });
    // …and the ledger still sums to the balance it describes.
    expect(
      [...fakeDb.state.ledger.values()]
        .filter((entry) => entry.userId === "user-a")
        .reduce((total, entry) => total + entry.amountCredits, 0)
    ).toBe(700);

    // The stamp is the balance at the moment this row was written — 920, after
    // the partial went back — not the 700 the later top-up left behind.
    expect(reversal.balanceAfterCredits).toBe(920);
    // Every other row's stamp still describes its own moment too.
    expect([...fakeDb.state.ledger.values()].find((entry) => entry.id === later!.id)?.balanceAfterCredits).toBe(620);

    // Both reasons are recoverable: on the row an operator reads, and per
    // settlement with the amount and balance each one produced.
    expect(reversal.description).toBe("Structural edit wrote 2 of 5 paid pages; Edit failed");
    expect(settlements).toEqual([
      {
        credits: 120,
        reason: "Structural edit wrote 2 of 5 paid pages",
        at: JUNE.toISOString(),
        balanceAfterCredits: 920,
        claimKey: "edit-shortfall:operation-1"
      },
      {
        credits: 80,
        reason: "Edit failed",
        at: NEXT_DAY.toISOString(),
        balanceAfterCredits: 700
      }
    ]);
    expect((settlements as Array<{ credits: number }>).reduce((total, entry) => total + entry.credits, 0)).toBe(200);
  });

  it("reconstructs the first settlement of a reversal written before the trail existed", async () => {
    // Rows already in production carry no `refundSettlements`, and the first
    // top-up to reach one is exactly the write that used to lose its reason.
    await grantCredits({ userId: "user-a", amountCredits: 1000, idempotencyKey: "grant:user-a" });
    const spend = await spendCredits({
      userId: "user-a",
      operation: "PAGE_REGENERATION",
      amountCredits: 200,
      idempotencyKey: "attempt:legacy-insert",
      now: JUNE
    });
    await refundCreditLedgerEntryPortion({
      entryId: spend!.id,
      amountCredits: 120,
      reason: "Wrote 2 of 5 paid pages",
      idempotencyKey: "edit-shortfall:legacy",
      now: JUNE
    });
    const reversal = [...fakeDb.state.ledger.values()].find((entry) => entry.reversesEntryId === spend!.id)!;
    const { refundSettlements: _dropped, ...legacyMetadata } = reversal.metadata as Record<string, unknown>;
    reversal.metadata = legacyMetadata;

    await refundCreditLedgerEntry(spend!.id, "Edit failed", NEXT_DAY);

    expect(reversal).toMatchObject({ amountCredits: 200, balanceAfterCredits: 920 });
    expect(reversal.description).toBe("Wrote 2 of 5 paid pages; Edit failed");
    expect((reversal.metadata as { refundSettlements: unknown[] }).refundSettlements).toEqual([
      {
        credits: 120,
        reason: "Wrote 2 of 5 paid pages",
        at: reversal.createdAt.toISOString(),
        balanceAfterCredits: 920
      },
      { credits: 80, reason: "Edit failed", at: NEXT_DAY.toISOString(), balanceAfterCredits: 1000 }
    ]);
    expect(await getCreditBalance("user-a")).toMatchObject({ availableCredits: 1000, lifetimeCreditsSpent: 0 });
  });

  it("gives the whole charge back when a portion would cover it", async () => {
    // The degenerate shortfall — nothing written at all — is a full reversal,
    // so it takes the path that also revokes entitlements and returns quota
    // slots rather than a second, thinner implementation of one.
    await grantCredits({ userId: "user-a", amountCredits: 1000, idempotencyKey: "grant:user-a" });
    const spend = await spendCredits({
      userId: "user-a",
      operation: "PAGE_REGENERATION",
      amountCredits: 200,
      idempotencyKey: "attempt:insert-none"
    });

    await refundCreditLedgerEntryPortion({
      entryId: spend!.id,
      amountCredits: 500,
      reason: "wrote nothing",
      idempotencyKey: "edit-shortfall:operation-none"
    });

    expect(await getCreditBalance("user-a")).toMatchObject({ availableCredits: 1000, lifetimeCreditsSpent: 0 });
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

  it("passes over a fully reversed charge to top up the partly reversed one behind it", async () => {
    // What makes a charge eligible is `reversedByEntry.amountCredits` being
    // under the charge, not the relation being absent: the newest charge here
    // came back whole and is finished with, while the one behind it is still
    // owed the 80 its partial settlement left, and the oldest is untouched and
    // must stay that way.
    await grantCredits({ userId: "user-a", amountCredits: 5000, idempotencyKey: "grant:user-a" });
    const untouched = await spendCredits({
      userId: "user-a",
      projectId: "project-1",
      operation: "PAGE_REGENERATION",
      amountCredits: 100,
      idempotencyKey: "spend:page-untouched"
    });
    const partlyReversed = await spendCredits({
      userId: "user-a",
      projectId: "project-1",
      operation: "PAGE_REGENERATION",
      amountCredits: 200,
      idempotencyKey: "spend:page-partial"
    });
    const fullyReversed = await spendCredits({
      userId: "user-a",
      projectId: "project-1",
      operation: "PAGE_REGENERATION",
      amountCredits: 300,
      idempotencyKey: "spend:page-full"
    });
    await refundCreditLedgerEntry(fullyReversed!.id, "Newest attempt failed");
    await refundCreditLedgerEntryPortion({
      entryId: partlyReversed!.id,
      amountCredits: 120,
      reason: "Wrote 2 of 5 paid pages",
      idempotencyKey: "edit-shortfall:operation-9"
    });

    const refund = await refundLatestProjectOperationCredits({
      projectId: "project-1",
      operation: "PAGE_REGENERATION",
      reason: "Edit failed"
    });

    expect(refund?.amountCredits).toBe(200);
    const reversals = [...fakeDb.state.ledger.values()].filter((entry) => entry.reversesEntryId !== null);
    expect(reversals.map((entry) => entry.reversesEntryId).sort()).toEqual(
      [fullyReversed!.id, partlyReversed!.id].sort()
    );
    expect(await refundedLedgerEntryIds([untouched!.id, partlyReversed!.id, fullyReversed!.id])).toEqual(
      new Set([partlyReversed!.id, fullyReversed!.id])
    );
    // Only the 100 the untouched charge still owes stays spent.
    expect(await getCreditBalance("user-a")).toMatchObject({ availableCredits: 4900, lifetimeCreditsSpent: 100 });
  });

  it("scans past a full page of settled charges to reach the one that still stands", async () => {
    // A heavily edited book's history is longer than one scan page, and the
    // charge that still stands can be at the bottom of it. The scan is bounded
    // per round trip, not per project: it pages until it finds that charge.
    await grantCredits({ userId: "user-a", amountCredits: 5000, idempotencyKey: "grant:user-a" });
    const stillStanding = await spendCredits({
      userId: "user-a",
      projectId: "project-1",
      operation: "PAGE_REGENERATION",
      amountCredits: 50,
      idempotencyKey: "spend:page-oldest"
    });
    for (let index = 0; index < 30; index += 1) {
      const charge = await spendCredits({
        userId: "user-a",
        projectId: "project-1",
        operation: "PAGE_REGENERATION",
        amountCredits: 10,
        idempotencyKey: `spend:page-${index}`
      });
      await refundCreditLedgerEntry(charge!.id, "Page attempt failed");
    }

    fakeDb.prisma.creditLedgerEntry.findMany.mockClear();
    const refund = await refundLatestProjectOperationCredits({
      projectId: "project-1",
      operation: "PAGE_REGENERATION",
      reason: "Edit failed"
    });

    expect(refund?.amountCredits).toBe(50);
    const reversal = [...fakeDb.state.ledger.values()].find((entry) => entry.reversesEntryId === stillStanding!.id);
    expect(reversal).toMatchObject({ amountCredits: 50 });
    expect(await getCreditBalance("user-a")).toMatchObject({ availableCredits: 5000, lifetimeCreditsSpent: 0 });
    // 31 charges, 25 to a page: the second page holds it, and no page loads the
    // whole history.
    const scans = fakeDb.prisma.creditLedgerEntry.findMany.mock.calls;
    expect(scans).toHaveLength(2);
    expect(scans.every((call: any[]) => call[0].take === 25)).toBe(true);
  });

  it("returns null when every charge in a long history is already fully reversed", async () => {
    // The pathological case for a bounded scan: nothing is eligible, so it
    // reaches the end of the history and says so rather than refunding a charge
    // that already came back.
    await grantCredits({ userId: "user-a", amountCredits: 5000, idempotencyKey: "grant:user-a" });
    for (let index = 0; index < 30; index += 1) {
      const charge = await spendCredits({
        userId: "user-a",
        projectId: "project-1",
        operation: "PAGE_REGENERATION",
        amountCredits: 10,
        idempotencyKey: `spend:page-${index}`
      });
      await refundCreditLedgerEntry(charge!.id, "Page attempt failed");
    }

    fakeDb.prisma.creditLedgerEntry.findMany.mockClear();
    const refund = await refundLatestProjectOperationCredits({
      projectId: "project-1",
      operation: "PAGE_REGENERATION",
      reason: "Edit failed"
    });

    expect(refund).toBeNull();
    expect(fakeDb.prisma.creditLedgerEntry.findMany.mock.calls).toHaveLength(2);
    expect(await getCreditBalance("user-a")).toMatchObject({ availableCredits: 5000, lifetimeCreditsSpent: 0 });
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

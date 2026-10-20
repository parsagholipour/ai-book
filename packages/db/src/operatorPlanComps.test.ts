import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetCreditPricing } from "@book-maker/core";

const fakeDb = await vi.hoisted(async () => (await import("./testing/billingTestDb.js")).createBillingTestDb());

vi.mock("./client.ts", () => ({
  prisma: fakeDb.prisma,
  Prisma: fakeDb.Prisma
}));

const {
  OperatorPlanCompError,
  getCreditBalance,
  getBookPageLimit,
  grantCredits,
  grantOperatorPlanComp,
  resolvePlanTier,
  revokeOperatorPlanComp
} = await import("./billing.js");

const GIVEN = new Date("2026-10-20T10:00:00.000Z");
const SAME_MONTH = new Date("2026-11-05T10:00:00.000Z");
const SECOND_MONTH = new Date("2026-11-21T10:00:00.000Z");

function ledger() {
  return [...fakeDb.state.ledger.values()];
}

function grantsFor(entitlementId: string) {
  return ledger().filter((entry) => entry.entryType === "GRANT" && entry.idempotencyKey.startsWith(`operator-comp:${entitlementId}:`));
}

describe("operator plan comps", () => {
  beforeEach(() => {
    fakeDb.reset();
    resetCreditPricing();
  });

  it("puts the reader on the plan with its month's allowance, and grants it once", async () => {
    const first = await grantOperatorPlanComp({ userId: "user-a", tier: "creator", note: "friend of the team", now: GIVEN });
    const again = await grantOperatorPlanComp({ userId: "user-a", tier: "creator", now: GIVEN });

    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, entitlementId: first.entitlementId });
    expect(await resolvePlanTier("user-a", GIVEN)).toBe("creator");
    expect(await getBookPageLimit("user-a", GIVEN)).toBeNull();
    expect(fakeDb.state.entitlements.get(first.entitlementId)).toMatchObject({
      type: "CREATOR_PLAN",
      source: "operator_comp",
      purchaseRecordId: null,
      startsAt: GIVEN,
      expiresAt: null
    });
    expect(await getCreditBalance("user-a", GIVEN)).toMatchObject({ planCredits: 6000, planCreditsPerPeriod: 6000, purchasedCredits: 0 });
    const grants = grantsFor(first.entitlementId);
    expect(grants).toHaveLength(1);
    // An allowance nobody paid for: the dashboard values these credits at nothing.
    expect(grants[0]).toMatchObject({ operation: "PLAN_ALLOWANCE_GRANT", amountCredits: 6000, planCreditsDelta: 6000 });
  });

  it("counts months from the day it was given and grants the next one on the first read", async () => {
    const { entitlementId } = await grantOperatorPlanComp({ userId: "user-a", tier: "creator", now: GIVEN });
    fakeDb.state.accounts.get("user-a")!.planCredits = 1500;

    // The 5th of November is still the first month: a calendar month would have reset here.
    expect(await getCreditBalance("user-a", SAME_MONTH)).toMatchObject({ planCredits: 1500 });
    expect(grantsFor(entitlementId)).toHaveLength(1);

    expect(await getCreditBalance("user-a", SECOND_MONTH)).toMatchObject({ planCredits: 6000 });
    expect(await getCreditBalance("user-a", SECOND_MONTH)).toMatchObject({ planCredits: 6000 });
    expect(grantsFor(entitlementId).map((entry) => entry.idempotencyKey)).toEqual([
      `operator-comp:${entitlementId}:month:0`,
      `operator-comp:${entitlementId}:month:1`
    ]);
    // The first month's leftover lapses like any monthly allowance.
    expect(ledger().find((entry) => entry.entryType === "ADJUSTMENT")).toMatchObject({ amountCredits: -1500, planCreditsDelta: -1500 });
    expect(fakeDb.state.accounts.get("user-a")).toMatchObject({
      planPeriodKey: `comp:${entitlementId}:1`,
      planPeriodStart: new Date("2026-11-20T10:00:00.000Z"),
      planPeriodEnd: new Date("2026-12-20T10:00:00.000Z")
    });
  });

  it("refuses a reader who already pays for a plan", async () => {
    await fakeDb.prisma.userEntitlement.create({
      data: { userId: "user-a", type: "PRO_PLAN", source: "google_play_subscription", startsAt: GIVEN, expiresAt: SECOND_MONTH }
    });

    await expect(grantOperatorPlanComp({ userId: "user-a", tier: "creator", now: GIVEN })).rejects.toBeInstanceOf(OperatorPlanCompError);
    expect([...fakeDb.state.entitlements.values()].filter((row) => row.source === "operator_comp")).toHaveLength(0);
  });

  it("leaves the pool to a store plan bought beside the comp", async () => {
    const { entitlementId } = await grantOperatorPlanComp({ userId: "user-a", tier: "creator", now: GIVEN });
    await fakeDb.prisma.userEntitlement.create({
      data: { userId: "user-a", type: "PRO_PLAN", source: "google_play_subscription", startsAt: SAME_MONTH, expiresAt: new Date("2026-12-31T00:00:00.000Z") }
    });

    expect(await resolvePlanTier("user-a", SECOND_MONTH)).toBe("pro");
    await getCreditBalance("user-a", SECOND_MONTH);
    expect(grantsFor(entitlementId)).toHaveLength(1);
  });

  it("replaces a comp of another tier, its months starting over", async () => {
    const creator = await grantOperatorPlanComp({ userId: "user-a", tier: "creator", now: GIVEN });
    const max = await grantOperatorPlanComp({ userId: "user-a", tier: "max", now: SAME_MONTH });

    expect(fakeDb.state.entitlements.get(creator.entitlementId)).toMatchObject({ status: "EXPIRED", expiresAt: SAME_MONTH });
    expect(await resolvePlanTier("user-a", SAME_MONTH)).toBe("max");
    expect(await getCreditBalance("user-a", SAME_MONTH)).toMatchObject({ planCredits: 80000 });
    expect(fakeDb.state.accounts.get("user-a")?.planPeriodKey).toBe(`comp:${max.entitlementId}:0`);
  });

  it("revokes to the free tier, expiring what is left of the month and keeping purchased credits", async () => {
    await grantCredits({ userId: "user-a", amountCredits: 700, idempotencyKey: "grant:purchased" });
    const { entitlementId } = await grantOperatorPlanComp({ userId: "user-a", tier: "creator", now: GIVEN });
    fakeDb.state.accounts.get("user-a")!.planCredits = 4000;

    const revoked = await revokeOperatorPlanComp({ userId: "user-a", now: SAME_MONTH });

    expect(revoked.revoked).toBe(1);
    expect(fakeDb.state.entitlements.get(entitlementId)).toMatchObject({ status: "EXPIRED", expiresAt: SAME_MONTH });
    expect(await resolvePlanTier("user-a", SAME_MONTH)).toBe("free");
    expect(await getCreditBalance("user-a", SAME_MONTH)).toMatchObject({ planCredits: 0, planCreditsPerPeriod: 0, purchasedCredits: 700 });
    expect(ledger().find((entry) => entry.entryType === "ADJUSTMENT")).toMatchObject({ amountCredits: -4000, planCreditsDelta: -4000 });
    expect(await revokeOperatorPlanComp({ userId: "user-a", now: SAME_MONTH })).toMatchObject({ revoked: 0 });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CREDIT_COSTS, resetCreditPricing, setCreditPricing } from "@book-maker/core";

const fakeDb = await vi.hoisted(async () => (await import("./testing/billingTestDb.ts")).createBillingTestDb());

vi.mock("./client.ts", () => ({
  prisma: fakeDb.prisma,
  Prisma: fakeDb.Prisma
}));

const { ensureCurrentPlanPeriod, getCreditBalance } = await import("./billing.ts");
const { WELCOME_CREDITS_IP_WINDOW_DAYS } = await import("./welcomeCredits.ts");

const JUNE = new Date("2026-06-15T12:00:00.000Z");
const WELCOME = DEFAULT_CREDIT_COSTS.welcomeCredits;
const MONTHLY = DEFAULT_CREDIT_COSTS.freeMonthlyCredits;

function pendingGrant(userId: string, ipHash: string | null = "ip-a"): void {
  fakeDb.state.welcomeGrants.set(userId, {
    userId,
    ipHash,
    outcome: "PENDING",
    amountCredits: 0,
    ledgerEntryId: null,
    createdAt: JUNE,
    settledAt: null
  });
}

function welcomeGrants() {
  return [...fakeDb.state.ledger.values()].filter((entry) => entry.operation === "WELCOME_GRANT");
}

function welcomeIpLockSql(call: unknown[], ipHash: string): boolean {
  const strings = call[0];
  if (!Array.isArray(strings)) {
    return false;
  }
  const sql = strings.join("?");
  return sql.includes("WelcomeCreditGrant") && sql.includes("FOR UPDATE") && call[1] === ipHash;
}

describe("welcome credits", () => {
  beforeEach(() => {
    fakeDb.reset();
    resetCreditPricing();
  });

  it("grants once into the purchased pool", async () => {
    pendingGrant("user-a");
    await ensureCurrentPlanPeriod("user-a", JUNE);
    await ensureCurrentPlanPeriod("user-a", JUNE);

    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      availableCredits: WELCOME + MONTHLY,
      purchasedCredits: WELCOME,
      planCredits: MONTHLY
    });
    expect(welcomeGrants()).toHaveLength(1);
    expect(welcomeGrants()[0]).toMatchObject({
      entryType: "GRANT",
      amountCredits: WELCOME,
      idempotencyKey: "welcome:user-a",
      description: "Welcome credits"
    });
    expect(fakeDb.state.welcomeGrants.get("user-a")).toMatchObject({
      outcome: "GRANTED",
      amountCredits: WELCOME
    });
  });

  it("is a no-op when the account has no welcome row", async () => {
    await ensureCurrentPlanPeriod("legacy", JUNE);
    expect(await getCreditBalance("legacy", JUNE)).toMatchObject({
      purchasedCredits: 0,
      planCredits: MONTHLY
    });
    expect(welcomeGrants()).toHaveLength(0);
  });

  it("settles DISABLED without credits when the toggle is off", async () => {
    pendingGrant("user-a");
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, welcomeCreditsEnabled: 0 });
    await ensureCurrentPlanPeriod("user-a", JUNE);

    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      purchasedCredits: 0,
      planCredits: MONTHLY
    });
    expect(fakeDb.state.welcomeGrants.get("user-a")).toMatchObject({ outcome: "DISABLED", amountCredits: 0 });
    expect(welcomeGrants()).toHaveLength(0);
  });

  it("settles DISABLED when the amount is zero", async () => {
    pendingGrant("user-a");
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, welcomeCredits: 0 });
    await ensureCurrentPlanPeriod("user-a", JUNE);

    expect(fakeDb.state.welcomeGrants.get("user-a")).toMatchObject({ outcome: "DISABLED" });
    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      purchasedCredits: 0,
      planCredits: MONTHLY
    });
  });

  it("withholds silently when the same IP was granted inside 30 days", async () => {
    fakeDb.state.welcomeGrants.set("user-b", {
      userId: "user-b",
      ipHash: "ip-a",
      outcome: "GRANTED",
      amountCredits: 1000,
      ledgerEntryId: "ledger-prior",
      createdAt: new Date("2026-05-20T12:00:00.000Z"),
      settledAt: new Date("2026-05-20T12:00:00.000Z")
    });
    pendingGrant("user-a", "ip-a");
    await ensureCurrentPlanPeriod("user-a", JUNE);

    expect(fakeDb.state.welcomeGrants.get("user-a")).toMatchObject({ outcome: "RECENT_IP", amountCredits: 0 });
    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      purchasedCredits: 0,
      planCredits: MONTHLY
    });
  });

  it("grants when the previous same-IP grant is older than 30 days", async () => {
    const settledAt = new Date(JUNE.getTime() - (WELCOME_CREDITS_IP_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000);
    fakeDb.state.welcomeGrants.set("user-b", {
      userId: "user-b",
      ipHash: "ip-a",
      outcome: "GRANTED",
      amountCredits: 1000,
      ledgerEntryId: "ledger-prior",
      createdAt: settledAt,
      settledAt
    });
    pendingGrant("user-a", "ip-a");
    await ensureCurrentPlanPeriod("user-a", JUNE);

    expect(fakeDb.state.welcomeGrants.get("user-a")).toMatchObject({ outcome: "GRANTED" });
    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      purchasedCredits: WELCOME,
      planCredits: MONTHLY
    });
  });

  it("settles NO_IP without credits when the signup has no IP", async () => {
    fakeDb.state.welcomeGrants.set("user-b", {
      userId: "user-b",
      ipHash: "ip-a",
      outcome: "GRANTED",
      amountCredits: 1000,
      ledgerEntryId: "ledger-prior",
      createdAt: JUNE,
      settledAt: JUNE
    });
    pendingGrant("user-a", null);
    await ensureCurrentPlanPeriod("user-a", JUNE);

    expect(fakeDb.state.welcomeGrants.get("user-a")).toMatchObject({ outcome: "NO_IP", amountCredits: 0 });
    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      purchasedCredits: 0,
      planCredits: MONTHLY
    });
    expect(welcomeGrants()).toHaveLength(0);
  });

  it("settles the second same-IP pending as RECENT_IP after the first grants", async () => {
    pendingGrant("user-a", "ip-shared");
    pendingGrant("user-b", "ip-shared");
    await ensureCurrentPlanPeriod("user-a", JUNE);
    await ensureCurrentPlanPeriod("user-b", JUNE);

    expect(fakeDb.state.welcomeGrants.get("user-a")).toMatchObject({ outcome: "GRANTED", amountCredits: WELCOME });
    expect(fakeDb.state.welcomeGrants.get("user-b")).toMatchObject({ outcome: "RECENT_IP", amountCredits: 0 });
    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({
      purchasedCredits: WELCOME,
      planCredits: MONTHLY
    });
    expect(await getCreditBalance("user-b", JUNE)).toMatchObject({
      purchasedCredits: 0,
      planCredits: MONTHLY
    });
    expect(welcomeGrants()).toHaveLength(1);
  });

  it("only one of two overlapping same-IP first opens is granted", async () => {
    pendingGrant("user-a", "ip-shared");
    pendingGrant("user-b", "ip-shared");
    await Promise.all([ensureCurrentPlanPeriod("user-a", JUNE), ensureCurrentPlanPeriod("user-b", JUNE)]);

    expect(fakeDb.prisma.$queryRaw.mock.calls.some((call) => welcomeIpLockSql(call, "ip-shared"))).toBe(true);

    const outcomes = ["user-a", "user-b"].map((userId) => fakeDb.state.welcomeGrants.get(userId)?.outcome);
    expect(outcomes.filter((outcome) => outcome === "GRANTED")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "RECENT_IP")).toHaveLength(1);
    expect(welcomeGrants()).toHaveLength(1);
    for (const userId of ["user-a", "user-b"] as const) {
      const granted = fakeDb.state.welcomeGrants.get(userId)?.outcome === "GRANTED";
      expect(await getCreditBalance(userId, JUNE)).toMatchObject({
        purchasedCredits: granted ? WELCOME : 0,
        planCredits: MONTHLY
      });
    }
  });

  it("retries a serializable conflict and still grants", async () => {
    pendingGrant("user-a");
    fakeDb.prisma.$transaction.mockRejectedValueOnce({ code: "P2034" });
    await ensureCurrentPlanPeriod("user-a", JUNE);

    expect(fakeDb.state.welcomeGrants.get("user-a")).toMatchObject({
      outcome: "GRANTED",
      amountCredits: WELCOME
    });
    expect(welcomeGrants()).toHaveLength(1);
    expect(fakeDb.prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});

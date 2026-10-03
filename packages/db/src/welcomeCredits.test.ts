import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CREDIT_COSTS, resetCreditPricing, setCreditPricing } from "@book-maker/core";

const fakeDb = await vi.hoisted(async () => (await import("./testing/billingTestDb.ts")).createBillingTestDb());

vi.mock("./client.ts", () => ({
  prisma: fakeDb.prisma,
  Prisma: fakeDb.Prisma
}));

const { ensureCurrentPlanPeriod, getCreditBalance, getWelcomeCreditsGranted } = await import("./billing.ts");
const { WELCOME_CREDITS_IP_WINDOW_DAYS } = await import("./welcomeCredits.ts");

const JUNE = new Date("2026-06-15T12:00:00.000Z");
const WELCOME = DEFAULT_CREDIT_COSTS.welcomeCredits;
const MONTHLY = DEFAULT_CREDIT_COSTS.freeMonthlyCredits;

function pendingGrant(userId: string, ipHash: string | null = "ip-a", countryCode: string | null = null): void {
  fakeDb.state.welcomeGrants.set(userId, {
    userId,
    ipHash,
    countryCode,
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

  it.each([["US", 2000], ["CA", 2000], ["FR", 2000], ["JP", 2000], ["KR", 2000], ["SG", 2000], ["AE", 2000],
    ["IN", 500], ["PK", 500], ["BD", 500], ["ZA", 500], ["BR", 500], ["AU", 2000], ["AQ", 100], [null, 100]] as const)(
    "grants the configured amount for signup country %s", async (country, amount) => {
      pendingGrant("regional-user", "regional-ip", country);
      setCreditPricing({ ...DEFAULT_CREDIT_COSTS, welcomeCreditsRegionalEnabled: 1, welcomeCredits: 100,
        welcomeCreditsHighIncome: 2000, welcomeCreditsLowMiddleIncome: 500 });
      await ensureCurrentPlanPeriod("regional-user", JUNE);
      expect(await getCreditBalance("regional-user", JUNE)).toMatchObject({ purchasedCredits: amount, planCredits: MONTHLY });
      expect(await getWelcomeCreditsGranted("regional-user")).toBe(amount);
      expect(welcomeGrants()[0]).toMatchObject({ amountCredits: amount });
    }
  );

  it("keeps settled grants and skips settled ineligible accounts after settings change", async () => {
    pendingGrant("granted", "ip-1", "US");
    await ensureCurrentPlanPeriod("granted", JUNE);
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, welcomeCreditsEnabled: 0 });
    pendingGrant("disabled", "ip-2", "US");
    await ensureCurrentPlanPeriod("disabled", JUNE);
    expect(await getWelcomeCreditsGranted("granted")).toBe(WELCOME);
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, welcomeCreditsRegionalEnabled: 1, welcomeCreditsHighIncome: 9000 });
    await ensureCurrentPlanPeriod("granted", JUNE);
    await ensureCurrentPlanPeriod("disabled", JUNE);
    expect(await getWelcomeCreditsGranted("granted")).toBe(WELCOME);
    expect(await getWelcomeCreditsGranted("disabled")).toBe(0);
    expect(await getWelcomeCreditsGranted("legacy")).toBe(0);
    expect(welcomeGrants()).toHaveLength(1);
  });

  it("settles zero regional amounts without creating a credit grant", async () => {
    pendingGrant("user-a", "ip-a", "IN");
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, welcomeCreditsRegionalEnabled: 1, welcomeCreditsLowMiddleIncome: 0 });
    await ensureCurrentPlanPeriod("user-a", JUNE);
    expect(fakeDb.state.welcomeGrants.get("user-a")).toMatchObject({ outcome: "DISABLED", amountCredits: 0 });
    expect(welcomeGrants()).toHaveLength(0);
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

  it.each([
    ["US", 2], ["CA", 2], ["JP", 2], ["AE", 2], ["GF", 2],
    ["IN", 1], ["PK", 1], ["BR", 1], ["AQ", 1], [null, 1]
  ] as const)("limits signup country %s to %i same-IP grants", async (country, limit) => {
    for (let index = 0; index <= limit; index += 1) {
      const userId = `user-${index}`;
      pendingGrant(userId, "ip-shared", country);
      await ensureCurrentPlanPeriod(userId, JUNE);

      const granted = index < limit;
      expect(await getWelcomeCreditsGranted(userId)).toBe(granted ? WELCOME : 0);
      expect(fakeDb.state.welcomeGrants.get(userId)?.outcome).toBe(granted ? "GRANTED" : "RECENT_IP");
      expect(await getCreditBalance(userId, JUNE)).toMatchObject({
        purchasedCredits: granted ? WELCOME : 0,
        planCredits: MONTHLY
      });
    }
    expect(welcomeGrants()).toHaveLength(limit);
  });

  it.each([0, 1])("uses country limits with equal welcome amounts and regional pricing toggle %i", async (enabled) => {
    setCreditPricing({
      ...DEFAULT_CREDIT_COSTS,
      welcomeCreditsRegionalEnabled: enabled,
      welcomeCredits: 500,
      welcomeCreditsHighIncome: 500,
      welcomeCreditsLowMiddleIncome: 500
    });
    for (const country of ["US", "IN"]) {
      for (let index = 0; index < 3; index += 1) {
        const userId = `${country}-${index}`;
        pendingGrant(userId, `ip-${country}`, country);
        await ensureCurrentPlanPeriod(userId, JUNE);
        expect(await getWelcomeCreditsGranted(userId)).toBe(index < (country === "US" ? 2 : 1) ? 500 : 0);
      }
    }
    expect(welcomeGrants()).toHaveLength(3);
  });

  it.each([["US", 3], ["IN", 2], [null, 2]] as const)(
    "enforces the configured same-IP cap for %s", async (country, limit) => {
      setCreditPricing({ ...DEFAULT_CREDIT_COSTS,
        welcomeCreditsAccountsPerIpHighIncome: 3, welcomeCreditsAccountsPerIpLowMiddleIncome: 2 });
      for (let index = 0; index <= limit; index += 1) {
        const userId = `user-${index}`;
        pendingGrant(userId, "ip-shared", country);
        await ensureCurrentPlanPeriod(userId, JUNE);
        expect(await getWelcomeCreditsGranted(userId)).toBe(index < limit ? WELCOME : 0);
      }
      expect(welcomeGrants()).toHaveLength(limit);
    }
  );

  it.each(["US", "IN", null])("disables the welcome gift for %s when its IP cap is zero", async (country) => {
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS,
      welcomeCreditsAccountsPerIpHighIncome: 0, welcomeCreditsAccountsPerIpLowMiddleIncome: 0 });
    pendingGrant("user-a", "ip-shared", country);
    await ensureCurrentPlanPeriod("user-a", JUNE);
    expect(fakeDb.state.welcomeGrants.get("user-a")?.outcome).toBe("DISABLED");
    expect(await getCreditBalance("user-a", JUNE)).toMatchObject({ purchasedCredits: 0, planCredits: MONTHLY });
    expect(welcomeGrants()).toHaveLength(0);
  });

  it("applies changed caps to new claims while keeping rejected claims settled", async () => {
    pendingGrant("first", "ip-shared", "US");
    await ensureCurrentPlanPeriod("first", JUNE);
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, welcomeCreditsAccountsPerIpHighIncome: 1 });
    pendingGrant("rejected", "ip-shared", "US");
    await ensureCurrentPlanPeriod("rejected", JUNE);
    expect(await getWelcomeCreditsGranted("rejected")).toBe(0);

    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, welcomeCreditsAccountsPerIpHighIncome: 3 });
    await ensureCurrentPlanPeriod("rejected", JUNE);
    expect(fakeDb.state.welcomeGrants.get("rejected")?.outcome).toBe("RECENT_IP");
    for (const userId of ["second", "third", "fourth"]) {
      pendingGrant(userId, "ip-shared", "US");
      await ensureCurrentPlanPeriod(userId, JUNE);
    }
    expect(await getWelcomeCreditsGranted("second")).toBe(WELCOME);
    expect(await getWelcomeCreditsGranted("third")).toBe(WELCOME);
    expect(await getWelcomeCreditsGranted("fourth")).toBe(0);
    expect(welcomeGrants()).toHaveLength(3);
  });

  it.each([["US", 4], ["IN", 3]] as const)(
    "keeps overlapping %s claims within the configured cap", async (country, limit) => {
      setCreditPricing({ ...DEFAULT_CREDIT_COSTS,
        welcomeCreditsAccountsPerIpHighIncome: 4, welcomeCreditsAccountsPerIpLowMiddleIncome: 3 });
      const userIds = Array.from({ length: limit + 1 }, (_, index) => `user-${index}`);
      for (const userId of userIds) pendingGrant(userId, "ip-shared", country);
      await Promise.all(userIds.map((userId) => ensureCurrentPlanPeriod(userId, JUNE)));
      expect(welcomeGrants()).toHaveLength(limit);
      expect(userIds.filter((userId) => fakeDb.state.welcomeGrants.get(userId)?.outcome === "RECENT_IP")).toHaveLength(1);
    }
  );

  it("counts grants across country groups toward the same IP quota", async () => {
    pendingGrant("lower-first", "ip-shared", "IN");
    pendingGrant("higher-second", "ip-shared", "US");
    pendingGrant("higher-third", "ip-shared", "CA");
    for (const userId of ["lower-first", "higher-second", "higher-third"]) {
      await ensureCurrentPlanPeriod(userId, JUNE);
    }

    expect(await getWelcomeCreditsGranted("lower-first")).toBe(WELCOME);
    expect(await getWelcomeCreditsGranted("higher-second")).toBe(WELCOME);
    expect(await getWelcomeCreditsGranted("higher-third")).toBe(0);
    expect(welcomeGrants()).toHaveLength(2);
  });

  it("withholds a lower-income claim after a high-income grant from the same IP", async () => {
    pendingGrant("higher-first", "ip-shared", "US");
    pendingGrant("lower-second", "ip-shared", "IN");
    await ensureCurrentPlanPeriod("higher-first", JUNE);
    await ensureCurrentPlanPeriod("lower-second", JUNE);

    expect(await getWelcomeCreditsGranted("higher-first")).toBe(WELCOME);
    expect(await getWelcomeCreditsGranted("lower-second")).toBe(0);
    expect(fakeDb.state.welcomeGrants.get("lower-second")?.outcome).toBe("RECENT_IP");
  });

  it("expires high-income IP grants after 30 days and keeps rejected claims settled", async () => {
    for (const userId of ["first", "second"]) {
      pendingGrant(userId, "ip-shared", "US");
      await ensureCurrentPlanPeriod(userId, JUNE);
    }

    const boundary = new Date(JUNE.getTime() + WELCOME_CREDITS_IP_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    pendingGrant("at-boundary", "ip-shared", "US");
    await ensureCurrentPlanPeriod("at-boundary", boundary);
    expect(await getWelcomeCreditsGranted("at-boundary")).toBe(0);

    const afterBoundary = new Date(boundary.getTime() + 1);
    await ensureCurrentPlanPeriod("at-boundary", afterBoundary);
    expect(fakeDb.state.welcomeGrants.get("at-boundary")?.outcome).toBe("RECENT_IP");
    pendingGrant("after-boundary", "ip-shared", "US");
    await ensureCurrentPlanPeriod("after-boundary", afterBoundary);
    expect(await getWelcomeCreditsGranted("after-boundary")).toBe(WELCOME);
    expect(welcomeGrants()).toHaveLength(3);
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

  it("only two of three overlapping high-income same-IP first opens are granted", async () => {
    const userIds = ["user-a", "user-b", "user-c"];
    for (const userId of userIds) {
      pendingGrant(userId, "ip-shared", "US");
    }
    await Promise.all(userIds.map((userId) => ensureCurrentPlanPeriod(userId, JUNE)));

    expect(fakeDb.prisma.$queryRaw.mock.calls.some((call) => welcomeIpLockSql(call, "ip-shared"))).toBe(true);
    const outcomes = userIds.map((userId) => fakeDb.state.welcomeGrants.get(userId)?.outcome);
    expect(outcomes.filter((outcome) => outcome === "GRANTED")).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome === "RECENT_IP")).toHaveLength(1);
    expect(welcomeGrants()).toHaveLength(2);
    for (const userId of userIds) {
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

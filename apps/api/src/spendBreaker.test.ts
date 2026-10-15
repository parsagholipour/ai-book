import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", () => ({ prisma: {} }));
vi.mock("@book-maker/db/billing", () => ({ hasActiveSubscriptionEntitlement: vi.fn(async () => false) }));

import {
  SpendBreaker,
  decideAiAccess,
  paidSpendStateFor,
  spendStateFor,
  type AiWorkKind,
  type PaidSpendState,
  type SpendState
} from "./spendBreaker.js";
import { DEFAULT_AI_SPEND_CONTROLS, type AiSpendControls } from "./spendControls.js";

const NOON = Date.parse("2026-10-13T12:00:00.000Z");
const MIDNIGHT = new Date("2026-10-14T00:00:00.000Z");
const NEXT_MONTH = new Date("2026-11-01T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const KINDS: AiWorkKind[] = ["standard", "ultra", "voice", "audiobook"];
const CAPS = { freeUserDailyCapUsd: 1.5, paidUserDailyCapUsd: 30 };
const WINDOWS = { resetsAt: MIDNIGHT, monthResetsAt: NEXT_MONTH };

function silentLog() {
  return { warn: vi.fn(), error: vi.fn() };
}

describe("decideAiAccess", () => {
  const cases: Array<[SpendState, PaidSpendState, boolean, AiWorkKind, string]> = [];
  for (const state of ["normal", "soft", "hard", "monthly"] as const) {
    for (const paidState of ["normal", "capped"] as const) {
      for (const paidPlan of [false, true]) {
        for (const kind of KINDS) {
          const expected = paidPlan
            ? paidState === "capped"
              ? "AI_PAUSED:paid_cap"
              : "allowed"
            : state === "monthly" || state === "hard"
              ? `AI_PAUSED:${state}`
              : state === "soft" && kind !== "standard"
                ? "AI_BUSY"
                : "allowed";
          cases.push([state, paidState, paidPlan, kind, expected]);
        }
      }
    }
  }
  for (const paidPlan of [false, true]) {
    for (const kind of KINDS) cases.push(["paused", "paused", paidPlan, kind, "AI_PAUSED:paused"]);
  }

  it.each(cases)("free %s, paid %s, paid plan %s, %s work → %s", (state, paidState, paidPlan, kind, expected) => {
    const decision = decideAiAccess({ state, paidState, kind, paidPlan, userSpendUsd: 0, controls: CAPS, ...WINDOWS });
    expect(decision.allowed ? "allowed" : decision.code === "AI_PAUSED" ? `AI_PAUSED:${decision.state}` : decision.code).toBe(
      expected
    );
  });

  it("tells a free reader when each pause ends: the day for the hard cap, the month for the ceiling", () => {
    const base = { paidState: "normal" as const, kind: "standard" as const, paidPlan: false, userSpendUsd: 0, controls: CAPS, ...WINDOWS };
    expect(decideAiAccess({ ...base, state: "hard" })).toEqual({ allowed: false, code: "AI_PAUSED", state: "hard", resetsAt: MIDNIGHT });
    expect(decideAiAccess({ ...base, state: "monthly" })).toEqual({
      allowed: false,
      code: "AI_PAUSED",
      state: "monthly",
      resetsAt: NEXT_MONTH
    });
    expect(decideAiAccess({ ...base, state: "paused", paidState: "paused" })).toEqual({ allowed: false, code: "AI_PAUSED", state: "paused" });
  });

  it("holds each reader to their own plan's cap, in every state that lets them through", () => {
    for (const state of ["normal", "soft"] as const) {
      const free = decideAiAccess({ state, paidState: "normal", kind: "standard", paidPlan: false, userSpendUsd: 1.5, controls: CAPS, ...WINDOWS });
      expect(free).toEqual({ allowed: false, code: "AI_DAILY_LIMIT", resetsAt: MIDNIGHT, capUsd: 1.5 });
    }
    for (const state of ["normal", "soft", "hard", "monthly"] as const) {
      expect(decideAiAccess({ state, paidState: "normal", kind: "standard", paidPlan: true, userSpendUsd: 1.5, controls: CAPS, ...WINDOWS }))
        .toEqual({ allowed: true });
      expect(decideAiAccess({ state, paidState: "normal", kind: "voice", paidPlan: true, userSpendUsd: 30, controls: CAPS, ...WINDOWS }))
        .toMatchObject({ allowed: false, code: "AI_DAILY_LIMIT", capUsd: 30 });
    }
  });

  it("applies no per-reader cap when there is no reader spend to compare", () => {
    expect(decideAiAccess({ state: "normal", paidState: "normal", kind: "ultra", paidPlan: false, userSpendUsd: null, controls: CAPS, ...WINDOWS }))
      .toEqual({ allowed: true });
  });

  it("orders the pause over the month, the month over the day, and the day's caps over nothing", () => {
    const controls = { ...DEFAULT_AI_SPEND_CONTROLS };
    expect(spendStateFor(controls, 0, 0)).toBe("normal");
    expect(spendStateFor(controls, 5, 5)).toBe("soft");
    expect(spendStateFor(controls, 12, 12)).toBe("hard");
    expect(spendStateFor(controls, 1, 150)).toBe("monthly");
    expect(spendStateFor(controls, 13, 150)).toBe("monthly");
    expect(spendStateFor({ ...controls, paused: true }, 0, 0)).toBe("paused");
    expect(paidSpendStateFor(controls, 59.99)).toBe("normal");
    expect(paidSpendStateFor(controls, 60)).toBe("capped");
    expect(paidSpendStateFor({ ...controls, paused: true }, 0)).toBe("paused");
  });

  it("ships the launch defaults: $5 soft and $12 hard on free spend, $150 a month, $60 on paid spend", () => {
    expect(DEFAULT_AI_SPEND_CONTROLS).toMatchObject({
      paused: false,
      softDailyCapUsd: 5,
      hardDailyCapUsd: 12,
      freeMonthlyCapUsd: 150,
      paidHardDailyCapUsd: 60,
      freeUserDailyCapUsd: 1.5,
      paidUserDailyCapUsd: 30
    });
  });
});

type Row = { userId: string | null; usd: number; at: number };
type FakeClient = ReturnType<typeof fakeClient>;
type GroupByArgs = { where: { createdAt: { gte: Date; lt: Date } } };

/**
 * The tables the breaker reads, in memory: priced call rows, the paid readers'
 * plan rows (any reader in `planHolders` held one all month) and the controls.
 */
function fakeClient(options: { controls?: Partial<AiSpendControls> | null; rows?: Row[]; planHolders?: string[] } = {}) {
  const state = {
    controls: options.controls ?? null,
    rows: [...(options.rows ?? [])],
    planHolders: new Set(options.planHolders ?? [])
  };
  const client = {
    state,
    aiSpendControlRevision: {
      findFirst: vi.fn(async () =>
        state.controls
          ? {
              version: 3,
              paused: false,
              softDailyCapUsd: 5,
              hardDailyCapUsd: 12,
              freeMonthlyCapUsd: 150,
              paidHardDailyCapUsd: 60,
              freeUserDailyCapUsd: 1.5,
              paidUserDailyCapUsd: 30,
              note: null,
              updatedBy: "operator-console",
              createdAt: new Date(NOON),
              ...state.controls
            }
          : null
      )
    },
    providerCallLog: {
      groupBy: vi.fn(async ({ where }: GroupByArgs) => {
        const sums = new Map<string | null, number>();
        for (const row of state.rows) {
          if (row.at < where.createdAt.gte.getTime() || row.at >= where.createdAt.lt.getTime()) continue;
          sums.set(row.userId, (sums.get(row.userId) ?? 0) + row.usd);
        }
        return [...sums].map(([userId, usd]) => ({ userId, _sum: { costHint: usd } }));
      }),
      aggregate: vi.fn(async ({ where }: { where: { userId?: string; createdAt: { gte: Date } } }) => ({
        _sum: {
          costHint: state.rows
            .filter((row) => row.userId === where.userId && row.at >= where.createdAt.gte.getTime())
            .reduce((sum, row) => sum + row.usd, 0)
        }
      }))
    },
    userEntitlement: {
      findMany: vi.fn(async ({ where }: { where: { userId: { in: string[] } } }) =>
        where.userId.in.filter((userId) => state.planHolders.has(userId)).map((userId) => ({ userId }))
      )
    }
  };
  return client;
}

/** Spend written this morning. */
function today(userId: string | null, usd: number): Row {
  return { userId, usd, at: NOON - HOUR };
}

/** Spend written earlier this month. */
function earlierThisMonth(userId: string | null, usd: number): Row {
  return { userId, usd, at: NOON - 5 * DAY };
}

function breakerFor(client: FakeClient, paid: (userId: string) => Promise<boolean> = async () => false) {
  let now = NOON;
  const isOnPaidPlan = vi.fn(paid);
  const breaker = new SpendBreaker({ client: client as never, isOnPaidPlan, now: () => now });
  return {
    breaker,
    isOnPaidPlan,
    advance: (ms: number) => {
      now += ms;
    }
  };
}

function reads(client: FakeClient, window: "today" | "earlier"): number {
  return client.providerCallLog.groupBy.mock.calls.filter(([args]) => {
    const fromMidnight = args.where.createdAt.gte.getUTCHours() === 0 && args.where.createdAt.gte.getUTCDate() !== 1;
    return window === "today" ? fromMidnight : !fromMidnight;
  }).length;
}

describe("SpendBreaker", () => {
  let log: ReturnType<typeof silentLog>;
  beforeEach(() => {
    log = silentLog();
  });

  it("reads today once a minute and the month's earlier days once a day, and a burst of doors shares one read", async () => {
    const client = fakeClient({ rows: [today(null, 1)] });
    const { breaker, advance } = breakerFor(client);

    await Promise.all(Array.from({ length: 20 }, (_, index) => breaker.check(`user-${index}`, "standard", log)));
    expect(reads(client, "today")).toBe(1);
    expect(reads(client, "earlier")).toBe(1);
    expect(client.aiSpendControlRevision.findFirst).toHaveBeenCalledTimes(1);

    advance(59_000);
    await breaker.check("user-0", "standard", log);
    expect(reads(client, "today")).toBe(1);

    advance(1_000);
    await breaker.check("user-0", "standard", log);
    expect(reads(client, "today")).toBe(2);
    expect(reads(client, "earlier")).toBe(1);

    advance(DAY);
    await breaker.check("user-0", "standard", log);
    expect(reads(client, "today")).toBe(3);
    expect(reads(client, "earlier")).toBe(2);
  });

  it("refuses everyone while paused, without reading anyone's spend or plan", async () => {
    const client = fakeClient({ controls: { paused: true } });
    const { breaker, isOnPaidPlan } = breakerFor(client, async () => true);

    expect(await breaker.check("user-a", "standard", log)).toEqual({ allowed: false, code: "AI_PAUSED", state: "paused" });
    expect(client.providerCallLog.aggregate).not.toHaveBeenCalled();
    expect(isOnPaidPlan).not.toHaveBeenCalled();
  });

  it("past the free hard cap refuses free accounts until 00:00 UTC and leaves paying readers to their own cap", async () => {
    const client = fakeClient({ rows: [today("free-1", 7), today("free-2", 6)] });
    const { breaker } = breakerFor(client, async (userId) => userId.startsWith("paid"));

    expect(await breaker.check("free-3", "standard", log)).toEqual({ allowed: false, code: "AI_PAUSED", state: "hard", resetsAt: MIDNIGHT });
    expect(await breaker.check("paid-1", "ultra", log)).toEqual({ allowed: true });
    expect((await breaker.globalView(log)).state).toBe("hard");
    expect(breaker.holdsWelcomeGrants()).toBe(true);
  });

  it("never lets paying readers' spend trip a free cap or hold a welcome grant", async () => {
    const client = fakeClient({ rows: [today("paid-1", 30), today("paid-2", 25)], planHolders: ["paid-1", "paid-2"] });
    const { breaker } = breakerFor(client);

    const view = await breaker.globalView(log);
    expect(view).toMatchObject({ state: "normal", paidState: "normal", freeSpendUsd: 0, today: { paidUsd: 55, freeUsd: 0 } });
    expect(await breaker.check("free-1", "ultra", log)).toEqual({ allowed: true });
    expect(breaker.holdsWelcomeGrants()).toBe(false);
  });

  it("counts spend that names no reader as free", async () => {
    const client = fakeClient({ rows: [today(null, 12.5), today("paid-1", 3)], planHolders: ["paid-1"] });
    const { breaker } = breakerFor(client);

    expect(await breaker.globalView(log)).toMatchObject({
      state: "hard",
      freeSpendUsd: 12.5,
      today: { freeUsd: 0, paidUsd: 3, unattributedUsd: 12.5 }
    });
  });

  it("counts the operator's own console books as paid, and never caps or holds back the operator", async () => {
    const client = fakeClient({ rows: [today("local-admin", 40), today(null, 13)] });
    const { breaker, isOnPaidPlan } = breakerFor(client);

    expect((await breaker.globalView(log)).today).toEqual({ freeUsd: 0, paidUsd: 40, unattributedUsd: 13 });
    expect(await breaker.check("local-admin", "ultra", log)).toEqual({ allowed: true });
    expect(client.providerCallLog.aggregate).not.toHaveBeenCalled();
    expect(isOnPaidPlan).not.toHaveBeenCalled();
    expect(client.userEntitlement.findMany).not.toHaveBeenCalled();
  });

  it("past the monthly ceiling refuses free accounts until the month turns, on a quiet day", async () => {
    const client = fakeClient({
      rows: [earlierThisMonth("free-1", 100), earlierThisMonth(null, 49), earlierThisMonth("paid-1", 500), today("free-2", 1)],
      planHolders: ["paid-1"]
    });
    const { breaker, advance } = breakerFor(client, async (userId) => userId.startsWith("paid"));

    expect(await breaker.globalView(log)).toMatchObject({ state: "monthly", freeSpendUsd: 1, monthFreeSpendUsd: 150, monthResetsAt: NEXT_MONTH });
    expect(await breaker.check("free-3", "standard", log)).toEqual({
      allowed: false,
      code: "AI_PAUSED",
      state: "monthly",
      resetsAt: NEXT_MONTH
    });
    expect(await breaker.check("paid-2", "standard", log)).toEqual({ allowed: true });
    expect(breaker.holdsWelcomeGrants()).toBe(true);

    // The operator raises the ceiling: free accounts are back at once.
    client.state.controls = { freeMonthlyCapUsd: 200 };
    breaker.forget();
    expect(await breaker.check("free-3", "standard", log)).toEqual({ allowed: true });

    // And a new month starts from nothing.
    client.state.controls = null;
    advance(19 * DAY);
    expect(await breaker.globalView(log)).toMatchObject({ state: "normal", monthFreeSpendUsd: 0 });
  });

  it("past the paid cap refuses paying readers with the operator's pause sentence, and leaves free accounts alone", async () => {
    const client = fakeClient({ rows: [today("paid-1", 29), today("paid-2", 31)], planHolders: ["paid-1", "paid-2"] });
    const { breaker } = breakerFor(client, async (userId) => userId.startsWith("paid"));

    expect(await breaker.globalView(log)).toMatchObject({ state: "normal", paidState: "capped" });
    expect(await breaker.check("paid-3", "standard", log)).toEqual({ allowed: false, code: "AI_PAUSED", state: "paid_cap" });
    expect(await breaker.check("free-1", "standard", log)).toEqual({ allowed: true });
    expect(breaker.holdsWelcomeGrants()).toBe(false);
  });

  it("past the soft cap holds free accounts to standard work and leaves paid ones alone", async () => {
    const client = fakeClient({ rows: [today("free-1", 6)] });
    const { breaker } = breakerFor(client, async (userId) => userId === "paid");

    for (const kind of ["ultra", "voice", "audiobook"] as const) {
      expect(await breaker.check("free", kind, log)).toEqual({ allowed: false, code: "AI_BUSY", resetsAt: MIDNIGHT });
      expect(await breaker.check("paid", kind, log)).toEqual({ allowed: true });
    }
    expect(await breaker.check("free", "standard", log)).toEqual({ allowed: true });
  });

  it("caps a reader's own day and resets it at 00:00 UTC", async () => {
    const client = fakeClient({ rows: [today("free", 1.6), today("paid", 1.6)] });
    const { breaker, advance } = breakerFor(client, async (userId) => userId === "paid");

    expect(await breaker.check("free", "standard", log)).toEqual({
      allowed: false,
      code: "AI_DAILY_LIMIT",
      resetsAt: MIDNIGHT,
      capUsd: 1.5
    });
    expect(await breaker.check("paid", "standard", log)).toEqual({ allowed: true });

    // A new UTC day sums from its own midnight.
    advance(12 * HOUR);
    expect(await breaker.check("free", "standard", log)).toEqual({ allowed: true });
    const lastUserRead = client.providerCallLog.aggregate.mock.calls.at(-1)?.[0];
    expect(lastUserRead?.where.createdAt.gte).toEqual(MIDNIGHT);
  });

  it("caps a paying reader's own day past the free hard cap too", async () => {
    const client = fakeClient({ rows: [today(null, 20), today("paid", 31)] });
    const { breaker } = breakerFor(client, async (userId) => userId === "paid");

    expect(await breaker.check("paid", "standard", log)).toMatchObject({ allowed: false, code: "AI_DAILY_LIMIT", capUsd: 30 });
  });

  it("reads a reader's plan only when the answer depends on it", async () => {
    const client = fakeClient({ rows: [today("reader", 0.2)] });
    const { breaker, isOnPaidPlan } = breakerFor(client);

    await breaker.check("reader", "ultra", log);
    expect(isOnPaidPlan).not.toHaveBeenCalled();
  });

  it("refuses a free reader past the hard cap without reading their own spend", async () => {
    const client = fakeClient({ rows: [today(null, 13)] });
    const { breaker } = breakerFor(client);

    expect(await breaker.check("free", "standard", log)).toMatchObject({ code: "AI_PAUSED", state: "hard" });
    expect(client.providerCallLog.aggregate).not.toHaveBeenCalled();
  });

  it("fails open when nothing has been read yet, and says so", async () => {
    const client = fakeClient();
    client.aiSpendControlRevision.findFirst.mockRejectedValue(new Error("db down"));
    client.providerCallLog.groupBy.mockRejectedValue(new Error("db down"));
    client.providerCallLog.aggregate.mockRejectedValue(new Error("db down"));
    const { breaker } = breakerFor(client);

    expect(await breaker.check("user-a", "ultra", log)).toEqual({ allowed: true });
    const events = log.error.mock.calls.map(([object]) => (object as { event: string }).event);
    expect(events).toEqual(
      expect.arrayContaining([
        "ai_spend.controls_read_failed",
        "ai_spend.global_spend_read_failed",
        "ai_spend.month_spend_read_failed",
        "ai_spend.user_spend_read_failed"
      ])
    );
  });

  it("fails open when the readers' plans cannot be classified, keeping what it saw", async () => {
    const client = fakeClient({ rows: [today("free-1", 13)] });
    const { breaker, advance } = breakerFor(client);
    expect((await breaker.globalView(log)).state).toBe("hard");

    client.userEntitlement.findMany.mockRejectedValue(new Error("db down"));
    advance(61_000);
    expect((await breaker.globalView(log)).state).toBe("hard");
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ event: "ai_spend.global_spend_read_failed" }), expect.any(String));
  });

  it("keeps a pause it has already seen through a failed read", async () => {
    const client = fakeClient({ controls: { paused: true } });
    const { breaker, advance } = breakerFor(client);
    expect(await breaker.check("user-a", "standard", log)).toMatchObject({ code: "AI_PAUSED" });

    client.aiSpendControlRevision.findFirst.mockRejectedValue(new Error("db down"));
    client.providerCallLog.groupBy.mockRejectedValue(new Error("db down"));
    advance(61_000);
    expect(await breaker.check("user-a", "standard", log)).toMatchObject({ code: "AI_PAUSED", state: "paused" });

    // A console save drops the cache but not the values a failed read falls back on.
    breaker.forget();
    expect(await breaker.check("user-a", "standard", log)).toMatchObject({ code: "AI_PAUSED" });
  });

  it("keeps today's spend through a failed read, because spend only grows within a day", async () => {
    const client = fakeClient({ rows: [today("free-1", 13)] });
    const { breaker, advance } = breakerFor(client);
    expect(await breaker.check("user-a", "standard", log)).toMatchObject({ code: "AI_PAUSED", state: "hard" });

    client.providerCallLog.groupBy.mockRejectedValue(new Error("db down"));
    advance(61_000);
    expect(await breaker.check("user-a", "standard", log)).toMatchObject({ code: "AI_PAUSED", state: "hard" });

    // A new day has seen nothing yet today, and the month's earlier days
    // cannot be read either: open.
    advance(12 * HOUR);
    expect(await breaker.check("user-a", "standard", log)).toEqual({ allowed: true });
  });

  it("keeps the month's earlier figure through a failed read and asks again on the next refresh", async () => {
    const client = fakeClient({ rows: [earlierThisMonth("free-1", 151)] });
    const { breaker, advance } = breakerFor(client);
    expect((await breaker.globalView(log)).state).toBe("monthly");

    // Tomorrow's read of the earlier days fails: yesterday's figure is a floor.
    const groupBy = client.providerCallLog.groupBy.getMockImplementation();
    client.providerCallLog.groupBy.mockImplementation(async (args: GroupByArgs) => {
      if (args.where.createdAt.gte.getUTCDate() === 1) throw new Error("db down");
      return groupBy!(args);
    });
    advance(DAY);
    expect((await breaker.globalView(log)).state).toBe("monthly");
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ event: "ai_spend.month_spend_read_failed" }), expect.any(String));

    client.providerCallLog.groupBy.mockImplementation(groupBy!);
    advance(61_000);
    await breaker.globalView(log);
    expect(reads(client, "earlier")).toBe(3);
  });

  it("treats a reader whose plan cannot be read as paid", async () => {
    const client = fakeClient({ rows: [today("reader", 2), today(null, 5)] });
    const { breaker } = breakerFor(client, async () => {
      throw new Error("db down");
    });

    expect(await breaker.check("reader", "voice", log)).toEqual({ allowed: true });
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ event: "ai_spend.plan_read_failed" }), expect.any(String));
  });

  it("warns once per process per day for each cap it sees crossed, and once per month for the ceiling", async () => {
    const client = fakeClient({ rows: [today("free-1", 6)] });
    const { breaker, advance } = breakerFor(client);

    await breaker.check("a", "standard", log);
    advance(61_000);
    await breaker.check("b", "standard", log);
    client.state.rows.push(today("free-2", 44), today("paid-1", 70));
    client.state.planHolders.add("paid-1");
    advance(61_000);
    await breaker.check("c", "standard", log);
    advance(61_000);
    await breaker.check("d", "standard", log);

    expect(log.warn.mock.calls.map(([object]) => (object as { event: string }).event)).toEqual([
      "ai_spend.soft_cap_reached",
      "ai_spend.hard_cap_reached",
      "ai_spend.paid_cap_reached"
    ]);
    expect(log.warn.mock.calls[0]?.[0]).toMatchObject({ day: "2026-10-13", freeSpendUsd: 6, softDailyCapUsd: 5 });

    // The next day: $50 of free spend this month, then $101 more today.
    client.state.rows.push({ userId: "free-3", usd: 101, at: NOON + DAY - HOUR });
    advance(DAY);
    await breaker.check("e", "standard", log);
    advance(61_000);
    await breaker.check("f", "standard", log);
    expect(log.warn.mock.calls.slice(3).map(([object]) => (object as { event: string }).event)).toEqual(["ai_spend.monthly_cap_reached"]);
  });

  it("holds welcome grants only while free spend is past the soft cap or the ceiling, or AI is paused", async () => {
    const client = fakeClient({ rows: [today("free-1", 6)] });
    const { breaker, advance } = breakerFor(client);
    expect(breaker.holdsWelcomeGrants()).toBe(false);

    await breaker.globalView(log);
    expect(breaker.holdsWelcomeGrants()).toBe(true);

    // What it read belongs to that day only.
    advance(12 * HOUR);
    expect(breaker.holdsWelcomeGrants()).toBe(false);

    client.state.rows = [];
    await breaker.globalView(log);
    expect(breaker.holdsWelcomeGrants()).toBe(false);

    client.state.controls = { paused: true };
    breaker.forget();
    await breaker.globalView(log);
    expect(breaker.holdsWelcomeGrants()).toBe(true);
  });

  it("re-reads after a console save", async () => {
    const client = fakeClient();
    const { breaker } = breakerFor(client);
    await breaker.check("user-a", "standard", log);

    client.state.controls = { paused: true };
    breaker.forget();
    expect(await breaker.check("user-a", "standard", log)).toMatchObject({ code: "AI_PAUSED" });
  });
});

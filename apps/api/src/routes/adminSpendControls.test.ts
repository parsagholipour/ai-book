import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAuth } from "../auth.js";
import { spendBreaker } from "../spendBreaker.js";
import { adminSpendControlRoutes } from "./adminSpendControls.js";

const mockPrisma = vi.hoisted(() => ({
  $transaction: vi.fn(),
  user: { upsert: vi.fn(), findMany: vi.fn() },
  aiSpendControlRevision: { findFirst: vi.fn(), create: vi.fn() },
  providerCallLog: { aggregate: vi.fn(), groupBy: vi.fn() },
  userEntitlement: { findMany: vi.fn() }
}));

vi.mock("@book-maker/db", () => ({ prisma: mockPrisma }));
vi.mock("@book-maker/db/billing", () => ({ hasActiveSubscriptionEntitlement: vi.fn(async () => false) }));

const savedControls = {
  paused: true,
  softDailyCapUsd: 4,
  hardDailyCapUsd: 10,
  freeMonthlyCapUsd: 100,
  paidHardDailyCapUsd: 80,
  freeUserDailyCapUsd: 1,
  paidUserDailyCapUsd: 25
};

const NOW = new Date("2026-10-13T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

type GroupByArgs = { take?: number; where: { createdAt: { gte: Date; lt?: Date } } };

describe("admin spend controls", () => {
  let revisions: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    spendBreaker.reset();
    revisions = [];
    mockPrisma.user.upsert.mockResolvedValue({ id: "local-admin" });
    mockPrisma.$transaction.mockImplementation(async (operation: (tx: typeof mockPrisma) => Promise<unknown>) =>
      operation(mockPrisma)
    );
    mockPrisma.aiSpendControlRevision.findFirst.mockImplementation(async () => revisions.at(-1) ?? null);
    mockPrisma.aiSpendControlRevision.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `revision-${String(data.version)}`, createdAt: new Date("2026-10-13T09:00:00.000Z"), ...data };
      revisions.push(row);
      return row;
    });
    mockPrisma.providerCallLog.aggregate.mockResolvedValue({ _sum: { costHint: 0 } });
    mockPrisma.providerCallLog.groupBy.mockImplementation(async ({ take, where }: GroupByArgs) => {
      // Today's top spenders, today's breakdown, and the month's earlier days.
      if (take !== undefined) {
        return [
          { userId: "user-b", _sum: { costHint: 1.75 } },
          { userId: "user-a", _sum: { costHint: 0.5 } }
        ];
      }
      const today = where.createdAt.lt !== undefined && where.createdAt.lt.getTime() - where.createdAt.gte.getTime() === DAY_MS;
      return today
        ? [
            { userId: "user-b", _sum: { costHint: 1.75 } },
            { userId: "user-a", _sum: { costHint: 0.5 } },
            { userId: null, _sum: { costHint: 1 } }
          ]
        : [{ userId: "user-a", _sum: { costHint: 20 } }];
    });
    mockPrisma.userEntitlement.findMany.mockImplementation(async ({ where }: { where: { userId: { in: string[] } } }) =>
      where.userId.in.filter((userId) => userId === "user-b").map((userId) => ({ userId }))
    );
    mockPrisma.user.findMany.mockResolvedValue([
      { id: "user-a", email: "a@example.com" },
      { id: "user-b", email: "b@example.com" }
    ]);
  });
  afterEach(() => {
    spendBreaker.reset();
    vi.useRealTimers();
  });

  it("shows the defaults, today's spend by plan, the month's free spend and their states before anything is saved", async () => {
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/admin/spend-controls" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.controls).toMatchObject({
      version: 0,
      paused: false,
      softDailyCapUsd: 5,
      hardDailyCapUsd: 12,
      freeMonthlyCapUsd: 150,
      paidHardDailyCapUsd: 60,
      freeUserDailyCapUsd: 1.5,
      paidUserDailyCapUsd: 30,
      updatedAt: null
    });
    expect(body.defaults).toEqual({
      paused: false,
      softDailyCapUsd: 5,
      hardDailyCapUsd: 12,
      freeMonthlyCapUsd: 150,
      paidHardDailyCapUsd: 60,
      freeUserDailyCapUsd: 1.5,
      paidUserDailyCapUsd: 30
    });
    expect(body.today).toEqual({
      day: "2026-10-13",
      resetsAt: "2026-10-14T00:00:00.000Z",
      state: "normal",
      paidState: "normal",
      freeUsd: 0.5,
      paidUsd: 1.75,
      unattributedUsd: 1,
      freeSpendUsd: 1.5,
      totalUsd: 3.25
    });
    expect(body.month).toEqual({ month: "2026-10", resetsAt: "2026-11-01T00:00:00.000Z", freeSpendUsd: 21.5 });
    expect(body.topSpenders).toEqual([
      { userId: "user-b", email: "b@example.com", spendUsd: 1.75, paidPlan: true },
      { userId: "user-a", email: "a@example.com", spendUsd: 0.5, paidPlan: false }
    ]);
    // Summed from the start of the UTC day, attributed rows only, biggest first.
    expect(mockPrisma.providerCallLog.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["userId"],
        where: expect.objectContaining({ costHint: { not: null }, userId: { not: null } }),
        orderBy: { _sum: { costHint: "desc" } },
        take: 10
      })
    );
    await app.close();
  });

  it("appends a revision on every save and acts on it at once", async () => {
    const app = await buildApp();
    // The breaker has read the defaults and holds them for a minute.
    expect(await spendBreaker.check("user-a", "standard")).toEqual({ allowed: true });

    const first = await app.inject({
      method: "PUT",
      url: "/api/admin/spend-controls",
      payload: { ...savedControls, note: "Provider bill spiked" }
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ controls: { version: 1, ...savedControls, note: "Provider bill spiked", updatedBy: "operator-console" }, today: { state: "paused" } });
    expect(await spendBreaker.check("user-a", "standard")).toMatchObject({ allowed: false, code: "AI_PAUSED" });

    const second = await app.inject({
      method: "PUT",
      url: "/api/admin/spend-controls",
      payload: { ...savedControls, paused: false }
    });
    expect(second.json()).toMatchObject({ controls: { version: 2, paused: false }, today: { state: "normal" } });
    expect(mockPrisma.aiSpendControlRevision.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.aiSpendControlRevision.create.mock.calls[1]?.[0]).toEqual({
      data: { version: 2, ...savedControls, paused: false, note: null, updatedBy: "operator-console" }
    });
    expect(await spendBreaker.check("user-a", "standard")).toEqual({ allowed: true });
    await app.close();
  });

  it.each([
    ["a soft cap above the hard cap", { ...savedControls, softDailyCapUsd: 50 }, "softDailyCapUsd"],
    ["a negative cap", { ...savedControls, freeUserDailyCapUsd: -1 }, "freeUserDailyCapUsd"],
    ["a missing cap", { ...savedControls, paidUserDailyCapUsd: undefined }, "paidUserDailyCapUsd"],
    ["a save without the monthly ceiling", { ...savedControls, freeMonthlyCapUsd: undefined }, "freeMonthlyCapUsd"],
    ["a negative paid cap", { ...savedControls, paidHardDailyCapUsd: -5 }, "paidHardDailyCapUsd"],
    ["a cap that is not a number", { ...savedControls, hardDailyCapUsd: "forty" }, "hardDailyCapUsd"],
    ["a pause that is not a switch", { ...savedControls, paused: "maybe" }, "paused"]
  ])("refuses %s without writing anything", async (_label, payload, field) => {
    const app = await buildApp();

    const response = await app.inject({ method: "PUT", url: "/api/admin/spend-controls", payload });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain(field);
    expect(mockPrisma.aiSpendControlRevision.create).not.toHaveBeenCalled();
    await app.close();
  });
});

/** Through the auth hook with password auth off, as in local development: the hook is what makes the operator. */
async function buildApp() {
  const app = Fastify({ logger: false });
  await registerAuth(app, { WEB_PASSWORD: "" } as never);
  await app.register(adminSpendControlRoutes);
  return app;
}

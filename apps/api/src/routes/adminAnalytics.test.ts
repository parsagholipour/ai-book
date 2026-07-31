import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAuth } from "../auth.js";
import { adminAnalyticsRoutes } from "./adminAnalytics.js";
import { resolveWindow } from "../admin/metrics.js";

const mockDb = vi.hoisted(() => {
  const zeroAgg = { _sum: {}, _count: { _all: 0 } };
  const prisma = {
    user: { upsert: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
    mobileSession: { findUnique: vi.fn() },
    purchaseRecord: { aggregate: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
    providerCallLog: { aggregate: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    creditLedgerEntry: { aggregate: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
    userCreditAccount: { aggregate: vi.fn(), findUnique: vi.fn() },
    subscriptionState: { count: vi.fn(), findMany: vi.fn() },
    project: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    generationJob: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
    voiceCall: { aggregate: vi.fn() },
    moderationReport: { count: vi.fn() },
    accountDeletionRequest: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
    $queryRawUnsafe: vi.fn()
  };
  return { prisma, zeroAgg };
});

vi.mock("@book-maker/db", () => ({ prisma: mockDb.prisma, Prisma: {} }));

const originalEnv = { ...process.env };
let app: FastifyInstance;

async function buildApp(webPassword = ""): Promise<FastifyInstance> {
  process.env = { ...originalEnv, WEB_PASSWORD: webPassword, OPENAI_API_KEY: "", GEMINI_API_KEY: "" };
  const instance = Fastify();
  await registerAuth(instance, { WEB_PASSWORD: webPassword } as never);
  await instance.register(adminAnalyticsRoutes);
  await instance.ready();
  return instance;
}

/** Defaults that make every aggregate return "nothing happened". */
function stubEmpty() {
  const p = mockDb.prisma;
  p.user.upsert.mockResolvedValue({ id: "local-admin" });
  p.mobileSession.findUnique.mockResolvedValue(null);
  p.user.count.mockResolvedValue(0);
  p.purchaseRecord.aggregate.mockResolvedValue({ _sum: { amountMicros: null } });
  p.purchaseRecord.groupBy.mockResolvedValue([]);
  p.providerCallLog.aggregate.mockResolvedValue({ _sum: { costHint: null } });
  p.providerCallLog.count.mockResolvedValue(0);
  p.providerCallLog.groupBy.mockResolvedValue([]);
  p.creditLedgerEntry.aggregate.mockResolvedValue({ _sum: { amountCredits: null } });
  p.creditLedgerEntry.groupBy.mockResolvedValue([]);
  p.userCreditAccount.aggregate.mockResolvedValue({ _sum: { availableCredits: null, reservedCredits: null } });
  p.subscriptionState.count.mockResolvedValue(0);
  p.project.count.mockResolvedValue(0);
  p.project.groupBy.mockResolvedValue([]);
  p.generationJob.count.mockResolvedValue(0);
  p.generationJob.groupBy.mockResolvedValue([]);
  p.voiceCall.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { elapsedSeconds: null } });
  p.moderationReport.count.mockResolvedValue(0);
  p.$queryRaw.mockResolvedValue([]);
  p.$queryRawUnsafe.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  stubEmpty();
});

afterEach(async () => {
  await app?.close();
  process.env = { ...originalEnv };
});

describe("resolveWindow", () => {
  it("clamps to something a dashboard can actually chart", () => {
    expect(resolveWindow(0).days).toBe(1);
    expect(resolveWindow(10_000).days).toBe(365);
    expect(resolveWindow(30).days).toBe(30);
  });

  it("spans the requested number of days back from now", () => {
    const window = resolveWindow(7);
    const spanDays = (window.until.getTime() - window.since.getTime()) / 86_400_000;
    expect(spanDays).toBeCloseTo(7, 5);
  });
});

describe("GET /api/admin/overview", () => {
  it("survives an empty database without dividing by zero", async () => {
    app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/admin/overview" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.money.cashCollectedUsd).toBe(0);
    expect(body.money.cashMarginPercent).toBeNull();
    expect(body.money.unitMarginPercent).toBeNull();
    expect(body.work.jobFailureRate).toBeNull();
    expect(body.series).toEqual([]);
  });

  it("reports cash and unit margins separately, because they answer different questions", async () => {
    // A reader bought $100 of credits this window but only consumed $30 of
    // service. Cash margin looks great; unit margin is the honest one.
    mockDb.prisma.purchaseRecord.aggregate.mockResolvedValue({ _sum: { amountMicros: 100_000_000n } });
    mockDb.prisma.providerCallLog.aggregate.mockResolvedValue({ _sum: { costHint: 12 } });
    // SPEND entries are stored negative.
    mockDb.prisma.creditLedgerEntry.aggregate.mockResolvedValue({ _sum: { amountCredits: -3000 } });
    mockDb.prisma.userCreditAccount.aggregate.mockResolvedValue({
      _sum: { availableCredits: 7000, reservedCredits: 500 }
    });
    app = await buildApp();

    const money = (await app.inject({ method: "GET", url: "/api/admin/overview" })).json().money;

    expect(money.cashCollectedUsd).toBe(100);
    expect(money.providerSpendUsd).toBe(12);
    expect(money.cashMarginUsd).toBe(88);
    expect(money.cashMarginPercent).toBe(88);
    // Delivered is the magnitude of the negative SPEND total.
    expect(money.creditsDelivered).toBe(3000);
    expect(money.creditsDeliveredUsd).toBe(30);
    expect(money.unitMarginUsd).toBe(18);
    expect(money.unitMarginPercent).toBe(60);
    // Credits bought and not yet burned are an obligation, not income.
    expect(money.creditsOutstanding).toBe(7500);
    expect(money.creditsOutstandingUsd).toBe(75);
  });

  it("counts calls the rate card could not price instead of hiding them", async () => {
    mockDb.prisma.providerCallLog.count.mockResolvedValue(9);
    app = await buildApp();

    expect((await app.inject({ method: "GET", url: "/api/admin/overview" })).json().money.unpricedCalls).toBe(9);
  });

  it("rejects a window it cannot chart", async () => {
    app = await buildApp();

    expect((await app.inject({ method: "GET", url: "/api/admin/overview?days=999" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/admin/overview?days=nope" })).statusCode).toBe(400);
  });
});

describe("GET /api/admin/users", () => {
  it("returns the page and the matching total together", async () => {
    mockDb.prisma.$queryRawUnsafe.mockResolvedValue([
      {
        id: "user-1",
        email: "reader@example.com",
        displayName: null,
        status: "ACTIVE",
        createdAt: new Date("2026-07-01T00:00:00Z"),
        availableCredits: 120,
        reservedCredits: 0,
        lifetimeGranted: 1000,
        lifetimeSpent: 880,
        projects: 4n,
        books_completed: 2n,
        cash_micros: 9_990_000n,
        subscription_status: "ACTIVE",
        last_activity: new Date("2026-07-20T00:00:00Z"),
        total: 37n
      }
    ]);
    app = await buildApp();

    const body = (await app.inject({ method: "GET", url: "/api/admin/users?sort=spend&limit=1" })).json();

    expect(body.total).toBe(37);
    expect(body.users[0]).toMatchObject({ email: "reader@example.com", cashUsd: 9.99, projects: 4, lifetimeSpent: 880 });
  });

  it("refuses a sort it has no SQL for, rather than interpolating it", async () => {
    app = await buildApp();

    expect((await app.inject({ method: "GET", url: "/api/admin/users?sort=email;DROP TABLE" })).statusCode).toBe(400);
  });

  it("passes the search term as a bound parameter", async () => {
    app = await buildApp();

    await app.inject({ method: "GET", url: "/api/admin/users?query=o%27brien" });

    const [sql, search] = mockDb.prisma.$queryRawUnsafe.mock.calls[0]!;
    expect(search).toBe("%o'brien%");
    expect(sql).not.toContain("o'brien");
  });
});

describe("inspection routes", () => {
  it("404s an unknown user and an unknown project", async () => {
    mockDb.prisma.user.findUnique.mockResolvedValue(null);
    mockDb.prisma.project.findUnique.mockResolvedValue(null);
    app = await buildApp();

    expect((await app.inject({ method: "GET", url: "/api/admin/users/nope" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/admin/projects/nope" })).statusCode).toBe(404);
  });
});

describe("auth", () => {
  it("refuses every analytics route without the operator cookie", async () => {
    app = await buildApp("hunter2");

    for (const url of ["/api/admin/overview", "/api/admin/users", "/api/admin/users/x", "/api/admin/projects/x"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
  });
});

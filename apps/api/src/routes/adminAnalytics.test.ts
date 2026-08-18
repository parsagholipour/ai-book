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

// `Prisma.raw` is real because the attributed-cost query splices a generated
// SQL fragment (the APPLY_BOOK_EDIT arm) into its template.
vi.mock("@book-maker/db", () => ({ prisma: mockDb.prisma, Prisma: { raw: (sql: string) => sql } }));

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

/**
 * A refunded charge keeps its gross `SPEND` row and adds a positive `REFUND`.
 * The stubs accept net kept + returned amounts, then synthesize those two
 * ledger aggregates.
 */
function isRefundQuery(args: { where?: { entryType?: unknown } }): boolean {
  return args.where?.entryType === "REFUND";
}

/** `kept` and `reversed` are credit magnitudes; SPEND rows are stored negative. */
function stubCreditAggregate(totals: { kept: number; reversed?: number }) {
  const refunded = totals.reversed ?? 0;
  mockDb.prisma.creditLedgerEntry.aggregate.mockImplementation((args: never) =>
    Promise.resolve({ _sum: { amountCredits: isRefundQuery(args) ? refunded : -(totals.kept + refunded) } })
  );
}

type ChargeGroup = { operation: string; credits: number; runs: number };

function stubChargeGroups(groups: { gross?: ChargeGroup[]; kept?: ChargeGroup[]; reversed?: ChargeGroup[] }) {
  const kept = groups.kept ?? [];
  const reversed = groups.reversed ?? [];
  const operations = new Set([...kept, ...reversed].map((row) => row.operation));
  const gross = groups.gross ?? [...operations].map((operation) => {
    const keptRow = kept.find((row) => row.operation === operation);
    const reversedRow = reversed.find((row) => row.operation === operation);
    return {
      operation,
      credits: (keptRow?.credits ?? 0) + (reversedRow?.credits ?? 0),
      runs: (keptRow?.runs ?? 0) + (reversedRow?.runs ?? 0)
    };
  });
  const toRows = (rows: ChargeGroup[], refund: boolean) =>
    rows.map((row) => ({
      operation: row.operation,
      _sum: { amountCredits: refund ? row.credits : -row.credits },
      _count: { _all: row.runs }
    }));
  mockDb.prisma.creditLedgerEntry.groupBy.mockImplementation((args: never) => {
    const refund = isRefundQuery(args);
    return Promise.resolve(toRows(refund ? reversed : gross, refund));
  });
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
    stubCreditAggregate({ kept: 3000 });
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

  it("keeps refunded charges out of delivered credits and reports them separately", async () => {
    mockDb.prisma.providerCallLog.aggregate.mockResolvedValue({ _sum: { costHint: 5 } });
    // 3000 credits stuck; another 1000 were charged and handed back.
    stubCreditAggregate({ kept: 3000, reversed: 1000 });
    app = await buildApp();

    const money = (await app.inject({ method: "GET", url: "/api/admin/overview" })).json().money;

    expect(money.creditsDelivered).toBe(3000);
    expect(money.creditsDeliveredUsd).toBe(30);
    expect(money.creditsRefunded).toBe(1000);
    expect(money.creditsRefundedUsd).toBe(10);
    // The refunded work still cost us to serve, so it is not netted out of spend.
    expect(money.unitMarginUsd).toBe(25);
  });

  it("reports the net and returned portions of one partial charge", async () => {
    stubCreditAggregate({ kept: 80, reversed: 120 });
    stubChargeGroups({
      gross: [{ operation: "PAGE_REGENERATION", credits: 200, runs: 1 }],
      reversed: [{ operation: "PAGE_REGENERATION", credits: 120, runs: 1 }]
    });
    app = await buildApp();

    const body = (await app.inject({ method: "GET", url: "/api/admin/overview" })).json();

    expect(body.money).toMatchObject({
      creditsDelivered: 80,
      creditsDeliveredUsd: 0.8,
      creditsRefunded: 120,
      creditsRefundedUsd: 1.2
    });
    expect(body.creditsByOperation).toEqual([
      expect.objectContaining({ key: "PAGE_REGENERATION", value: 80, secondary: 1 })
    ]);
    const [seriesSql] = mockDb.prisma.$queryRaw.mock.calls[0]!;
    expect(Array.from(seriesSql as readonly string[]).join(" ")).toContain("GREATEST");
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

describe("GET /api/admin/costs", () => {
  it("breaks provider spend down by operation and by the model that spent it", async () => {
    mockDb.prisma.$queryRaw.mockResolvedValue([
      {
        kind: "text",
        purpose: "generate-page",
        provider: "gemini",
        model: "gemini-3.5-flash",
        calls: 12,
        priced_calls: 12,
        failed_calls: 0,
        in_flight_calls: 0,
        estimated_calls: 0,
        usd: 0.48,
        prompt_tokens: 300_000,
        cached_prompt_tokens: 90_000,
        output_tokens: 60_000,
        audio_ms: 0
      },
      {
        kind: "image",
        purpose: "image.generate",
        provider: "gemini",
        model: "gemini-3.1-flash-image",
        calls: 5,
        priced_calls: 5,
        failed_calls: 0,
        in_flight_calls: 0,
        estimated_calls: 0,
        usd: 0.335,
        prompt_tokens: 0,
        cached_prompt_tokens: 0,
        output_tokens: 0,
        audio_ms: 0
      }
    ]);
    app = await buildApp();

    const body = (await app.inject({ method: "GET", url: "/api/admin/costs?days=7" })).json();

    expect(body.window.days).toBe(7);
    expect(body.totals).toMatchObject({ calls: 17, usd: 0.815, promptTokens: 300_000, images: 5 });
    expect(body.operations.map((entry: { key: string }) => entry.key)).toEqual(["generate-page", "image.generate"]);
    expect(body.operations[0].models[0]).toMatchObject({ provider: "gemini", model: "gemini-3.5-flash", usd: 0.48 });
    expect(body.models).toHaveLength(2);
    expect(body.byKind.map((entry: { kind: string }) => entry.kind)).toEqual(["text", "image"]);
  });

  it("survives an empty window", async () => {
    app = await buildApp();

    const body = (await app.inject({ method: "GET", url: "/api/admin/costs" })).json();

    expect(body.totals.usd).toBe(0);
    expect(body.operations).toEqual([]);
    expect(body.models).toEqual([]);
  });

  it("rejects a window it cannot report on", async () => {
    app = await buildApp();

    expect((await app.inject({ method: "GET", url: "/api/admin/costs?days=999" })).statusCode).toBe(400);
  });
});

describe("GET /api/admin/operations", () => {
  function attributedRow(operation: string, overrides: Record<string, unknown> = {}) {
    return {
      kind: "text",
      purpose: operation,
      provider: "deepseek",
      model: "deepseek-v4-pro",
      calls: 10,
      priced_calls: 10,
      failed_calls: 0,
      in_flight_calls: 0,
      estimated_calls: 0,
      usd: 1.2,
      prompt_tokens: 500_000,
      cached_prompt_tokens: 0,
      output_tokens: 120_000,
      audio_ms: 0,
      ...overrides
    };
  }

  it("pairs what an operation charged against the spend attributed to it", async () => {
    mockDb.prisma.$queryRaw.mockResolvedValue([attributedRow("FULL_BOOK_GENERATION")]);
    stubChargeGroups({ kept: [{ operation: "FULL_BOOK_GENERATION", credits: 4000, runs: 5 }] });
    app = await buildApp();

    const body = (await app.inject({ method: "GET", url: "/api/admin/operations?days=30" })).json();

    expect(body.totals).toMatchObject({ runs: 5, credits: 4000, revenueUsd: 40, providerUsd: 1.2, marginUsd: 38.8 });
    expect(body.operations[0]).toMatchObject({
      key: "FULL_BOOK_GENERATION",
      label: "Full book generation",
      runs: 5,
      credits: 4000,
      revenueUsd: 40,
      providerUsd: 1.2,
      marginPercent: 97,
      costPerRunUsd: 0.24,
      creditsPerRun: 800
    });
    expect(body.operations[0].models[0]).toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro", usd: 1.2 });
  });

  it("keeps spend no charge accounts for out of every margin", async () => {
    mockDb.prisma.$queryRaw.mockResolvedValue([
      attributedRow("FULL_BOOK_GENERATION", { usd: 1 }),
      attributedRow("UNBILLED_NO_CHARGE", { usd: 9, provider: "gemini", model: "gemini-3.5-flash" })
    ]);
    stubChargeGroups({ kept: [{ operation: "FULL_BOOK_GENERATION", credits: 1000, runs: 1 }] });
    app = await buildApp();

    const body = (await app.inject({ method: "GET", url: "/api/admin/operations" })).json();

    // The margin is on the $1 the charge paid for, not the $10 that was spent.
    expect(body.totals.providerUsd).toBe(1);
    expect(body.totals.unbilledUsd).toBe(9);
    expect(body.totals.marginUsd).toBe(9);
    expect(body.operations).toHaveLength(1);
    expect(body.unbilled[0]).toMatchObject({ key: "UNBILLED_NO_CHARGE", label: "Never charged", usd: 9 });
    expect(body.unbilled[0].description).toContain("operator console");
  });

  it("flags an operation whose provider cost we cannot see", async () => {
    mockDb.prisma.$queryRaw.mockResolvedValue([]);
    stubChargeGroups({ kept: [{ operation: "VOICE_CALL_MINUTE", credits: 600, runs: 12 }] });
    app = await buildApp();

    const voice = (await app.inject({ method: "GET", url: "/api/admin/operations" })).json().operations[0];

    // 100% margin is the honest arithmetic and a lie about the business, so it
    // never appears without the reason next to it.
    expect(voice).toMatchObject({ key: "VOICE_CALL_MINUTE", providerUsd: 0, marginPercent: 100, models: [] });
    expect(voice.note).toContain("never reaches our server");
  });

  it("counts only the charges that stuck, and says what was refunded", async () => {
    // The narration case this split was written for: one 368-credit audiobook
    // kept, two 224-credit ones charged and refunded. Reading all three as
    // revenue reported 816 credits of narration nobody paid for.
    mockDb.prisma.$queryRaw.mockResolvedValue([
      attributedRow("AUDIOBOOK_GENERATION", { kind: "audio", provider: "openai_tts", model: "gpt-4o-mini-tts", usd: 1.75 })
    ]);
    stubChargeGroups({
      kept: [{ operation: "AUDIOBOOK_GENERATION", credits: 368, runs: 1 }],
      reversed: [{ operation: "AUDIOBOOK_GENERATION", credits: 448, runs: 2 }]
    });
    app = await buildApp();

    const body = (await app.inject({ method: "GET", url: "/api/admin/operations" })).json();

    expect(body.operations[0]).toMatchObject({
      key: "AUDIOBOOK_GENERATION",
      runs: 3,
      credits: 368,
      refundedRuns: 2,
      refundedCredits: 448,
      revenueUsd: 3.68,
      providerUsd: 1.75,
      creditsPerRun: 123
    });
    // Cost per run divides by every attempt we paid for, refunds included.
    expect(body.operations[0].costPerRunUsd).toBeCloseTo(1.75 / 3, 6);
    expect(body.totals).toMatchObject({ runs: 3, credits: 368, refundedRuns: 2, refundedCredits: 448, revenueUsd: 3.68 });
  });

  it("shows an operation that refunded everything as the loss it is", async () => {
    mockDb.prisma.$queryRaw.mockResolvedValue([attributedRow("AUDIOBOOK_GENERATION", { usd: 2 })]);
    stubChargeGroups({ reversed: [{ operation: "AUDIOBOOK_GENERATION", credits: 448, runs: 2 }] });
    app = await buildApp();

    const operation = (await app.inject({ method: "GET", url: "/api/admin/operations" })).json().operations[0];

    // No revenue, real spend: the row still appears rather than vanishing with
    // its cost, and the margin is below zero because that is what happened.
    expect(operation).toMatchObject({ runs: 2, credits: 0, refundedRuns: 2, refundedCredits: 448, revenueUsd: 0 });
    expect(operation.marginUsd).toBe(-2);
    expect(operation.creditsPerRun).toBe(0);
  });

  it("nets a partial refund without counting its one attempt twice", async () => {
    mockDb.prisma.$queryRaw.mockResolvedValue([
      attributedRow("PAGE_REGENERATION", { usd: 0.4 })
    ]);
    stubChargeGroups({
      gross: [{ operation: "PAGE_REGENERATION", credits: 200, runs: 1 }],
      reversed: [{ operation: "PAGE_REGENERATION", credits: 120, runs: 1 }]
    });
    app = await buildApp();

    const operation = (await app.inject({ method: "GET", url: "/api/admin/operations" })).json().operations[0];

    expect(operation).toMatchObject({
      runs: 1,
      credits: 80,
      refundedRuns: 1,
      refundedCredits: 120,
      revenueUsd: 0.8,
      providerUsd: 0.4,
      costPerRunUsd: 0.4,
      creditsPerRun: 80
    });
  });

  it("survives a window with no charges and no calls", async () => {
    app = await buildApp();

    const body = (await app.inject({ method: "GET", url: "/api/admin/operations" })).json();

    expect(body.operations).toEqual([]);
    expect(body.unbilled).toEqual([]);
    expect(body.totals.marginPercent).toBeNull();
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

  it("reports project economics net of a partial refund", async () => {
    mockDb.prisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      title: "Partly delivered",
      status: "COMPLETE",
      category: "fiction",
      language: "English",
      targetPages: 5,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T01:00:00.000Z"),
      user: { id: "user-1", email: "reader@example.com" },
      _count: { pages: 2, images: 0 }
    });
    mockDb.prisma.providerCallLog.aggregate.mockResolvedValue({ _sum: { costHint: 0.4 } });
    mockDb.prisma.providerCallLog.count.mockResolvedValue(0);
    mockDb.prisma.providerCallLog.groupBy.mockResolvedValue([]);
    mockDb.prisma.generationJob.findMany.mockResolvedValue([]);
    mockDb.prisma.creditLedgerEntry.findMany.mockResolvedValue([]);
    mockDb.prisma.creditLedgerEntry.aggregate.mockImplementation(({ where }: { where: { entryType: string } }) =>
      Promise.resolve({ _sum: { amountCredits: where.entryType === "REFUND" ? 120 : -200 } })
    );
    app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/admin/projects/project-1" });

    expect(response.statusCode).toBe(200);
    expect(response.json().economics).toMatchObject({
      creditsCharged: 80,
      revenueUsd: 0.8,
      providerUsd: 0.4,
      marginUsd: 0.4,
      marginPercent: 50
    });
  });
});

describe("auth", () => {
  it("refuses every analytics route without the operator cookie", async () => {
    app = await buildApp("hunter2");

    const urls = [
      "/api/admin/overview",
      "/api/admin/costs",
      "/api/admin/operations",
      "/api/admin/users",
      "/api/admin/users/x",
      "/api/admin/projects/x"
    ];
    for (const url of urls) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
  });
});

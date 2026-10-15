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
    purchaseRecord: { findMany: vi.fn() },
    purchasePayment: { aggregate: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
    providerCallLog: { aggregate: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    creditLedgerEntry: { aggregate: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
    userCreditAccount: { aggregate: vi.fn(), findUnique: vi.fn() },
    subscriptionState: { count: vi.fn(), findMany: vi.fn() },
    project: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    generationJob: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
    voiceCall: { aggregate: vi.fn() },
    moderationReport: { count: vi.fn() },
    bookShare: { groupBy: vi.fn(), aggregate: vi.fn() },
    mobileCreationDraft: { count: vi.fn() },
    welcomeCreditGrant: { groupBy: vi.fn() },
    accountDeletionRequest: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
    $queryRawUnsafe: vi.fn()
  };
  return { prisma, zeroAgg };
});

// `Prisma.raw` is real because the attributed-cost query splices a generated
// SQL fragment (the APPLY_BOOK_EDIT arm) into its template.
vi.mock("@book-maker/db", () => ({ prisma: mockDb.prisma, Prisma: { raw: (sql: string) => sql } }));

// The valuation's own SQL and arithmetic are `admin/creditValuation.test.ts`'s;
// here it is the source of each charge's dollars, so the routes are tested on
// what they do with them.
const mockValuation = vi.hoisted(() => ({ loadValuedSpends: vi.fn(), loadOutstandingPaidCredits: vi.fn() }));
vi.mock("../admin/creditValuation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../admin/creditValuation.js")>()),
  loadValuedSpends: mockValuation.loadValuedSpends,
  loadOutstandingPaidCredits: mockValuation.loadOutstandingPaidCredits
}));

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
  p.purchasePayment.aggregate.mockResolvedValue({ _sum: { amountMicros: null } });
  p.purchasePayment.groupBy.mockResolvedValue([]);
  p.purchasePayment.findMany.mockResolvedValue([]);
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
  p.bookShare.groupBy.mockResolvedValue([]);
  p.bookShare.aggregate.mockResolvedValue({ _sum: { viewCount: null } });
  p.mobileCreationDraft.count.mockResolvedValue(0);
  p.welcomeCreditGrant.groupBy.mockResolvedValue([]);
  p.$queryRaw.mockResolvedValue([]);
  p.$queryRawUnsafe.mockResolvedValue([]);
  mockValuation.loadValuedSpends.mockResolvedValue([]);
  mockValuation.loadOutstandingPaidCredits.mockResolvedValue({ credits: 0, usd: 0 });
}

/** What a Creator allowance credit earns after Google's 15%. */
const CREATOR_CREDIT_USD = (19.99 * 0.85) / 6_000;

type Valued = { operation?: string; usd: number; refundedUsd?: number; paidCredits?: number; createdAt?: Date; projectId?: string | null };

/** The charges the valuation returns: only paying readers' come back, each with its dollars. */
function stubValued(rows: Valued[]) {
  mockValuation.loadValuedSpends.mockResolvedValue(
    rows.map((row) => ({
      userId: "payer",
      createdAt: row.createdAt ?? new Date(),
      operation: row.operation ?? "FULL_BOOK_GENERATION",
      projectId: row.projectId ?? null,
      grossCredits: 0,
      refundedCredits: 0,
      usd: row.usd,
      refundedUsd: row.refundedUsd ?? 0,
      paidCredits: row.paidCredits ?? 0
    }))
  );
}

type Payment = { usd: number; refundedUsd?: number; productType?: string | null; paidAt?: Date; local?: [number, string, string] };

function stubPayments(rows: Payment[]) {
  mockDb.prisma.purchasePayment.findMany.mockResolvedValue(
    rows.map((row) => ({
      paidAt: row.paidAt ?? new Date(),
      amountMicros: BigInt(Math.round(row.usd * 1_000_000)),
      refundedAmountMicros: BigInt(Math.round((row.refundedUsd ?? 0) * 1_000_000)),
      localPriceMicros: row.local ? BigInt(Math.round(row.local[0] * 1_000_000)) : null,
      localCurrency: row.local?.[1] ?? null,
      localPriceSource: row.local?.[2] ?? null,
      purchaseRecord: { product: row.productType === null ? null : { productType: row.productType ?? "SUBSCRIPTION" } }
    }))
  );
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

describe("GET /api/admin/growth", () => {
  it("follows the signup cohort and leaves the operator's own user out", async () => {
    mockDb.prisma.$queryRaw.mockImplementation(async (sql: readonly string[]) => {
      const text = Array.from(sql).join(" ");
      if (text.includes("started_chat")) {
        return [{ signups: 4n, started_chat: 3n, built_plan: 2n, started_book: 2n, delivered_book: 1n, second_book: 0n, paid: 1n }];
      }
      if (text.includes("percentile_cont")) return [{ samples: 1n, median: 42.4, p90: 42.4 }];
      return [];
    });
    mockDb.prisma.welcomeCreditGrant.groupBy.mockResolvedValue([
      { outcome: "GRANTED", _count: { _all: 3 } },
      { outcome: "RECENT_IP", _count: { _all: 1 } }
    ]);
    app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/admin/growth?days=30" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.cohort).toMatchObject({ signups: 4, startedChat: 3, deliveredBook: 1, paid: 1 });
    expect(body.cohort.welcome).toMatchObject({ GRANTED: 3, RECENT_IP: 1, NO_IP: 0 });
    expect(body.timeToFirstBook).toEqual({ samples: 1, medianMinutes: 42, p90Minutes: 42 });
    const cohortSql = mockDb.prisma.$queryRaw.mock.calls.find(([sql]) => Array.from(sql as readonly string[]).join(" ").includes("started_chat"));
    expect(cohortSql).toContain("local-admin");
  });

  it("carries checkouts, installs, intro conversion, churn and net cash by product and country", async () => {
    mockDb.prisma.$queryRaw.mockImplementation(async (sql: readonly string[]) => {
      const text = Array.from(sql).join(" ");
      if (text.includes('"WelcomeCreditGrant" g')) {
        return [
          {
            user_id: "u1",
            paid_at: new Date(),
            amount_micros: 19_990_000n,
            refunded_micros: 0n,
            local_micros: null,
            local_currency: null,
            local_source: null,
            sku: "tomeza.creator_monthly",
            product_type: "SUBSCRIPTION",
            country: "US"
          }
        ];
      }
      return [];
    });
    mockDb.prisma.welcomeCreditGrant.groupBy.mockResolvedValue([]);
    app = await buildApp();

    const body = (await app.inject({ method: "GET", url: "/api/admin/growth?days=30" })).json();

    expect(body.purchasesBySku).toEqual([{ sku: "tomeza.creator_monthly", payments: 1, buyers: 1, cashUsd: 19.99, netUsd: 16.99 }]);
    expect(body.revenueByCountry).toEqual([
      { country: "US", orders: 1, buyers: 1, collectedUsd: 19.99, netUsd: 16.99, byCurrency: [{ currency: null, orders: 1, localKept: 0 }] }
    ]);
    expect(body.checkout).toEqual({ bySku: [], failures: [], bySurface: [] });
    expect(body.installSources).toEqual([]);
    expect(body.introConversion).toEqual([]);
    expect(body.churn.length).toBeGreaterThanOrEqual(1);
    expect(body.churn.at(-1)).toMatchObject({ activeAtStart: 0, ended: 0, partial: true });
  });

  it("is operator-only", async () => {
    app = await buildApp("secret");
    expect((await app.inject({ method: "GET", url: "/api/admin/growth" })).statusCode).toBe(401);
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
    expect(body.sharing).toEqual({ sharesCreated: 0, previewShares: 0, fullShares: 0, pdfViews: 0, remixDrafts: 0, remixBooks: 0 });
    expect(body.series).toEqual([]);
  });

  it("follows one cohort of shares from share to built book", async () => {
    mockDb.prisma.bookShare.groupBy.mockResolvedValue([
      { mode: "PREVIEW", _count: { _all: 7 } },
      { mode: "FULL", _count: { _all: 2 } }
    ]);
    mockDb.prisma.bookShare.aggregate.mockResolvedValue({ _sum: { viewCount: 41 } });
    mockDb.prisma.mobileCreationDraft.count.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      "createdProjectId" in where ? 1 : 3
    );
    app = await buildApp();

    const sharing = (await app.inject({ method: "GET", url: "/api/admin/overview" })).json().sharing;

    expect(sharing).toEqual({ sharesCreated: 9, previewShares: 7, fullShares: 2, pdfViews: 41, remixDrafts: 3, remixBooks: 1 });
  });

  it("reports cash and unit margins separately, because they answer different questions", async () => {
    // A reader paid $100 this window but only consumed $8.50 of service. Cash
    // margin looks great; unit margin is the honest one.
    stubPayments([{ usd: 100, productType: "SUBSCRIPTION" }]);
    mockDb.prisma.providerCallLog.aggregate.mockResolvedValue({ _sum: { costHint: 12 } });
    stubCreditAggregate({ kept: 3000 });
    stubValued([{ usd: 8.5, paidCredits: 3000 }]);
    mockDb.prisma.userCreditAccount.aggregate.mockResolvedValue({
      _sum: { availableCredits: 7000, reservedCredits: 500 }
    });
    mockValuation.loadOutstandingPaidCredits.mockResolvedValue({ credits: 650, usd: 4.414 });
    app = await buildApp();

    const body = (await app.inject({ method: "GET", url: "/api/admin/overview" })).json();
    const money = body.money;

    // Gross is what the reader was charged; Google keeps 15% of a subscription.
    expect(money.cashCollectedUsd).toBe(100);
    expect(money.playFeeUsd).toBe(15);
    expect(money.cashNetUsd).toBe(85);
    expect(money.providerSpendUsd).toBe(12);
    // The cash margin is on what reaches us, not on the catalog price.
    expect(money.cashMarginUsd).toBe(73);
    expect(money.cashMarginPercent).toBe(85.9);
    // Delivered is the magnitude of the negative SPEND total, valued by source.
    expect(money.creditsDelivered).toBe(3000);
    expect(money.creditsDeliveredUsd).toBe(8.5);
    expect(money.paidCreditsDelivered).toBe(3000);
    expect(money.unitMarginUsd).toBe(-3.5);
    expect(money.unitMarginPercent).toBe(-41.2);
    // Credits held and not yet burned are an obligation, not income; only the
    // bought-and-paid part of them was paid for.
    expect(money.creditsOutstanding).toBe(7500);
    expect(money.paidCreditsOutstanding).toBe(650);
    expect(money.creditsOutstandingUsd).toBe(4.41);
    expect(body.valuation.method).toContain("welcome or operator credits at $0");
    expect(body.creditUsdValue).toBeUndefined();
  });

  it("values a free reader's delivered credits at nothing", async () => {
    // 5,000 credits of welcome-credit books: real work, no revenue behind it.
    mockDb.prisma.providerCallLog.aggregate.mockResolvedValue({ _sum: { costHint: 1.5 } });
    stubCreditAggregate({ kept: 5000 });
    app = await buildApp();

    const money = (await app.inject({ method: "GET", url: "/api/admin/overview" })).json().money;

    expect(money.creditsDelivered).toBe(5000);
    expect(money.creditsDeliveredUsd).toBe(0);
    expect(money.paidCreditsDelivered).toBe(0);
    expect(money.unitMarginUsd).toBe(-1.5);
    expect(mockValuation.loadValuedSpends).toHaveBeenCalledWith({ kind: "window", since: expect.any(Date), until: expect.any(Date) });
  });

  it("reports retained renewal payments net of order-specific refunds without a subscription-status filter", async () => {
    stubPayments([{ usd: 19.99 }, { usd: 19.99 }, { usd: 19.99, refundedUsd: 19.99 }]);
    app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/admin/overview" });
    expect(response.statusCode).toBe(200);
    expect(response.json().money).toMatchObject({ cashCollectedUsd: 39.98, playFeeUsd: 6, cashNetUsd: 33.98 });
    const query = mockDb.prisma.purchasePayment.findMany.mock.calls[0]![0];
    expect(query.where).toEqual({ paidAt: { gte: expect.any(Date), lte: expect.any(Date) } });
    // The series buckets the same payment rows rather than summing them again.
    const seriesSql = mockDb.prisma.$queryRaw.mock.calls.map(([sql]) => Array.from(sql).join(" ")).join(" ");
    expect(seriesSql).not.toContain('FROM "PurchasePayment"');
  });

  it("takes Google's one-time-product fee off a pack and its subscription fee off a plan", async () => {
    stubPayments([
      { usd: 7.99, productType: "CREDIT_PACK" },
      { usd: 19.99, productType: "SUBSCRIPTION" }
    ]);
    app = await buildApp();

    const money = (await app.inject({ method: "GET", url: "/api/admin/overview" })).json().money;

    expect(money.cashCollectedUsd).toBe(27.98);
    expect(money.cashNetUsd).toBeCloseTo(7.99 * 0.85 + 19.99 * 0.85, 2);
  });

  it("breaks the window's orders down by the buyer's own currency, unconverted", async () => {
    stubPayments([
      { usd: 19.99, local: [899_000, "IRR", "client"] },
      { usd: 19.99, local: [899_000, "IRR", "play_recurring_price"] },
      { usd: 7.99, productType: "CREDIT_PACK", local: [7.49, "EUR", "client"], refundedUsd: 7.99 },
      // A build from before local prices were reported.
      { usd: 19.99 }
    ]);
    app = await buildApp();

    const byCurrency = (await app.inject({ method: "GET", url: "/api/admin/overview" })).json().revenueByCurrency;

    expect(byCurrency).toEqual([
      {
        currency: "IRR",
        orders: 2,
        refundedOrders: 0,
        localGross: 1_798_000,
        localKept: 1_798_000,
        sources: { client: 1, playRecurringPrice: 1 },
        catalogUsd: 39.98
      },
      {
        currency: "EUR",
        orders: 1,
        refundedOrders: 1,
        localGross: 7.49,
        localKept: 0,
        sources: { client: 1, playRecurringPrice: 0 },
        catalogUsd: 0
      },
      {
        currency: null,
        orders: 1,
        refundedOrders: 0,
        localGross: 0,
        localKept: 0,
        sources: { client: 0, playRecurringPrice: 0 },
        catalogUsd: 19.99
      }
    ]);
  });

  it("keeps refunded charges out of delivered credits and reports them separately", async () => {
    mockDb.prisma.providerCallLog.aggregate.mockResolvedValue({ _sum: { costHint: 5 } });
    // 3000 credits stuck; another 1000 were charged and handed back.
    stubCreditAggregate({ kept: 3000, reversed: 1000 });
    stubValued([{ usd: 3000 * CREATOR_CREDIT_USD, refundedUsd: 1000 * CREATOR_CREDIT_USD, paidCredits: 3000 }]);
    app = await buildApp();

    const money = (await app.inject({ method: "GET", url: "/api/admin/overview" })).json().money;

    expect(money.creditsDelivered).toBe(3000);
    expect(money.creditsDeliveredUsd).toBe(8.5);
    expect(money.creditsRefunded).toBe(1000);
    expect(money.creditsRefundedUsd).toBe(2.83);
    // The refunded work still cost us to serve, so it is not netted out of spend.
    expect(money.unitMarginUsd).toBe(3.5);
  });

  it("reports the net and returned portions of one partial charge", async () => {
    stubCreditAggregate({ kept: 80, reversed: 120 });
    stubChargeGroups({
      gross: [{ operation: "PAGE_REGENERATION", credits: 200, runs: 1 }],
      reversed: [{ operation: "PAGE_REGENERATION", credits: 120, runs: 1 }]
    });
    stubValued([{ operation: "PAGE_REGENERATION", usd: 80 * CREATOR_CREDIT_USD, refundedUsd: 120 * CREATOR_CREDIT_USD }]);
    app = await buildApp();

    const body = (await app.inject({ method: "GET", url: "/api/admin/overview" })).json();

    expect(body.money).toMatchObject({
      creditsDelivered: 80,
      creditsDeliveredUsd: 0.23,
      creditsRefunded: 120,
      creditsRefundedUsd: 0.34
    });
    expect(body.creditsByOperation).toEqual([
      expect.objectContaining({ key: "PAGE_REGENERATION", value: 80, secondary: 1 })
    ]);
  });

  it("charts delivered value and cash on the days they happened, from the rows the totals came from", async () => {
    const today = new Date();
    const day = today.toISOString().slice(0, 10);
    mockDb.prisma.$queryRaw.mockImplementation(async (sql: readonly string[]) =>
      Array.from(sql).join(" ").includes("generate_series")
        ? [{ day: new Date(`${day}T00:00:00.000Z`), provider_usd: 1.25, new_users: 2n, books_completed: 1n }]
        : []
    );
    stubPayments([{ usd: 19.99, paidAt: today }]);
    stubValued([{ usd: 2, createdAt: today }, { usd: 1.5, createdAt: today }]);
    app = await buildApp();

    const body = (await app.inject({ method: "GET", url: "/api/admin/overview" })).json();

    expect(body.series).toEqual([
      { date: day, cashUsd: 19.99, cashNetUsd: 16.99, providerUsd: 1.25, creditsDeliveredUsd: 3.5, newUsers: 2, booksCompleted: 1 }
    ]);
    const seriesSql = Array.from(
      mockDb.prisma.$queryRaw.mock.calls.find(([sql]) => Array.from(sql as readonly string[]).join(" ").includes("generate_series"))![0] as readonly string[]
    ).join(" ");
    // Each day's provider lookup is a range the createdAt index can serve.
    expect(seriesSql).toContain('l."createdAt" >= days.day');
    expect(seriesSql).not.toContain('"CreditLedgerEntry"');
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
    expect(body.searchGrounding).toMatchObject({ searchCalls: 0, units: 0, freeUnits: 0, billedFeeUsd: 0, periods: [] });
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
    // 4,000 Creator allowance credits: $11.33 after Google's fee, not the $40 a cent a credit read.
    stubValued([{ operation: "FULL_BOOK_GENERATION", usd: 4000 * CREATOR_CREDIT_USD, paidCredits: 4000 }]);
    app = await buildApp();

    const body = (await app.inject({ method: "GET", url: "/api/admin/operations?days=30" })).json();

    expect(body.totals).toMatchObject({ runs: 5, credits: 4000, revenueUsd: 11.33, paidCredits: 4000, providerUsd: 1.2, marginUsd: 10.13 });
    expect(body.operations[0]).toMatchObject({
      key: "FULL_BOOK_GENERATION",
      label: "Full book generation",
      runs: 5,
      credits: 4000,
      revenueUsd: 11.33,
      paidCredits: 4000,
      providerUsd: 1.2,
      marginPercent: 89.4,
      costPerRunUsd: 0.24,
      creditsPerRun: 800
    });
    expect(body.valuation.rates).toEqual(expect.arrayContaining([{ key: "welcome", label: "Welcome credits", usdPerCredit: 0 }]));
    expect(body.operations[0].models[0]).toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro", usd: 1.2 });
  });

  it("keeps spend no charge accounts for out of every margin", async () => {
    mockDb.prisma.$queryRaw.mockResolvedValue([
      attributedRow("FULL_BOOK_GENERATION", { usd: 1 }),
      attributedRow("UNBILLED_NO_CHARGE", { usd: 9, provider: "gemini", model: "gemini-3.5-flash" })
    ]);
    stubChargeGroups({ kept: [{ operation: "FULL_BOOK_GENERATION", credits: 1000, runs: 1 }] });
    stubValued([{ operation: "FULL_BOOK_GENERATION", usd: 3 }]);
    app = await buildApp();

    const body = (await app.inject({ method: "GET", url: "/api/admin/operations" })).json();

    // The margin is on the $1 the charge paid for, not the $10 that was spent.
    expect(body.totals.providerUsd).toBe(1);
    expect(body.totals.unbilledUsd).toBe(9);
    expect(body.totals.marginUsd).toBe(2);
    expect(body.operations).toHaveLength(1);
    expect(body.unbilled[0]).toMatchObject({ key: "UNBILLED_NO_CHARGE", label: "Never charged", usd: 9 });
    expect(body.unbilled[0].description).toContain("operator console");
  });

  it("flags an operation whose provider cost we cannot see", async () => {
    mockDb.prisma.$queryRaw.mockResolvedValue([]);
    stubChargeGroups({ kept: [{ operation: "VOICE_CALL_MINUTE", credits: 600, runs: 12 }] });
    stubValued([{ operation: "VOICE_CALL_MINUTE", usd: 1.7 }]);
    app = await buildApp();

    const voice = (await app.inject({ method: "GET", url: "/api/admin/operations" })).json().operations[0];

    // 100% margin is the honest arithmetic and a lie about the business, so it
    // never appears without the reason next to it.
    expect(voice).toMatchObject({ key: "VOICE_CALL_MINUTE", providerUsd: 0, marginPercent: 100, models: [] });
    // Relayed calls are costed now, but older calls and direct-token ones are not.
    expect(voice.note).toContain("have no cost here");
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
    stubValued([
      { operation: "AUDIOBOOK_GENERATION", usd: 368 * CREATOR_CREDIT_USD },
      { operation: "AUDIOBOOK_GENERATION", usd: 0, refundedUsd: 224 * CREATOR_CREDIT_USD },
      { operation: "AUDIOBOOK_GENERATION", usd: 0, refundedUsd: 224 * CREATOR_CREDIT_USD }
    ]);
    app = await buildApp();

    const body = (await app.inject({ method: "GET", url: "/api/admin/operations" })).json();

    expect(body.operations[0]).toMatchObject({
      key: "AUDIOBOOK_GENERATION",
      runs: 3,
      credits: 368,
      refundedRuns: 2,
      refundedCredits: 448,
      revenueUsd: 1.04,
      providerUsd: 1.75,
      creditsPerRun: 123
    });
    // Cost per run divides by every attempt we paid for, refunds included.
    expect(body.operations[0].costPerRunUsd).toBeCloseTo(1.75 / 3, 6);
    expect(body.totals).toMatchObject({ runs: 3, credits: 368, refundedRuns: 2, refundedCredits: 448, revenueUsd: 1.04 });
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
    stubValued([{ operation: "PAGE_REGENERATION", usd: 80 * CREATOR_CREDIT_USD, refundedUsd: 120 * CREATOR_CREDIT_USD }]);
    app = await buildApp();

    const operation = (await app.inject({ method: "GET", url: "/api/admin/operations" })).json().operations[0];

    expect(operation).toMatchObject({
      runs: 1,
      credits: 80,
      refundedRuns: 1,
      refundedCredits: 120,
      revenueUsd: 0.23,
      providerUsd: 0.4,
      costPerRunUsd: 0.4,
      creditsPerRun: 80
    });
  });

  it("earns nothing on charges only free readers made, and shows the spend as the loss it is", async () => {
    mockDb.prisma.$queryRaw.mockResolvedValue([attributedRow("FULL_BOOK_GENERATION")]);
    stubChargeGroups({ kept: [{ operation: "FULL_BOOK_GENERATION", credits: 4000, runs: 5 }] });
    app = await buildApp();

    const operation = (await app.inject({ method: "GET", url: "/api/admin/operations" })).json().operations[0];

    expect(operation).toMatchObject({ credits: 4000, revenueUsd: 0, paidCredits: 0, marginUsd: -1.2, marginPercent: null });
  });

  it("gives a reader's source reads their own unbilled bucket rather than the API's inline calls", async () => {
    mockDb.prisma.$queryRaw.mockResolvedValue([
      attributedRow("UNBILLED_SOURCE_READING", { usd: 0.05, provider: "gemini", model: "gemini-3.5-flash" }),
      attributedRow("UNBILLED_INLINE", { usd: 0.02, provider: "gemini", model: "gemini-3.5-flash" })
    ]);
    app = await buildApp();

    const body = (await app.inject({ method: "GET", url: "/api/admin/operations" })).json();

    expect(body.unbilled).toEqual([
      expect.objectContaining({ key: "UNBILLED_SOURCE_READING", label: "Source reading", usd: 0.05 }),
      expect.objectContaining({ key: "UNBILLED_INLINE", label: "Inline API calls", usd: 0.02 })
    ]);
    expect(body.totals.unbilledUsd).toBe(0.07);
    const [strings, ...values] = mockDb.prisma.$queryRaw.mock.calls[0]! as [readonly string[], ...unknown[]];
    const sql = [...strings, ...values.map(String)].join(" ");
    expect(sql).toContain("'source-summary', 'source-ocr'");
    expect(sql).toContain("THEN 'UNBILLED_SOURCE_READING'");
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
    stubValued([{ usd: 0.8, refundedUsd: 1.2, projectId: "project-1" }]);
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
    expect(mockValuation.loadValuedSpends).toHaveBeenCalledWith({ kind: "projects", projectIds: ["project-1"] });
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

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAuth } from "../auth.js";
import { adminAnalyticsRoutes } from "./adminAnalytics.js";

const mockDb = vi.hoisted(() => ({
  prisma: {
    user: { upsert: vi.fn() },
    mobileSession: { findUnique: vi.fn() },
    project: { count: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    $queryRawUnsafe: vi.fn(),
    $queryRaw: vi.fn()
  }
}));

vi.mock("@book-maker/db", () => ({
  prisma: mockDb.prisma,
  Prisma: { raw: (sql: string) => sql }
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

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.prisma.user.upsert.mockResolvedValue({ id: "local-admin" });
  mockDb.prisma.mobileSession.findUnique.mockResolvedValue(null);
  mockDb.prisma.project.count.mockResolvedValue(0);
  mockDb.prisma.project.findMany.mockResolvedValue([]);
  mockDb.prisma.project.findUnique.mockResolvedValue(null);
  mockDb.prisma.$queryRawUnsafe.mockResolvedValue([]);
  mockDb.prisma.$queryRaw.mockResolvedValue([]);
});

afterEach(async () => {
  await app?.close();
  process.env = { ...originalEnv };
});

describe("GET /api/admin/operations/books", () => {
  it("returns the requested page of completed books newest first with owner and lifetime economics", async () => {
    mockDb.prisma.project.count.mockResolvedValue(31);
    mockDb.prisma.project.findMany.mockResolvedValue([
      {
        id: "book-newest",
        title: "The Newest Book",
        updatedAt: new Date("2026-08-25T14:00:00.000Z"),
        user: { email: "owner@example.com" },
        _count: { pages: 12, images: 5 }
      }
    ]);
    mockDb.prisma.$queryRawUnsafe.mockResolvedValue([
      {
        project_id: "book-newest",
        charge_count: 2n,
        gross_credits: 1_200n,
        refund_count: 1n,
        refunded_credits: 200n,
        provider_cost_usd: 1.2345674
      }
    ]);
    app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/operations/books?days=7&limit=1&offset=25"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      books: [
        {
          id: "book-newest",
          title: "The Newest Book",
          ownerEmail: "owner@example.com",
          pageCount: 12,
          imageCount: 5,
          completedAt: "2026-08-25T14:00:00.000Z",
          grossCredits: 1200,
          refundedCredits: 200,
          netCredits: 1000,
          revenueUsd: 10,
          providerCostUsd: 1.234567,
          marginUsd: 8.765433,
          marginPercent: 87.7
        }
      ],
      total: 31,
      limit: 1,
      offset: 25
    });
    expect(mockDb.prisma.project.findMany).toHaveBeenCalledWith({
      where: {
        status: "COMPLETE",
        updatedAt: { gte: expect.any(Date), lte: expect.any(Date) }
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: 25,
      take: 1,
      select: {
        id: true,
        title: true,
        updatedAt: true,
        user: { select: { email: true } },
        _count: { select: { pages: true, images: true } }
      }
    });
    const [economicsSql] = mockDb.prisma.$queryRawUnsafe.mock.calls[0]!;
    expect(economicsSql).not.toContain('"createdAt"');
  });

  it("shows an uncharged operator book as zero revenue and a negative lifetime margin", async () => {
    mockDb.prisma.project.count.mockResolvedValue(1);
    mockDb.prisma.project.findMany.mockResolvedValue([
      {
        id: "operator-book",
        title: "Console Draft",
        updatedAt: new Date("2026-08-25T14:00:00.000Z"),
        user: { email: "local-admin@ai-book-maker.local" },
        _count: { pages: 4, images: 0 }
      }
    ]);
    mockDb.prisma.$queryRawUnsafe.mockResolvedValue([
      {
        project_id: "operator-book",
        charge_count: 0,
        gross_credits: 0,
        refund_count: 0,
        refunded_credits: 0,
        provider_cost_usd: 1.25
      }
    ]);
    app = await buildApp();

    const book = (await app.inject({ method: "GET", url: "/api/admin/operations/books?days=30" })).json().books[0];

    expect(book).toMatchObject({
      grossCredits: 0,
      refundedCredits: 0,
      netCredits: 0,
      revenueUsd: 0,
      providerCostUsd: 1.25,
      marginUsd: -1.25,
      marginPercent: null
    });
  });
});

describe("GET /api/admin/operations/books/:id", () => {
  it("returns complete lifetime ledger economics and provider costs grouped by raw purpose and model", async () => {
    mockDb.prisma.project.findUnique.mockResolvedValue({ id: "book-1", status: "COMPLETE" });
    mockDb.prisma.$queryRawUnsafe.mockResolvedValue([
      {
        project_id: "book-1",
        charge_count: 1n,
        gross_credits: 100n,
        refund_count: 1n,
        refunded_credits: 100n,
        provider_cost_usd: 0.1000124
      }
    ]);
    mockDb.prisma.$queryRaw.mockResolvedValue([
      {
        kind: "text",
        purpose: "book.plan.raw",
        provider: "gemini",
        model: "gemini-3.5-flash",
        calls: 8,
        priced_calls: 4,
        failed_calls: 1,
        in_flight_calls: 1,
        estimated_calls: 1,
        usd: 0.0000123456,
        prompt_tokens: 12_345,
        cached_prompt_tokens: 2_000,
        output_tokens: 678,
        audio_ms: 0
      },
      {
        kind: "image",
        purpose: "image.generate",
        provider: "gemini",
        model: "imagen-4",
        calls: 2,
        priced_calls: 2,
        failed_calls: 0,
        in_flight_calls: 0,
        estimated_calls: 0,
        usd: 0.08,
        prompt_tokens: 0,
        cached_prompt_tokens: 0,
        output_tokens: 0,
        audio_ms: 0
      },
      {
        kind: "audio",
        purpose: "tts.synthesize",
        provider: "openai_tts",
        model: "gpt-4o-mini-tts",
        calls: 1,
        priced_calls: 1,
        failed_calls: 0,
        in_flight_calls: 0,
        estimated_calls: 0,
        usd: 0.02,
        prompt_tokens: 0,
        cached_prompt_tokens: 0,
        output_tokens: 0,
        audio_ms: 65_000
      }
    ]);
    app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/admin/operations/books/book-1" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      bookId: "book-1",
      chargeCount: 1,
      refundCount: 1,
      grossCredits: 100,
      refundedCredits: 100,
      netCredits: 0,
      revenueUsd: 0,
      providerCostUsd: 0.100012,
      marginUsd: -0.100012,
      marginPercent: null,
      totals: {
        calls: 11,
        pricedCalls: 7,
        failedCalls: 1,
        inFlightCalls: 1,
        estimatedCalls: 1,
        unratedCalls: 1,
        usd: 0.100012,
        promptTokens: 12_345,
        outputTokens: 678,
        images: 2,
        audioSeconds: 65
      }
    });
    expect(response.json().byKind).toEqual([
      expect.objectContaining({ kind: "image", calls: 2, images: 2, usd: 0.08 }),
      expect.objectContaining({ kind: "audio", calls: 1, audioSeconds: 65, usd: 0.02 }),
      expect.objectContaining({ kind: "text", calls: 8, unratedCalls: 1, usd: 0.000012 })
    ]);
    expect(response.json().purposes).toEqual([
      expect.objectContaining({
        key: "image.generate",
        models: [expect.objectContaining({ provider: "gemini", model: "imagen-4", calls: 2 })]
      }),
      expect.objectContaining({
        key: "tts.synthesize",
        models: [expect.objectContaining({ provider: "openai_tts", model: "gpt-4o-mini-tts", calls: 1 })]
      }),
      expect.objectContaining({
        key: "book.plan.raw",
        models: [expect.objectContaining({ provider: "gemini", model: "gemini-3.5-flash", unratedCalls: 1 })]
      })
    ]);
    const [costSql] = mockDb.prisma.$queryRaw.mock.calls[0]!;
    expect(Array.from(costSql as readonly string[]).join(" ")).not.toContain('l."createdAt"');
  });

  it("returns 404 when the project is missing or is no longer complete", async () => {
    app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/api/admin/operations/books/missing" })).statusCode).toBe(404);

    mockDb.prisma.project.findUnique.mockResolvedValue({ id: "book-review", status: "REVIEW_REQUIRED" });
    expect((await app.inject({ method: "GET", url: "/api/admin/operations/books/book-review" })).statusCode).toBe(404);
    expect(mockDb.prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("generated-book route auth and pagination defaults", () => {
  it("uses 25 rows by default and requires the operator cookie for both endpoints", async () => {
    app = await buildApp();
    const empty = await app.inject({ method: "GET", url: "/api/admin/operations/books" });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ books: [], total: 0, limit: 25, offset: 0 });
    expect(mockDb.prisma.project.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 25, skip: 0 }));
    await app.close();

    app = await buildApp("hunter2");
    expect((await app.inject({ method: "GET", url: "/api/admin/operations/books" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/admin/operations/books/book-1" })).statusCode).toBe(401);
  });
});

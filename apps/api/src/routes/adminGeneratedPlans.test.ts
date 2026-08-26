import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAuth } from "../auth.js";
import { adminAnalyticsRoutes } from "./adminAnalytics.js";

const mockDb = vi.hoisted(() => ({
  prisma: {
    user: { upsert: vi.fn() },
    mobileSession: { findUnique: vi.fn() },
    project: { count: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    planVersion: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
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
  mockDb.prisma.planVersion.count.mockResolvedValue(0);
  mockDb.prisma.planVersion.findMany.mockResolvedValue([]);
  mockDb.prisma.planVersion.findFirst.mockResolvedValue(null);
  mockDb.prisma.$queryRawUnsafe.mockResolvedValue([]);
  mockDb.prisma.$queryRaw.mockResolvedValue([]);
});

afterEach(async () => {
  await app?.close();
  process.env = { ...originalEnv };
});

describe("GET /api/admin/operations/plans", () => {
  it("returns generated plans with economics isolated from downstream book work", async () => {
    mockDb.prisma.planVersion.count.mockResolvedValue(31);
    mockDb.prisma.planVersion.findMany.mockResolvedValue([
      {
        id: "plan-1",
        projectId: "book-1",
        version: 1,
        status: "APPROVED",
        createdAt: new Date("2026-08-25T12:00:00.000Z"),
        project: {
          title: "The Planned Book",
          targetPages: 24,
          user: { email: "owner@example.com" }
        }
      }
    ]);
    mockDb.prisma.$queryRawUnsafe.mockResolvedValue([
      {
        plan_id: "plan-1",
        charge_count: 1n,
        gross_credits: 100n,
        refund_count: 0n,
        refunded_credits: 0n,
        provider_cost_usd: 0.1234567
      }
    ]);
    app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/operations/plans?days=7&limit=1&offset=25"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      plans: [
        {
          id: "plan-1",
          projectId: "book-1",
          title: "The Planned Book",
          ownerEmail: "owner@example.com",
          targetPages: 24,
          version: 1,
          status: "APPROVED",
          generatedAt: "2026-08-25T12:00:00.000Z",
          grossCredits: 100,
          refundedCredits: 0,
          netCredits: 100,
          revenueUsd: 1,
          providerCostUsd: 0.123457,
          marginUsd: 0.876543,
          marginPercent: 87.7
        }
      ],
      total: 31,
      limit: 1,
      offset: 25
    });
    expect(mockDb.prisma.planVersion.findMany).toHaveBeenCalledWith({
      where: {
        version: 1,
        createdAt: { gte: expect.any(Date), lte: expect.any(Date) },
        project: { jobs: { some: { type: "PLAN_BOOK" } } }
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: 25,
      take: 1,
      select: {
        id: true,
        projectId: true,
        version: true,
        status: true,
        createdAt: true,
        project: {
          select: {
            title: true,
            targetPages: true,
            user: { select: { email: true } }
          }
        }
      }
    });
    const [economicsSql] = mockDb.prisma.$queryRawUnsafe.mock.calls[0]!;
    expect(economicsSql).toContain("PLAN_GENERATION");
    expect(economicsSql).toContain("j.type = 'PLAN_BOOK'");
    expect(economicsSql).not.toContain("GENERATE_BOOK");
  });
});

describe("GET /api/admin/operations/plans/:id", () => {
  it("returns the same detailed cost breakdown using only PLAN_BOOK calls", async () => {
    mockDb.prisma.planVersion.findFirst.mockResolvedValue({ id: "plan-1", projectId: "book-1" });
    mockDb.prisma.$queryRawUnsafe.mockResolvedValue([
      {
        plan_id: "plan-1",
        charge_count: 1,
        gross_credits: 100,
        refund_count: 0,
        refunded_credits: 0,
        provider_cost_usd: 0.1
      }
    ]);
    mockDb.prisma.$queryRaw.mockResolvedValue([
      {
        kind: "text",
        purpose: "book.plan.raw",
        provider: "gemini",
        model: "gemini-3.5-flash",
        calls: 2,
        priced_calls: 2,
        failed_calls: 0,
        in_flight_calls: 0,
        estimated_calls: 0,
        usd: 0.1,
        prompt_tokens: 1000,
        cached_prompt_tokens: 100,
        output_tokens: 200,
        audio_ms: 0
      }
    ]);
    app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/admin/operations/plans/plan-1" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      planId: "plan-1",
      chargeCount: 1,
      grossCredits: 100,
      revenueUsd: 1,
      providerCostUsd: 0.1,
      marginUsd: 0.9,
      totals: { calls: 2, pricedCalls: 2, usd: 0.1, promptTokens: 1000, outputTokens: 200 }
    });
    expect(response.json().purposes).toEqual([
      expect.objectContaining({
        key: "book.plan.raw",
        models: [expect.objectContaining({ provider: "gemini", model: "gemini-3.5-flash" })]
      })
    ]);
    const [costSql] = mockDb.prisma.$queryRaw.mock.calls[0]!;
    const sql = Array.from(costSql as readonly string[]).join(" ");
    expect(sql).toContain("j.type = 'PLAN_BOOK'");
    expect(sql).not.toContain("GENERATE_BOOK");
  });

  it("returns 404 for a row that is not an initial generated plan", async () => {
    app = await buildApp();

    expect((await app.inject({ method: "GET", url: "/api/admin/operations/plans/missing" })).statusCode).toBe(404);
    expect(mockDb.prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("generated-plan route auth and pagination defaults", () => {
  it("uses 25 rows by default and requires the operator cookie", async () => {
    app = await buildApp();
    const empty = await app.inject({ method: "GET", url: "/api/admin/operations/plans" });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ plans: [], total: 0, limit: 25, offset: 0 });
    expect(mockDb.prisma.planVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 25, skip: 0 }));
    await app.close();

    app = await buildApp("hunter2");
    expect((await app.inject({ method: "GET", url: "/api/admin/operations/plans" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/admin/operations/plans/plan-1" })).statusCode).toBe(401);
  });
});

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CREDIT_PRICE_KEYS,
  CREDIT_PRICING_KEYS,
  CREDIT_PRICING_LIMITS,
  DEFAULT_CREDIT_COSTS,
  type CreditPricing,
  creditPricing,
  resetCreditPricing
} from "@book-maker/core";
import { registerAuth } from "../auth.js";
import { adminPricingRoutes } from "./adminPricing.js";
import { revenueAtPricing, type PricingDrivers } from "../admin/pricingDrivers.js";

// Drivers cover the price keys only; the allowance keys in the same table are
// limits, not something a quantity multiplies.
const ZERO_DRIVERS = Object.fromEntries(CREDIT_PRICE_KEYS.map((key) => [key, 0])) as PricingDrivers;
const ZERO_PRICING = Object.fromEntries(CREDIT_PRICING_KEYS.map((key) => [key, 0])) as CreditPricing;

const mockDb = vi.hoisted(() => {
  class FakeConflictError extends Error {
    readonly currentVersion: number;
    constructor(currentVersion: number) {
      super("Pricing changed in another session. Reload before saving again.");
      this.name = "CreditPricingConflictError";
      this.currentVersion = currentVersion;
    }
  }

  return {
    FakeConflictError,
    state: {
      version: 0,
      values: {} as Record<string, number>,
      revisions: [] as Array<Record<string, unknown>>,
      conflict: false
    },
    prisma: {
      user: { upsert: vi.fn() },
      mobileSession: { findUnique: vi.fn() },
      creditLedgerEntry: { groupBy: vi.fn(), aggregate: vi.fn() },
      providerCallLog: { aggregate: vi.fn() },
      voiceCall: { findMany: vi.fn() },
      bookEditOperation: { findMany: vi.fn() },
      project: { findMany: vi.fn() }
    }
  };
});

vi.mock("@book-maker/db", () => ({
  prisma: mockDb.prisma,
  Prisma: {},
  CreditPricingConflictError: mockDb.FakeConflictError,
  getCreditPricingState: vi.fn(async () => ({
    values: { ...DEFAULT_CREDIT_COSTS, ...mockDb.state.values },
    version: mockDb.state.version,
    note: null,
    updatedBy: null,
    updatedAt: null
  })),
  listCreditPricingRevisions: vi.fn(async () => mockDb.state.revisions),
  saveCreditPricing: vi.fn(async (options: { values: Record<string, number>; expectedVersion?: number }) => {
    if (mockDb.state.conflict) {
      throw new mockDb.FakeConflictError(mockDb.state.version);
    }
    mockDb.state.values = { ...options.values };
    mockDb.state.version += 1;
    return {
      values: { ...DEFAULT_CREDIT_COSTS, ...mockDb.state.values },
      version: mockDb.state.version,
      note: null,
      updatedBy: null,
      updatedAt: new Date("2026-07-28T00:00:00.000Z"),
      changed: {},
      applied: true
    };
  }),
  revertCreditPricing: vi.fn(async (options: { version: number }) => {
    if (options.version > mockDb.state.version) {
      throw new Error(`No pricing revision numbered ${options.version}.`);
    }
    mockDb.state.version += 1;
    return {
      values: { ...DEFAULT_CREDIT_COSTS },
      version: mockDb.state.version,
      note: `Reverted to version ${options.version}`,
      updatedBy: null,
      updatedAt: new Date("2026-07-28T00:00:00.000Z"),
      changed: {},
      applied: true
    };
  })
}));

const originalEnv = { ...process.env };
let app: FastifyInstance;

async function buildApp(webPassword = ""): Promise<FastifyInstance> {
  process.env = { ...originalEnv, WEB_PASSWORD: webPassword, OPENAI_API_KEY: "", GEMINI_API_KEY: "" };
  const instance = Fastify();
  await registerAuth(instance, { WEB_PASSWORD: webPassword } as never);
  await instance.register(adminPricingRoutes);
  await instance.ready();
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.state.version = 0;
  mockDb.state.values = {};
  mockDb.state.revisions = [];
  mockDb.state.conflict = false;
  mockDb.prisma.user.upsert.mockResolvedValue({ id: "local-admin" });
  mockDb.prisma.mobileSession.findUnique.mockResolvedValue(null);
  mockDb.prisma.creditLedgerEntry.groupBy.mockResolvedValue([]);
  mockDb.prisma.creditLedgerEntry.aggregate.mockResolvedValue({ _sum: { amountCredits: null } });
  mockDb.prisma.providerCallLog.aggregate.mockResolvedValue({ _sum: { costHint: null } });
  mockDb.prisma.voiceCall.findMany.mockResolvedValue([]);
  mockDb.prisma.bookEditOperation.findMany.mockResolvedValue([]);
  mockDb.prisma.project.findMany.mockResolvedValue([]);
  resetCreditPricing();
});

afterEach(async () => {
  await app?.close();
  process.env = { ...originalEnv };
  resetCreditPricing();
});

describe("GET /api/admin/pricing", () => {
  it("returns the live values alongside the defaults, limits and a worked example", async () => {
    app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/admin/pricing" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.values).toEqual({ ...DEFAULT_CREDIT_COSTS });
    expect(body.defaults).toEqual({ ...DEFAULT_CREDIT_COSTS });
    expect(body.limits.fullBookPerPage).toBe(CREDIT_PRICING_LIMITS.fullBookPerPage);
    expect(body.version).toBe(0);
    // The same estimator production charges through, so the dashboard cannot drift.
    expect(body.preview.totalCredits).toBe(994);
    expect(body.preview.estimatedUsd).toBeCloseTo(9.94, 2);
  });
});

describe("PUT /api/admin/pricing", () => {
  it("saves a complete, in-range price list", async () => {
    app = await buildApp();

    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/pricing",
      payload: { values: { ...DEFAULT_CREDIT_COSTS, imageGeneration: 90 }, note: "Gemini price change" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().version).toBe(1);
    expect(mockDb.state.values.imageGeneration).toBe(90);
  });

  it("rejects a value past its ceiling", async () => {
    app = await buildApp();

    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/pricing",
      payload: { values: { ...DEFAULT_CREDIT_COSTS, fullBookPerPage: CREDIT_PRICING_LIMITS.fullBookPerPage + 1 } }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/fullBookPerPage/);
  });

  it.each([
    ["a negative price", { imageGeneration: -5 }],
    ["a fractional price", { fullBookPerPage: 8.5 }]
  ])("rejects %s", async (_label, patch) => {
    app = await buildApp();

    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/pricing",
      payload: { values: { ...DEFAULT_CREDIT_COSTS, ...patch } }
    });

    expect(response.statusCode).toBe(400);
  });

  it("drops a key this build does not know rather than storing it", async () => {
    // Fastify's AJV strips it under `additionalProperties: false` before Zod
    // sees the body, so this succeeds — what matters is that it never lands.
    app = await buildApp();

    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/pricing",
      payload: { values: { ...DEFAULT_CREDIT_COSTS, somethingNew: 12 } }
    });

    expect(response.statusCode).toBe(200);
    expect(mockDb.state.values).not.toHaveProperty("somethingNew");
  });

  it("accepts the numeric strings a browser form sends", async () => {
    app = await buildApp();

    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/pricing",
      payload: { values: { ...DEFAULT_CREDIT_COSTS, imageGeneration: "90" } }
    });

    expect(response.statusCode).toBe(200);
    expect(mockDb.state.values.imageGeneration).toBe(90);
  });

  it("rejects a partial price list rather than defaulting the rest", async () => {
    app = await buildApp();

    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/pricing",
      payload: { values: { imageGeneration: 90 } }
    });

    expect(response.statusCode).toBe(400);
  });

  it("reports a stale editor as a conflict, not a silent overwrite", async () => {
    mockDb.state.conflict = true;
    mockDb.state.version = 4;
    app = await buildApp();

    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/pricing",
      payload: { values: { ...DEFAULT_CREDIT_COSTS }, expectedVersion: 1 }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().currentVersion).toBe(4);
  });
});

describe("POST /api/admin/pricing/revert", () => {
  it("re-applies an earlier revision", async () => {
    mockDb.state.version = 3;
    app = await buildApp();

    const response = await app.inject({ method: "POST", url: "/api/admin/pricing/revert", payload: { version: 1 } });

    expect(response.statusCode).toBe(200);
    expect(response.json().version).toBe(4);
  });

  it("404s on a revision that was never written", async () => {
    app = await buildApp();

    const response = await app.inject({ method: "POST", url: "/api/admin/pricing/revert", payload: { version: 99 } });

    expect(response.statusCode).toBe(404);
  });
});

describe("POST /api/admin/pricing/preview", () => {
  it("prices proposed values without making them live", async () => {
    app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/pricing/preview",
      payload: { values: { ...DEFAULT_CREDIT_COSTS, exportUnlock: 400 } }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().totalCredits).toBe(994 + 250);
    // The prices everyone else is being charged have not moved.
    expect(creditPricing().exportUnlock).toBe(DEFAULT_CREDIT_COSTS.exportUnlock);
  });
});

describe("GET /api/admin/pricing/drivers", () => {
  it("turns charged work into quantities the browser can re-price", async () => {
    // Two generations of one 20-page book, plus a voice call and a text edit.
    mockDb.prisma.creditLedgerEntry.groupBy.mockImplementation(async ({ where }: { where: { operation?: string } }) => {
      if (where.operation === "FULL_BOOK_GENERATION") return [{ projectId: "project-1", _count: { _all: 2 } }];
      if (where.operation === "BOOK_REPLAN") return [];
      return [{ operation: "PLAN_REVISION", _count: { _all: 3 } }];
    });
    mockDb.prisma.project.findMany.mockResolvedValue([
      {
        id: "project-1",
        title: "Onboarding workbook",
        subtitle: null,
        authorName: null,
        coverTagline: null,
        prompt: "Create a practical workbook about onboarding new managers.",
        category: "EDUCATION",
        subcategory: "Workbook or Study Guide",
        targetPages: 20,
        complexity: 5,
        temperature: 0.65,
        language: "en",
        mediaSettings: { fullIllustrations: true, includeCover: true }
      }
    ]);
    mockDb.prisma.voiceCall.findMany.mockResolvedValue([{ elapsedSeconds: 90 }]);
    mockDb.prisma.bookEditOperation.findMany.mockResolvedValue([{ kind: "LOCAL_PATCH", affectedPageIndexes: [1, 2] }]);
    mockDb.prisma.providerCallLog.aggregate.mockResolvedValue({ _sum: { costHint: 4.5 } });
    mockDb.prisma.creditLedgerEntry.aggregate.mockResolvedValue({ _sum: { amountCredits: -9000 } });
    app = await buildApp();

    const body = (await app.inject({ method: "GET", url: "/api/admin/pricing/drivers?days=90" })).json();

    expect(body.books).toBe(2);
    expect(body.drivers.fullBookBase).toBe(2);
    expect(body.drivers.fullBookPerPage).toBe(40);
    // A full generation bundles the export unlock, so two books means two.
    expect(body.drivers.exportUnlock).toBe(2);
    expect(body.drivers.planRevision).toBe(3);
    // 90 seconds rounds up to two billable minutes.
    expect(body.drivers.voiceCallPerMinute).toBe(2);
    expect(body.drivers.bookTextEditBase).toBe(1);
    expect(body.drivers.bookTextEditPerPage).toBe(2);
    expect(body.providerUsd).toBe(4.5);
    expect(body.coverage.chargedCredits).toBe(9000);
  });

  it("reports how faithfully the model reproduces the ledger", async () => {
    mockDb.prisma.creditLedgerEntry.groupBy.mockResolvedValue([]);
    mockDb.prisma.creditLedgerEntry.aggregate.mockResolvedValue({ _sum: { amountCredits: -1000 } });
    mockDb.prisma.voiceCall.findMany.mockResolvedValue([{ elapsedSeconds: 600 }]);
    app = await buildApp();

    const coverage = (await app.inject({ method: "GET", url: "/api/admin/pricing/drivers" })).json().coverage;

    // 10 minutes at 60 credits = 600 modelled against 1000 charged.
    expect(coverage.modelledCredits).toBe(600);
    expect(coverage.accuracyPercent).toBe(60);
  });

  it("says nothing was charged rather than dividing by zero", async () => {
    app = await buildApp();

    const body = (await app.inject({ method: "GET", url: "/api/admin/pricing/drivers?days=7" })).json();

    expect(body.coverage.chargedCredits).toBe(0);
    expect(body.coverage.accuracyPercent).toBeNull();
  });

  it("rejects a window it cannot project over", async () => {
    app = await buildApp();

    expect((await app.inject({ method: "GET", url: "/api/admin/pricing/drivers?days=0" })).statusCode).toBe(400);
  });
});

describe("revenueAtPricing", () => {
  it("is linear in every price, which is what lets the dashboard recompute locally", () => {
    const drivers = { ...ZERO_DRIVERS, fullBookBase: 3, imageGeneration: 10 };
    const base = revenueAtPricing(drivers, DEFAULT_CREDIT_COSTS);

    const dearerImages = revenueAtPricing(drivers, { ...DEFAULT_CREDIT_COSTS, imageGeneration: DEFAULT_CREDIT_COSTS.imageGeneration + 5 });

    expect(dearerImages - base).toBe(50);
    expect(revenueAtPricing(drivers, ZERO_PRICING)).toBe(0);
  });
});

describe("auth", () => {
  it("refuses every route without the operator cookie", async () => {
    app = await buildApp("hunter2");

    const routes = [
      { method: "GET" as const, url: "/api/admin/pricing" },
      { method: "GET" as const, url: "/api/admin/pricing/drivers" },
      { method: "PUT" as const, url: "/api/admin/pricing", payload: { values: { ...DEFAULT_CREDIT_COSTS } } },
      { method: "POST" as const, url: "/api/admin/pricing/revert", payload: { version: 1 } },
      { method: "POST" as const, url: "/api/admin/pricing/preview", payload: { values: { ...DEFAULT_CREDIT_COSTS } } }
    ];

    for (const route of routes) {
      const response = await app.inject(route);
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });
});

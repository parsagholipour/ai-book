import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QUALITY_FEATURE_DEFAULTS, qualityFeatureEnabled } from "@book-maker/core";
import { adminGenerationQualityRoutes } from "./adminGenerationQuality.js";

const mockPrisma = vi.hoisted(() => ({
  $transaction: vi.fn(),
  generationQualityRevision: {
    findFirst: vi.fn(),
    create: vi.fn()
  }
}));

vi.mock("@book-maker/db", () => ({ prisma: mockPrisma }));
vi.mock("../requestAuth.js", () => ({
  markOperatorRequest: vi.fn(async () => ({ userId: "local-admin" }))
}));

const emptySettings = {
  storyExtractAudit: [],
  planCritic: [],
  claimVerifier: [],
  styleExcerpts: [],
  styleAuditor: [],
  pageMapCritic: [],
  writerTools: [],
  bestOfPolish: [],
  planThinkingBoost: [],
  claimRetrieve: []
};

describe("admin generation quality settings", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPrisma.$transaction.mockImplementation(
      async (operation: (tx: typeof mockPrisma) => Promise<unknown>) => operation(mockPrisma)
    );
  });

  it("returns compiled defaults when no revision rows exist", async () => {
    mockPrisma.generationQualityRevision.findFirst.mockResolvedValue(null);
    const app = Fastify();
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/generation-quality"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 0,
      usingCompiledDefaults: true,
      settings: QUALITY_FEATURE_DEFAULTS
    });
    await app.close();
  });

  it("writes an append-only revision for the full feature map", async () => {
    mockPrisma.generationQualityRevision.findFirst.mockResolvedValue({ version: 2 });
    mockPrisma.generationQualityRevision.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "quality-3",
        note: null,
        updatedBy: null,
        createdAt: new Date("2026-08-14T09:00:00.000Z"),
        ...data
      })
    );
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: {
        ...QUALITY_FEATURE_DEFAULTS,
        styleAuditor: ["ultra"],
        note: "Premium style audit off"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 3,
      usingCompiledDefaults: false,
      settings: {
        ...QUALITY_FEATURE_DEFAULTS,
        styleAuditor: ["ultra"]
      },
      note: "Premium style audit off"
    });
    expect(mockPrisma.generationQualityRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        version: 3,
        updatedBy: "operator-console"
      })
    });
    await app.close();
  });

  it("treats an empty assignment as disabled", async () => {
    mockPrisma.generationQualityRevision.findFirst.mockResolvedValue({ version: 1 });
    mockPrisma.generationQualityRevision.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "quality-2",
        note: null,
        updatedBy: "operator-console",
        createdAt: new Date("2026-08-14T10:00:00.000Z"),
        ...data
      })
    );
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: emptySettings
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { settings: typeof emptySettings };
    expect(body.settings.storyExtractAudit).toEqual([]);
    expect(qualityFeatureEnabled(body.settings, "storyExtractAudit", "ultra")).toBe(false);
    expect(qualityFeatureEnabled(body.settings, "writerTools", "ultra")).toBe(false);
    await app.close();
  });

  it("reset writes a revision matching compiled defaults", async () => {
    mockPrisma.generationQualityRevision.findFirst.mockResolvedValue({ version: 4 });
    mockPrisma.generationQualityRevision.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "quality-5",
        updatedBy: "operator-console",
        createdAt: new Date("2026-08-14T11:00:00.000Z"),
        ...data
      })
    );
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/generation-quality/reset",
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 5,
      usingCompiledDefaults: false,
      settings: QUALITY_FEATURE_DEFAULTS,
      note: "Reset to compiled defaults"
    });
    await app.close();
  });
});

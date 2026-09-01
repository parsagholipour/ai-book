import Fastify from "fastify";
import { OPENROUTER_GLM_53_FLASH_MODEL, QUALITY_FEATURE_DEFAULTS } from "@book-maker/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminGenerationQualityRoutes } from "./adminGenerationQuality.js";

const mockPrisma = vi.hoisted(() => ({
  generationQualityRevision: { findFirst: vi.fn(), create: vi.fn() }
}));
const mockRequireOperatorActor = vi.hoisted(() => vi.fn());
vi.mock("@book-maker/db", () => ({ prisma: mockPrisma }));
vi.mock("../requestAuth.js", () => ({ requireOperatorActor: mockRequireOperatorActor }));

describe("admin generation model routing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.assign(process.env, {
      DEEPSEEK_API_KEY: "deepseek-test-key",
      DEEPINFRA_API_KEY: "deepinfra-test-key",
      GEMINI_API_KEY: "gemini-test-key",
      ALIBABA_API_KEY: "alibaba-test-key",
      OPENAI_API_KEY: "openai-test-key",
      OPENROUTER_API_KEY: "openrouter-test-key",
      MOCK_AI: "false"
    });
    mockRequireOperatorActor.mockResolvedValue({ kind: "operator", userId: "local-admin" });
  });

  it("backfills compact context defaults in a stored pre-feature revision", async () => {
    const { compactPageDraftContext: _missing, ...legacySettings } = QUALITY_FEATURE_DEFAULTS;
    mockStoredRevision({ version: 4, settings: legacySettings });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({ method: "GET", url: "/api/admin/generation-quality" });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { settings: Record<string, string[]> }).settings.compactPageDraftContext).toEqual([
      "balanced",
      "fast"
    ]);
    await app.close();
  });

  it("can disable and reassign compact page-draft context tiers live", async () => {
    mockStoredRevision({ version: 1, settings: { ...QUALITY_FEATURE_DEFAULTS } });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const disabled = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { compactPageDraftContext: [] }
    });
    expect(disabled.statusCode).toBe(200);
    const disabledSettings = (disabled.json() as { settings: Record<string, string[]> }).settings;
    expect(disabledSettings.compactPageDraftContext).toEqual([]);

    mockStoredRevision({ version: 2, settings: disabledSettings });
    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { compactPageDraftContext: ["ultra", "premium"] }
    });
    expect(enabled.statusCode).toBe(200);
    expect((enabled.json() as { settings: Record<string, string[]> }).settings.compactPageDraftContext).toEqual([
      "ultra",
      "premium"
    ]);
    await app.close();
  });

  it("merges one model-role leaf and validates its discrete effort", async () => {
    mockStoredRevision({ version: 5, settings: { ...QUALITY_FEATURE_DEFAULTS } });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: {
        models: { balanced: { writer: { provider: "deepseek", model: "deepseek-v4-pro", thinkingEffort: "high" } } }
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 6,
      models: { balanced: { writer: { provider: "deepseek", model: "deepseek-v4-pro", thinkingEffort: "high" } } }
    });
    const create = createdSettings(0);
    expect(create.models).toMatchObject({ balanced: { writer: { thinkingEffort: "high" } } });
    expect(create.planCritic).toEqual(QUALITY_FEATURE_DEFAULTS.planCritic);
    await app.close();
  });

  it("persists fallback selections for fast judgments and tier routes", async () => {
    mockStoredRevision({ version: 5, settings: { ...QUALITY_FEATURE_DEFAULTS } });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: {
        models: {
          fastJudgmentsFallback: { provider: "alibaba", model: "qwen-flash" },
          fast: { writerFallback: { provider: "alibaba", model: "qwen-plus" } }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      models: {
        fastJudgmentsFallback: { provider: "alibaba", model: "qwen-flash" },
        fast: { writerFallback: { provider: "alibaba", model: "qwen-plus" } }
      }
    });
    expect(createdSettings(0).models).toMatchObject({
      fastJudgmentsFallback: { provider: "alibaba", model: "qwen-flash" },
      fast: { writerFallback: { provider: "alibaba", model: "qwen-plus" } }
    });
    await app.close();
  });

  it("offers and saves every OpenAI model with its supported reasoning effort", async () => {
    mockStoredRevision(null);
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const catalogResponse = await app.inject({ method: "GET", url: "/api/admin/generation-quality" });
    const catalog = (catalogResponse.json() as {
      modelOptions: Array<{
        provider: string;
        model: string;
        thinkingEfforts?: Array<{ value: string }>;
        costs?: Array<{ inputPerMillion: number; outputPerMillion: number }>;
      }>;
    }).modelOptions;
    expect(catalog.filter((option) => option.provider === "openai").map((option) => option.model)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5-nano"
    ]);
    expect(catalog.find((option) => option.model === "gpt-5.6-sol")?.thinkingEfforts?.map((effort) => effort.value))
      .toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(catalog.find((option) => option.model === "gpt-5.6-luna")?.costs).toEqual([
      expect.objectContaining({ inputPerMillion: 0.2, outputPerMillion: 1.2 }),
      expect.objectContaining({ inputPerMillion: 0.4, outputPerMillion: 1.8 })
    ]);
    expect(catalog.find((option) => option.model === "gpt-5-nano")?.thinkingEfforts?.map((effort) => effort.value))
      .toEqual(["minimal", "low", "medium", "high"]);
    expect(catalog.find((option) => option.model === "gpt-5-nano")?.costs).toEqual([
      expect.objectContaining({ inputPerMillion: 0.05, outputPerMillion: 0.4 })
    ]);

    const save = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: {
        models: {
          premium: { writer: { provider: "openai", model: "gpt-5.6-sol", thinkingEffort: "xhigh" } }
        }
      }
    });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toMatchObject({
      models: {
        premium: { writer: { provider: "openai", model: "gpt-5.6-sol", thinkingEffort: "xhigh" } }
      }
    });
    await app.close();
  });

  it("offers and saves OpenRouter GLM 5.3 Flash with supported reasoning effort", async () => {
    mockStoredRevision(null);
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const catalogResponse = await app.inject({ method: "GET", url: "/api/admin/generation-quality" });
    const catalog = (catalogResponse.json() as {
      modelOptions: Array<{
        provider: string;
        model: string;
        thinkingEfforts?: Array<{ value: string }>;
        costs?: Array<{ inputPerMillion: number; outputPerMillion: number }>;
      }>;
    }).modelOptions;
    const glm = catalog.find(
      (option) => option.provider === "openrouter" && option.model === OPENROUTER_GLM_53_FLASH_MODEL
    );
    expect(glm?.thinkingEfforts?.map((effort) => effort.value)).toEqual(["low", "high", "max"]);
    expect(glm?.costs).toEqual([
      expect.objectContaining({ inputPerMillion: 0.075, outputPerMillion: 0.25, cacheHitPerMillion: 0.015 })
    ]);

    const save = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: {
        models: {
          balanced: {
            writer: { provider: "openrouter", model: OPENROUTER_GLM_53_FLASH_MODEL, thinkingEffort: "high" }
          }
        }
      }
    });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toMatchObject({
      models: {
        balanced: {
          writer: { provider: "openrouter", model: OPENROUTER_GLM_53_FLASH_MODEL, thinkingEffort: "high" }
        }
      }
    });
    await app.close();
  });

  it("refuses unknown roles, non-catalog models, unsupported efforts, and unavailable providers", async () => {
    mockStoredRevision({ version: 2, settings: { ...QUALITY_FEATURE_DEFAULTS } });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);
    const payloads = [
      { models: { balanced: { reviewer: { provider: "deepseek", model: "deepseek-v4-pro" } } } },
      { models: { balanced: { writer: { provider: "deepseek", model: "invented-model" } } } },
      { models: { balanced: { writer: { provider: "alibaba", model: "qwen-plus", thinkingEffort: "high" } } } }
    ];
    const responses = await Promise.all(payloads.map((payload) => app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload
    })));
    expect(responses.map((response) => response.statusCode)).toEqual([400, 400, 400]);
    expect((responses[0]!.json() as { error: string }).error).toContain("models.balanced.reviewer");
    expect((responses[1]!.json() as { error: string }).error).toContain("not a configured catalog model");
    expect((responses[2]!.json() as { error: string }).error).toContain("not supported");
    await app.close();

    process.env.GEMINI_API_KEY = "";
    const withoutGemini = Fastify({ logger: false });
    await withoutGemini.register(adminGenerationQualityRoutes);
    const unavailable = await withoutGemini.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { models: { premium: { writer: { provider: "gemini", model: "gemini-2.5-pro" } } } }
    });
    expect(unavailable.statusCode).toBe(400);
    expect((unavailable.json() as { error: string }).error).toContain("not a configured catalog model");
    expect(mockPrisma.generationQualityRevision.create).not.toHaveBeenCalled();
    await withoutGemini.close();
  });

  it("keeps models on a gate reset and keeps gates on a model reset", async () => {
    const savedModels = {
      fastJudgments: { provider: "alibaba", model: "qwen-flash" },
      balanced: {
        writer: { provider: "alibaba", model: "qwen-plus" },
        futureReviewer: { provider: "alibaba", model: "qwen3-max" }
      },
      futureTier: { writer: { provider: "alibaba", model: "qwen3.5-plus" } }
    };
    mockStoredRevision({
      version: 8,
      settings: { ...QUALITY_FEATURE_DEFAULTS, styleAuditor: [], models: savedModels }
    });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);
    const gates = await app.inject({ method: "POST", url: "/api/admin/generation-quality/reset", payload: {} });
    expect(gates.statusCode).toBe(200);
    expect(createdSettings(0).models).toEqual(savedModels);
    expect(createdSettings(0).styleAuditor).toEqual(QUALITY_FEATURE_DEFAULTS.styleAuditor);

    mockPrisma.generationQualityRevision.create.mockClear();
    const models = await app.inject({
      method: "POST",
      url: "/api/admin/generation-quality/models/reset",
      payload: { note: "restore routing" }
    });
    expect(models.statusCode).toBe(200);
    expect(createdSettings(0).styleAuditor).toEqual([]);
    expect(createdSettings(0).models).toMatchObject({
      fastJudgments: { provider: "deepseek", model: "deepseek-v4-flash" },
      fastJudgmentsFallback: { provider: "deepinfra", model: "deepseek-ai/DeepSeek-V4-Flash" },
      premium: {
        writer: { provider: "gemini", model: "gemini-2.5-pro" },
        writerFallback: { provider: "deepseek", model: "deepseek-v4-pro" }
      },
      balanced: { futureReviewer: savedModels.balanced.futureReviewer },
      futureTier: savedModels.futureTier
    });
    await app.close();
  });

  it("re-merges different role leaves after a concurrent revision wins", async () => {
    const winner = {
      ...QUALITY_FEATURE_DEFAULTS,
      models: { balanced: { judgment: { provider: "alibaba", model: "qwen-plus" } } }
    };
    mockPrisma.generationQualityRevision.findFirst
      .mockResolvedValueOnce({ version: 7, settings: { ...QUALITY_FEATURE_DEFAULTS } })
      .mockResolvedValueOnce({ version: 8, settings: winner });
    mockPrisma.generationQualityRevision.create
      .mockRejectedValueOnce(versionAlreadyTaken())
      .mockImplementation(echoCreatedRevision);
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: {
        models: { premium: { writer: { provider: "deepseek", model: "deepseek-v4-pro", thinkingEffort: "high" } } }
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 9,
      models: {
        balanced: { judgment: { provider: "alibaba", model: "qwen-plus" } },
        premium: { writer: { provider: "deepseek", model: "deepseek-v4-pro", thinkingEffort: "high" } }
      }
    });
    expect(createdSettings(1).models).toMatchObject({
      balanced: { judgment: { provider: "alibaba", model: "qwen-plus" } },
      premium: { writer: { provider: "deepseek", model: "deepseek-v4-pro", thinkingEffort: "high" } }
    });
    await app.close();
  });
});

function mockStoredRevision(current: { version: number; settings?: unknown } | null): void {
  mockPrisma.generationQualityRevision.findFirst.mockResolvedValue(
    current
      ? {
          note: null,
          updatedBy: "operator-console",
          createdAt: new Date("2026-08-23T08:00:00.000Z"),
          ...current
        }
      : null
  );
  mockPrisma.generationQualityRevision.create.mockImplementation(echoCreatedRevision);
}

async function echoCreatedRevision({ data }: { data: Record<string, unknown> }) {
  return {
    id: "quality-next",
    note: null,
    updatedBy: "operator-console",
    createdAt: new Date("2026-08-23T09:00:00.000Z"),
    ...data
  };
}

function createdSettings(call: number): Record<string, unknown> {
  const createCall = mockPrisma.generationQualityRevision.create.mock.calls[call];
  if (!createCall) {
    throw new Error(`Expected generation quality revision create call ${call}`);
  }
  return (createCall[0] as {
    data: { settings: Record<string, unknown> };
  }).data.settings;
}

function versionAlreadyTaken(): Error {
  return Object.assign(new Error("Unique constraint failed on version"), { code: "P2002" });
}

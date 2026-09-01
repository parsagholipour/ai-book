import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PAGE_REVIEW_PROMPT_MODE_DEFAULTS,
  QUALITY_FEATURE_DEFAULTS
} from "@book-maker/core";
import { adminGenerationQualityRoutes } from "./adminGenerationQuality.js";

const mockPrisma = vi.hoisted(() => ({
  $transaction: vi.fn(),
  generationQualityRevision: {
    findFirst: vi.fn(),
    create: vi.fn()
  }
}));

const mockRequireOperatorActor = vi.hoisted(() => vi.fn());

vi.mock("@book-maker/db", () => ({ prisma: mockPrisma }));
vi.mock("../requestAuth.js", () => ({
  requireOperatorActor: mockRequireOperatorActor
}));

function mockStoredRevision(current: { version: number; settings?: unknown }): void {
  mockPrisma.generationQualityRevision.findFirst.mockResolvedValue(current);
  mockPrisma.generationQualityRevision.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: "quality-next",
      note: null,
      updatedBy: "operator-console",
      createdAt: new Date("2026-08-23T09:00:00.000Z"),
      ...data
    })
  );
}

describe("admin generation quality prompt modes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DEEPSEEK_API_KEY = "deepseek-test-key";
    process.env.DEEPINFRA_API_KEY = "deepinfra-test-key";
    process.env.GEMINI_API_KEY = "gemini-test-key";
    process.env.ALIBABA_API_KEY = "alibaba-test-key";
    process.env.OPENAI_API_KEY = "openai-test-key";
    process.env.MOCK_AI = "false";
    mockRequireOperatorActor.mockResolvedValue({ kind: "operator", userId: "local-admin" });
    mockPrisma.$transaction.mockImplementation(
      async (operation: (tx: typeof mockPrisma) => Promise<unknown>) => operation(mockPrisma)
    );
  });

  it("stores one tier without moving the others", async () => {
    mockStoredRevision({
      version: 3,
      settings: {
        ...QUALITY_FEATURE_DEFAULTS,
        pageReviewPromptModes: { ...PAGE_REVIEW_PROMPT_MODE_DEFAULTS, ultra: "compact" }
      }
    });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { pageReviewPromptModes: { premium: "compact" } }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 4,
      pageReviewPromptModes: {
        ultra: "compact",
        premium: "compact",
        balanced: "normal",
        fast: "normal"
      }
    });
    expect(mockPrisma.generationQualityRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        settings: expect.objectContaining({
          pageReviewPromptModes: {
            ultra: "compact",
            premium: "compact",
            balanced: "normal",
            fast: "normal"
          }
        })
      })
    });
    await app.close();
  });

  it("resets prompt modes with the compiled gate defaults", async () => {
    mockStoredRevision({
      version: 4,
      settings: {
        ...QUALITY_FEATURE_DEFAULTS,
        pageReviewPromptModes: { ...PAGE_REVIEW_PROMPT_MODE_DEFAULTS, premium: "compact" }
      }
    });
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
      pageReviewPromptModes: PAGE_REVIEW_PROMPT_MODE_DEFAULTS,
      note: "Reset to compiled defaults"
    });
    await app.close();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProjectSchema,
  FakeTextModelAdapter,
  FallbackTextModelAdapter,
  geminiImageReferenceLimit,
  LiveGenerationTextModelAdapter,
  PREMIUM_COVER_IMAGE_MODEL,
  PREMIUM_FALLBACK_IMAGE_MODEL,
  qwenImageReferenceLimit,
  RoutingTextModelAdapter,
  type ImageModelSelection,
  type TextModelAdapter
} from "@book-maker/core";

const mocks = vi.hoisted(() => ({
  nextProviderCallLogId: 1,
  providerCallLogs: new Map<string, Record<string, unknown>>(),
  prisma: {
    providerCallLog: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn()
    }
  }
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("../runtime/config.js", () => ({
  config: {
    MOCK_AI: false as boolean,
    ALIBABA_IMAGE_MODEL: "qwen-image-2.0",
    GEMINI_IMAGE_MODEL: "gemini-3.1-flash-image",
    GEMINI_API_KEY: "gemini-key"
  }
}));

import { config } from "../runtime/config.js";
import {
  coverImageSelectionForInput,
  imageFallbackSelection,
  liveGenerationTextModel,
  LoggingTextModelAdapter
} from "./loggedAdapters.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.nextProviderCallLogId = 1;
  mocks.providerCallLogs.clear();
  mocks.prisma.providerCallLog.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const id = `provider-call-${mocks.nextProviderCallLogId}`;
    mocks.nextProviderCallLogId += 1;
    mocks.providerCallLogs.set(id, { id, ...data });
    return { id };
  });
  mocks.prisma.providerCallLog.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const current = mocks.providerCallLogs.get(where.id) ?? { id: where.id };
      const updated = { ...current, ...data };
      mocks.providerCallLogs.set(where.id, updated);
      return updated;
    }
  );
  mocks.prisma.providerCallLog.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) => mocks.providerCallLogs.get(where.id) ?? null
  );
});

function silentLogger() {
  return {
    filePath: "/tmp/logged-adapters-test.jsonl",
    append: async () => "2026-01-01T00:00:00.000Z"
  };
}

function wrap(inner: TextModelAdapter) {
  return new LoggingTextModelAdapter(inner, silentLogger(), undefined, undefined, {
    provider: "gemini",
    model: "prose-model"
  });
}

describe("LoggingTextModelAdapter.setPurposeOverridesEnabled", () => {
  it("forwards the toggle to a wrapped RoutingTextModelAdapter", () => {
    const routing = new RoutingTextModelAdapter(
      { selection: { provider: "gemini", model: "prose-model", thinkingBudget: 2048 }, adapter: new FakeTextModelAdapter() },
      { selection: { provider: "gemini", model: "mechanical-model", thinkingBudget: 0 }, adapter: new FakeTextModelAdapter() },
      new Map([
        [
          "plan-book",
          {
            selection: { provider: "gemini", model: "plan-thinking-model", thinkingBudget: 4096 },
            adapter: new FakeTextModelAdapter()
          }
        ]
      ])
    );
    const logged = wrap(routing);
    expect(routing.selectionForPurpose("plan-book").model).toBe("plan-thinking-model");

    logged.setPurposeOverridesEnabled(false);

    expect(routing.selectionForPurpose("plan-book").model).toBe("prose-model");
    expect(routing.selectionForPurpose("plan-book").thinkingBudget).toBe(2048);
  });

  it("forwards the toggle to an inner adapter that only duck-types the method", () => {
    const setPurposeOverridesEnabled = vi.fn();
    const logged = wrap({ setPurposeOverridesEnabled } as unknown as TextModelAdapter);

    logged.setPurposeOverridesEnabled(false);

    expect(setPurposeOverridesEnabled).toHaveBeenCalledWith(false);
  });
});

describe("LoggingTextModelAdapter live selection logging", () => {
  it("persists bounded page-QA rewrite diagnostics without copying request content into provider metadata", async () => {
    const logged = wrap(new FakeTextModelAdapter());

    await logged.generateText({
      messages: [{ role: "user", content: "Reader-facing draft content must stay out of metadata." }],
      purpose: "revise-page",
      providerCallMetadata: {
        qaTriggerReasons: ["claim_grounding", "style"],
        qaCandidateNumber: 3,
        qaRewriteNumber: 2
      }
    } as Parameters<typeof logged.generateText>[0]);

    expect(providerCallRows()).toHaveLength(1);
    const metadata = providerCallRows()[0]!.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({
      qaTriggerReasons: ["claim_grounding", "style"],
      qaCandidateNumber: 3,
      qaRewriteNumber: 2
    });
    expect(JSON.stringify(metadata)).not.toContain("Reader-facing draft content");
  });

  it("records the model bound for the call in its request log", async () => {
    const inner = new FakeTextModelAdapter();
    const delegate: TextModelAdapter = {
      generateText: (options) => inner.generateText(options),
      generateJson: (options) => inner.generateJson(options),
      streamText: () => inner.streamText(),
      generateWithTools: (options) => inner.generateWithTools(options),
      bindForCall: async () => ({
        adapter: inner,
        selection: { provider: "deepseek", model: "revision-selected-model" }
      })
    };
    const append = vi.fn().mockResolvedValue("2026-01-01T00:00:00.000Z");
    const logged = new LoggingTextModelAdapter(
      delegate,
      { filePath: "/tmp/logged-adapters-test.jsonl", append },
      undefined,
      undefined,
      { provider: "deepseek", model: "stale-construction-model" }
    );

    await logged.generateText({ messages: [], purpose: "generate-page" });

    expect(append).toHaveBeenCalledWith(
      "text.generateText.request",
      expect.objectContaining({
        model: { provider: "deepseek", model: "revision-selected-model" }
      })
    );
  });

  it("accounts a failed primary and successful fallback as separate provider calls", async () => {
    const logged = loggedFallbackAdapter(
      usageFailure("gemini", "gemini-2.5-flash", { promptTokens: 17, outputTokens: 3 }),
      {
        text: "fallback answer",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        usage: { promptTokens: 19, outputTokens: 5 }
      }
    );

    await logged.generateText({ messages: [{ role: "user", content: "Draft a page." }] });

    expect(providerCallRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "gemini",
          model: "gemini-2.5-flash",
          promptTokens: 17,
          outputTokens: 3
        }),
        expect.objectContaining({
          provider: "deepseek",
          model: "deepseek-v4-flash",
          promptTokens: 19,
          outputTokens: 5
        })
      ])
    );
    expect(providerCallRows()).toHaveLength(2);
  });

  it("accounts both provider attempts when primary and fallback fail", async () => {
    const logged = loggedFallbackAdapter(
      usageFailure("gemini", "gemini-2.5-flash", { promptTokens: 23, outputTokens: 4 }),
      usageFailure("deepseek", "deepseek-v4-flash", { promptTokens: 29, outputTokens: 6 })
    );

    await expect(
      logged.generateText({ messages: [{ role: "user", content: "Draft a page." }] })
    ).rejects.toThrow("failed for primary gemini/gemini-2.5-flash and fallback deepseek/deepseek-v4-flash");

    expect(providerCallRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "gemini",
          model: "gemini-2.5-flash",
          promptTokens: 23,
          outputTokens: 4
        }),
        expect.objectContaining({
          provider: "deepseek",
          model: "deepseek-v4-flash",
          promptTokens: 29,
          outputTokens: 6
        })
      ])
    );
    expect(providerCallRows()).toHaveLength(2);
  });

  it("keeps every primary/fallback pair separate when the logical call retries", async () => {
    vi.useFakeTimers();
    try {
      const logged = loggedFallbackAdapter(
        usageFailure("gemini", "gemini-2.5-flash", { promptTokens: 31, outputTokens: 7 }, 503),
        usageFailure("deepseek", "deepseek-v4-flash", { promptTokens: 37, outputTokens: 8 }, 503)
      );

      const rejection = expect(
        logged.generateText({ messages: [{ role: "user", content: "Draft a page." }] })
      ).rejects.toThrow("failed for primary gemini/gemini-2.5-flash and fallback deepseek/deepseek-v4-flash");
      await vi.runAllTimersAsync();
      await rejection;

      expect(providerCallRows().filter((row) => row.provider === "gemini")).toHaveLength(3);
      expect(providerCallRows().filter((row) => row.provider === "deepseek")).toHaveLength(3);
      expect(providerCallRows()).toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("coverImageSelectionForInput", () => {
  it("uses the premium cover image model for both premium and ultra books", () => {
    const expected = { provider: "gemini", model: PREMIUM_COVER_IMAGE_MODEL };
    expect(coverImageSelectionForInput(tierProjectInput("premium"))).toEqual(expected);
    expect(coverImageSelectionForInput(tierProjectInput("ultra"))).toEqual(expected);
  });

  it("leaves balanced and fast books on the default image model", () => {
    expect(coverImageSelectionForInput(tierProjectInput("balanced"))).toBeUndefined();
    expect(coverImageSelectionForInput(tierProjectInput("fast"))).toBeUndefined();
  });
});

describe("imageFallbackSelection", () => {
  const geminiPrimary: ImageModelSelection = { provider: "gemini", model: "gemini-3.1-flash-image" };

  it("falls back ultra books to the same premium Alibaba model as premium books", () => {
    const expected = { provider: "alibaba", model: PREMIUM_FALLBACK_IMAGE_MODEL };
    expect(imageFallbackSelection(geminiPrimary, tierProjectInput("premium"))).toEqual(expected);
    expect(imageFallbackSelection(geminiPrimary, tierProjectInput("ultra"))).toEqual(expected);
  });

  it("falls back balanced books to the default Alibaba model", () => {
    expect(imageFallbackSelection(geminiPrimary, tierProjectInput("balanced"))).toEqual({
      provider: "alibaba",
      model: "qwen-image-2.0"
    });
  });

  // The pair this module builds is the reason `FallbackImageAdapter` re-fits a
  // fallback render rather than reporting the weaker of the two budgets: on the
  // stock config a premium cover is sized against five references and its
  // fallback takes three, so trimming is the ordinary case rather than an
  // operator misconfiguration.
  it("pairs a premium cover with a fallback that takes fewer reference images", () => {
    const cover = coverImageSelectionForInput(tierProjectInput("premium"));
    const fallback = imageFallbackSelection(cover!, tierProjectInput("premium"));

    expect(geminiImageReferenceLimit(cover!.model)).toBe(5);
    expect(qwenImageReferenceLimit(fallback.model)).toBe(3);
  });

  it("can pair a reference-capable primary with a fallback model that takes none", () => {
    const previous = config.ALIBABA_IMAGE_MODEL;
    try {
      config.ALIBABA_IMAGE_MODEL = "qwen-image-max";
      const fallback = imageFallbackSelection(geminiPrimary, tierProjectInput("balanced"));

      expect(fallback).toEqual({ provider: "alibaba", model: "qwen-image-max" });
      expect(geminiImageReferenceLimit(geminiPrimary.model)).toBeGreaterThan(0);
      expect(qwenImageReferenceLimit(fallback.model)).toBe(0);
    } finally {
      config.ALIBABA_IMAGE_MODEL = previous;
    }
  });
});

describe("liveGenerationTextModel", () => {
  it("returns the factory-provided delegate only outside a real project generation", () => {
    const delegate = new FakeTextModelAdapter();
    const logger = silentLogger();
    const previousMockAi = config.MOCK_AI;
    try {
      config.MOCK_AI = true;
      expect(liveGenerationTextModel(delegate, tierProjectInput("fast"), logger)).toBe(delegate);
    } finally {
      config.MOCK_AI = previousMockAi;
    }
    expect(liveGenerationTextModel(delegate, undefined, logger)).toBe(delegate);
  });

  it("uses live Quality-tab routing for tiered, explicit-model, and legacy project inputs", () => {
    const delegate = new FakeTextModelAdapter();
    expect(liveGenerationTextModel(delegate, tierProjectInput("fast"), silentLogger())).toBeInstanceOf(
      LiveGenerationTextModelAdapter
    );
    expect(
      liveGenerationTextModel(
        delegate,
        tierProjectInput("fast", { provider: "deepseek", model: "deepseek-writer" }),
        silentLogger()
      )
    ).toBeInstanceOf(LiveGenerationTextModelAdapter);
    expect(liveGenerationTextModel(delegate, legacyProjectInput(), silentLogger())).toBeInstanceOf(
      LiveGenerationTextModelAdapter
    );
  });
});

function legacyProjectInput() {
  return createProjectSchema.parse({
    prompt: "A legacy project created before quality tiers were stored.",
    mediaSettings: {
      fullIllustrations: true,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral"
    }
  });
}

function tierProjectInput(
  modelTier: "fast" | "balanced" | "premium" | "ultra",
  textModel?: { provider: "deepseek" | "deepinfra" | "gemini" | "alibaba" | "openai"; model: string }
) {
  return createProjectSchema.parse({
    prompt: "A practical book about choosing the right generation model for long-form writing.",
    mediaSettings: {
      fullIllustrations: true,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral",
      modelTier,
      ...(textModel ? { textModel } : {})
    }
  });
}

function loggedFallbackAdapter(primaryError: Error, fallbackResult: Awaited<ReturnType<TextModelAdapter["generateText"]>> | Error) {
  const primary = textAdapter(async () => {
    throw primaryError;
  });
  const fallback = textAdapter(async () => {
    if (fallbackResult instanceof Error) {
      throw fallbackResult;
    }
    return fallbackResult;
  });
  return new LoggingTextModelAdapter(
    new FallbackTextModelAdapter({
      primary: {
        selection: { provider: "gemini", model: "gemini-2.5-flash" },
        adapter: primary
      },
      fallback: {
        selection: { provider: "deepseek", model: "deepseek-v4-flash" },
        adapter: fallback
      }
    }),
    silentLogger(),
    undefined,
    "project-1",
    { provider: "gemini", model: "gemini-2.5-flash" }
  );
}

function textAdapter(generateText: TextModelAdapter["generateText"]): TextModelAdapter {
  const fake = new FakeTextModelAdapter();
  return {
    generateText,
    generateJson: (options) => fake.generateJson(options),
    streamText: () => fake.streamText(),
    generateWithTools: (options) => fake.generateWithTools(options)
  };
}

function usageFailure(
  provider: string,
  model: string,
  usage: { promptTokens: number; outputTokens: number },
  status?: number
) {
  return Object.assign(new Error(`${provider} failed`), {
    provider,
    model,
    usage,
    ...(status === undefined ? {} : { status })
  });
}

function providerCallRows() {
  return [...mocks.providerCallLogs.values()];
}

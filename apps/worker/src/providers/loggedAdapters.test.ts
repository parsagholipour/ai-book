import { describe, expect, it, vi } from "vitest";
import {
  createProjectSchema,
  FakeTextModelAdapter,
  LiveGenerationTextModelAdapter,
  PREMIUM_COVER_IMAGE_MODEL,
  PREMIUM_FALLBACK_IMAGE_MODEL,
  RoutingTextModelAdapter,
  type ImageModelSelection,
  type TextModelAdapter
} from "@book-maker/core";

vi.mock("@book-maker/db", () => ({ prisma: {}, Prisma: {} }));
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
});

describe("liveGenerationTextModel", () => {
  it("returns the factory-provided delegate when MOCK_AI, no tier, or an explicit text model is set", () => {
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
    expect(liveGenerationTextModel(delegate, tierProjectInput("fast", { provider: "deepseek", model: "deepseek-writer" }), logger)).toBe(
      delegate
    );
  });

  it("returns the live factory adapter when a quality tier is in force", () => {
    const delegate = new FakeTextModelAdapter();
    expect(liveGenerationTextModel(delegate, tierProjectInput("fast"), silentLogger())).toBeInstanceOf(
      LiveGenerationTextModelAdapter
    );
  });
});

function tierProjectInput(
  modelTier: "fast" | "balanced" | "premium" | "ultra",
  textModel?: { provider: "deepseek" | "deepinfra" | "gemini" | "alibaba"; model: string }
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

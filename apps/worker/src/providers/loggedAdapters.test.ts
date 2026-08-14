import { describe, expect, it, vi } from "vitest";
import {
  createProjectSchema,
  FakeTextModelAdapter,
  PREMIUM_COVER_IMAGE_MODEL,
  PREMIUM_FALLBACK_IMAGE_MODEL,
  RoutingTextModelAdapter,
  type ImageModelSelection,
  type TextModelAdapter
} from "@book-maker/core";

vi.mock("@book-maker/db", () => ({ prisma: {}, Prisma: {} }));
vi.mock("../runtime/config.js", () => ({
  config: {
    MOCK_AI: false,
    ALIBABA_IMAGE_MODEL: "qwen-image-2.0",
    GEMINI_IMAGE_MODEL: "gemini-3.1-flash-image"
  }
}));

import { coverImageSelectionForInput, imageFallbackSelection, LoggingTextModelAdapter } from "./loggedAdapters.js";

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

function tierProjectInput(modelTier: "fast" | "balanced" | "premium" | "ultra") {
  return createProjectSchema.parse({
    prompt: "A practical book about choosing the right generation model for long-form writing.",
    mediaSettings: {
      fullIllustrations: true,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral",
      modelTier
    }
  });
}

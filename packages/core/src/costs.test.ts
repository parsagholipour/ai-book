import { describe, expect, it } from "vitest";
import {
  calculateImageGenerationCost,
  calculateProjectCostSummary,
  calculateTextGenerationCost
} from "./costs.js";

describe("provider cost calculation", () => {
  it("calculates DeepSeek text cost with cache-hit pricing", () => {
    const cost = calculateTextGenerationCost({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      promptTokens: 1_000_000,
      cacheHitTokens: 100_000,
      outputTokens: 500_000
    });

    expect(cost).toBe(0.826863);
  });

  it("calculates DeepInfra DeepSeek text cost with cache-hit pricing", () => {
    const proCost = calculateTextGenerationCost({
      provider: "deepinfra",
      model: "deepseek-ai/DeepSeek-V4-Pro",
      promptTokens: 1_000_000,
      cacheHitTokens: 100_000,
      outputTokens: 500_000
    });
    const flashCost = calculateTextGenerationCost({
      provider: "deepinfra",
      model: "deepseek-ai/DeepSeek-V4-Flash",
      promptTokens: 1_000_000,
      cacheHitTokens: 200_000,
      outputTokens: 500_000
    });

    expect(proCost).toBe(2.48);
    expect(flashCost).toBe(0.184);
  });

  it("calculates DeepInfra Mistral Small text cost", () => {
    const cost = calculateTextGenerationCost({
      provider: "deepinfra",
      model: "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
      promptTokens: 1_000_000,
      cacheHitTokens: 200_000,
      outputTokens: 500_000
    });
    const legacyAliasCost = calculateTextGenerationCost({
      provider: "deepinfra",
      model: "mistral-small-latest",
      promptTokens: 1_000_000,
      outputTokens: 500_000
    });

    expect(cost).toBe(0.175);
    expect(legacyAliasCost).toBe(0.175);
  });

  it("uses selected Gemini text model pricing tiers", () => {
    const shortPromptCost = calculateTextGenerationCost({
      provider: "gemini",
      model: "gemini-2.5-pro",
      promptTokens: 200_000,
      cacheHitTokens: 20_000,
      outputTokens: 10_000
    });
    const longPromptCost = calculateTextGenerationCost({
      provider: "gemini",
      model: "gemini-2.5-pro",
      promptTokens: 200_001,
      outputTokens: 10_000
    });

    expect(shortPromptCost).toBe(0.3275);
    expect(longPromptCost).toBe(0.650003);
  });

  it("calculates Gemini 3 Flash preview text cost", () => {
    const cost = calculateTextGenerationCost({
      provider: "gemini",
      model: "gemini-3-flash-preview",
      promptTokens: 100_000,
      cacheHitTokens: 20_000,
      outputTokens: 10_000
    });

    expect(cost).toBe(0.071);
  });

  it("calculates Qwen text cost for Alibaba project logs", () => {
    const plusCost = calculateTextGenerationCost({
      provider: "alibaba",
      model: "qwen-plus",
      promptTokens: 100_000,
      outputTokens: 50_000
    });
    const qwen35Cost = calculateTextGenerationCost({
      provider: "alibaba",
      model: "qwen3.5-plus",
      promptTokens: 300_000,
      outputTokens: 20_000
    });

    expect(plusCost).toBe(0.1);
    expect(qwen35Cost).toBe(0.21);
  });

  it("prices supported Gemini image models from asset metadata", () => {
    expect(
      calculateImageGenerationCost({
        provider: "gemini",
        metadata: { model: "models/gemini-2.5-flash-image" }
      })
    ).toBe(0.039);
    expect(
      calculateImageGenerationCost({
        provider: "gemini",
        metadata: { model: "gemini-3.1-flash-image", imageSizeTier: "4k" }
      })
    ).toBe(0.151);
    expect(
      calculateImageGenerationCost({
        provider: "gemini",
        metadata: { model: "imagen-4.0-fast-generate-001" }
      })
    ).toBe(0.02);
  });

  it("prices supported Qwen image models from provider logs", () => {
    expect(
      calculateImageGenerationCost({
        provider: "alibaba",
        model: "qwen-image-2.0"
      })
    ).toBe(0.035);
    expect(
      calculateImageGenerationCost({
        provider: "alibaba",
        metadata: { model: "qwen-image-plus" }
      })
    ).toBe(0.03);
  });

  it("uses image provider logs when available and falls back to image assets otherwise", () => {
    expect(
      calculateProjectCostSummary([], [
        { provider: "gemini", metadata: { model: "gemini-2.5-flash-image" } },
        { provider: "gemini", metadata: { model: "unknown-image-model" } }
      ])
    ).toEqual({
      textUsd: 0,
      imageUsd: 0.039,
      totalUsd: 0.039,
      unpricedTextCalls: 0,
      unpricedImages: 1
    });

    expect(
      calculateProjectCostSummary(
        [
          {
            provider: "gemini",
            model: "gemini-2.5-flash-image",
            purpose: "image.generate",
            costHint: 0.078,
            metadata: { operation: "image.generate" }
          }
        ],
        [{ provider: "gemini", metadata: { model: "gemini-2.5-flash-image" } }]
      ).imageUsd
    ).toBe(0.078);
  });

  it("uses image assets when only some images have provider logs", () => {
    const summary = calculateProjectCostSummary(
      [
        {
          provider: "gemini",
          model: "gemini-2.5-flash-image",
          purpose: "image.generate",
          costHint: 0.039,
          metadata: { operation: "image.generate" }
        }
      ],
      [
        { provider: "gemini", metadata: { model: "gemini-2.5-flash-image" } },
        { provider: "gemini", metadata: { model: "gemini-2.5-flash-image" } }
      ]
    );

    expect(summary.imageUsd).toBe(0.078);
  });

  it("reports unknown text models without guessing a cost", () => {
    const summary = calculateProjectCostSummary([
      {
        provider: "custom",
        model: "local-writer",
        promptTokens: 1000,
        outputTokens: 1000,
        metadata: { operation: "text.generateText" }
      }
    ]);

    expect(summary.textUsd).toBe(0);
    expect(summary.unpricedTextCalls).toBe(1);
  });

  it("recalculates supported text cost when older logs have no cost hint", () => {
    const summary = calculateProjectCostSummary([
      {
        provider: "alibaba",
        model: "qwen3.5-plus",
        purpose: "generate-page",
        promptTokens: 47_372,
        outputTokens: 8_172,
        costHint: null,
        metadata: { operation: "text.generateJson" }
      }
    ]);

    expect(summary.textUsd).toBe(0.038562);
    expect(summary.unpricedTextCalls).toBe(0);
  });
});

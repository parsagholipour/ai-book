import { describe, expect, it } from "vitest";
import {
  calculateImageGenerationCost,
  calculateProjectCostSummary,
  estimateSpeechCostUsd,
  calculateTextGenerationCost,
  textGenerationCostRates
} from "./costs.js";

describe("provider cost calculation", () => {
  it("accounts for OpenAI narration at $0.00025 per audio second", () => {
    expect(estimateSpeechCostUsd({ provider: "openai_tts", audioMs: 60_000 })).toBe(0.015);
  });

  it("calculates DeepSeek V4 text cost at official peak and off-peak rates", () => {
    const tokens = {
      provider: "deepseek" as const,
      promptTokens: 1_000_000,
      cacheHitTokens: 100_000,
      outputTokens: 500_000
    };
    const weekdayOffPeak = "2026-08-24T12:00:00.000Z";
    const weekdayPeak = "2026-08-24T07:00:00.000Z";
    const weekendDuringPeakHours = "2026-08-22T07:00:00.000Z";

    expect(
      calculateTextGenerationCost({ ...tokens, model: "deepseek-v4-pro", billedAt: weekdayOffPeak })
    ).toBe(1.5862);
    expect(
      calculateTextGenerationCost({ ...tokens, model: "deepseek-v4-pro", billedAt: weekdayPeak })
    ).toBe(3.1724);
    expect(
      calculateTextGenerationCost({ ...tokens, model: "deepseek-v4-flash", billedAt: weekdayOffPeak })
    ).toBe(0.5287);
    expect(
      calculateTextGenerationCost({ ...tokens, model: "deepseek-v4-flash", billedAt: weekdayPeak })
    ).toBe(1.0574);
    expect(
      calculateTextGenerationCost({
        ...tokens,
        model: "deepseek-v4-pro",
        billedAt: weekendDuringPeakHours
      })
    ).toBe(1.5862);
  });

  it("projects every applicable text rate band for model-routing comparisons", () => {
    expect(textGenerationCostRates({ provider: "deepseek", model: "deepseek-v4-pro" })).toEqual([
      { inputPerMillion: 0.66, outputPerMillion: 1.98, cacheHitPerMillion: 0.022, label: "Off-peak" },
      { inputPerMillion: 1.32, outputPerMillion: 3.96, cacheHitPerMillion: 0.044, label: "Peak" }
    ]);
    expect(textGenerationCostRates({ provider: "openai", model: "gpt-5.6-luna" })).toEqual([
      expect.objectContaining({ inputPerMillion: 0.2, outputPerMillion: 1.2, label: "Up to 272K prompt tokens" }),
      expect.objectContaining({ inputPerMillion: 0.4, outputPerMillion: 1.8, label: "Over 272K prompt tokens" })
    ]);
    expect(textGenerationCostRates({ provider: "deepinfra", model: "unknown" })).toEqual([]);
  });

  it("treats DeepSeek peak windows as [01:00, 04:00) and [06:00, 10:00) UTC on weekdays", () => {
    const flashMiss = {
      provider: "deepseek" as const,
      model: "deepseek-v4-flash",
      promptTokens: 1_000_000,
      outputTokens: 0
    };

    expect(calculateTextGenerationCost({ ...flashMiss, billedAt: "2026-08-24T00:59:59.000Z" })).toBe(0.22);
    expect(calculateTextGenerationCost({ ...flashMiss, billedAt: "2026-08-24T01:00:00.000Z" })).toBe(0.44);
    expect(calculateTextGenerationCost({ ...flashMiss, billedAt: "2026-08-24T03:59:59.000Z" })).toBe(0.44);
    expect(calculateTextGenerationCost({ ...flashMiss, billedAt: "2026-08-24T04:00:00.000Z" })).toBe(0.22);
    expect(calculateTextGenerationCost({ ...flashMiss, billedAt: "2026-08-24T05:59:59.000Z" })).toBe(0.22);
    expect(calculateTextGenerationCost({ ...flashMiss, billedAt: "2026-08-24T06:00:00.000Z" })).toBe(0.44);
    expect(calculateTextGenerationCost({ ...flashMiss, billedAt: "2026-08-24T09:59:59.000Z" })).toBe(0.44);
    expect(calculateTextGenerationCost({ ...flashMiss, billedAt: "2026-08-24T10:00:00.000Z" })).toBe(0.22);
  });

  it("replays unhinted DeepSeek logs against the call's createdAt peak window", () => {
    const summary = calculateProjectCostSummary([
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        promptTokens: 1_000_000,
        outputTokens: 0,
        costHint: null,
        createdAt: "2026-08-24T07:00:00.000Z",
        metadata: { operation: "text.generateText" }
      }
    ]);

    expect(summary.textUsd).toBe(1.32);
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

  it("calculates GPT-5.6 family text cost across short and long context", () => {
    const sol = calculateTextGenerationCost({
      provider: "openai",
      model: "gpt-5.6-sol",
      promptTokens: 200_000,
      cacheHitTokens: 20_000,
      cacheWriteTokens: 40_000,
      outputTokens: 10_000
    });
    const terraLong = calculateTextGenerationCost({
      provider: "openai",
      model: "gpt-5.6-terra",
      promptTokens: 272_001,
      outputTokens: 10_000
    });
    const luna = calculateTextGenerationCost({
      provider: "openai",
      model: "gpt-5.6-luna",
      promptTokens: 100_000,
      cacheHitTokens: 10_000,
      outputTokens: 10_000
    });

    expect(sol).toBe(0.968);
    expect(terraLong).toBe(1.268004);
    expect(luna).toBe(0.0302);
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

  it("calculates Gemini 3.7 Flash text cost", () => {
    const cost = calculateTextGenerationCost({
      provider: "gemini",
      model: "gemini-3.7-flash",
      promptTokens: 100_000,
      cacheHitTokens: 20_000,
      outputTokens: 10_000
    });

    expect(cost).toBe(0.099);
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
    const qwen37Cost = calculateTextGenerationCost({
      provider: "alibaba",
      model: "qwen3.7-plus",
      promptTokens: 100_000,
      outputTokens: 50_000
    });
    const qwen35Cost = calculateTextGenerationCost({
      provider: "alibaba",
      model: "qwen3.5-plus",
      promptTokens: 300_000,
      outputTokens: 20_000
    });
    const qwen38MaxCost = calculateTextGenerationCost({
      provider: "alibaba",
      model: "qwen3.8-max",
      promptTokens: 100_000,
      cacheHitTokens: 20_000,
      outputTokens: 10_000
    });

    expect(plusCost).toBe(0.1);
    expect(qwen37Cost).toBe(0.12);
    expect(qwen35Cost).toBe(0.21);
    expect(qwen38MaxCost).toBe(0.225);
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
      audioUsd: 0,
      totalUsd: 0.039,
      unpricedTextCalls: 0,
      unpricedImages: 1,
      unpricedAudioCalls: 0
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

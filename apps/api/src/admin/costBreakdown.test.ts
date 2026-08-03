import { describe, expect, it } from "vitest";
import { costBreakdownFromRows, type ProviderCostRow } from "./costBreakdown.js";

function row(overrides: Partial<ProviderCostRow>): ProviderCostRow {
  return {
    kind: "text",
    purpose: "generate-page",
    provider: "gemini",
    model: "gemini-3.5-flash",
    calls: 1,
    priced_calls: 1,
    failed_calls: 0,
    in_flight_calls: 0,
    estimated_calls: 0,
    usd: 0,
    prompt_tokens: 0,
    cached_prompt_tokens: 0,
    output_tokens: 0,
    audio_ms: 0,
    ...overrides
  };
}

describe("costBreakdownFromRows", () => {
  it("rolls one operation up over the models that served it", () => {
    const breakdown = costBreakdownFromRows([
      row({ model: "gemini-3.5-flash", calls: 10, priced_calls: 10, usd: 0.4, prompt_tokens: 200_000, output_tokens: 40_000 }),
      row({ model: "gemini-3.1-flash-lite", calls: 4, priced_calls: 4, usd: 0.01, prompt_tokens: 20_000, output_tokens: 5_000 })
    ]);

    const [operation] = breakdown.operations;
    expect(operation?.key).toBe("generate-page");
    expect(operation?.calls).toBe(14);
    expect(operation?.usd).toBe(0.41);
    expect(operation?.promptTokens).toBe(220_000);
    expect(operation?.outputTokens).toBe(45_000);
    // Most expensive model first, so the row that matters is the row on top.
    expect(operation?.models.map((entry) => entry.model)).toEqual(["gemini-3.5-flash", "gemini-3.1-flash-lite"]);
    expect(operation?.models[0]?.usd).toBe(0.4);
  });

  it("orders operations by spend, not by call count", () => {
    const breakdown = costBreakdownFromRows([
      row({ purpose: "detect-language", calls: 500, priced_calls: 500, usd: 0.02 }),
      row({ purpose: "generate-whole-book", calls: 3, priced_calls: 3, usd: 1.5 })
    ]);

    expect(breakdown.operations.map((entry) => entry.key)).toEqual(["generate-whole-book", "detect-language"]);
  });

  it("rolls a model up across every operation that used it", () => {
    const breakdown = costBreakdownFromRows([
      row({ purpose: "detect-language", calls: 500, priced_calls: 500, usd: 0.02 }),
      row({ purpose: "generate-whole-book", calls: 3, priced_calls: 3, usd: 1.5 }),
      row({ purpose: "generate-whole-book", model: "qwen3.5-plus", calls: 2, priced_calls: 2, usd: 0.3 })
    ]);

    expect(breakdown.models).toHaveLength(2);
    expect(breakdown.models[0]).toMatchObject({ model: "gemini-3.5-flash", calls: 503, usd: 1.52 });
    expect(breakdown.models[1]).toMatchObject({ model: "qwen3.5-plus", calls: 2, usd: 0.3 });
  });

  it("keeps a model's text and image work apart, because the units differ", () => {
    const breakdown = costBreakdownFromRows([
      row({ kind: "text", purpose: "generate-page", provider: "gemini", model: "gemini-3.5-flash", usd: 0.1, prompt_tokens: 9_000 }),
      row({
        kind: "image",
        purpose: "image.generate",
        provider: "gemini",
        model: "gemini-3.5-flash",
        calls: 6,
        priced_calls: 6,
        usd: 0.234
      })
    ]);

    expect(breakdown.models).toHaveLength(2);
    const image = breakdown.models.find((entry) => entry.kind === "image");
    expect(image?.images).toBe(6);
    expect(image?.promptTokens).toBe(0);
    const text = breakdown.models.find((entry) => entry.kind === "text");
    expect(text?.images).toBe(0);
    expect(text?.promptTokens).toBe(9_000);
    expect(breakdown.byKind.map((entry) => entry.kind)).toEqual(["image", "text"]);
  });

  it("counts narration in seconds of audio produced", () => {
    const breakdown = costBreakdownFromRows([
      row({
        kind: "audio",
        purpose: "tts.synthesize",
        provider: "gemini",
        model: "gemini-3-pro-tts",
        calls: 40,
        priced_calls: 40,
        usd: 0.9,
        audio_ms: 3_600_500
      })
    ]);

    expect(breakdown.totals.audioSeconds).toBe(3601);
    expect(breakdown.operations[0]?.kind).toBe("audio");
  });

  it("splits calls that produced no cost into why, instead of one 'unpriced' lump", () => {
    const breakdown = costBreakdownFromRows([
      row({ calls: 12, priced_calls: 6, failed_calls: 3, in_flight_calls: 1, estimated_calls: 2, usd: 0.2 }),
      // A model with no rate card at all: settled on real tokens, priced by nothing.
      row({ provider: "deepinfra", model: "who/knows", calls: 4, priced_calls: 0, usd: 0 })
    ]);

    expect(breakdown.totals).toMatchObject({
      calls: 16,
      pricedCalls: 6,
      failedCalls: 3,
      inFlightCalls: 1,
      estimatedCalls: 2,
      unratedCalls: 4
    });
    const unrated = breakdown.models.find((entry) => entry.model === "who/knows");
    expect(unrated?.unratedCalls).toBe(4);
    expect(unrated?.usd).toBe(0);
  });

  it("prices to six decimals, so a fraction of a cent is not rounded to nothing", () => {
    const breakdown = costBreakdownFromRows([row({ usd: 0.0000123456 })]);

    expect(breakdown.totals.usd).toBe(0.000012);
    expect(breakdown.models[0]?.usd).toBe(0.000012);
  });

  it("survives nulls and an empty window rather than emitting NaN", () => {
    expect(costBreakdownFromRows([])).toEqual({ totals: expect.objectContaining({ usd: 0 }), byKind: [], operations: [], models: [] });

    const breakdown = costBreakdownFromRows([
      row({ purpose: null, provider: null, model: null, calls: 2, priced_calls: null, usd: null, prompt_tokens: null })
    ]);

    expect(breakdown.operations[0]?.key).toBe("unknown");
    expect(breakdown.models[0]?.provider).toBe("unknown");
    expect(breakdown.totals.usd).toBe(0);
    expect(breakdown.totals.unratedCalls).toBe(2);
  });
});

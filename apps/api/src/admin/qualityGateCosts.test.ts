import { QUALITY_FEATURE_IDS } from "@book-maker/core/qualityGates";
import { describe, expect, it } from "vitest";
import type { ProviderCostRow } from "./costBreakdown.js";
import { qualityGateCostsForProject } from "./qualityGateCosts.js";

const at = (day: number) => new Date(`2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`);

function settingsWith(...enabled: string[]) {
  const enabledSet = new Set(enabled);
  return Object.fromEntries(
    QUALITY_FEATURE_IDS.map((id) => [id, enabledSet.has(id) ? ["balanced"] : []])
  );
}

function row(
  purpose: string,
  usd: number,
  generationJobType: string = "GENERATE_PAGE"
): ProviderCostRow {
  return {
    kind: "text",
    purpose,
    generation_job_type: generationJobType,
    provider: "gemini",
    model: "gemini-flash",
    calls: 1,
    priced_calls: 1,
    failed_calls: 0,
    in_flight_calls: 0,
    estimated_calls: 0,
    usd,
    prompt_tokens: 100,
    cached_prompt_tokens: 0,
    output_tokens: 20,
    audio_ms: 0
  };
}

describe("qualityGateCostsForProject", () => {
  it("uses the settings revision active for the run and attributes direct provider calls", () => {
    const gates = qualityGateCostsForProject({
      mediaSettings: { modelTier: "balanced" },
      fallbackAt: at(20),
      runs: [{ createdAt: at(10), startedAt: at(11) }],
      revisions: [
        {
          version: 1,
          settings: settingsWith(
            "pageLocalQa",
            "smartUnslop",
            "pageModelReview",
            "pageQaRewrite",
            "finalBookQa",
            "planThinkingBoost"
          ),
          createdAt: at(5)
        },
        { version: 2, settings: settingsWith("planCritic"), createdAt: at(15) }
      ],
      costRows: [
        row("review-page", 0.01),
        row("revise-page", 0.02),
        row("revise-page", 0.03, "COMPILE_EXPORT"),
        row("final-book-qa", 0.04, "COMPILE_EXPORT"),
        row("plan-book", 0.5, "PLAN_BOOK")
      ]
    });

    expect(gates.map((gate) => gate.id)).toEqual([
      "pageLocalQa",
      "smartUnslop",
      "pageModelReview",
      "pageQaRewrite",
      "finalBookQa",
      "planThinkingBoost"
    ]);
    expect(gates.find((gate) => gate.id === "pageModelReview")).toMatchObject({
      calls: 1,
      providerCostUsd: 0.01
    });
    expect(gates.find((gate) => gate.id === "pageQaRewrite")).toMatchObject({
      calls: 1,
      providerCostUsd: 0.02
    });
    expect(gates.find((gate) => gate.id === "finalBookQa")).toMatchObject({
      calls: 2,
      providerCostUsd: 0.07
    });
    expect(gates.find((gate) => gate.id === "pageLocalQa")).toMatchObject({
      calls: 0,
      providerCostUsd: 0,
      costNote: "Deterministic checks; no provider call."
    });
    expect(gates.find((gate) => gate.id === "planThinkingBoost")).toMatchObject({
      calls: null,
      providerCostUsd: null
    });
    expect(gates.some((gate) => gate.id === "planCritic")).toBe(false);
  });

  it("unions gates enabled across multiple runs and reports an enabled direct gate with no calls", () => {
    const gates = qualityGateCostsForProject({
      mediaSettings: { modelTier: "balanced" },
      fallbackAt: at(20),
      runs: [
        { createdAt: at(6), startedAt: null },
        { createdAt: at(16), startedAt: at(17) }
      ],
      revisions: [
        { version: 1, settings: settingsWith("pageModelReview"), createdAt: at(5) },
        { version: 2, settings: settingsWith("planCritic"), createdAt: at(15) }
      ],
      costRows: []
    });

    expect(gates.map((gate) => gate.id)).toEqual(["pageModelReview", "planCritic"]);
    expect(gates[0]).toMatchObject({
      calls: 0,
      providerCostUsd: 0,
      costNote: "Enabled, but no attributable provider call was triggered."
    });
  });
});

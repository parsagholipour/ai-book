import { QUALITY_FEATURE_IDS } from "@book-maker/core/qualityGates";
import type { GenerationQuality } from "./GenerationQualityScreen.js";

/** A complete current API response, optionally carrying future feature ids. */
export function generationQualityResponse(...undescribedIds: string[]): GenerationQuality {
  const settings = {} as GenerationQuality["settings"];
  for (const id of QUALITY_FEATURE_IDS) settings[id] = [];
  settings.planCritic = ["ultra", "premium"];
  for (const id of undescribedIds) settings[id] = [];
  const fast = { provider: "deepseek" as const, model: "deepseek-fast", thinkingEnabled: false };
  return {
    version: 3,
    settings,
    models: {
      fastJudgments: { ...fast },
      fast: { writer: { ...fast }, judgment: { ...fast } },
      balanced: { writer: { provider: "deepseek", model: "deepseek-pro" }, judgment: { ...fast } },
      premium: {
        writer: { provider: "gemini", model: "gemini-2.5-pro", thinkingBudget: 2048 },
        judgment: { provider: "gemini", model: "gemini-2.5-flash", thinkingBudget: 0 }
      },
      ultra: {
        writer: { provider: "gemini", model: "gemini-2.5-pro", thinkingBudget: 2048 },
        judgment: { provider: "gemini", model: "gemini-2.5-flash", thinkingBudget: 0 }
      }
    },
    modelOptions: [
      {
        provider: "deepseek",
        model: "deepseek-pro",
        label: "DeepSeek Pro",
        thinkingEfforts: [
          { value: "none", label: "Off", default: true },
          { value: "high", label: "High" }
        ]
      },
      { ...fast, label: "DeepSeek Fast" },
      { provider: "gemini", model: "gemini-2.5-pro", label: "Gemini Pro", thinkingBudget: 2048 },
      { provider: "gemini", model: "gemini-2.5-flash", label: "Gemini Flash", thinkingBudget: 0 }
    ],
    usingCompiledDefaults: false,
    features: [{ id: "planCritic", label: "Plan critic", summary: "One cheap call per book." }],
    note: null,
    updatedBy: null,
    updatedAt: null
  };
}

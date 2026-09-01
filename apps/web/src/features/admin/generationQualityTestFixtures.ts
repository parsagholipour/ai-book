import {
  PAGE_REVIEW_PROMPT_MODE_DEFAULTS,
  QUALITY_FEATURE_IDS
} from "@book-maker/core/qualityGates";
import type { GenerationQuality } from "./GenerationQualityScreen.js";

/** A complete current API response, optionally carrying future feature ids. */
export function generationQualityResponse(...undescribedIds: string[]): GenerationQuality {
  const settings = {} as GenerationQuality["settings"];
  for (const id of QUALITY_FEATURE_IDS) settings[id] = [];
  settings.planCritic = ["ultra", "premium"];
  for (const id of undescribedIds) settings[id] = [];
  const fast = { provider: "deepseek" as const, model: "deepseek-fast", thinkingEnabled: false };
  const fallback = { provider: "gemini" as const, model: "gemini-2.5-flash", thinkingBudget: 0 };
  return {
    version: 3,
    settings,
    pageReviewPromptModes: { ...PAGE_REVIEW_PROMPT_MODE_DEFAULTS },
    models: {
      fastJudgments: { ...fast },
      fastJudgmentsFallback: { ...fallback },
      fast: {
        writer: { ...fast },
        writerFallback: { ...fallback },
        judgment: { ...fast },
        judgmentFallback: { ...fallback }
      },
      balanced: {
        writer: { provider: "deepseek", model: "deepseek-pro" },
        writerFallback: { ...fallback },
        judgment: { ...fast },
        judgmentFallback: { ...fallback }
      },
      premium: {
        writer: { provider: "gemini", model: "gemini-2.5-pro", thinkingBudget: 2048 },
        writerFallback: { provider: "deepseek", model: "deepseek-pro" },
        judgment: { provider: "gemini", model: "gemini-2.5-flash", thinkingBudget: 0 },
        judgmentFallback: { ...fast }
      },
      ultra: {
        writer: { provider: "gemini", model: "gemini-2.5-pro", thinkingBudget: 2048 },
        writerFallback: { provider: "deepseek", model: "deepseek-pro" },
        judgment: { provider: "gemini", model: "gemini-2.5-flash", thinkingBudget: 0 },
        judgmentFallback: { ...fast }
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

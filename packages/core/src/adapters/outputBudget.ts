type OutputBudget = { maxTokens: number; retryCeiling?: number };

/** Keep the actual request limit on the error as it travels through adapter wrappers. */
export function withOutputBudget<E extends Error>(
  error: E,
  details: { maxTokens: number | undefined; provider: "openai" | "gemini"; model: string; requestedModel?: string | undefined; promptTokens: number | undefined }
): E {
  if (details.maxTokens === undefined) return error;
  // A response may name a resolved model ID absent from our limit table. The
  // known request alias still bounds the retry; keep response identity for usage.
  const retryCeiling = outputRetryCeiling(details.provider, details.model, details.promptTokens)
    ?? (details.requestedModel === undefined ? undefined
      : outputRetryCeiling(details.provider, details.requestedModel, details.promptTokens));
  return Object.assign(error, {
    outputBudget: { maxTokens: details.maxTokens, ...(retryCeiling === undefined ? {} : { retryCeiling }) }
  });
}

/** A retry must buy real headroom, or the original paid failure should be returned. */
export function widenedOutputBudget(error: unknown, requestedMaxTokens: number): number | undefined {
  const budget = error instanceof Error && "outputBudget" in error ? error.outputBudget : undefined;
  const effective = isOutputBudget(budget) ? budget.maxTokens : requestedMaxTokens;
  const ceiling = isOutputBudget(budget) ? budget.retryCeiling ?? Infinity : Infinity;
  const widened = Math.min(Math.ceil(effective * 1.5), ceiling);
  return Number.isSafeInteger(widened) && effective > 0 && widened > effective ? widened : undefined;
}

function isOutputBudget(value: unknown): value is OutputBudget {
  return typeof value === "object" && value !== null && "maxTokens" in value
    && typeof value.maxTokens === "number" && Number.isSafeInteger(value.maxTokens)
    && (!("retryCeiling" in value) || (typeof value.retryCeiling === "number" && Number.isFinite(value.retryCeiling)));
}

// Verified 2026-09-21 against each model's official model page. Unknown/custom
// models keep the existing bounded retry behavior; do not guess their limits.
// https://developers.openai.com/api/docs/models/gpt-6-sol (also luna)
// https://developers.openai.com/api/docs/models/gpt-5.6-sol (also terra/luna)
// https://developers.openai.com/api/docs/models/gpt-5-nano
// https://ai.google.dev/gemini-api/docs/models/<model ID below>
function outputRetryCeiling(provider: "openai" | "gemini", model: string, promptTokens: number | undefined): number | undefined {
  const normalized = model.trim().replace(/^models\//, "");
  if (provider === "gemini") return GEMINI_64K_MODELS.has(normalized) ? 65_536 : undefined;
  const contextWindow = OPENAI_CONTEXT_WINDOWS.get(normalized);
  if (contextWindow === undefined) return undefined;
  const available = promptTokens !== undefined && Number.isFinite(promptTokens) && promptTokens >= 0
    ? contextWindow - promptTokens : Infinity;
  return Math.max(0, Math.min(128_000, available));
}

const OPENAI_CONTEXT_WINDOWS = new Map([
  ["gpt-6-sol", 1_050_000], ["gpt-6-luna", 1_050_000],
  ["gpt-5.6", 1_050_000], ["gpt-5.6-sol", 1_050_000], ["gpt-5.6-terra", 1_050_000], ["gpt-5.6-luna", 1_050_000],
  ["gpt-5-nano", 400_000], ["gpt-5-nano-2025-08-07", 400_000]
]);

const GEMINI_64K_MODELS = new Set([
  "gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools",
  "gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"
]);

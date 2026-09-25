import type { GenerateTextOptions, Usage } from "./types.js";
import { consumeTextAttempt } from "./textAttemptBudget.js";

/** Read the effective limit from the final wire request, never from routing guesses. */
export async function reportTextProviderRequest(
  options: GenerateTextOptions,
  provider: string,
  model: string,
  effectiveMaxTokens: unknown
): Promise<void> {
  const attempt = consumeTextAttempt(options);
  try {
    await options.onProviderRequest?.({
      provider,
      model,
      ...attempt,
      requestedMaxTokens: options.maxTokens ?? null,
      effectiveMaxTokens: typeof effectiveMaxTokens === "number" ? effectiveMaxTokens : null
    });
  } catch {
    // A diagnostic callback must not fail or trigger a retry of a paid call.
  }
}

export async function reportTextProviderUsage(options: GenerateTextOptions, usage: Usage | undefined): Promise<void> {
  if (!usage) return;
  try { await options.onProviderUsage?.(usage); }
  catch { /* Usage telemetry must not turn a provider response into a failure. */ }
}

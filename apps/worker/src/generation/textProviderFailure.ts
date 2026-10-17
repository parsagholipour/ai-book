import {
  isCancellationError, isOutputBudgetExhausted, isProviderQuotaExhaustedError, isRecoverableNetworkError,
  ProviderHttpError, ProviderStreamInterruptedError, TextAttemptBudgetExhaustedError,
  TextGenerationFallbackError
} from "@book-maker/core";

/** Recognized model failures must not restart a fresh outer operation budget. */
export function isTextProviderFailure(error: unknown): boolean {
  return error instanceof Error && (
    error instanceof TextAttemptBudgetExhaustedError || isOutputBudgetExhausted(error) ||
    error instanceof ProviderHttpError || error instanceof ProviderStreamInterruptedError ||
    error instanceof TextGenerationFallbackError || /Json(?:Parse|Validation)Error$/.test(error.name) ||
    /^(?:APIError|APIConnectionError|APIConnectionTimeoutError|OpenAIResponseError|GeminiResponseError)$/.test(error.name) ||
    refusedForEmptyAccount(error)
  );
}

/** Optional repair may retain saved prose after bounded model failure, never after a storage or ownership failure. */
export function isBoundedTextProviderFailure(error: unknown): boolean {
  if (!(error instanceof Error) || isCancellationError(error)) return false;
  if (error instanceof TextAttemptBudgetExhaustedError || isOutputBudgetExhausted(error)) return true;
  if (/Json(?:Parse|Validation)Error$/.test(error.name)) return true;
  // An empty account is the provider failing, whatever SDK raised it — and no
  // longer "recoverable", since no wait repairs it (core's retry.ts).
  if (refusedForEmptyAccount(error)) return true;
  // Require provider provenance before applying the broad transport classifier:
  // a PostgreSQL connection reset is not an unavailable quality repair.
  const providerFailure = error instanceof ProviderHttpError || error instanceof ProviderStreamInterruptedError ||
    error instanceof TextGenerationFallbackError || /^(?:APIConnectionError|APIConnectionTimeoutError)$/.test(error.name);
  return providerFailure && isRecoverableNetworkError(error);
}

/**
 * A provider refused some attempt behind this failure because its account is
 * out of credit or quota. Either attempt of a two-provider failure counts: a
 * 429 on the primary used to make the pair "recoverable", which is what kept
 * an optional repair's saved prose when the fallback refused too.
 */
function refusedForEmptyAccount(error: Error): boolean {
  return isProviderQuotaExhaustedError(error) || (
    error instanceof TextGenerationFallbackError &&
    (isProviderQuotaExhaustedError(error.primary.error) || isProviderQuotaExhaustedError(error.fallback.error))
  );
}

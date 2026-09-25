import {
  isCancellationError, isOutputBudgetExhausted, isRecoverableNetworkError,
  ProviderHttpError, ProviderStreamInterruptedError, TextAttemptBudgetExhaustedError,
  TextGenerationFallbackError
} from "@book-maker/core";

/** Recognized model failures must not restart a fresh outer operation budget. */
export function isTextProviderFailure(error: unknown): boolean {
  return error instanceof Error && (
    error instanceof TextAttemptBudgetExhaustedError || isOutputBudgetExhausted(error) ||
    error instanceof ProviderHttpError || error instanceof ProviderStreamInterruptedError ||
    error instanceof TextGenerationFallbackError || /Json(?:Parse|Validation)Error$/.test(error.name) ||
    /^(?:APIError|APIConnectionError|APIConnectionTimeoutError|OpenAIResponseError|GeminiResponseError)$/.test(error.name)
  );
}

/** Optional repair may retain saved prose after bounded model failure, never after a storage or ownership failure. */
export function isBoundedTextProviderFailure(error: unknown): boolean {
  if (!(error instanceof Error) || isCancellationError(error)) return false;
  if (error instanceof TextAttemptBudgetExhaustedError || isOutputBudgetExhausted(error)) return true;
  if (/Json(?:Parse|Validation)Error$/.test(error.name)) return true;
  // Require provider provenance before applying the broad transport classifier:
  // a PostgreSQL connection reset is not an unavailable quality repair.
  const providerFailure = error instanceof ProviderHttpError || error instanceof ProviderStreamInterruptedError ||
    error instanceof TextGenerationFallbackError || /^(?:APIConnectionError|APIConnectionTimeoutError)$/.test(error.name);
  return providerFailure && isRecoverableNetworkError(error);
}

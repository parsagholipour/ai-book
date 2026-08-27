import { hashString } from "./support.js";

export type GenerationRecoveryAttempt = {
  id: string;
  commandKey: string;
  quotedCredits: number;
  /** Missing on a few legacy/test records; those keep the safer confirmation. */
  operation?: string | undefined;
};

export type MobileGenerationRecoveryQuote = {
  retryToken: string;
  credits: number;
  requiresConfirmation: boolean;
};

export function generationRecoveryQuote(attempt: GenerationRecoveryAttempt): MobileGenerationRecoveryQuote {
  return {
    retryToken: generationRetryToken(attempt),
    credits: attempt.quotedCredits,
    // Initial planning has already been chosen by tapping Build/Retry. Full
    // generation and plan revisions retain their dedicated billing dialog.
    requiresConfirmation: attempt.operation !== "PLAN_GENERATION"
  };
}

export function generationRetryToken(attempt: GenerationRecoveryAttempt): string {
  return hashString(`generation-retry:v1:${attempt.id}:${attempt.commandKey}:${attempt.quotedCredits}`);
}

export function isValidGenerationRetryToken(attempt: GenerationRecoveryAttempt, token: string): boolean {
  return token === generationRetryToken(attempt);
}

import { hashString } from "./support.js";

export type GenerationRecoveryAttempt = {
  id: string;
  commandKey: string;
  quotedCredits: number;
};

export type MobileGenerationRecoveryQuote = {
  retryToken: string;
  credits: number;
};

export function generationRecoveryQuote(attempt: GenerationRecoveryAttempt): MobileGenerationRecoveryQuote {
  return { retryToken: generationRetryToken(attempt), credits: attempt.quotedCredits };
}

export function generationRetryToken(attempt: GenerationRecoveryAttempt): string {
  return hashString(`generation-retry:v1:${attempt.id}:${attempt.commandKey}:${attempt.quotedCredits}`);
}

export function isValidGenerationRetryToken(attempt: GenerationRecoveryAttempt, token: string): boolean {
  return token === generationRetryToken(attempt);
}

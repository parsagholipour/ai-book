import type { GenerateTextOptions } from "./types.js";

/** Shared by network retries, fallback, output widening and JSON repair. */
export type TextAttemptBudget = { limit: number; used: number; outputWidened: boolean };
export const MAX_TEXT_PROVIDER_ATTEMPTS = 5;

export class TextAttemptBudgetExhaustedError extends Error {
  constructor(readonly attempts: number) {
    super(`Text operation exhausted its ${attempts} provider attempts.`);
    this.name = "TextAttemptBudgetExhaustedError";
  }
}

export function withTextAttemptBudget<T extends GenerateTextOptions>(options: T): T {
  return options.textAttemptBudget ? options : {
    ...options,
    textAttemptBudget: { limit: MAX_TEXT_PROVIDER_ATTEMPTS, used: 0, outputWidened: false }
  };
}

export function assertTextAttemptAvailable(options: GenerateTextOptions): void {
  const budget = options.textAttemptBudget;
  if (budget && budget.used >= budget.limit) throw new TextAttemptBudgetExhaustedError(budget.used);
}

/** Called at the wire boundary, outside best-effort telemetry. */
export function consumeTextAttempt(options: GenerateTextOptions): { attempt: number; maxAttempts: number } | undefined {
  const budget = options.textAttemptBudget;
  if (!budget) return undefined;
  assertTextAttemptAvailable(options);
  return { attempt: ++budget.used, maxAttempts: budget.limit };
}

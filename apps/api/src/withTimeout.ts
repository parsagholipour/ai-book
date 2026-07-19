export class TimeBudgetExceededError extends Error {
  constructor(label: string, budgetMs: number) {
    // Deliberately avoids "timeout"/"timed out"/"abort" wording so
    // isRecoverableNetworkError never treats an exhausted budget as a
    // retryable network failure.
    super(`${label} exceeded its ${budgetMs}ms budget.`);
    this.name = "TimeBudgetExceededError";
  }
}

/**
 * Rejects with TimeBudgetExceededError when the promise takes longer than
 * budgetMs. The underlying work is not cancelled; callers are expected to fall
 * back and ignore the eventual settlement.
 */
export function withTimeout<T>(promise: Promise<T>, budgetMs: number, label = "Operation"): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new TimeBudgetExceededError(label, budgetMs)), budgetMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

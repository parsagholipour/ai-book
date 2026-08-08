import { AsyncLocalStorage } from "node:async_hooks";

const generationAttemptStorage = new AsyncLocalStorage<string | null>();

export function runWithGenerationAttempt<T>(attemptId: string | null, run: () => Promise<T>): Promise<T> {
  return generationAttemptStorage.run(attemptId, run);
}

export function currentGenerationAttemptId(): string | null {
  return generationAttemptStorage.getStore() ?? null;
}

import { vi } from "vitest";

/**
 * A stand-in for `@book-maker/db`'s `degradeRetrievalArm`, shared by every
 * worker suite that mocks the client out from under a caller which degrades
 * through it: the embedding writes and their backfill
 * (`embeddingWrites.test.ts`, `embeddingRepair.test.ts`), the continuity-note
 * loader (`generationContext.test.ts`), the page and research recalls
 * (`semanticRecall.test.ts`, `researchMemory.test.ts`) and the per-entity state
 * (`entityState.test.ts`). They must share it because they are all asking
 * the same question of every one of those callers — was the failure handed to
 * the shared policy at all, and does a stop still escape it — and a suite that
 * quietly drifted to a laxer stand-in would answer *yes* while its caller had
 * stopped calling the policy. That is the fault this fake exists for: the
 * hybrid page-memory retrieval hand-rolled its own wrap and lost both arms to
 * one pg_trgm fault.
 *
 * Faithful to the contract, not to the logging: the per-(arm, message)
 * reporting ladder is asserted in the policy's own suite
 * (`packages/db/src/retrievalArms.test.ts`), never here.
 *
 * **Import this with `await import(...)` from inside an async `vi.hoisted`
 * factory**, the way the three suites do. `vi.hoisted` runs before the file's
 * static imports are initialised, so a plain `import` of this module reaches a
 * binding in its temporal dead zone and the suite dies with
 * `Cannot access '__vi_import_0__' before initialization`. Like
 * `embeddingRowStore.ts`, this file may import nothing but `vitest`: a shared
 * fixture that reaches a mocked module from inside a hoisted factory deadlocks
 * the mock registry, and a hang is far worse to debug than a failure.
 */
export function createDegradeRetrievalArmFake() {
  return vi.fn((options: { error: unknown; fallback: unknown; rethrowIf: ((error: unknown) => boolean) | null }) => {
    if (options.rethrowIf?.(options.error)) {
      throw options.error;
    }
    return options.fallback;
  });
}

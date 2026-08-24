import { isStopRequestedError } from "../runtime/jobTypes.js";

/**
 * Best effort has one spelling in the book-preparation passes, and a stop is the
 * one thing it may not swallow.
 *
 * The passes that come through here are advisory by construction: a page map
 * nobody critiqued, or a colliding beat the drafter is merely *told* about
 * instead of handed a rewrite of, costs the book a little polish, while the same
 * failure escaping costs the reader the whole book — `prepare-chapter-setups`
 * runs inside GENERATE_BOOK, which owns the project's outcome. So the shape is
 * always the same: run it, and on a failure say so and keep what the caller
 * already had.
 *
 * It was hand-rolled three times in `bookState.ts` alone, and a fourth time as
 * `writeStandDownRecordBestEffort` in `handlers/compileExportStandDown.ts`; all
 * four come through here now. Each copy restated the stop rethrow, and the one
 * that restated it *last* had to spend a paragraph arguing why it bothered.
 * Restated, the rule is only ever as strong as the next pass someone adds beside
 * them — and the pass that forgets it is indistinguishable, from the outside,
 * from one that worked.
 *
 * **`isStopRequestedError` is not a parameter.** A caller cannot pass the wrong
 * predicate here, or omit it, because there is nothing to pass: a degrade *looks
 * like success*, so a stop folded into a fallback is a run the reader ended that
 * keeps drafting, keeps calling providers and keeps billing. This is the
 * worker-side twin of `degradeRetrievalArm` (`packages/db/src/retrievalArms.ts`),
 * which has to take `rethrowIf` as a required option only because `packages/db`
 * cannot see the worker's stop error; from inside the worker the predicate is
 * simply wired in. What that policy has and this one does not is the reporting
 * ladder, and deliberately: its arms run once per *page job*, so a single
 * deployment fact prints three hundred times for a three-hundred-page book,
 * while every pass through here runs once per book.
 *
 * **`fallback` is a value, not a thunk, and that is the second structural
 * guarantee.** A fallback that can fail is not a fallback — it is one more
 * failure with nothing behind it, which is exactly the bug this file's oldest
 * caller was written to fix: the beat-dedup catch answered a merge it could not
 * do by merging again, the second merge threw the same way, and an advisory note
 * failed a finished manuscript. So anything that can throw — a deterministic
 * stand-in computed only because the model path failed, the merge that consumes
 * it — belongs *inside* `attempt`, where this guard already covers it and where
 * it is skipped for free on the path that never needed it. The value is then the
 * one thing left that cannot fail, which is what makes "and nothing behind it"
 * unreachable rather than merely unlikely.
 *
 * **`details` is what the fourth caller needed in order to stop being a copy.**
 * The book-preparation passes log a bare warning and an error, and that is
 * right for them: the degrade is a fact about the run, and the run is the log
 * line's whole context. The compile-export write is not. It is one of two
 * writes a *superseded* compile attempts against a row a retention sweep may
 * have retired, and whoever reads it is grepping `generation.consistency_warning`
 * across every book on the box — so the object that call site already logged
 * (the event key, the named warning, the project, the durable job) is passed
 * through verbatim with the error folded into it, rather than the warning
 * string being padded until it happens to contain the same words. A caller with
 * nothing to add still gets exactly `console.warn(warning, error)`, which is the
 * shape all three `bookState.ts` passes want and the shape their assertions
 * read.
 *
 * `attempt` may be synchronous (the merges are pure) and `T` may be `void` (a
 * best-effort *write*, which is what the compile-export copy is); the await
 * covers both.
 */
export async function bestEffortPass<T>(options: {
  /** The pass. Everything that may throw belongs in here, including any lazily-computed stand-in it falls back on. */
  attempt: () => T | PromiseLike<T>;
  /** What the caller already had — returned verbatim when the pass fails. */
  fallback: T;
  /** Logged with the error. Per call site: three passes degrade in three different ways and each says which. */
  warning: string;
  /** Structured context for a call site whose warning is grepped rather than read; the error is folded in beside it. */
  details?: Record<string, unknown>;
}): Promise<T> {
  try {
    return await options.attempt();
  } catch (error) {
    if (isStopRequestedError(error)) {
      throw error;
    }
    console.warn(options.warning, options.details ? { ...options.details, error } : error);
    return options.fallback;
  }
}

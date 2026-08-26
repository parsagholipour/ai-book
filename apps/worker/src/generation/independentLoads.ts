import { isStopRequestedError } from "../runtime/jobTypes.js";

/**
 * Settles independent work without letting wall-clock rejection order decide
 * which failure the caller observes. A stop request always wins; otherwise the
 * first rejected entry in argument order wins, matching the serial chain the
 * fan-out replaced.
 */
export async function settleIndependentLoads<T extends readonly unknown[] | []>(
  loads: T
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const settled = await Promise.allSettled(loads);
  const failures = settled.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
  for (const failure of failures) {
    if (isStopRequestedError(failure)) {
      throw failure;
    }
  }
  if (failures.length > 0) {
    throw failures[0];
  }
  return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as {
    -readonly [K in keyof T]: Awaited<T[K]>;
  };
}

/**
 * A deadlock or serialization failure, in whichever shape Prisma or the driver
 * reported it. These are races worth re-sending immediately.
 */
export function isRetryableTransactionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const known = error as { code?: unknown; message?: unknown };
  if (known.code === "P2034" || known.code === "40P01" || known.code === "40001") {
    return true;
  }
  const message = typeof known.message === "string" ? known.message : "";
  return /40P01|deadlock detected|could not serialize access/i.test(message);
}

/** What a route hands Prisma's interactive `$transaction`. */
export type CharacterTransactionOptions = { timeout: number; maxWait: number };

/**
 * The lock window for a rename/delete that can claim up to 99 mentioning rows.
 * The lane now costs five statements regardless of library size, so 10 seconds
 * is enough transaction time while `maxWait + timeout` remains below the app's
 * 20-second receive timeout.
 */
export const CHARACTER_MENTION_TRANSACTION_OPTIONS = {
  timeout: 10_000,
  maxWait: 5_000
} satisfies CharacterTransactionOptions;

/** The wall clock in which every character write must finish answering. */
export const CHARACTER_WRITE_CLIENT_BUDGET_MS = 20_000;

/** Time reserved for the reply and the delete retry's portrait-liveness read. */
const CHARACTER_WRITE_RESERVE_MS = 2_000;

/**
 * Minimum transaction execution time worth opening. This floors `timeout`, not
 * the whole `maxWait + timeout` window: the claim, unlink, and delete execute
 * inside the transaction after any pool wait.
 */
export const CHARACTER_RETRY_FLOOR_MS = 3_000;

/**
 * Rations a transaction against the request's remaining client budget.
 *
 * DELETE can attempt its lane twice and PATCH pays for reads before opening its
 * one transaction. Both therefore pass total elapsed request time rather than
 * taking a fresh per-transaction ceiling. The full 5s/10s window is preserved
 * when it fits; a shorter window retains that ceiling's 1:2 pool/work split.
 *
 * A remainder too small to fund the execution floor returns `null`. Widening it
 * back to the floor would exceed the very client budget this function enforces,
 * producing the same 503 only after the device had stopped listening.
 */
export function characterRetryTransactionOptions(elapsedMs: number): CharacterTransactionOptions | null {
  const base = CHARACTER_MENTION_TRANSACTION_OPTIONS;
  const left = CHARACTER_WRITE_CLIENT_BUDGET_MS - CHARACTER_WRITE_RESERVE_MS - Math.max(elapsedMs, 0);
  if (left >= base.maxWait + base.timeout) {
    return { ...base };
  }
  const floorWindow = CHARACTER_RETRY_FLOOR_MS + Math.round(CHARACTER_RETRY_FLOOR_MS / 2);
  if (left < floorWindow) {
    return null;
  }
  const maxWait = Math.round(left / 3);
  return { timeout: left - maxWait, maxWait };
}

/**
 * A transaction timeout, deliberately distinct from a retryable conflict.
 *
 * A conflict means this write lost a race and is worth re-sending now. `P2028`
 * means the transaction did not fit its window (or was already closed), so an
 * immediate retry only burns another window. This distinction drives different
 * status messages and must not be blurred by the prose fallback below.
 *
 * Exact conflict signals win before timeout prose, and a coded error other than
 * `P2028` is never guessed from its message. Only codeless wrapper/driver shapes
 * reach the fallback for "transaction already closed" or "expired transaction".
 */
export function isTransactionTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const known = error as { code?: unknown; message?: unknown };
  if (known.code === "P2028") {
    return true;
  }
  if (isRetryableTransactionConflict(error)) {
    return false;
  }
  if (known.code !== undefined && known.code !== null && known.code !== "") {
    return false;
  }
  const message = typeof known.message === "string" ? known.message : "";
  return /transaction already closed|expired transaction/i.test(message);
}

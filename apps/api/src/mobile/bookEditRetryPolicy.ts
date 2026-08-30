/**
 * Failed edit kinds whose original generation job can be replayed as a new,
 * explicitly confirmed paid attempt.
 *
 * Keep this policy small and shared by the serializer and retry route: a card
 * must never advertise Retry when the write side can only reject it.
 */
const PAID_RETRYABLE_BOOK_EDIT_KINDS = new Set(["PLAN_REVISION", "PAGE_REWRITE"]);

export function isPaidRetryableBookEditFailure(operation: { kind: string; status: string }): boolean {
  return PAID_RETRYABLE_BOOK_EDIT_KINDS.has(operation.kind) &&
    ["FAILED", "CANCELED"].includes(operation.status);
}

import { refundedLedgerEntryIds, settledGenerationAttemptIds } from "@book-maker/db/billing";

type ResumableJobRow = { attemptId: string | null; payload: unknown };

/**
 * Refunded work must not resume for free: post-migration rows are ruled out by
 * their settled attempt, pre-migration paid rows by the refunded charge
 * stamped on their payload (the legacy failure path refunded automatically).
 * What survives — the operator console's own unbilled jobs and still-charged
 * rows — stays freely resumable; refunded books recover through the mobile
 * paid-retry route, which starts a fresh attempt.
 */
export async function jobsWithoutRefundedCharges<T extends ResumableJobRow>(failedJobs: T[]): Promise<T[]> {
  const [settledAttemptIds, refundedEntryIds] = await Promise.all([
    settledGenerationAttemptIds([...new Set(failedJobs.flatMap((job) => (job.attemptId ? [job.attemptId] : [])))]),
    refundedLedgerEntryIds([
      ...new Set(failedJobs.flatMap((job) => (job.attemptId ? [] : paidEntryId(job.payload) ?? [])))
    ])
  ]);
  return failedJobs.filter((job) =>
    job.attemptId
      ? !settledAttemptIds.has(job.attemptId)
      : !refundedEntryIds.has(paidEntryId(job.payload) ?? "")
  );
}

function paidEntryId(payload: unknown): string | null {
  const value = (payload as { billingLedgerEntryId?: unknown } | null)?.billingLedgerEntryId;
  return typeof value === "string" && value ? value : null;
}

import { isCoverPurchasePayload, isRevisionOwnedCoverPayload } from "@book-maker/core";
import { failGenerationAttempt, refundCreditLedgerEntry } from "@book-maker/db/billing";
import { generationAttemptIdFromJob } from "./editOperationSettlement.js";
import type { WorkerRuntimeJob } from "./jobPayloads.js";

/**
 * How a revision-owned cover settles when it fails or is stopped — the cover a
 * Writing Studio publish draws, a Studio cover change, a replan's cover
 * (`isRevisionOwnedCoverPayload`). None of them is the book's outcome: the
 * pages are published and paid for, so the row settles alone and the project is
 * left exactly as it is. On a failure the compile its revision queued is still
 * waiting on this cover, and `maybeCompileAfterFailedJob` (dispatch, which a
 * lifecycle module may not import) releases it, so the book publishes with the
 * cover it already has, or the coverless title sheet.
 *
 * The attempt a row carries is only sometimes this cover's to settle:
 *
 * - A purchase (`coverPurchase`, the Studio's "Generate with AI") carries its
 *   own attempt, and nothing but this cover job settles it. A failure refunds
 *   it; a stop cancels and refunds it. Its sibling compile is never stopped with
 *   it, because that compile is what puts the book back down.
 * - A replan's cover carries the *replan's* attempt, which the compile after it
 *   completes. A failure leaves it open for that compile; a stop settles it the
 *   way the API's stop does (`stopProjectGenerationJobs` cancels every attempt
 *   a stopped row carries), so the two sides of a stop agree about the charge.
 * - A publish's cover and a free return to a designed cover carry none.
 */

export function isRevisionOwnedCoverJob(job: WorkerRuntimeJob): boolean {
  return job.name === "generate-image" && isRevisionOwnedCoverPayload(job.data);
}

export async function settleRevisionOwnedCoverExit(
  job: WorkerRuntimeJob,
  reason: string,
  exit: "failed" | "stopped"
): Promise<void> {
  const attemptId = generationAttemptIdFromJob(job);
  const purchase = isCoverPurchasePayload(job.data);
  if (attemptId && (purchase || exit === "stopped")) {
    await failGenerationAttempt(attemptId, reason, exit === "stopped" ? "CANCELED" : "FAILED").catch((error) => {
      // The attempt is terminal with `refundPending` set, or still open; either
      // way `reconcileGenerationAttemptRefunds` or the next settlement finishes it.
      console.error(`Failed to settle the attempt of cover job ${job.data.generationJobId}`, error);
    });
    return;
  }
  const ledgerEntryId = job.data.billingLedgerEntryId;
  if (purchase && ledgerEntryId) {
    // A purchase that somehow lost its attempt still names its charge.
    await refundCreditLedgerEntry(ledgerEntryId, reason).catch((error) => {
      console.error(`Failed to refund the purchased cover of project ${job.data.projectId ?? "?"}`, error);
    });
  }
}

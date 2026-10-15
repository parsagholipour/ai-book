/**
 * The settlement a stop owes the rows it claimed that carry no paid attempt —
 * rows enqueued before the attempt ledger existed. Split out of `queue.ts`,
 * whose `stopProjectGenerationJobs` calls it after the stop commits, when that
 * file reached its size budget; it is still the API's second copy of the
 * worker's own legacy settlement (`refundFailedProjectCredits` in
 * `apps/worker/src/runtime/jobLifecycle.ts`), so a change to one is owed to the
 * other.
 *
 * It refunds whole, as it always has: a legacy charge records no quote to price
 * delivered pages against. What it cannot do is undo a user stop's partial
 * settlement of an attempt's charge — the ledger caps every reversal at what the
 * stop's stamp left refundable (`packages/db/src/userStopSettlement.ts`) — nor
 * reverse a charge whose paid attempt SUCCEEDED, which the ledger refuses
 * outright: a walk from an attempt-less row to a delivered book's charge is the
 * shape of the free-recompile refund (launch review 2026-10-13, B3), and the
 * caller's own filter (`payloadOwnsProjectOutcome`) keeps those rows out first.
 */
import {
  BOOK_GENERATION_CHARGE_LOOKBACK,
  STOPPED_JOB_ERROR,
  bookGenerationChargeFromPayloads,
  jsonPayloadToRecord
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { refundCreditLedgerEntry, refundLatestProjectOperationCredits } from "@book-maker/db/billing";

const BOOK_RUN_JOB_TYPES = new Set(["GENERATE_BOOK", "GENERATE_PAGE", "GENERATE_IMAGE", "COMPILE_EXPORT"]);

/**
 * Legacy (attempt-less) rows settle the way the worker settles them: each job
 * type against its own charge. Only book-run rows may walk to the project's
 * full-book entry — routing a stopped audiobook or edit there refunds a charge
 * that paid for a book the user keeps.
 */
export async function settleLegacyStoppedJobs(
  projectId: string,
  legacyJobs: ReadonlyArray<{ id: string; type: string; payload: unknown }>
): Promise<void> {
  const refundedEntryIds = new Set<string>();
  const refundOnce = async (entryId: string) => {
    if (!refundedEntryIds.has(entryId)) {
      refundedEntryIds.add(entryId);
      await refundCreditLedgerEntry(entryId, STOPPED_JOB_ERROR);
    }
  };
  const bookRunJobs: Array<{ type: string; payload: unknown }> = [];
  for (const job of legacyJobs) {
    const payload = jsonPayloadToRecord(job.payload);
    const ownEntryId =
      typeof payload.billingLedgerEntryId === "string" && payload.billingLedgerEntryId
        ? payload.billingLedgerEntryId
        : null;
    if (BOOK_RUN_JOB_TYPES.has(job.type)) {
      bookRunJobs.push(job);
      continue;
    }
    if (job.type === "PLAN_BOOK") {
      if (ownEntryId) {
        await refundOnce(ownEntryId);
      } else {
        await refundLatestProjectOperationCredits({ projectId, operation: "PLAN_GENERATION", reason: STOPPED_JOB_ERROR });
      }
      continue;
    }
    // Audiobooks, edits, continuations, replans: their own stamped entry, or
    // their operation's. Unpriced derivative work (characters, research)
    // stamps nothing and refunds nothing.
    if (ownEntryId) {
      await refundOnce(ownEntryId);
      continue;
    }
    const operationId = legacyOperationId(payload);
    if (operationId) {
      const operation = await prisma.bookEditOperation.findUnique({
        where: { id: operationId },
        select: { ledgerEntryId: true }
      });
      if (operation?.ledgerEntryId) {
        await refundOnce(operation.ledgerEntryId);
      }
    }
  }
  if (bookRunJobs.length > 0) {
    const chargedEntryId = await stoppedRunLedgerEntryId(projectId, bookRunJobs);
    if (chargedEntryId) {
      await refundOnce(chargedEntryId);
    } else {
      await refundLatestProjectOperationCredits({
        projectId,
        operation: "FULL_BOOK_GENERATION",
        reason: STOPPED_JOB_ERROR
      });
    }
  }
}

export function legacyOperationId(payload: Record<string, unknown>): string | null {
  const value = payload.operationId ?? payload.editOperationId ?? payload.replanOperationId;
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The charge that paid for the run being stopped, resolved the same way the
 * worker settles a failed run (its runtime/jobLifecycle.ts): the GENERATE_BOOK
 * payload's own ledger entry first, then the plan walk shared through
 * `bookGenerationChargeFromPayloads`. Null falls back to the latest
 * FULL_BOOK_GENERATION charge, which keeps runs enqueued before the payload
 * stamp refundable.
 */
async function stoppedRunLedgerEntryId(
  projectId: string,
  openJobs: ReadonlyArray<{ type: string; payload: unknown }>
): Promise<string | null> {
  let planId: string | null = null;
  for (const job of openJobs) {
    const payload = jsonPayloadToRecord(job.payload);
    if (job.type === "GENERATE_BOOK" && typeof payload.billingLedgerEntryId === "string" && payload.billingLedgerEntryId) {
      return payload.billingLedgerEntryId;
    }
    if (!planId && typeof payload.planId === "string" && payload.planId) {
      planId = payload.planId;
    }
  }
  if (!planId) {
    return null;
  }
  const rows = await prisma.generationJob.findMany({
    where: { projectId, type: "GENERATE_BOOK" },
    orderBy: { createdAt: "desc" },
    take: BOOK_GENERATION_CHARGE_LOOKBACK,
    select: { payload: true }
  });
  return bookGenerationChargeFromPayloads(rows, planId);
}

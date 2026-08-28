import { classifyEditFailure, failedEditOperationData } from "@book-maker/core/editFailure";
import { errorMessage } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import {
  failGenerationAttempt,
  refundCreditLedgerEntry,
  refundCreditLedgerEntryPortion
} from "@book-maker/db/billing";
import { type WorkerRuntimeJob } from "./jobPayloads.js";

/**
 * How a delivery settles the `BookEditOperation` row it was carrying.
 *
 * Split out of `jobLifecycle.ts`, which owns the `GenerationJob` row's own
 * transitions: an edit operation is a second durable record with its own claim
 * order, its own refund handles and — the reason this file exists — its own
 * reader-facing column. `jobLifecycle.ts` re-exports everything here for the
 * historical import path.
 *
 * `ReaderEditFailure` is re-exported so a caller settling with deliberate copy
 * takes it from the module it is settling through.
 */

export { ReaderEditFailure, failedEditOperationData } from "@book-maker/core/editFailure";

export async function markEditOperationActive(job: WorkerRuntimeJob): Promise<void> {
  const editOperationId = editOperationIdFromJob(job);
  if (!editOperationId) {
    return;
  }
  await prisma.bookEditOperation
    .updateMany({ where: { id: editOperationId, status: "QUEUED" }, data: { status: "ACTIVE" } })
    .catch(() => ({ count: 0 }));
}

export async function markEditOperationCompleted(job: WorkerRuntimeJob): Promise<void> {
  const editOperationId = editOperationIdFromJob(job);
  if (!editOperationId) {
    return;
  }
  if (job.name === "apply-book-edit" || job.name === "replan-book") {
    return;
  }
  await prisma.bookEditOperation
    .updateMany({
      where: { id: editOperationId, status: { in: ["QUEUED", "ACTIVE"] } },
      data: { status: "APPLIED", appliedAt: new Date() }
    })
    .catch(() => ({ count: 0 }));
}

/**
 * Settle an open edit operation as failed, in the reader's words.
 *
 * `cause` is the error, never a message: a `string` parameter is what let every
 * caller hand this `errorMessage(error)` and ship it to the device. A sentence
 * written for the reader on purpose says so by arriving as a
 * `ReaderEditFailure` — the stop path is the only one today.
 */
export async function failEditOperation(
  operationId: string,
  cause: unknown,
  options: { refund?: boolean } = {}
): Promise<void> {
  const failure = classifyEditFailure(cause, "settlement");
  if (failure.internal) {
    // The serializer could not do this half: by the time the column is read the
    // cause is gone. So the classification sits at the write, and this is where
    // the fault stays readable.
    console.error(`Edit operation ${operationId} failed`, cause);
  }
  // Claim before refunding, like markEditOperationCompleted: an operation that
  // is already APPLIED (or FAILED/CANCELED and settled with it) must not have
  // its charge clawed back by a straggling failure path.
  const claimed = await prisma.bookEditOperation
    .updateMany({
      where: { id: operationId, status: { in: ["QUEUED", "ACTIVE"] } },
      data: failedEditOperationData(cause)
    })
    .catch(() => ({ count: 0 }));
  if (claimed.count !== 1 || options.refund === false) {
    return;
  }
  const operation = await prisma.bookEditOperation.findUnique({
    where: { id: operationId },
    select: { ledgerEntryId: true }
  });
  if (operation?.ledgerEntryId) {
    // The raw cause, not the reader sentence: a ledger description is operator
    // reading, and `MobileCreditLogEntryDto.title` is built rather than copied
    // precisely so this column can carry provider errors without shipping them.
    await refundCreditLedgerEntry(operation.ledgerEntryId, errorMessage(cause)).catch((error) => {
      console.error(`Failed to refund edit operation ${operationId}`, error);
    });
  }
}

/**
 * Hands back the charge for an edit that settles without applying anything.
 *
 * A handler that records a skip and returns normally is *completing*, so no
 * failure path runs at all: `markCompleted` marks the attempt SUCCEEDED, and an
 * attempt's credits are reserved **and committed** when the edit is queued, so
 * nothing downstream ever gives them back. `restructurePages` settles a stale
 * insert exactly that way — the book changed under the card, the pages it was
 * charged for are never written — and kept the money on the strength of a
 * comment claiming the throw it does not make would have refunded it.
 *
 * Closing the attempt is half the fix rather than bookkeeping:
 * `markGenerationAttemptSucceeded` claims a QUEUED or ACTIVE row moments later,
 * so an attempt left open is marked SUCCEEDED over a spend this just reversed,
 * with `refundPending` cleared and `reconcileGenerationAttemptRefunds` never
 * looking at it again. CANCELED rather than FAILED because nothing broke — and
 * it makes any redelivery of the job stale, which is right: there is nothing
 * left to run.
 *
 * It deliberately does not swallow. `failGenerationAttempt` leaves
 * `refundPending` behind when its own transaction fails, and the throw carries
 * the delivery into `markFailed`, which asks for the same settlement again;
 * a caught error is a kept charge nobody is looking for. Call it *before*
 * claiming the operation APPLIED for the same reason — the throw then finds the
 * row still ACTIVE, which is what `failEditOperation` claims.
 */
export async function refundSkippedEditOperation(job: WorkerRuntimeJob, reason: string): Promise<void> {
  const attemptId = generationAttemptIdFromJob(job);
  if (attemptId) {
    await failGenerationAttempt(attemptId, reason, "CANCELED");
    return;
  }
  // An attempt-less charged edit records its entry on the operation row — the
  // same handle `failEditOperation` refunds through when it owns the failure.
  const operationId = editOperationIdFromJob(job);
  if (!operationId) {
    return;
  }
  const operation = await prisma.bookEditOperation.findUnique({
    where: { id: operationId },
    select: { ledgerEntryId: true }
  });
  if (operation?.ledgerEntryId) {
    await refundCreditLedgerEntry(operation.ledgerEntryId, reason);
  }
}

/**
 * Hands back the pages a priced edit billed for and did not write.
 *
 * The sibling of `refundSkippedEditOperation`, for the case that settles as a
 * delivered *part* rather than a delivered nothing. A structural insert charges
 * `pagesBilled × pageRegenerationPerPage` up front and its apply resumes against
 * the page ids the shift recorded — so a redelivery meeting a book that holds
 * only some of them writes only some of them, and every path out of there is a
 * *completion*: `markCompleted` marks the attempt SUCCEEDED, and neither
 * `markFailed`, `failGenerationAttempt` nor `failEditOperation` ever runs.
 * Nothing broke, so nothing may fail the book — but the reader paid for five
 * pages and has two, `operationCanUndo` offers an undo of the shift rather than
 * of the charge, and the shortfall used to be kept in silence.
 *
 * `bookEditCreditCost` prices `restructure_pages` as `pagesBilled` times a
 * per-page rate with no flat half, so the share of the charge the missing pages
 * carried is exactly their share of the pages — read off the operation row's own
 * `creditsCharged` rather than recomputed from a price list that an operator may
 * have edited since the edit was quoted.
 *
 * Like `refundSkippedEditOperation` it does not swallow: a kept charge nobody is
 * looking for is worse than a delivery that fails loudly, and the caller runs it
 * *before* claiming the operation APPLIED so a throw leaves behind the ACTIVE
 * row `failEditOperation` claims. The operation id makes the ledger settlement
 * replay-safe while still allowing a later full failure to top it up.
 */
export async function refundUnwrittenEditPages(
  job: WorkerRuntimeJob,
  options: { billedPages: number; writtenPages: number; reason: string }
): Promise<void> {
  const missing = options.billedPages - options.writtenPages;
  if (options.billedPages <= 0 || missing <= 0) {
    return;
  }
  const operationId = editOperationIdFromJob(job);
  if (!operationId) {
    return;
  }
  const operation = await prisma.bookEditOperation.findUnique({
    where: { id: operationId },
    select: { ledgerEntryId: true, creditsCharged: true }
  });
  if (!operation?.ledgerEntryId || operation.creditsCharged <= 0) {
    return;
  }
  const owed = Math.round((operation.creditsCharged * missing) / options.billedPages);
  if (owed <= 0) {
    return;
  }
  console.warn("Refunding the pages a paid edit billed and could not write", {
    event: "generation.edit_page_shortfall_refunded",
    operationId,
    projectId: job.data.projectId,
    billedPages: options.billedPages,
    writtenPages: options.writtenPages,
    creditsCharged: operation.creditsCharged,
    refundedCredits: owed
  });
  await refundCreditLedgerEntryPortion({
    entryId: operation.ledgerEntryId,
    amountCredits: owed,
    reason: options.reason,
    idempotencyKey: `edit-page-shortfall:${operationId}`
  });
}

export function editOperationIdFromJob(job: WorkerRuntimeJob): string | null {
  const value = job.data.operationId ?? job.data.editOperationId ?? job.data.replanOperationId;
  return value ?? null;
}

/** The attempt a delivery is paid through, when it is paid at all. */
export function generationAttemptIdFromJob(job: WorkerRuntimeJob): string | null {
  return job.data.attemptId ?? null;
}

import {
  completeStructuralPageLease,
  isStructuralPageLeaseLostError,
  renewStructuralPageLeaseTx,
  startStructuralPageLeaseHeartbeat,
  StructuralPageLeaseLostError,
  waitForStructuralPageLease,
  waitForStructuralPageLeaseCompletion
} from "./structuralPageLease.js";
import type { Prisma } from "@book-maker/db";

/**
 * Text rewrites share the operation-level delivery columns that were first
 * introduced for structural edits. The column names are historical; an edit
 * operation has exactly one apply fork, so the same durable owner can fence
 * either fork without the two protocols ever overlapping.
 */
export type TextEditLeaseClaim =
  | { outcome: "acquired"; phase: "draft" | "tail" }
  | { outcome: "completed" }
  | { outcome: "settled" }
  | { outcome: "abandoned" };

export async function waitForTextEditLease(operationId: string, ownerToken: string): Promise<TextEditLeaseClaim> {
  const claim = await waitForStructuralPageLease(operationId, ownerToken);
  if (claim.outcome !== "acquired") {
    return { outcome: claim.outcome };
  }
  return { outcome: "acquired", phase: claim.phase };
}

export const startTextEditLeaseHeartbeat = startStructuralPageLeaseHeartbeat;
export const completeTextEditLease = completeStructuralPageLease;
export const waitForTextEditLeaseCompletion = waitForStructuralPageLeaseCompletion;
export const isTextEditLeaseLostError = isStructuralPageLeaseLostError;

/**
 * First operation-row statement of every manuscript-writing transaction. A
 * transaction that also touches Project locks Project first; operation-only
 * page/snapshot transactions begin here. The renewal is a database-time
 * compare-and-set and keeps the operation row locked until the caller's writes
 * commit.
 */
export async function assertTextEditLeaseTx(
  tx: Prisma.TransactionClient,
  operationId: string,
  ownerToken: string
): Promise<{ classifier: unknown; status: string }> {
  const owned = await renewStructuralPageLeaseTx(tx, operationId, ownerToken);
  if (!owned) {
    throw new StructuralPageLeaseLostError();
  }
  return owned;
}

/**
 * Atomically settles the text-only verdict that applied no page at all.
 *
 * This is deliberately a sibling, not an alias, of the structural skip CAS.
 * The two operation kinds have different durable classifier markers and their
 * redelivery tails do different things. What they share is only the ownership
 * rule: the still-live token must move an ACTIVE row to APPLIED and complete
 * the lease in one lock-taking statement. The caller merges its text marker
 * onto the classifier returned by that statement inside the same transaction.
 */
export async function settleSkippedTextEditLeaseTx(
  tx: Prisma.TransactionClient,
  operationId: string,
  ownerToken: string
): Promise<{ classifier: unknown } | null> {
  const rows = await tx.$queryRawUnsafe<Array<{ classifier: unknown }>>(
    `UPDATE "BookEditOperation"
       SET "status" = 'APPLIED',
           "affectedPageIndexes" = '{}'::integer[],
           "appliedAt" = CURRENT_TIMESTAMP,
           "structuralLeaseToken" = NULL,
           "structuralLeaseExpiresAt" = NULL,
           "structuralLeaseCompletedAt" = CURRENT_TIMESTAMP,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = $1
       AND "structuralLeaseToken" = $2
       AND "structuralLeaseExpiresAt" > CURRENT_TIMESTAMP
       AND "structuralLeaseCompletedAt" IS NULL
       AND "status" = 'ACTIVE'
     RETURNING "classifier"`,
    operationId,
    ownerToken
  );
  return rows[0] ?? null;
}

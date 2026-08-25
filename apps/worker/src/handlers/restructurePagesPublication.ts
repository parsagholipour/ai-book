import {
  enqueueAppliedEditPublication,
  publishAppliedEditTail
} from "../generation/appliedEditPublication.js";
import {
  renewStructuralPageLeaseTx,
  StructuralPageLeaseLostError
} from "../generation/structuralPageLease.js";
import { maybeEnqueueCompile } from "../runtime/dispatch.js";
import { PAGE_RESTRUCTURE_TRANSACTION_OPTIONS } from "@book-maker/db";
import type { SettledProjectStatus } from "@book-maker/core";

/** Queue only the exact publication generation the APPLIED operation stamped. */
export async function queueRestructureCompile(
  projectId: string,
  planVersionId: string,
  operationId: string,
  publicationRevision: number,
  fallbackStatus: SettledProjectStatus
): Promise<void> {
  await enqueueAppliedEditPublication({
    projectId,
    operationId,
    fallbackStatus,
    identity: { planVersionId, publicationRevision },
    enqueueFailureMessage: `Failed to enqueue the export refresh for restructured project ${projectId}:`,
    enqueue: ({ planVersionId: compilePlanVersionId, publicationRevision: compileRevision }) =>
      maybeEnqueueCompile(projectId, compilePlanVersionId, undefined, {
        contentRevision: compileRevision,
        requireContentRevisionMatch: true
      })
  });
}

/**
 * Replay only an APPLIED structural edit's original publication tail.
 *
 * The manuscript mutation, revision increment and operation stamp committed
 * atomically before this function is reachable. The project/operation claim
 * keeps a newer edit or compile from lending this stale tail its lifecycle;
 * renewing the delivery lease under those locks keeps cancellation, failure,
 * or takeover from deleting files after the ownership decision.
 */
export async function replayAppliedRestructure(
  projectId: string,
  operationId: string,
  ownerToken: string,
  fallbackStatus: SettledProjectStatus
): Promise<void> {
  await publishAppliedEditTail({
    projectId,
    operationId,
    fallbackStatus,
    missingPlanMessage:
      `Cannot replay APPLIED page restructure ${operationId} for project ${projectId}: no plan version is available`,
    enqueueFailureMessage: `Failed to enqueue the export refresh for restructured project ${projectId}:`,
    transactionOptions: PAGE_RESTRUCTURE_TRANSACTION_OPTIONS,
    afterClaim: async (tx) => {
      if (!(await renewStructuralPageLeaseTx(tx, operationId, ownerToken))) {
        throw new StructuralPageLeaseLostError();
      }
    },
    publicationRevision: {
      resolve: async (tx) =>
        (
          await tx.bookEditOperation.findUnique({
            where: { id: operationId },
            select: { publicationRevision: true }
          })
        )?.publicationRevision ?? null,
      missingMessage: "Applied structural edit lost its publication revision"
    },
    enqueue: ({
      planVersionId,
      publicationRevision
    }: {
      planVersionId: string;
      publicationRevision: number;
    }) =>
      maybeEnqueueCompile(projectId, planVersionId, undefined, {
        contentRevision: publicationRevision,
        requireContentRevisionMatch: true
      })
  });
}

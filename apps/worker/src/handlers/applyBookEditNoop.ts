import {
  isTextEditLeaseLostError,
  settleSkippedTextEditLeaseTx
} from "../generation/textEditLease.js";
import { restoreEditProjectStatus } from "../generation/editProjectStatus.js";
import { refundSkippedEditOperation } from "../runtime/jobLifecycle.js";
import { jsonPayloadToRecord, type SettledProjectStatus } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import type { ApplyBookEditJob } from "../runtime/jobPayloads.js";

/** Text-specific proof that an exact replacement delivered no page changes. */
export const TEXT_EXACT_SKIPPED_MARKER = "textExactSkipped";

export function textExactEditWasSkipped(classifier: unknown): boolean {
  return jsonPayloadToRecord(classifier)[TEXT_EXACT_SKIPPED_MARKER] === true;
}

/**
 * Refund and durably settle an exact text edit whose literal vanished from all
 * of its targets.
 *
 * The refund is first because `refundSkippedEditOperation` closes the attempt
 * CANCELED, and a throw must leave the operation ACTIVE for the ordinary
 * failure settlement to claim. The heartbeat supplied by the owning handler
 * keeps the lease alive through that ledger work; the post-refund CAS then
 * proves the same delivery still owns the row. Its APPLIED verdict, text-only
 * marker, unused-snapshot deletion, lease completion and project-status
 * restoration commit together, so no redelivery can observe half a no-op and
 * enter the publication tail.
 */
export async function settleSkippedExactTextEdit(options: {
  job: ApplyBookEditJob;
  projectId: string;
  operationId: string;
  ownerToken: string;
  skippedPageIndexes: number[];
  fallbackStatus: SettledProjectStatus;
  assertLease: () => Promise<void>;
}): Promise<boolean> {
  const { projectId, operationId, ownerToken, skippedPageIndexes, fallbackStatus } = options;
  try {
    await options.assertLease();
  } catch (error) {
    if (!isTextEditLeaseLostError(error)) throw error;
    return false;
  }

  await refundSkippedEditOperation(
    options.job,
    "Exact text edit skipped because the requested literal disappeared from every target"
  );

  const lostLeaseAfterStatusClaim = {};
  let settled: boolean;
  try {
    settled = await prisma.$transaction(async (tx) => {
      const statusOwned = await restoreEditProjectStatus(
        tx,
        projectId,
        operationId,
        fallbackStatus,
        "ACTIVE"
      );
      if (!statusOwned) return false;
      const owned = await settleSkippedTextEditLeaseTx(tx, operationId, ownerToken);
      // Roll the status restoration back with the failed operation CAS. The
      // sentinel is caught outside the transaction and retains the established
      // false/wait outcome without committing half of the no-op settlement.
      if (!owned) throw lostLeaseAfterStatusClaim;
      await tx.bookEditOperation.update({
        where: { id: operationId },
        data: {
          classifier: {
            ...jsonPayloadToRecord(owned.classifier),
            skippedPageIndexes,
            [TEXT_EXACT_SKIPPED_MARKER]: true
          } as Prisma.InputJsonValue
        }
      });
      await tx.pageEditSnapshot.deleteMany({ where: { operationId } });
      return true;
    });
  } catch (error) {
    if (error !== lostLeaseAfterStatusClaim) throw error;
    settled = false;
  }

  if (!settled) {
    // The refund is replay-safe, but it cannot be undone. Keep the replacement
    // delivery's token and project status intact and let the caller wait for
    // that owner instead of turning this refunded no-op into a failed edit.
    console.error("Exact text edit lost its lease between the skip refund and settlement", {
      event: "generation.text_exact_skip_settlement_lost_lease",
      projectId,
      operationId
    });
  }
  return settled;
}

import {
  isStructuralPageLeaseLostError,
  settleSkippedStructuralPageLeaseTx,
  startStructuralPageLeaseHeartbeat
} from "../generation/structuralPageLease.js";
import { refundSkippedEditOperation } from "../runtime/jobLifecycle.js";
import { jsonRecord, type SettledProjectStatus } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import type { Job } from "bullmq";

/**
 * Settles a structural edit that is going to apply nothing: refunded, marked,
 * and the book put back down in the status it came in with.
 *
 * Its own file because it is the one settlement that runs *before* anything was
 * written, so it is the one that has to hold the delivery lease open across work
 * it does not control — and `restructurePages.ts` has the shift, the drafting,
 * the rollback and the tail to explain already.
 *
 * The charge comes back first, and by hand: settling normally is precisely the
 * path no refund reaches. A delete or a move is free, but an insert paid for
 * pages that are never going to be written, and the attempt behind it committed
 * those credits when the edit was queued — so returning from here runs
 * `markCompleted`, which marks that attempt SUCCEEDED and closes the only door
 * the money could have come back through. The refusal branch used to record the
 * reason and nothing else, so a reader paid a full insert for pages the book
 * never got — and `operationCanUndo` refuses a skipped row, so there was no way
 * back. A free delete or move is asked all the same: it is a no-op on an
 * operation with no ledger entry, and branching on the price is how the next
 * priced skip inherits that bug.
 *
 * The refund runs before the APPLIED claim, because a settlement that throws
 * has to leave behind the ACTIVE row `failEditOperation` claims.
 *
 * **Which is why ownership has to outlive the refund, and be asked again after
 * it.** The caller acquires a three-minute lease and hands it here; this used to
 * refund with no heartbeat and then write unconditionally. A ledger call that
 * stalls — or a paused process, a long GC, a database failover — past expiry
 * lets a replacement delivery acquire the lease and start shifting the book, and
 * the stale transaction then marked *its* live edit APPLIED with
 * `structuralSkipped`, cleared its token, and put the project back down in the
 * pre-edit status, after handing back a charge the replacement is still working
 * against. That is the pre-flight refusal's own race arriving one lease later:
 * the winner's `markStructuralPageLeaseApplied` then fails (it claims ACTIVE)
 * and its rollback cannot run either, because that begins by renewing the token
 * this settlement just cleared. So a heartbeat runs for the whole call, the
 * barrier before the refund is what proves the money is this delivery's to hand
 * back, and the write is a compare-and-swap on the same token and expiry
 * (`settleSkippedStructuralPageLeaseTx`). Either answer of "you no longer own
 * this" ends the call with **nothing written** — the replacement's token, the
 * marker and the project's status all left exactly as they were found — the way
 * every other lost-lease path here stands down rather than throwing, since
 * throwing would hand a book somebody else is editing to `markFailed`.
 *
 * Then every write in one transaction, for the reason the rollback takes its
 * stamp down inside the revert's: `structuralSkipped` on an APPLIED row is what
 * tells a second delivery there is nothing left to finish here, so it may not
 * land before the write that takes the book out of EDITING. Half of this pair is
 * a project left EDITING with no job coming and a marker telling the only thing
 * that could have noticed to stand down.
 *
 * **And the marker is merged onto a classifier read inside that transaction,
 * under the operation row's own lock — never onto the copy the caller carried
 * in**, the rule `applyStructuralPageChange` writes its own stamp by. That copy
 * is read before the plan-version reads, the provider construction and the whole
 * shift transaction, so anything written into the classifier across that window
 * used to come straight back off: a concurrent rollback's
 * `structuralRolledBackAt` or a stamp a racing delivery had just committed.
 * The reader's `undoneAt` no longer reaches here — `settleRefusedRestructure`
 * stands down on it instead of skip-settling. The CAS is the first statement for
 * the reason the lease claim is: it takes the lock, and it returns the very row
 * the marker is merged onto.
 *
 * The reason is a string rather than a `StructuralPageRefusal`, because the
 * resolver is not the only thing that can decline: a job carrying no request at
 * all settles here too. `structuralSkipSummary`
 * (`apps/api/src/mobile/editOperationCopy.ts`) is what turns it into a sentence.
 *
 * Answers whether this delivery is the one that settled it, so a caller that
 * lost the row writes nothing further either.
 */
export async function settleSkippedRestructure(options: {
  job: Job;
  projectId: string;
  operationId: string;
  ownerToken: string;
  reason: string;
  fallbackStatus: SettledProjectStatus;
}): Promise<boolean> {
  const { projectId, operationId, ownerToken, reason, fallbackStatus } = options;
  const heartbeat = startStructuralPageLeaseHeartbeat(operationId, ownerToken);
  try {
    // A renewal the database refuses is real takeover, and the refund below is
    // the first irreversible thing this path does.
    if (!(await stillOwnsSkippedRestructure(heartbeat, operationId, projectId))) return false;
    await refundSkippedEditOperation(options.job, `Structural edit skipped: ${reason}`);
    const settled = await prisma.$transaction(async (tx) => {
      // Stop owns Project before it revokes an edit lease. Keep the same root
      // lock here before the conditional operation settlement below.
      await tx.project.update({
        where: { id: projectId },
        data: { contentRevision: { increment: 0 } }
      });
      const owned = await settleSkippedStructuralPageLeaseTx(tx, operationId, ownerToken);
      if (!owned) return false;
      await tx.bookEditOperation.update({
        where: { id: operationId },
        data: {
          classifier: { ...jsonRecord(owned.classifier), structuralSkipped: reason } as Prisma.InputJsonValue
        }
      });
      await tx.project.update({
        where: { id: projectId },
        data: { status: fallbackStatus }
      });
      return true;
    });
    if (!settled) {
      // The refund is already made and cannot be unmade, which is the right way
      // round: a kept charge nobody is looking for is worse than a loud line.
      console.error("Structural page edit lost its lease between the skip refund and the settlement", {
        event: "generation.structural_skip_settlement_lost_lease",
        projectId,
        operationId,
        reason
      });
    }
    return settled;
  } finally {
    await heartbeat.stop();
  }
}

/**
 * The barrier before the money, reported rather than thrown.
 *
 * `assertHeld` raises `StructuralPageLeaseLostError` on a refused renewal, which
 * every other caller here converts into a stand-down; a real database failure
 * still propagates, because nothing has been written yet and `markFailed`
 * settling the still-ACTIVE row is exactly right for it.
 */
async function stillOwnsSkippedRestructure(
  heartbeat: { assertHeld: () => Promise<void> },
  operationId: string,
  projectId: string
): Promise<boolean> {
  try {
    await heartbeat.assertHeld();
    return true;
  } catch (error) {
    if (!isStructuralPageLeaseLostError(error)) throw error;
    console.warn("Structural page edit stood down: another delivery owns the edit this one would skip", {
      event: "generation.structural_skip_lost_lease",
      projectId,
      operationId
    });
    return false;
  }
}

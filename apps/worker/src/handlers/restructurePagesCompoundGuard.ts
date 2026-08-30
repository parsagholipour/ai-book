import { rebuildRolledBackProjectStoryState } from "../generation/storyStateStore.js";
import { waitForStructuralPageLease } from "../generation/structuralPageLease.js";
import { redeliverUnrevertedStructuralEdit } from "./restructurePagesRedelivery.js";
import { EDIT_ADHERENCE_FAILED, ReaderEditFailure } from "@book-maker/core/editFailure";
import {
  structuralEditRequiresWholeBookGeneration,
  type StructuralApplication,
  type StructuralInstructionEdit,
  type StructuralPageEdit
} from "@book-maker/core";
import {
  PAGE_RESTRUCTURE_TRANSACTION_OPTIONS,
  compensateStructuralPageChangeTx,
  prisma
} from "@book-maker/db";
import { UnownedStructuralDeliveryError } from "../runtime/jobTypes.js";

/**
 * Legacy/tampered RESTRUCTURE_PAGES rows cannot silently drop prose work.
 *
 * New proposals are rerouted before pricing. This is the durable defense for
 * rows that bypassed that boundary: an unstamped row fails before mutation; a
 * stamped row first acquires the exact structural lease and compensates the
 * exact application stamp, then enters normal failure/refund settlement.
 */
export async function guardCompoundStructuralDelivery(options: {
  projectId: string;
  operationId: string;
  generationJobId: string;
  ownerToken: string;
  edit: StructuralPageEdit | null;
  editInstruction: string;
  application: StructuralApplication | null;
}): Promise<void> {
  const classified = options.edit ?? instructionEditFromApplication(options.application);
  if (!classified || !structuralEditRequiresWholeBookGeneration(classified, options.editInstruction)) {
    return;
  }

  if (!options.application) {
    throw new ReaderEditFailure(EDIT_ADHERENCE_FAILED);
  }

  const claim = await waitForStructuralPageLease(options.operationId, options.ownerToken);
  if (
    claim.outcome !== "acquired" ||
    claim.phase !== "draft" ||
    claim.application?.appliedAt !== options.application.appliedAt
  ) {
    // A publication winner or another live compensation owns settlement. This
    // delivery may neither complete the shared job nor refund under that owner.
    throw new UnownedStructuralDeliveryError();
  }

  const compensation = await prisma.$transaction(
    (tx) =>
      compensateStructuralPageChangeTx(tx, {
        projectId: options.projectId,
        operationId: options.operationId,
        expectedLeaseToken: options.ownerToken,
        expectedAppliedAt: options.application!.appliedAt
      }),
    PAGE_RESTRUCTURE_TRANSACTION_OPTIONS
  );
  switch (compensation.outcome) {
    case "compensated":
      break;
    case "published":
    case "superseded":
      // A winner owns settlement; this delivery may neither complete the shared
      // job nor refund under it.
      throw new UnownedStructuralDeliveryError();
    case "not-needed":
      // The stamp is already off the row, and only a compensation takes one off
      // — reverting the pages in the same transaction. So the shift this guard
      // exists to undo is undone, and the edit can go straight to the failure
      // and refund it was always going to end in. Requeueing instead would hand
      // the row back for a fresh delivery of a request that must not be
      // delivered at all.
      throw new ReaderEditFailure(EDIT_ADHERENCE_FAILED);
    case "lost":
      // The shift is still standing under an owner this delivery is not, so the
      // revert is somebody else's to make and `markFailed` must not run.
      return redeliverUnrevertedStructuralEdit(
        options.projectId,
        options.operationId,
        options.ownerToken,
        options.generationJobId
      );
    default: {
      const unhandled: never = compensation;
      throw new Error(`Unhandled structural compensation outcome ${JSON.stringify(unhandled)}`);
    }
  }

  try {
    if (!(await rebuildRolledBackProjectStoryState(options.projectId, compensation.currentPlanId))) {
      console.error(`Failed to restore story state after rejecting compound structural edit ${options.operationId}`);
    }
  } catch (error) {
    // The manuscript and plan are already restored transactionally. Story
    // state is derived and can be rebuilt later; never re-run the page revert.
    console.error(`Failed to restore story state after rejecting compound structural edit ${options.operationId}`, error);
  }
  throw new ReaderEditFailure(EDIT_ADHERENCE_FAILED);
}

/**
 * The coordinates to classify by when the request itself no longer parses.
 *
 * `structuralEditFromClassifier` answers `null` for a row whose
 * `classifier.structuralEdit` is gone or malformed — the tampered and legacy
 * rows this module is the durable defense against — and the payload copy is
 * exactly what such a delivery has already lost. Read as "nothing to guard",
 * that row walked past this gate with a `structuralApplication` stamp on it,
 * resumed the stamped page ids and settled APPLIED: the *shift* delivered and
 * the prose half of a compound request dropped in silence, eleven lines above
 * where an unstamped row correctly fails closed.
 *
 * The stamp is what still knows the shape. It carries the `action`, which is
 * the whole of the question for an insert — an insert drafts prose here, so
 * `structuralEditRequiresWholeBookGeneration` is `false` for one whatever the
 * instruction says, and this derivation cannot make the guard fire on a row it
 * would not already have fired on. For a delete the removed pages *are* the
 * coordinate set the request named, so the count the classifier's second door
 * measures against is exact. A move records no such list, so it derives none:
 * a coordinate count that is too low can only refuse a request the classifier
 * would otherwise have read as bare, which is the direction this module fails
 * in by design — a refund and a failure the reader can see, rather than half an
 * edit they paid for and were told nothing about.
 */
function instructionEditFromApplication(
  application: StructuralApplication | null
): StructuralInstructionEdit | null {
  if (!application) return null;
  return {
    action: application.action,
    anchorPageIndex: null,
    pageIndexes: application.removedPages.map((page) => page.index)
  };
}

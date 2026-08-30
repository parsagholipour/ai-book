import { jsonRecord, parseStructuralApplication } from "@book-maker/core";
import { Prisma } from "./client.ts";
import { revertStructuralPageChange } from "./pageRestructureRevert.ts";

type LockedStructuralOperation = {
  id: string;
  projectId: string;
  kind: string;
  status: string;
  classifier: unknown;
  structuralLeaseToken: string | null;
  /**
   * Whether the row's lease is *live* — unexpired and uncompleted — measured in
   * database time inside this transaction, never against the caller's clock.
   */
  leaseHeld: boolean;
  publicationRevision: number | null;
};

export type StructuralCompensationResult =
  | { outcome: "compensated"; currentPlanId: string | null }
  | { outcome: "not-needed" }
  | { outcome: "lost" }
  | { outcome: "published" }
  | { outcome: "superseded" };

/**
 * Reverts one committed structural shift under the project/operation locks.
 *
 * Stop and the worker both need the same ownership boundary: Project is the
 * root lock, the operation is then read FOR UPDATE, and only the exact
 * structuralApplication visible under that lock may be removed. The revert and
 * its durable completion marker commit together, so a canceled operation can
 * never advertise cleanup while placeholders or shifted indexes remain.
 *
 * A caller that names a lease must still *hold* one: `expectedLeaseToken` is
 * checked against an unexpired, uncompleted lease in database time, so an
 * expired owner is `lost` rather than a reverter.
 */
export async function compensateStructuralPageChangeTx(
  tx: Prisma.TransactionClient,
  options: {
    projectId: string;
    operationId: string;
    expectedAppliedAt?: string;
    expectedLeaseToken?: string;
  }
): Promise<StructuralCompensationResult> {
  const project = await tx.project.update({
    where: { id: options.projectId },
    data: { contentRevision: { increment: 0 } },
    select: { contentRevision: true, currentPlanId: true }
  });
  const rows = await tx.$queryRawUnsafe<LockedStructuralOperation[]>(
    `SELECT "id", "projectId", "kind", "status", "classifier",
            "structuralLeaseToken", "publicationRevision",
            ("structuralLeaseCompletedAt" IS NULL
              AND "structuralLeaseExpiresAt" IS NOT NULL
              AND "structuralLeaseExpiresAt" > CURRENT_TIMESTAMP) AS "leaseHeld"
       FROM "BookEditOperation"
      WHERE "id" = $1
      FOR UPDATE`,
    options.operationId
  );
  const operation = rows[0];
  if (
    !operation ||
    operation.projectId !== options.projectId ||
    operation.kind !== "RESTRUCTURE_PAGES"
  ) {
    return { outcome: "lost" };
  }
  if (operation.status === "APPLIED" || operation.publicationRevision !== null) {
    return { outcome: "published" };
  }
  if (operation.status !== "QUEUED" && operation.status !== "ACTIVE") {
    return { outcome: "lost" };
  }
  // The worker's rollback names its lease, and naming it is not the same as
  // still holding it. Token equality alone lets a *zombie* through: a delivery
  // whose heartbeat stalled past the lease window with no replacement yet on
  // the row still finds its own token there, so an ordinary provider error
  // reaching its catch would revert the shift, fail the operation and refund
  // work a replacement is free to pick up the instant this transaction commits.
  // The predicate is therefore the same compare-and-set the rollback used
  // before this primitive was extracted (`renewStructuralPageLeaseTx`) — this
  // token, unexpired, uncompleted — and it is measured in Postgres time, since
  // a paused process's own clock is exactly what cannot be trusted here.
  // Cancellation passes no token: Stop owns the row by cancelling it, and
  // holding a lease is a claim only a delivery can make.
  if (
    options.expectedLeaseToken !== undefined &&
    (operation.structuralLeaseToken !== options.expectedLeaseToken || !operation.leaseHeld)
  ) {
    return { outcome: "lost" };
  }

  const classifier = jsonRecord(operation.classifier);
  const application = parseStructuralApplication(operation.classifier);
  if (!application) {
    // Absence means the worker never committed a shift. Presence that fails
    // validation means the opposite may be true but cannot be reversed safely;
    // never turn a malformed recovery record into permission to cancel it.
    if (classifier.structuralApplication !== undefined && classifier.structuralApplication !== null) {
      return { outcome: "lost" };
    }
    return { outcome: "not-needed" };
  }
  if (
    options.expectedAppliedAt !== undefined &&
    application.appliedAt !== options.expectedAppliedAt
  ) {
    return { outcome: "lost" };
  }
  // A publication or another manuscript writer that advanced the book after
  // this stamp wins. Replaying an older ordering over that revision would undo
  // work this operation never owned. Legacy stamps retain the plan fence.
  if (
    (application.baseContentRevision !== undefined &&
      application.baseContentRevision !== project.contentRevision) ||
    (application.newPlanVersionId !== null &&
      project.currentPlanId !== application.newPlanVersionId)
  ) {
    return { outcome: "superseded" };
  }

  const reverted = await revertStructuralPageChange(tx, options.projectId, application);
  delete classifier.structuralApplication;
  const completedAt = new Date().toISOString();
  await tx.bookEditOperation.update({
    where: { id: options.operationId },
    data: {
      classifier: {
        ...classifier,
        structuralRolledBackAt: completedAt,
        structuralCompensation: {
          status: "COMPLETED",
          applicationAppliedAt: application.appliedAt,
          completedAt
        }
      } as Prisma.InputJsonValue
    }
  });
  return { outcome: "compensated", currentPlanId: reverted.currentPlanId };
}

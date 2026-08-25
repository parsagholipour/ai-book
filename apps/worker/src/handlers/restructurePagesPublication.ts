import { invalidateProjectExports } from "../generation/bookHelpers.js";
import {
  claimAppliedEditPublication,
  restoreEditProjectStatus
} from "../generation/editProjectStatus.js";
import {
  renewStructuralPageLeaseTx,
  StructuralPageLeaseLostError
} from "../generation/structuralPageLease.js";
import { maybeEnqueueCompile } from "../runtime/dispatch.js";
import { PAGE_RESTRUCTURE_TRANSACTION_OPTIONS, prisma } from "@book-maker/db";
import type { SettledProjectStatus } from "@book-maker/core";

/** Queue only the exact publication generation the APPLIED operation stamped. */
export async function queueRestructureCompile(
  projectId: string,
  planVersionId: string,
  operationId: string,
  publicationRevision: number,
  fallbackStatus: SettledProjectStatus
): Promise<void> {
  let dispatched: Awaited<ReturnType<typeof maybeEnqueueCompile>>;
  try {
    dispatched = await maybeEnqueueCompile(projectId, planVersionId, undefined, {
      contentRevision: publicationRevision,
      requireContentRevisionMatch: true
    });
  } catch (error) {
    console.error(`Failed to enqueue the export refresh for restructured project ${projectId}:`, error);
    dispatched = "not-ready";
  }
  if (dispatched === "not-ready") {
    await prisma
      .$transaction((tx) => restoreEditProjectStatus(tx, projectId, operationId, fallbackStatus))
      .catch(() => undefined);
  }
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
  const publication = await prisma.$transaction(async (tx) => {
    if (!(await claimAppliedEditPublication(tx, projectId, operationId, fallbackStatus))) {
      return null;
    }
    if (!(await renewStructuralPageLeaseTx(tx, operationId, ownerToken))) {
      throw new StructuralPageLeaseLostError();
    }
    const [project, operation] = await Promise.all([
      tx.project.findUnique({ where: { id: projectId }, select: { currentPlanId: true } }),
      tx.bookEditOperation.findUnique({ where: { id: operationId }, select: { publicationRevision: true } })
    ]);
    if (!project?.currentPlanId) {
      console.error(
        `Cannot replay APPLIED page restructure ${operationId} for project ${projectId}: no plan version is available`
      );
      await restoreEditProjectStatus(tx, projectId, operationId, fallbackStatus).catch(() => undefined);
      return null;
    }
    if (operation?.publicationRevision == null) {
      throw new Error("Applied structural edit lost its publication revision");
    }
    await invalidateProjectExports(projectId);
    return { planVersionId: project.currentPlanId, publicationRevision: operation.publicationRevision };
  }, PAGE_RESTRUCTURE_TRANSACTION_OPTIONS);
  if (!publication) return;
  await queueRestructureCompile(
    projectId,
    publication.planVersionId,
    operationId,
    publication.publicationRevision,
    fallbackStatus
  );
}

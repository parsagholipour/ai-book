import { releaseStructuralPageLease } from "../generation/structuralPageLease.js";
import { redeliverWorkerGenerationJob } from "../runtime/dispatch.js";
import { StructuralRollbackRedeliveryError } from "../runtime/jobTypes.js";

/**
 * A drafting failure whose revert did not land: keep the stamp, yield the
 * lease, requeue the durable job, and leave the row out of generic settlement.
 *
 * `markFailed` refunds the ACTIVE operation, clears its lease and restores
 * COMPLETE — the wrong three writes when the pages are still shifted. The
 * stamp survives on purpose (see `rollbackStructuralChange`); this is the
 * matching delivery: resume drafting against those ids instead of terminalizing.
 * Always throws so the caller cannot fall through into `markFailed`.
 */
export async function redeliverUnrevertedStructuralEdit(
  projectId: string,
  operationId: string,
  ownerToken: string,
  generationJobId: string | undefined
): Promise<never> {
  try {
    await releaseStructuralPageLease(operationId, ownerToken);
  } catch (error: unknown) {
    console.error(
      `Failed to yield the structural lease for ${operationId} after a rollback that did not land`,
      error
    );
  }
  if (generationJobId) {
    try {
      await redeliverWorkerGenerationJob(generationJobId);
    } catch (error: unknown) {
      console.error(
        `Failed to requeue structural edit ${operationId} on project ${projectId} after a rollback that did not land`,
        error
      );
    }
  }
  throw new StructuralRollbackRedeliveryError();
}

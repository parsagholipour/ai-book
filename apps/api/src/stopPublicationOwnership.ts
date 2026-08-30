import type { Prisma } from "@book-maker/db";

/**
 * Whether an already-completed durable job still owns this project's EDITING.
 *
 * Publication commits Job COMPLETED + operation APPLIED + the new manuscript
 * revision before its export/compile tail runs. Stop therefore cannot infer
 * "stranded" from the absence of QUEUED/ACTIVE jobs alone. The operation lease
 * is the live owner, and its expiry is compared in database time like every
 * worker-side lease assertion.
 *
 * Ordinary edits keep operation and job on the same project. A replan copy is
 * deliberately different: its operation stays on the immutable source while
 * `generationJobId` is moved to the target copy's GENERATE_BOOK successor.
 * The joined durable job is consequently the target-project relationship for
 * that fork; sourceProjectId = projectId proves the supported source-owned
 * operation shape rather than treating any cross-project link as ownership.
 */
export async function hasLiveCompletedPublicationTailTx(
  tx: Prisma.TransactionClient,
  projectId: string,
  contentRevision: number
): Promise<boolean> {
  const owners = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT operation."id"
       FROM "BookEditOperation" operation
       JOIN "GenerationJob" job
         ON job."id" = operation."generationJobId"
      WHERE job."projectId" = $1
        AND job."status" = 'COMPLETED'
        AND operation."status" = 'APPLIED'
        AND operation."publicationRevision" = $2
        AND operation."structuralLeaseToken" IS NOT NULL
        AND operation."structuralLeaseExpiresAt" > CURRENT_TIMESTAMP
        AND operation."structuralLeaseCompletedAt" IS NULL
        AND (
          (operation."projectId" = $1 AND job."type" IN ('APPLY_BOOK_EDIT', 'CONTINUE_BOOK'))
          OR (
            operation."kind" = 'BOOK_REPLAN'
            AND job."type" = 'GENERATE_BOOK'
            AND operation."sourceProjectId" = operation."projectId"
          )
        )
      LIMIT 1`,
    projectId,
    contentRevision
  );
  return owners.length === 1;
}

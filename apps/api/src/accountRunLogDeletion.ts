import { jobNames, safePathPart } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { deleteAccountRunLogs, objectKey, objectStore } from "@book-maker/storage";

/** Remove account content without dropping the jobs that identify old runs. */
export async function deleteAccountGenerationLogs(userId: string): Promise<void> {
  // Fence new appends first. Payload ownership survives deleting a character
  // and redrawing its portrait; the current portraitJobId is not its history.
  await deleteAccountRunLogs(userId);
  const jobs = await prisma.generationJob.findMany({
    where: { projectId: null, type: "GENERATE_CHARACTER_PORTRAIT", payload: { path: ["userId"], equals: userId } },
    select: { id: true }
  });
  for (const job of jobs) {
    const key = objectKey("books", "_unknown-project", "runs", `${safePathPart(job.id)}-${jobNames.GENERATE_CHARACTER_PORTRAIT}.jsonl`);
    // Older runs used the shared prefix, with immutable event objects or a
    // consolidated JSONL object. Never delete a bare job-id prefix.
    await objectStore().deletePrefix(`${key}.events/`);
    await objectStore().delete(key);
  }
}

/** Prisma promise so normal deletion can commit this alongside COMPLETED. */
export function markAccountGenerationLogsDeleted(userId: string) {
  return prisma.$executeRaw`
    UPDATE "AccountDeletionRequest"
       SET "metadata" = (CASE WHEN jsonb_typeof("metadata") = 'object'
                              THEN "metadata" ELSE '{}'::jsonb END)
                        || '{"accountRunLogsDeleted":true}'::jsonb
     WHERE "userId" = ${userId} AND "status" IN ('PENDING', 'COMPLETED')
  `;
}

/** Backfill completed requests, without repeating deletion of their financial tombstone. */
export async function repairDeletedAccountGenerationLogs(log: { warn: (object: unknown, message: string) => void }): Promise<void> {
  const requests = await prisma.$queryRaw<Array<{ userId: string }>>`
    SELECT DISTINCT "userId" FROM "AccountDeletionRequest"
     WHERE "status" = 'COMPLETED' AND "userId" IS NOT NULL
       AND NOT COALESCE("metadata" @> '{"accountRunLogsDeleted":true}'::jsonb, false)
     ORDER BY "userId"
     LIMIT 20
  `;
  for (const { userId } of requests) {
    try {
      await deleteAccountGenerationLogs(userId);
      await markAccountGenerationLogsDeleted(userId);
    } catch (error) {
      // The completion marker is written only after every object was removed.
      log.warn({ err: error, userId }, "Deleted account run-log cleanup failed; it will be retried");
    }
  }
}

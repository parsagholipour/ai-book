import { Prisma, prisma } from "@book-maker/db";
import { maybeEnqueueCompile } from "./dispatch.js";
import type { ImportBookJob } from "./jobPayloads.js";
import { parseJobSteps } from "./jobProgress.js";
import { StopRequestedError, isStoppedGenerationJob, type JobCompletion } from "./jobTypes.js";
import { jsonPayloadToRecord } from "./serialization.js";

export class ImportSupersededError extends Error {
  constructor() {
    super("Import completion no longer owns the project");
    this.name = "ImportSupersededError";
  }
}

/** Called under Project's publication lock, in the transaction writing the pages. */
export async function claimImportCompletion(
  tx: Prisma.TransactionClient,
  job: ImportBookJob,
  expected: { currentPlanId: string | null; contentRevision: number },
  live: { status: string; currentPlanId: string | null; contentRevision: number }
): Promise<void> {
  const { generationJobId, projectId, attemptId } = job.data;
  const durable = await tx.generationJob.findUnique({ where: { id: generationJobId } });
  if (isStoppedGenerationJob(durable)) throw new StopRequestedError();
  if (expected.currentPlanId !== null || expected.contentRevision !== 0 ||
    live.status !== "GENERATING" || live.currentPlanId !== expected.currentPlanId ||
    live.contentRevision !== expected.contentRevision) throw new ImportSupersededError();
  const latest = await tx.generationJob.findFirst({
    where: { projectId, type: "IMPORT_BOOK" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true }
  });
  if (latest?.id !== generationJobId) throw new ImportSupersededError();
  const completed = await tx.generationJob.updateMany({
    where: { id: generationJobId, projectId, type: "IMPORT_BOOK", status: "ACTIVE", attemptId: attemptId ?? null },
    data: {
      status: "COMPLETED", progress: 100, message: "Completed", error: null, finishedAt: new Date(),
      steps: parseJobSteps(durable?.steps).map((step) => ({ ...step, status: "done" })) as Prisma.InputJsonValue
    }
  });
  if (completed.count !== 1) throw new ImportSupersededError();
  if (attemptId) {
    const settled = await tx.generationAttempt.updateMany({
      where: { id: attemptId, projectId, primaryJobId: generationJobId, status: { in: ["QUEUED", "ACTIVE"] } },
      data: { status: "SUCCEEDED", finishedAt: new Date(), error: null, refundPending: false }
    });
    if (settled.count !== 1) throw new ImportSupersededError();
  }
}

/** Re-read the durable receipt only in the processor's post-completion boundary. */
export function importCompletion(job: ImportBookJob, durableCompletionCommitted = true): JobCompletion {
  return {
    durableCompletionCommitted,
    retryFollowUpOnRedelivery: true,
    afterJobCompleted: async () => {
      const { projectId, importId, generationJobId } = job.data;
      const receipt = await prisma.bookImport.findUnique({ where: { id: importId } });
      if (receipt?.status !== "COMPLETE" || receipt.projectId !== projectId) return;
      const saved = jsonPayloadToRecord(jsonPayloadToRecord(receipt.stats).completion);
      const checkpointed = typeof saved.planVersionId === "string" && typeof saved.contentRevision === "number";
      // Old COMPLETE receipts predate the checkpoint. Imports create the first
      // plan and revision; never use a newer current plan as their replacement.
      const planId = typeof saved.planVersionId === "string" ? saved.planVersionId :
        (await prisma.planVersion.findFirst({ where: { projectId, version: 1 }, select: { id: true } }))?.id;
      const contentRevision = typeof saved.contentRevision === "number" ? saved.contentRevision : 1;
      const [project, durable] = await Promise.all([
        prisma.project.findUnique({ where: { id: projectId } }),
        prisma.generationJob.findUnique({ where: { id: generationJobId } })
      ]);
      if (!planId || !project || durable?.status !== "COMPLETED" || isStoppedGenerationJob(durable) ||
        project.currentPlanId !== planId || project.contentRevision !== contentRevision ||
        !(checkpointed ? ["COMPLETE"] : ["COMPLETE", "GENERATING"]).includes(project.status)) return;
      await maybeEnqueueCompile(projectId, planId, undefined, { contentRevision, requireContentRevisionMatch: true });
    }
  };
}

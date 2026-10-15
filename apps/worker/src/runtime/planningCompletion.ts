import { Prisma } from "@book-maker/db";
import type { PlanBookJob } from "./jobPayloads.js";
import { parseJobSteps } from "./jobProgress.js";
import { StopRequestedError, isStoppedGenerationJob } from "./jobTypes.js";

export class PlanningSupersededError extends Error {
  constructor() {
    super("Planning completion no longer owns the project");
    this.name = "PlanningSupersededError";
  }
}

/** Lock in Stop's order and bind the output to the exact open planning run. */
export async function claimPlanningCompletion(
  tx: Prisma.TransactionClient,
  job: PlanBookJob,
  project: { currentPlanId: string | null; contentRevision: number }
): Promise<void> {
  const { projectId, generationJobId, attemptId } = job.data;
  // Byline/matter saves are allowed during PLANNING without a replacement
  // job. Claim lifecycle identity, not updatedAt, and never restore an old
  // metadata timestamp while taking the project lock.
  const owned = await tx.project.updateMany({
    where: { id: projectId, status: "PLANNING", ...project },
    data: { status: "PLANNING" }
  });
  const durable = await tx.generationJob.findUnique({ where: { id: generationJobId } });
  if (isStoppedGenerationJob(durable)) throw new StopRequestedError();
  if (owned.count !== 1) throw new PlanningSupersededError();

  // A newer plan request can still be PLANNING with the same currentPlanId
  // and revision. Project's lock orders this read against enqueue's write.
  const latest = await tx.generationJob.findFirst({
    where: { projectId, type: "PLAN_BOOK" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true }
  });
  if (latest?.id !== generationJobId ||
    (durable?.contentRevision != null && durable.contentRevision !== project.contentRevision)) {
    throw new PlanningSupersededError();
  }
  const completed = await tx.generationJob.updateMany({
    where: { id: generationJobId, projectId, type: "PLAN_BOOK", status: "ACTIVE", attemptId: attemptId ?? null },
    data: {
      status: "COMPLETED", progress: 100, message: "Completed", error: null, finishedAt: new Date(),
      steps: parseJobSteps(durable?.steps).map((step) => ({ ...step, status: "done" })) as Prisma.InputJsonValue
    }
  });
  if (completed.count !== 1) throw new PlanningSupersededError();
  if (attemptId) {
    const settled = await tx.generationAttempt.updateMany({
      where: { id: attemptId, projectId, primaryJobId: generationJobId, status: { in: ["QUEUED", "ACTIVE"] } },
      data: { status: "SUCCEEDED", finishedAt: new Date(), error: null, refundPending: false }
    });
    if (settled.count !== 1) throw new PlanningSupersededError();
  }
}

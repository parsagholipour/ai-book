import { Prisma } from "@book-maker/db";
import { parseJobSteps } from "./jobProgress.js";

type DurableEditJobType = "APPLY_BOOK_EDIT" | "CONTINUE_BOOK" | "GENERATE_BOOK";

export type DurableEditCompletionClaim = {
  generationJobId: string;
  projectId: string;
  operationId: string;
  attemptId?: string | undefined;
  type: DurableEditJobType;
  message: string;
};

/**
 * Claims the exact still-open durable job while the caller holds Project.
 * Callers must lock their BookEditOperation immediately after this returns,
 * preserving the Stop/publication order Project -> GenerationJob -> operation.
 */
export async function claimDurableEditCompletionTx(
  tx: Prisma.TransactionClient,
  claim: DurableEditCompletionClaim
): Promise<boolean> {
  const completed = await tx.generationJob.updateMany({
    where: {
      id: claim.generationJobId,
      projectId: claim.projectId,
      type: claim.type,
      status: "ACTIVE",
      attemptId: claim.attemptId ?? null
    },
    data: {
      status: "COMPLETED",
      progress: 100,
      message: claim.message,
      error: null,
      finishedAt: new Date()
    }
  });
  if (completed.count !== 1) return false;

  const row = await tx.generationJob.findUnique({
    where: { id: claim.generationJobId },
    select: { steps: true }
  });
  const steps = parseJobSteps(row?.steps);
  if (steps.length > 0) {
    await tx.generationJob.update({
      where: { id: claim.generationJobId },
      data: {
        steps: steps.map((step) => ({ ...step, status: "done" as const })) as Prisma.InputJsonValue
      }
    });
  }
  return true;
}

/** Completes the paid attempt in the same transaction as its delivered edit. */
export async function settleDurableEditAttemptTx(
  tx: Prisma.TransactionClient,
  claim: DurableEditCompletionClaim
): Promise<boolean> {
  if (!claim.attemptId) return true;
  const completed = await tx.generationAttempt.updateMany({
    where: {
      id: claim.attemptId,
      projectId: claim.projectId,
      editOperationId: claim.operationId,
      primaryJobId: claim.generationJobId,
      status: { in: ["QUEUED", "ACTIVE"] }
    },
    data: {
      status: "SUCCEEDED",
      finishedAt: new Date(),
      error: null,
      refundPending: false
    }
  });
  return completed.count === 1;
}

/**
 * Completes the paid replan attempt through its exact GENERATE_BOOK
 * successor. A replan's primary job is REPLAN_BOOK, so the ordinary edit
 * settlement's primaryJobId fence cannot describe this handoff safely.
 */
export async function settleReplanAttemptTx(
  tx: Prisma.TransactionClient,
  claim: DurableEditCompletionClaim
): Promise<boolean> {
  if (!claim.attemptId) return true;
  const completed = await tx.generationAttempt.updateMany({
    where: {
      id: claim.attemptId,
      projectId: claim.projectId,
      editOperationId: claim.operationId,
      status: "ACTIVE",
      jobs: {
        some: {
          id: claim.generationJobId,
          projectId: claim.projectId,
          type: "GENERATE_BOOK",
          attemptId: claim.attemptId
        }
      }
    },
    data: {
      status: "SUCCEEDED",
      finishedAt: new Date(),
      error: null,
      refundPending: false
    }
  });
  return completed.count === 1;
}

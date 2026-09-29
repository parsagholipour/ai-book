import { prisma } from "@book-maker/db";

type AttemptTiming = {
  operation: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  primaryJob: { type: string; payload: unknown } | null;
};

export type GenerationTimings = {
  planningMs: number | null;
  bookMs: number | null;
};

function durationMs(attempt: AttemptTiming): number | null {
  if (!attempt.startedAt || !attempt.finishedAt) return null;
  const duration = attempt.finishedAt.getTime() - attempt.startedAt.getTime();
  return duration >= 0 ? duration : null;
}

export function generationTimingsForPlan(
  attempts: AttemptTiming[],
  plan: { id: string; createdAt: Date; approvedAt: Date | null }
): GenerationTimings {
  // A plan version is created during its successful planning job, shortly
  // before that attempt settles. This interval ties revisions to their own
  // plan even though REVISE_PLAN's payload names the preceding version.
  const planning = attempts
    .filter((attempt) =>
      (attempt.operation === "PLAN_GENERATION" || attempt.operation === "PLAN_REVISION") &&
      (attempt.primaryJob?.type === "PLAN_BOOK" || attempt.primaryJob?.type === "REVISE_PLAN") &&
      attempt.startedAt != null && attempt.startedAt <= plan.createdAt &&
      attempt.finishedAt != null && attempt.finishedAt >= plan.createdAt
    )
    .sort((a, b) => a.finishedAt!.getTime() - b.finishedAt!.getTime())[0];

  const book = plan.approvedAt == null ? undefined : attempts
    .filter((attempt) => {
      const payload = attempt.primaryJob?.payload;
      return attempt.operation === "FULL_BOOK_GENERATION" &&
        payload != null && typeof payload === "object" && !Array.isArray(payload) &&
        (payload as Record<string, unknown>).planId === plan.id &&
        attempt.finishedAt != null && attempt.finishedAt >= plan.approvedAt!;
    })
    .sort((a, b) => a.finishedAt!.getTime() - b.finishedAt!.getTime())[0];

  return { planningMs: planning ? durationMs(planning) : null, bookMs: book ? durationMs(book) : null };
}

export async function loadGenerationTimings(
  projectId: string,
  plan: { id: string; createdAt: Date; approvedAt: Date | null } | null
): Promise<GenerationTimings> {
  if (!plan) return { planningMs: null, bookMs: null };
  const attempts = await prisma.generationAttempt.findMany({
    where: {
      projectId,
      status: "SUCCEEDED",
      operation: { in: ["PLAN_GENERATION", "PLAN_REVISION", "FULL_BOOK_GENERATION"] }
    },
    select: {
      operation: true,
      startedAt: true,
      finishedAt: true,
      primaryJob: { select: { type: true, payload: true } }
    }
  });
  return generationTimingsForPlan(attempts, plan);
}

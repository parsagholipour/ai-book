import { bookPlanSchema, createProviders } from "@book-maker/core";
import { strategyForInput } from "../generation/bookHelpers.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { prepareCompositionSpeculatively, speculativePrepTarget } from "../generation/composedSpeculativePrep.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { createRunLogger } from "../providers/runLogging.js";
import { config } from "../runtime/config.js";
import { prisma } from "@book-maker/db";
import type { JobCompletion } from "../runtime/jobTypes.js";
import type { PrepareCompositionJob } from "../runtime/jobPayloads.js";

/**
 * A prep that has waited this long in the queue is for a plan its reader has
 * either approved (the book run cancels it then) or left: it exits without a
 * call. So a backlog in the background lane drains at once rather than paying
 * for plans nobody is reading, and one that waits past the lane's alert
 * threshold (15 minutes) means nothing is consuming the lane.
 */
export const PREPARE_COMPOSITION_STALE_MS = 10 * 60_000;

/**
 * `prepare-composition`: plans a composed book's stance, brief inventory,
 * episodes and form plan while its reader reads the plan
 * (`generation/composedSpeculativePrep.ts`). Unbilled, and owned by nobody but
 * its own row: it changes no project status, and its provider calls are costed
 * to the book's owner (`runtime/providerSpendUser.ts`), so the spend breaker
 * sees them. Queued by `plan-book` and `revise-plan` only when the door that
 * started the plan asked the breaker for speculative work (`prepareComposition`
 * on their payload).
 */
export async function prepareComposition(job: PrepareCompositionJob): Promise<JobCompletion> {
  const { projectId, planId, generationJobId } = job.data;
  const runLog = createRunLogger(job);
  const row = await prisma.generationJob.findUnique({ where: { id: generationJobId }, select: { createdAt: true } });
  if (row && Date.now() - row.createdAt.getTime() > PREPARE_COMPOSITION_STALE_MS) {
    await runLog.append("generation.speculative_prep.skipped", { reason: "stale", projectId, planId });
    return {};
  }
  // Approved, revised or written by its author since it was queued: the book run (or nobody) owns these calls now.
  const target = await speculativePrepTarget(projectId, planId);
  if (!target) {
    await runLog.append("generation.speculative_prep.skipped", { reason: "plan-not-open", projectId, planId });
    return {};
  }
  const input = inputForPlanVersion(target.project, target.inputSnapshot);
  if (strategyForInput(input).executionMode !== "composed-chapters") {
    await runLog.append("generation.speculative_prep.skipped", { reason: "not-composed", projectId, planId });
    return {};
  }
  const providers = createLoggedProviders(job, createProviders(config, input), input);
  await prepareCompositionSpeculatively({
    projectId,
    planId,
    generationJobId,
    input,
    plan: bookPlanSchema.parse(target.planningPackage),
    textModel: providers.text,
    runLog
  });
  return {};
}

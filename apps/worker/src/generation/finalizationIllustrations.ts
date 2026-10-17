import type { BookGenerationStrategy, BookPlan, CreateProjectInput } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { dispatchWorkerGenerationJob } from "../runtime/dispatch.js";
import { currentGenerationAttemptId } from "../runtime/generationAttemptContext.js";
import { pageIllustrationJobDedupeKey, pageIllustrationKeeperToken } from "./pageIllustrationOwnership.js";
import { pageIllustrationVisualContract, reusablePageIllustration } from "./pageIllustrationVisualContract.js";

export type FinalizationIllustrationsResult =
  | { kind: "superseded" }
  | { kind: "ready"; pendingJobIds: string[]; missingPageIndexes: number[] };

/** Queue illustrations only for the manuscript that bounded final review kept. */
export async function enqueueFinalizationIllustrations(options: {
  projectId: string;
  planId: string;
  contentRevision: number;
  input: CreateProjectInput;
  plan: BookPlan;
  strategy: BookGenerationStrategy;
}): Promise<FinalizationIllustrationsResult> {
  const attemptId = currentGenerationAttemptId();
  const result = await prisma.$transaction(async (tx): Promise<FinalizationIllustrationsResult> => {
    // Same lock ordering as export/page publication. No provider or queue I/O
    // belongs inside: the durable jobs commit before Redis sees them.
    const projects = await tx.$queryRaw<Array<{ contentRevision: number; currentPlanId: string | null; status: string }>>`
      SELECT "contentRevision", "currentPlanId", "status" FROM "Project"
      WHERE "id" = ${options.projectId} FOR UPDATE`;
    const project = projects[0];
    if (!project || project.status === "FAILED" || project.currentPlanId !== options.planId ||
      project.contentRevision !== options.contentRevision) return { kind: "superseded" };
    if (attemptId) {
      const attempt = await tx.generationAttempt.findUnique({ where: { id: attemptId }, select: { status: true } });
      if (!attempt || !["QUEUED", "ACTIVE"].includes(attempt.status)) return { kind: "superseded" };
    }
    await tx.$queryRaw`SELECT "id" FROM "Page" WHERE "projectId" = ${options.projectId} ORDER BY "id" FOR UPDATE`;
    const pages = await tx.page.findMany({ where: { projectId: options.projectId }, orderBy: { index: "asc" }, include: { images: true } });
    const referenceAssets = await tx.imageAsset.findMany({
      where: { projectId: options.projectId, type: "CHARACTER_REFERENCE", metadata: { path: ["planId"], equals: options.planId } },
      select: { id: true, path: true }
    });
    const pendingJobIds: string[] = [];
    const missingPageIndexes: number[] = [];
    for (const page of pages) {
      if (!options.strategy.shouldIllustratePage(options.input, options.plan, page.index)) continue;
      if (!["COMPLETED", "FAILED_QA"].includes(page.status) || !page.markdown.trim() || !page.imagePrompt?.trim()) {
        missingPageIndexes.push(page.index);
        continue;
      }
      const keeper = { projectId: options.projectId, pageId: page.id, title: page.title, markdown: page.markdown,
        summary: page.summary, imagePrompt: page.imagePrompt, revision: page.revision };
      const visualContract = pageIllustrationVisualContract({ prompt: page.imagePrompt, input: options.input, plan: options.plan, referenceAssets });
      if (reusablePageIllustration(page.images, keeper, visualContract)) continue;
      const keeperToken = pageIllustrationKeeperToken(keeper);
      // The same key the draft-time enqueue and page publication use, so a picture
      // already queued for this unchanged keeper is found here rather than redrawn.
      const baseKey = pageIllustrationJobDedupeKey({ pageId: page.id, planId: options.planId, revision: page.revision, keeperToken });
      const dedupeKey = attemptId ? `${baseKey}:attempt:${attemptId}` : baseKey;
      const job = await tx.generationJob.upsert({
        where: { dedupeKey }, update: {},
        create: {
          projectId: options.projectId, type: "GENERATE_IMAGE", status: "QUEUED", progress: 0,
          message: "Queued after manuscript review", ownsQualityVerdict: false, dedupeKey,
          contentRevision: options.contentRevision, ...(attemptId ? { attemptId } : {}),
          payload: { pageId: page.id, planId: options.planId, prompt: page.imagePrompt, keeperToken }
        },
        select: { id: true, status: true }
      });
      // The exact keeper's settled job, not the unversioned page failure
      // message, decides exhaustion. A changed scene may earn its own image.
      if (job.status === "QUEUED" || job.status === "ACTIVE") pendingJobIds.push(job.id);
      else missingPageIndexes.push(page.index);
    }
    return { kind: "ready", pendingJobIds, missingPageIndexes };
  }, { maxWait: 10_000, timeout: 30_000 });
  if (result.kind === "ready") {
    // Queue errors leave durable QUEUED rows for reconciliation. Failures may
    // not erase the pending result or allow an image-less early publication.
    const dispatched = await Promise.allSettled(result.pendingJobIds.map((id) => dispatchWorkerGenerationJob(id)));
    for (let i = 0; i < dispatched.length; i += 1) {
      const item = dispatched[i]!;
      if (item.status === "rejected") console.warn("Finalization illustration dispatch deferred", {
        generationJobId: result.pendingJobIds[i], error: item.reason
      });
    }
  }
  return result;
}

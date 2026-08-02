import { getProjectOrThrow, invalidateProjectExports, strategyForInput } from "../generation/bookHelpers.js";
import { storeEmbedding } from "../generation/semanticMemory.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { maybeEnqueueCompile } from "../runtime/dispatch.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import { locallyPatchedPage, rewritePageForUserRequest } from "./replanBook.js";
import { bookPlanSchema, createProviders } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { Job } from "bullmq";

/**
 * `apply-book-edit` job: apply a user-approved edit to saved pages.
 */

/** Where in the `apply` step's own band each page's phases sit. */
const PAGE_PHASE_SHARE = { draft: 0.05, review: 0.6, save: 0.9 } as const;

type EditPagePhase = keyof typeof PAGE_PHASE_SHARE;

/** The `apply` step owns 40–75 of the job's progress column. */
function applyStepProgress(pagesDone: number, total: number): number {
  return 40 + Math.round((pagesDone / Math.max(total, 1)) * 35);
}

export async function applyBookEdit(job: Job) {
  const {
    projectId,
    operationId,
    request,
    affectedPageIndexes,
    planId,
    exactReplacement
  } = job.data as {
    projectId: string;
    operationId: string;
    request: string;
    affectedPageIndexes: number[];
    planId?: string;
    exactReplacement?: { from: string; to: string };
  };
  const generationJobId = job.data.generationJobId as string | undefined;
  const operation = await prisma.bookEditOperation.findUnique({ where: { id: operationId } });
  if (!operation) {
    throw new Error("Book edit operation not found");
  }
  await prisma.bookEditOperation.update({ where: { id: operationId }, data: { status: "ACTIVE" } });
  await prisma.project.update({ where: { id: projectId }, data: { status: "EDITING" } });
  await advanceJobStep(generationJobId, "prepare", 20, "Preparing page edit");

  const [project, planVersion] = await Promise.all([
    getProjectOrThrow(projectId),
    prisma.planVersion.findUnique({ where: { id: planId ?? "" } })
  ]);
  if (!project.currentPlanId && !planId) {
    throw new Error("Cannot edit a book without a current plan");
  }
  const effectivePlanVersion =
    planVersion ?? (project.currentPlanId ? await prisma.planVersion.findUnique({ where: { id: project.currentPlanId } }) : null);
  if (!effectivePlanVersion) {
    throw new Error("Current plan not found");
  }
  const input = inputForPlanVersion(project, effectivePlanVersion.inputSnapshot);
  const plan = bookPlanSchema.parse(effectivePlanVersion.planningPackage);
  const strategy = strategyForInput(input);
  const providers = createLoggedProviders(job, createProviders(config, input), input);
  const pages = await prisma.page.findMany({
    where: { projectId, index: { in: affectedPageIndexes } },
    orderBy: { index: "asc" },
    include: { chapter: true }
  });
  if (pages.length === 0) {
    throw new Error("No matching pages found for this edit");
  }

  await advanceJobStep(generationJobId, "snapshot", 35, `Snapshotting ${pages.length} page edit target(s)`, {
    done: 0,
    total: pages.length
  });
  const snapshots = new Map<number, string>();
  for (const page of pages) {
    const snapshot = await prisma.pageEditSnapshot.create({
      data: {
        projectId,
        pageId: page.id,
        operationId,
        pageIndex: page.index,
        titleBefore: page.title,
        markdownBefore: page.markdown,
        summaryBefore: page.summary,
        revisionBefore: page.revision
      }
    });
    snapshots.set(page.index, snapshot.id);
  }

  const updatedPageIndexes: number[] = [];
  // Rewriting is the long step, and one flat "applying" for the whole of it is
  // what made a multi-page edit look stalled. Each page reports itself three
  // times so both the bar and the phrase above it keep moving; the API turns
  // these counters into the words, this file never does.
  const reportPage = (page: { index: number }, offset: number, phase: EditPagePhase) =>
    advanceJobStep(
      generationJobId,
      "apply",
      applyStepProgress(offset + PAGE_PHASE_SHARE[phase], pages.length),
      `Applying edit to page ${page.index}`,
      { done: offset, total: pages.length, phase, pageIndex: page.index }
    );

  for (const [offset, page] of pages.entries()) {
    await reportPage(page, offset, "draft");
    const updated = exactReplacement && page.markdown.includes(exactReplacement.from)
      ? locallyPatchedPage(page, exactReplacement)
      : await rewritePageForUserRequest({
          projectId,
          page,
          input,
          plan,
          strategy,
          providers,
          request,
          generationJobId,
          onPhase: (phase) => reportPage(page, offset, phase)
        });
    await reportPage(page, offset, "save");

    const saved = await prisma.page.update({
      where: { id: page.id },
      data: {
        title: updated.title,
        markdown: updated.markdown,
        summary: updated.summary,
        imagePrompt: updated.imagePrompt ?? page.imagePrompt,
        status: "COMPLETED",
        revision: { increment: 1 },
        qualityReport: updated.qualityReport as Prisma.InputJsonValue
      }
    });
    const snapshotId = snapshots.get(page.index);
    if (snapshotId) {
      await prisma.pageEditSnapshot.update({
        where: { id: snapshotId },
        data: {
          titleAfter: saved.title,
          markdownAfter: saved.markdown,
          summaryAfter: saved.summary,
          revisionAfter: saved.revision
        }
      });
    }
    if (updated.continuityNotes.length > 0) {
      await prisma.continuityNote.createMany({
        data: updated.continuityNotes.map((body) => ({
          projectId,
          scope: `page:${page.index}:edit:${operationId}`,
          body,
          tags: ["page", String(page.index), "edit"]
        }))
      });
    }
    await storeEmbedding(projectId, `page:${page.index}`, page.id, saved.summary, providers.embedding);
    updatedPageIndexes.push(page.index);
  }

  await advanceJobStep(generationJobId, "export", 85, "Refreshing exports");
  await invalidateProjectExports(projectId);
  await prisma.bookEditOperation.update({
    where: { id: operationId },
    data: {
      status: "APPLIED",
      affectedPageIndexes: updatedPageIndexes,
      appliedAt: new Date()
    }
  });
  await prisma.project.update({
    where: { id: projectId },
    data: { contentRevision: { increment: 1 } }
  });
  await maybeEnqueueCompile(projectId, effectivePlanVersion.id);
}

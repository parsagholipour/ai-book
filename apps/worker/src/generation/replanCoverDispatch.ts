import { coverArtSourceFor, type CreateProjectInput } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { countOpenCoverJobs, enqueueWorkerJob } from "../runtime/dispatch.js";

/**
 * Queues only the cover belonging to one exact replan publication. The durable
 * job carries the same revision and EDITING expectation, so the worker's stale
 * guard also stands it down if the manuscript changes after dispatch.
 */
export async function maybeEnqueueRevisionOwnedReplanCover(
  projectId: string,
  planId: string,
  input: CreateProjectInput,
  scope: { contentRevision: number; expectedProjectStatus: "EDITING"; requireContentRevisionMatch: true }
): Promise<boolean> {
  if (coverArtSourceFor(input.mediaSettings) === "none") return false;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { currentPlanId: true, contentRevision: true, status: true }
  });
  if (
    !project ||
    project.currentPlanId !== planId ||
    project.status !== scope.expectedProjectStatus ||
    (scope.requireContentRevisionMatch && project.contentRevision !== scope.contentRevision)
  ) {
    return false;
  }
  const [coverAssets, openCoverJobs] = await Promise.all([
    prisma.imageAsset.count({ where: { projectId, type: "COVER" } }),
    countOpenCoverJobs(projectId)
  ]);
  if (coverAssets > 0 || openCoverJobs > 0) return false;
  await enqueueWorkerJob({
    projectId,
    type: "GENERATE_IMAGE",
    payload: {
      planId,
      assetType: "COVER",
      contentRevision: scope.contentRevision,
      exportPublicationProjectStatus: scope.expectedProjectStatus
    },
    dedupeKey: `generate-cover:${projectId}:${planId}:revision-${scope.contentRevision}:status-${scope.expectedProjectStatus}`,
    contentRevision: scope.contentRevision
  });
  return true;
}

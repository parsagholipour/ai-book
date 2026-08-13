import { getProjectOrThrow, invalidateProjectExports } from "../generation/bookHelpers.js";
import {
  applyLayoutBatchInTx,
  LayoutUnwritableError,
  type LayoutDestRef,
  type LayoutSourceRef,
  type PageRow,
  type ResolvedLayoutSource
} from "../generation/imageLayoutPlan.js";
import { maybeEnqueueCompile } from "../runtime/dispatch.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import { prisma } from "@book-maker/db";
import { Job } from "bullmq";

/**
 * The `apply-book-edit` layout fork: move or remove existing illustrations with
 * no generation. A chat-added line is cut from its page (and pasted on a move);
 * a generation `ImageAsset` is unlinked or reassigned, and a destination page's
 * own hero is demoted to an in-body line rather than lost. Undo restores
 * `pageId` from the classifier plus the page snapshots.
 *
 * This file owns the job: the replay, the claim, the status, and the compile.
 * `generation/imageLayoutPlan.ts` owns what happens to the pages — including
 * the rule that makes a batch safe, one snapshot per page.
 */

const INTERIOR_ASSET_TYPES = ["SCENE_ILLUSTRATION", "DIAGRAM"] as const;

export type ImageLayoutPayload = {
  action: "move" | "remove";
  /** Every picture the edit covers. One entry for a move. */
  sources?: LayoutSourceRef[];
  /** The pre-bulk shape. Still read: a job enqueued before that change may still be delivered. */
  source?: LayoutSourceRef;
  dest?: LayoutDestRef;
};

/** Why a layout edit wrote nothing. Read back by the card, never by the reader. */
type LayoutSkipReason = "missing" | "already_positioned";

class LayoutUnavailableError extends Error {
  readonly reason: LayoutSkipReason;

  constructor(reason: LayoutSkipReason = "missing") {
    super("The illustration to move or remove is no longer in this book");
    this.name = "LayoutUnavailableError";
    this.reason = reason;
  }
}

export async function applyImageLayout(job: Job, operation: { status: string; classifier: unknown }) {
  const { projectId, operationId, planId, imageLayout } = job.data as {
    projectId: string;
    operationId: string;
    planId?: string;
    imageLayout: ImageLayoutPayload;
  };
  const generationJobId = job.data.generationJobId as string | undefined;

  if (operation.status === "APPLIED") {
    await replayAppliedLayout(projectId, planId, operation.classifier);
    return;
  }

  const activated = await prisma.bookEditOperation.updateMany({
    where: { id: operationId, status: { notIn: ["APPLIED", "CANCELED"] } },
    data: { status: "ACTIVE" }
  });
  if (activated.count === 0) {
    const settled = await prisma.bookEditOperation.findUnique({ where: { id: operationId } });
    if (settled?.status === "APPLIED") {
      await replayAppliedLayout(projectId, planId, settled.classifier);
    }
    return;
  }
  const prior = await prisma.project.findUnique({
    where: { id: projectId },
    select: { status: true, currentPlanId: true }
  });
  const fallbackStatus = prior?.status === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "COMPLETE";
  await prisma.project.update({ where: { id: projectId }, data: { status: "EDITING" } });
  await advanceJobStep(generationJobId, "prepare", 20, "Preparing the illustration change");

  const payloadSources = imageLayout.sources ?? (imageLayout.source ? [imageLayout.source] : []);
  const sources = (await Promise.all(payloadSources.map((source) => resolveLayoutSource(projectId, source)))).filter(
    (source): source is ResolvedLayoutSource => source !== null
  );
  const dest = imageLayout.action === "move" ? await resolveLayoutDest(projectId, imageLayout.dest) : null;
  if (sources.length === 0 || (imageLayout.action === "move" && !dest)) {
    await markLayoutSkipped(projectId, operationId, fallbackStatus);
    return;
  }

  await advanceJobStep(generationJobId, "snapshot", 35, snapshotStepLabel(sources));
  await advanceJobStep(generationJobId, "apply", 50, applyStepLabel(imageLayout, sources, dest));

  let applied: boolean;
  let skipReason: LayoutSkipReason | null = null;
  try {
    applied = await prisma.$transaction(async (tx) => {
      const claimed = await tx.bookEditOperation.updateMany({
        where: { id: operationId, status: { in: ["QUEUED", "ACTIVE"] } },
        data: { status: "APPLIED", appliedAt: new Date() }
      });
      if (claimed.count !== 1) {
        return false;
      }
      const language = (await tx.project.findUnique({ where: { id: projectId }, select: { language: true } }))?.language;
      const batch = await applyLayoutBatchInTx(tx, {
        projectId,
        operationId,
        action: imageLayout.action,
        sources,
        dest,
        ...(imageLayout.dest?.position ? { destPosition: imageLayout.dest.position } : {}),
        ...(language ? { language } : {})
      });
      if (batch.empty) {
        throw new LayoutUnavailableError(batch.allAlreadyPositioned ? "already_positioned" : "missing");
      }
      const row = await tx.bookEditOperation.findUnique({
        where: { id: operationId },
        select: { classifier: true }
      });
      await tx.bookEditOperation.update({
        where: { id: operationId },
        data: {
          // Written from the flush rather than guessed before it: a target that
          // had already gone must not leave its page claimed as edited.
          affectedPageIndexes: batch.writtenPageIndexes,
          classifier: {
            ...(row && typeof row.classifier === "object" && row.classifier !== null ? row.classifier : {}),
            ...(batch.previousAssets.length > 0 ? { previousAssets: batch.previousAssets } : {}),
            ...(batch.demotedAssets.length > 0 ? { demotedAssets: batch.demotedAssets } : {}),
            ...(batch.skipped > 0 ? { layoutSkippedCount: batch.skipped } : {})
          }
        }
      });
      await tx.project.update({ where: { id: projectId }, data: { contentRevision: { increment: 1 } } });
      return true;
    });
  } catch (error) {
    if (error instanceof LayoutUnavailableError) {
      skipReason = error.reason;
      applied = false;
    } else if (error instanceof LayoutUnwritableError) {
      skipReason = "missing";
      applied = false;
    } else {
      throw error;
    }
  }

  if (skipReason) {
    await markLayoutSkipped(projectId, operationId, fallbackStatus, skipReason);
    return;
  }
  if (!applied) {
    return;
  }
  try {
    await advanceJobStep(generationJobId, "export", 85, "Refreshing exports");
  } catch {
    // Progress display only.
  }
  const compilePlanId = planId ?? prior?.currentPlanId;
  if (!compilePlanId) {
    await prisma.project
      .updateMany({ where: { id: projectId, status: "EDITING" }, data: { status: fallbackStatus } })
      .catch(() => undefined);
    return;
  }
  await refreshExports(projectId, compilePlanId, fallbackStatus);
}

function snapshotStepLabel(sources: ResolvedLayoutSource[]): string {
  const pages = [...new Set(sources.map((source) => source.page.index))].sort((a, b) => a - b);
  return pages.length === 1 ? `Snapshotting page ${pages[0]}` : `Snapshotting ${pages.length} pages`;
}

function applyStepLabel(
  imageLayout: ImageLayoutPayload,
  sources: ResolvedLayoutSource[],
  dest: PageRow | null
): string {
  if (imageLayout.action === "move") {
    return `Moving the illustration to page ${dest?.index ?? ""}`.trim();
  }
  return sources.length === 1
    ? `Removing the illustration on page ${sources[0]?.page.index}`
    : `Removing ${sources.length} illustrations`;
}

async function resolveLayoutSource(
  projectId: string,
  source: LayoutSourceRef
): Promise<ResolvedLayoutSource | null> {
  if (source.replaceAssetId) {
    const asset = await prisma.imageAsset.findFirst({
      where: { id: source.replaceAssetId, projectId, type: { in: [...INTERIOR_ASSET_TYPES] } },
      select: { id: true, page: true }
    });
    return asset?.page ? { kind: "asset", assetId: asset.id, page: asset.page as PageRow } : null;
  }
  const marker = source.replaceMarker;
  if (!marker) {
    return null;
  }
  const page = await prisma.page.findFirst({
    where: { projectId, markdown: { contains: marker } }
  });
  return page ? { kind: "markdown", marker, page: page as PageRow } : null;
}

async function resolveLayoutDest(projectId: string, dest: LayoutDestRef | undefined): Promise<PageRow | null> {
  if (!dest) {
    return null;
  }
  if (dest.placement === "end_of_book") {
    return (await prisma.page.findFirst({
      where: { projectId },
      orderBy: { index: "desc" }
    })) as PageRow | null;
  }
  return (await prisma.page.findFirst({
    where: { projectId, index: dest.pageIndex }
  })) as PageRow | null;
}

/**
 * A layout edit that found nothing to do. It is APPLIED rather than FAILED —
 * nothing broke, and failing it would mark a finished book FAILED and refund it
 * — but the queued chat reply already promised the reader a change, so the
 * reason is recorded for the card to say. That is the only surface that can:
 * this process never writes chat messages.
 *
 * `layoutMissing` also switches `operationCanUndo` off, because there are no
 * snapshots here and an Undo would revert the previous edit instead.
 */
async function markLayoutSkipped(
  projectId: string,
  operationId: string,
  fallbackStatus: "COMPLETE" | "REVIEW_REQUIRED",
  reason: LayoutSkipReason = "missing"
): Promise<void> {
  const row = await prisma.bookEditOperation.findUnique({
    where: { id: operationId },
    select: { classifier: true }
  });
  await prisma.bookEditOperation.update({
    where: { id: operationId },
    data: {
      status: "APPLIED",
      appliedAt: new Date(),
      affectedPageIndexes: [],
      classifier: {
        ...(row && typeof row.classifier === "object" && row.classifier !== null ? row.classifier : {}),
        layoutMissing: true,
        layoutSkippedReason: reason
      }
    }
  });
  await prisma.project.updateMany({
    where: { id: projectId, status: "EDITING" },
    data: { status: fallbackStatus }
  });
}

async function replayAppliedLayout(projectId: string, planId: string | undefined, classifier: unknown): Promise<void> {
  if (
    classifier &&
    typeof classifier === "object" &&
    classifier !== null &&
    (classifier as { layoutMissing?: unknown }).layoutMissing === true
  ) {
    return;
  }
  const project = await getProjectOrThrow(projectId);
  const compilePlanId = planId ?? project.currentPlanId;
  if (!compilePlanId) {
    return;
  }
  const fallbackStatus = project.status === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "COMPLETE";
  await refreshExports(projectId, compilePlanId, fallbackStatus);
}

async function refreshExports(
  projectId: string,
  planVersionId: string,
  fallbackStatus: "COMPLETE" | "REVIEW_REQUIRED"
): Promise<void> {
  await invalidateProjectExports(projectId);
  let dispatched: Awaited<ReturnType<typeof maybeEnqueueCompile>>;
  try {
    dispatched = await maybeEnqueueCompile(projectId, planVersionId, {
      skipFinalReview: true,
      withoutQualityVerdict: true
    });
  } catch (error) {
    console.error(`Failed to enqueue the export refresh for layout-edited project ${projectId}:`, error);
    dispatched = "not-ready";
  }
  if (dispatched === "not-ready") {
    await prisma.project
      .updateMany({ where: { id: projectId, status: "EDITING" }, data: { status: fallbackStatus } })
      .catch(() => undefined);
  }
}

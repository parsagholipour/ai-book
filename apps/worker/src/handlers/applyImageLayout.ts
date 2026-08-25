import { getProjectOrThrow, invalidateProjectExports } from "../generation/bookHelpers.js";
import {
  claimAppliedEditPublication,
  restoreEditProjectStatus
} from "../generation/editProjectStatus.js";
import { claimEditOperationForDelivery } from "../generation/editOperationDelivery.js";
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
import { jsonRecord, preEditProjectStatus, type SettledProjectStatus } from "@book-maker/core";
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

/**
 * The layout edit as the operation's own classifier holds it.
 *
 * `applyBookEdit` forks here on the operation's `kind`, never on this payload
 * field, so a job whose `imageLayout` was rebuilt away — a hand requeue, a
 * reconciler, a future trim — still arrives, and the Apply wrote the resolved
 * intent onto the classifier in the same transaction that created the row. That
 * copy is a different shape rather than the same one: the intent names its
 * pictures as `targets` (an asset id, or a marker the picture's markdown line
 * carries, or the operation id that marker is built from) and its destination as
 * three flat fields, so this translates rather than casts. The marker rule is
 * `resolveStoredLayoutTarget`'s (`apps/api/src/mobile/imageLayoutTargets.ts`) —
 * the two have to agree about what a stored target means or a redelivery would
 * act on a different picture than the card named.
 *
 * `null` means there is no usable request on either copy, which the caller
 * settles as a delivered no-op: a move or a remove is free, so there is nothing
 * to refund and nothing a retry could find.
 */
export function layoutPayloadFromClassifier(classifier: unknown): ImageLayoutPayload | null {
  const layout = jsonRecord(jsonRecord(classifier).imageLayout);
  const action = layout.action === "move" || layout.action === "remove" ? layout.action : null;
  if (!action) {
    return null;
  }
  const targets = Array.isArray(layout.targets) ? layout.targets : [];
  const sources = targets.flatMap((entry): LayoutSourceRef[] => {
    const target = jsonRecord(entry);
    const pageIndex = typeof target.pageIndex === "number" ? target.pageIndex : null;
    if (pageIndex === null) {
      return [];
    }
    if (typeof target.assetId === "string" && target.assetId) {
      return [{ pageIndex, replaceAssetId: target.assetId }];
    }
    const marker =
      typeof target.marker === "string" && target.marker
        ? target.marker
        : typeof target.operationId === "string" && target.operationId
          ? `chat-image-${target.operationId}`
          : null;
    return marker ? [{ pageIndex, replaceMarker: marker }] : [];
  });
  if (sources.length === 0) {
    return null;
  }
  const dest = layoutDestFromClassifier(layout);
  return { action, sources, ...(dest ? { dest } : {}) };
}

/**
 * The stored intent's three destination fields as the one the resolver reads.
 *
 * `end_of_book` carries no page index on the intent and needs none here either:
 * `resolveLayoutDest` re-reads the book's last page for that placement, which is
 * the whole point of the placement. A move with no resolvable destination
 * answers `null`, and the resolver refuses the edit exactly as it does for a
 * destination page that has since gone.
 */
function layoutDestFromClassifier(layout: Record<string, unknown>): LayoutDestRef | null {
  const position = layout.destPosition === "top" || layout.destPosition === "bottom" ? layout.destPosition : null;
  if (layout.destPlacement === "end_of_book") {
    return { placement: "end_of_book", pageIndex: 0, ...(position ? { position } : {}) };
  }
  if (layout.destPlacement === "page" && typeof layout.destPageIndex === "number") {
    return { placement: "page", pageIndex: layout.destPageIndex, ...(position ? { position } : {}) };
  }
  return null;
}

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
    /** Optional: the fork that routes a job here tests the operation's `kind`, not this field. */
    imageLayout?: ImageLayoutPayload;
  };
  const generationJobId = job.data.generationJobId as string | undefined;
  // Read once from the queue-time stamp. The project row already says EDITING
  // before either a first delivery or an APPLIED redelivery reaches this fork.
  const fallbackStatus = preEditProjectStatus(job.data);

  if (operation.status === "APPLIED") {
    await replayAppliedLayout(projectId, operationId, planId, operation.classifier, fallbackStatus);
    return;
  }

  const delivery = await claimEditOperationForDelivery(operationId);
  if (delivery.outcome === "replay") {
    await replayAppliedLayout(projectId, operationId, planId, delivery.stored.classifier, fallbackStatus);
    return;
  }
  if (delivery.outcome === "settled") {
    return;
  }
  const prior = await prisma.project.findUnique({
    where: { id: projectId },
    select: { currentPlanId: true }
  });
  await prisma.project.update({ where: { id: projectId }, data: { status: "EDITING" } });
  await advanceJobStep(generationJobId, "prepare", 20, "Preparing the illustration change");

  // The payload's copy first, the classifier's second — the same order and the
  // same reason as `restructurePages`: the fork above is the operation's `kind`,
  // so a job whose payload lost `imageLayout` still lands here.
  const layout = imageLayout ?? layoutPayloadFromClassifier(operation.classifier);
  if (!layout) {
    // Neither copy survived. There is no picture to act on and no retry that
    // could find one, so it settles the way a vanished picture does: APPLIED
    // with nothing done and the book put back where it was found. Nothing to
    // refund — a move and a remove are both free.
    console.error(
      `Image layout edit ${operationId} on project ${projectId} carries no request on its payload or its classifier`
    );
    await markLayoutSkipped(projectId, operationId, fallbackStatus);
    return;
  }

  const payloadSources = layout.sources ?? (layout.source ? [layout.source] : []);
  const sources = (await Promise.all(payloadSources.map((source) => resolveLayoutSource(projectId, source)))).filter(
    (source): source is ResolvedLayoutSource => source !== null
  );
  const dest = layout.action === "move" ? await resolveLayoutDest(projectId, layout.dest) : null;
  if (sources.length === 0 || (layout.action === "move" && !dest)) {
    await markLayoutSkipped(projectId, operationId, fallbackStatus);
    return;
  }

  await advanceJobStep(generationJobId, "snapshot", 35, snapshotStepLabel(sources));
  await advanceJobStep(generationJobId, "apply", 50, applyStepLabel(layout, sources, dest));

  let applied: boolean;
  let skipReason: LayoutSkipReason | null = null;
  try {
    applied = await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: projectId },
        data: { contentRevision: { increment: 0 } }
      });
      const claimed = await tx.bookEditOperation.updateMany({
        where: { id: operationId, status: { in: ["QUEUED", "ACTIVE"] } },
        data: { automaticRetryCount: { increment: 0 } }
      });
      if (claimed.count !== 1) {
        return false;
      }
      const language = (await tx.project.findUnique({ where: { id: projectId }, select: { language: true } }))?.language;
      const batch = await applyLayoutBatchInTx(tx, {
        projectId,
        operationId,
        action: layout.action,
        sources,
        dest,
        ...(layout.dest?.position ? { destPosition: layout.dest.position } : {}),
        ...(language ? { language } : {})
      });
      if (batch.empty) {
        throw new LayoutUnavailableError(batch.allAlreadyPositioned ? "already_positioned" : "missing");
      }
      const row = await tx.bookEditOperation.findUnique({
        where: { id: operationId },
        select: { classifier: true }
      });
      const published = await tx.project.update({
        where: { id: projectId },
        data: { contentRevision: { increment: 1 } },
        select: { contentRevision: true }
      });
      await tx.bookEditOperation.update({
        where: { id: operationId },
        data: {
          status: "APPLIED",
          publicationRevision: published.contentRevision,
          appliedAt: new Date(),
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
    // Both deliveries may have passed the ACTIVE fence and written EDITING
    // before one wins the transactional APPLIED claim. Replay that winner's
    // idempotent export/status tail so this loser cannot overwrite an earlier
    // fallback restoration and leave the project stranded in EDITING.
    const settled = await prisma.bookEditOperation.findUnique({ where: { id: operationId } });
    if (settled?.status === "APPLIED") {
      await replayAppliedLayout(projectId, operationId, planId, settled.classifier, fallbackStatus);
    }
    // CANCELED (or any non-APPLIED outcome) belongs to the actor that settled
    // it; this delivery must neither mutate pages nor change that settlement.
    return;
  }
  try {
    await advanceJobStep(generationJobId, "export", 85, "Refreshing exports");
  } catch {
    // Progress display only.
  }
  const compilePlanId = planId ?? prior?.currentPlanId;
  if (!compilePlanId) {
    await restoreLayoutStatus(projectId, operationId, fallbackStatus);
    return;
  }
  await refreshExports(projectId, compilePlanId, operationId, fallbackStatus);
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
  fallbackStatus: SettledProjectStatus,
  reason: LayoutSkipReason = "missing"
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const restored = await restoreEditProjectStatus(
      tx,
      projectId,
      operationId,
      fallbackStatus,
      "ACTIVE"
    );
    if (!restored) return;
    const row = await tx.bookEditOperation.findUnique({
      where: { id: operationId },
      select: { classifier: true }
    });
    await tx.bookEditOperation.update({
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
  });
}

async function replayAppliedLayout(
  projectId: string,
  operationId: string,
  planId: string | undefined,
  classifier: unknown,
  fallbackStatus: SettledProjectStatus
): Promise<void> {
  if (
    classifier &&
    typeof classifier === "object" &&
    classifier !== null &&
    (classifier as { layoutMissing?: unknown }).layoutMissing === true
  ) {
    await restoreLayoutStatus(projectId, operationId, fallbackStatus, "APPLIED_NOOP");
    return;
  }
  const project = await getProjectOrThrow(projectId);
  const compilePlanId = planId ?? project.currentPlanId;
  if (!compilePlanId) {
    await restoreLayoutStatus(projectId, operationId, fallbackStatus);
    return;
  }
  await refreshExports(projectId, compilePlanId, operationId, fallbackStatus);
}

async function refreshExports(
  projectId: string,
  planVersionId: string,
  operationId: string,
  fallbackStatus: SettledProjectStatus
): Promise<void> {
  const claimed = await prisma.$transaction(async (tx) => {
    if (!(await claimAppliedEditPublication(tx, projectId, operationId, fallbackStatus))) {
      return false;
    }
    await invalidateProjectExports(projectId);
    return true;
  });
  if (!claimed) return;
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
    await restoreLayoutStatus(projectId, operationId, fallbackStatus);
  }
}

async function restoreLayoutStatus(
  projectId: string,
  operationId: string,
  fallbackStatus: SettledProjectStatus,
  phase: "APPLIED" | "APPLIED_NOOP" = "APPLIED"
): Promise<void> {
  await prisma
    .$transaction((tx) => restoreEditProjectStatus(tx, projectId, operationId, fallbackStatus, phase))
    .catch(() => undefined);
}

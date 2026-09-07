import { bookPlanSchema, withImageRenderProvenance } from "@book-maker/core";
import { PAGE_RESTRUCTURE_TRANSACTION_OPTIONS, Prisma, prisma } from "@book-maker/db";

import { type BookEditIntent } from "../bookEditIntent.js";
import {
  bookEditRedoCandidate,
  canRedoBookEdit,
  classifierAfterRedo,
  hasRedoableAfterState,
  pickRedoableBookEdit,
  snapshotHasAfter,
  storyDeltaAfterToRestore
} from "./bookEditRedo.js";
import { type MobileProjectChatMessageRecord } from "./dto.js";
import {
  demotedImageAssetsFromClassifier,
  previousImageAssetsFromClassifier,
  type PreviousImageAssetRecord
} from "./imageEditRecords.js";
import { UNDOABLE_EDIT_KINDS, queueUserEditExportRecompile } from "./manualEdits.js";
import { createAssistantChatMessage, type ProjectForChat } from "./projectChat.js";
import { rebuildStoryStateAfterUndo } from "./rebuildStoryState.js";
import { jsonInputValue } from "./support.js";

/**
 * Restores the after-snapshots of the most recently undone snapshot-backed
 * edit, then queues an export refresh. Free: nothing is regenerated.
 *
 * Structural-only undos are not candidates — see `hasBookEditRedoRecord`.
 */
export async function redoLastBookEdit(
  project: ProjectForChat,
  intent: BookEditIntent,
  parentId: string
): Promise<MobileProjectChatMessageRecord> {
  const recentOperations = await prisma.bookEditOperation.findMany({
    where: {
      projectId: project.id,
      status: "APPLIED",
      kind: { in: [...UNDOABLE_EDIT_KINDS] }
    },
    orderBy: [{ appliedAt: "desc" }, { createdAt: "desc" }],
    take: 20,
    include: {
      snapshots: true,
      _count: { select: { archivedSnapshots: true } }
    }
  });
  const candidates = recentOperations.map((operation) => bookEditRedoCandidate(operation));
  const picked = pickRedoableBookEdit(candidates);
  const operation = picked
    ? recentOperations.find((candidate) => candidate.id === picked.id)
    : undefined;
  if (!operation) {
    return nothingToRedoReply(project.id, parentId, intent);
  }

  const fallbackStatus = project.status === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "COMPLETE";
  const redone = await prisma.$transaction(async (tx) => {
    const claimed = await tx.bookEditOperation.updateMany({
      where: { id: operation.id, status: "APPLIED" },
      data: { status: "APPLIED" }
    });
    const held =
      claimed.count === 0
        ? null
        : await tx.bookEditOperation.findUnique({
            where: { id: operation.id },
            select: { classifier: true }
          });
    if (
      !held ||
      !canRedoBookEdit({
        status: "APPLIED",
        kind: operation.kind,
        classifier: held.classifier,
        snapshotCount: operation.snapshots.length,
        archivedSnapshotCount: operation._count?.archivedSnapshots ?? 0
      })
    ) {
      return null;
    }
    const later = await tx.bookEditOperation.findMany({
      where: {
        projectId: project.id,
        status: "APPLIED",
        kind: { in: [...UNDOABLE_EDIT_KINDS] },
        id: { not: operation.id }
      },
      select: {
        id: true,
        status: true,
        kind: true,
        classifier: true,
        appliedAt: true,
        createdAt: true,
        _count: { select: { snapshots: true, archivedSnapshots: true } }
      }
    });
    const stillPicked = pickRedoableBookEdit([
      bookEditRedoCandidate({
        id: operation.id,
        status: "APPLIED",
        kind: operation.kind,
        classifier: held.classifier,
        snapshots: operation.snapshots,
        _count: { archivedSnapshots: operation._count?.archivedSnapshots ?? 0 },
        appliedAt: operation.appliedAt,
        createdAt: operation.createdAt
      }),
      ...later.map((row) => bookEditRedoCandidate(row))
    ]);
    if (stillPicked?.id !== operation.id) {
      return null;
    }
    if (!hasRedoableAfterState(operation.snapshots, held.classifier)) {
      return null;
    }
    const previousAssets = previousImageAssetsFromClassifier(held.classifier);
    const demotedAssets = demotedImageAssetsFromClassifier(held.classifier);
    const restoredPageIndexes: number[] = [];
    const editRevision = project.currentPlanId
      ? await tx.project.update({
          where: { id: project.id },
          data: { status: "EDITING", contentRevision: { increment: 1 } },
          select: { contentRevision: true }
        })
      : null;
    for (const snapshot of operation.snapshots) {
      if (!snapshotHasAfter(snapshot)) {
        continue;
      }
      const imagePrompt = imagePromptToRedo(snapshot.pageId, previousAssets);
      // Legacy undos never stamped; inventing an after would fold a book
      // Redo never saw.
      const storyDelta = storyDeltaAfterToRestore(held.classifier, snapshot.pageId);
      await tx.page.update({
        where: { id: snapshot.pageId },
        data: {
          title: snapshot.titleAfter ?? snapshot.titleBefore,
          markdown: snapshot.markdownAfter ?? snapshot.markdownBefore,
          summary: snapshot.summaryAfter ?? snapshot.summaryBefore,
          status: "COMPLETED",
          revision: { increment: 1 },
          ...(imagePrompt !== undefined ? { imagePrompt } : {}),
          ...(storyDelta !== undefined ? { storyDelta } : {})
        }
      });
      restoredPageIndexes.push(snapshot.pageIndex);
    }
    const liveMetadata = await liveMetadataForRestore(
      tx,
      project.id,
      previousAssets.filter((asset) => asset.afterPath).map((asset) => asset.id)
    );
    for (const asset of previousAssets) {
      await tx.imageAsset.updateMany({
        where: { id: asset.id, projectId: project.id },
        data: imageAssetRedoWrite(asset, liveMetadata)
      });
    }
    // Undo put the dest hero back on the page. The moved picture is already
    // on dest above; leaving this hero linked gives the page two. Path and
    // prompt stay — a demotion never redrew them.
    for (const asset of demotedAssets) {
      await tx.imageAsset.updateMany({
        where: { id: asset.id, projectId: project.id },
        data: { pageId: null }
      });
    }
    await tx.bookEditOperation.update({
      where: { id: operation.id },
      data: {
        classifier: jsonInputValue(classifierAfterRedo(held.classifier))
      }
    });
    return {
      contentRevision: editRevision?.contentRevision ?? null,
      restoredPageIndexes
    };
  }, PAGE_RESTRUCTURE_TRANSACTION_OPTIONS);
  if (!redone) {
    return nothingToRedoReply(project.id, parentId, intent);
  }
  const { contentRevision, restoredPageIndexes } = redone;
  restoredPageIndexes.sort((a, b) => a - b);
  try {
    const parsed = bookPlanSchema.safeParse(project.currentPlan?.planningPackage);
    await rebuildStoryStateAfterUndo(project.id, parsed.success ? parsed.data.promises ?? [] : []);
  } catch (error) {
    console.warn(`Story state rebuild after redo skipped for project ${project.id}`, error);
  }

  if (contentRevision !== null) {
    if (project.currentPlanId) {
      await queueUserEditExportRecompile(project.id, project.currentPlanId, fallbackStatus, {
        contentRevision
      });
    } else {
      await prisma.project
        .updateMany({
          where: { id: project.id, status: "EDITING", contentRevision },
          data: { status: fallbackStatus }
        })
        .catch(() => undefined);
    }
  }

  return createAssistantChatMessage({
    projectId: project.id,
    parentId,
    operationId: operation.id,
    content: redoConfirmation(operation.request, restoredPageIndexes),
    metadata: {
      intent,
      charged: false,
      redo: { operationId: operation.id, restoredPageIndexes }
    }
  });
}

function nothingToRedoReply(
  projectId: string,
  parentId: string,
  intent: BookEditIntent
): Promise<MobileProjectChatMessageRecord> {
  return createAssistantChatMessage({
    projectId,
    parentId,
    content: "There’s no undone edit I can put back on this book.",
    metadata: { intent, charged: false }
  });
}

function redoConfirmation(request: string, restoredPageIndexes: number[]): string {
  const restored =
    restoredPageIndexes.length === 0
      ? "put that edit back"
      : restoredPageIndexes.length === 1
        ? `put page ${restoredPageIndexes[0]} back`
        : `put pages ${restoredPageIndexes.join(", ")} back`;
  return `I ${restored} to redo “${request.slice(0, 120)}”. I’m rebuilding your book now. Redo is free.`;
}

async function liveMetadataForRestore(
  tx: Pick<Prisma.TransactionClient, "imageAsset">,
  projectId: string,
  ids: readonly string[]
): Promise<Map<string, unknown>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await tx.imageAsset.findMany({
    where: { id: { in: [...ids] }, projectId },
    select: { id: true, metadata: true }
  });
  return new Map(rows.map((row) => [row.id, row.metadata]));
}

/**
 * Invert of what Undo wrote for `previousAssets`.
 *
 * `afterPath` is a replacement: the new bytes go back, and the redraw's
 * provenance is cleared when Undo had nothing of its own to restore.
 * `destPageId` is a move. Neither is a remove, so the picture leaves the page.
 */
function imageAssetRedoWrite(
  asset: PreviousImageAssetRecord,
  liveMetadata: Map<string, unknown>
): {
  path?: string;
  pageId: string | null;
  metadata?: Prisma.InputJsonValue;
} {
  if (asset.afterPath) {
    return {
      path: asset.afterPath,
      pageId: asset.destPageId ?? asset.pageId,
      ...(liveMetadata.has(asset.id)
        ? {
            metadata: withImageRenderProvenance(liveMetadata.get(asset.id), {}) as Prisma.InputJsonValue
          }
        : {})
    };
  }
  if (asset.destPageId) {
    return { pageId: asset.destPageId };
  }
  return { pageId: null };
}

/**
 * The `imagePrompt` after a picture edit is put back.
 *
 * A move took the picture off the source and wrote its prompt onto dest.
 * Undo restored dest's old hero prompt; leaving dest alone here keeps that
 * undone prompt over the picture Redo just put back. A remove still clears
 * the page. A replacement leaves the prompt alone — we do not store the
 * after prompt.
 */
function imagePromptToRedo(
  pageId: string,
  previousAssets: PreviousImageAssetRecord[]
): string | null | undefined {
  const movedAway = previousAssets.find((asset) => asset.pageId === pageId && asset.destPageId);
  if (movedAway) {
    return null;
  }
  const movedOnto = previousAssets.find((asset) => asset.destPageId === pageId);
  if (movedOnto) {
    return movedOnto.prompt;
  }
  const removed = previousAssets.find(
    (asset) => asset.pageId === pageId && !asset.afterPath && !asset.destPageId
  );
  return removed ? null : undefined;
}

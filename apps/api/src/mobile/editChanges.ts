import { diffProse, proseChanged } from "@book-maker/core";
import { prisma } from "@book-maker/db";

import { type MobileEditChangesDto, type MobileEditPageChangeDto } from "./dto.js";
import { jsonRecord } from "./support.js";

/**
 * The before/after record of one applied edit, read back for review.
 *
 * Every page an edit touches is snapshotted with its text on both sides — the
 * rows undo restores from. Nothing extra is stored to support this view; it is
 * the same snapshots, diffed instead of replayed.
 */
export type EditSnapshotRecord = {
  pageIndex: number;
  titleBefore: string;
  markdownBefore: string;
  titleAfter: string | null;
  markdownAfter: string | null;
};

export type EditChangesOperationRecord = {
  id: string;
  kind: string;
  status: string;
  request: string;
  creditsCharged: number;
  classifier: unknown;
  appliedAt: Date | null;
  snapshots: EditSnapshotRecord[];
};

export async function loadEditChanges(
  projectId: string,
  operationId: string
): Promise<MobileEditChangesDto | null> {
  const operation = (await prisma.bookEditOperation.findFirst({
    where: { id: operationId, projectId },
    include: {
      snapshots: {
        orderBy: { pageIndex: "asc" },
        select: { pageIndex: true, titleBefore: true, markdownBefore: true, titleAfter: true, markdownAfter: true }
      }
    }
  })) as EditChangesOperationRecord | null;
  if (!operation) {
    return null;
  }
  return serializeEditChanges(operation);
}

export function serializeEditChanges(operation: EditChangesOperationRecord): MobileEditChangesDto {
  const pages = operation.snapshots
    // A snapshot with no "after" is an edit that was rolled back before it wrote
    // anything, or one still mid-flight. There is no change to show yet.
    .filter((snapshot) => snapshot.markdownAfter !== null)
    .map((snapshot) => pageChange(snapshot))
    .filter((page) => page.titleChanged || page.addedWords > 0 || page.removedWords > 0);

  return {
    operationId: operation.id,
    kind: operation.kind.toLowerCase() as MobileEditChangesDto["kind"],
    status: operation.status.toLowerCase() as MobileEditChangesDto["status"],
    request: operation.request,
    creditsCharged: operation.creditsCharged,
    appliedAt: operation.appliedAt?.toISOString() ?? null,
    undone: jsonRecord(operation.classifier).undoneAt !== undefined,
    pages,
    addedWords: pages.reduce((total, page) => total + page.addedWords, 0),
    removedWords: pages.reduce((total, page) => total + page.removedWords, 0)
  };
}

function pageChange(snapshot: EditSnapshotRecord): MobileEditPageChangeDto {
  const titleAfter = snapshot.titleAfter ?? snapshot.titleBefore;
  const diff = diffProse(snapshot.markdownBefore, snapshot.markdownAfter ?? snapshot.markdownBefore);
  return {
    pageIndex: snapshot.pageIndex,
    titleBefore: snapshot.titleBefore,
    titleAfter,
    titleChanged: proseChanged(snapshot.titleBefore, titleAfter),
    blocks: diff.blocks,
    addedWords: diff.addedWords,
    removedWords: diff.removedWords
  };
}

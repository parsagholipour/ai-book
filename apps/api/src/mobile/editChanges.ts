import { diffProse, proseChanged } from "@book-maker/core";
import { prisma } from "@book-maker/db";

import { type MobileEditChangesDto, type MobileEditPageChangeDto } from "./dto.js";
import { jsonRecord } from "./support.js";

/**
 * The before/after record of one applied edit, read back for review.
 *
 * Every page an edit touches is snapshotted with its text on both sides — the
 * rows undo restores from. Illustration replacements that leave markdown
 * unchanged still write a snapshot (so undo can restore the ImageAsset); they
 * are kept in this view via `classifier.previousAsset` rather than a word diff.
 */
export type EditSnapshotRecord = {
  pageId?: string;
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
        select: {
          pageId: true,
          pageIndex: true,
          titleBefore: true,
          markdownBefore: true,
          titleAfter: true,
          markdownAfter: true
        }
      }
    }
  })) as EditChangesOperationRecord | null;
  if (!operation) {
    return null;
  }
  const swap = illustrationChangesFromClassifier(operation);
  let afterPath = swap.find((change) => change.afterPath)?.afterPath;
  if (operation.kind !== "REMOVE_IMAGE" && operation.kind !== "MOVE_IMAGE" && swap[0] && !afterPath) {
    const live = await prisma.imageAsset.findUnique({
      where: { id: swap[0].assetId },
      select: { path: true, projectId: true }
    });
    if (live && live.projectId === projectId && typeof live.path === "string") {
      afterPath = live.path;
    }
  }
  return afterPath ? serializeEditChanges(operation, afterPath) : serializeEditChanges(operation);
}

export function serializeEditChanges(
  operation: EditChangesOperationRecord,
  illustrationAfterPath?: string
): MobileEditChangesDto {
  const changes = illustrationChangesFromClassifier(operation, illustrationAfterPath);
  const written = operation.snapshots.filter((snapshot) => snapshot.markdownAfter !== null);
  const pages = written
    .map((snapshot) => pageChange(snapshot, changes, written.length))
    .filter(
      (page) =>
        page.titleChanged || page.addedWords > 0 || page.removedWords > 0 || page.illustrationChanged
    );

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

function pageChange(
  snapshot: EditSnapshotRecord,
  changes: IllustrationChange[],
  writtenCount: number
): MobileEditPageChangeDto {
  const titleAfter = snapshot.titleAfter ?? snapshot.titleBefore;
  const diff = diffProse(snapshot.markdownBefore, snapshot.markdownAfter ?? snapshot.markdownBefore);
  const change = matchesIllustrationChange(snapshot, changes, writtenCount);
  const illustrationChanged = change !== null;
  return {
    pageIndex: snapshot.pageIndex,
    titleBefore: snapshot.titleBefore,
    titleAfter,
    titleChanged: proseChanged(snapshot.titleBefore, titleAfter),
    blocks: diff.blocks,
    addedWords: diff.addedWords,
    removedWords: diff.removedWords,
    illustrationChanged,
    ...(illustrationChanged && change?.before ? { illustrationBefore: change.before } : {}),
    ...(illustrationChanged && change?.after ? { illustrationAfter: change.after } : {})
  };
}

type IllustrationChange = {
  assetId: string;
  pageId: string;
  before: string | null;
  after: string | null;
  afterPath?: string;
};

function illustrationChangesFromClassifier(
  operation: Pick<EditChangesOperationRecord, "kind" | "classifier">,
  afterPathFallback?: string
): IllustrationChange[] {
  const stored = jsonRecord(jsonRecord(operation.classifier).previousAsset);
  if (
    typeof stored.id !== "string" ||
    !stored.id ||
    typeof stored.pageId !== "string" ||
    !stored.pageId ||
    typeof stored.path !== "string" ||
    !stored.path
  ) {
    return [];
  }
  const before = illustrationPublicPath(stored.path);
  if (operation.kind === "REMOVE_IMAGE") {
    return [{ assetId: stored.id, pageId: stored.pageId, before, after: null }];
  }
  if (operation.kind === "MOVE_IMAGE") {
    const destPageId = typeof stored.destPageId === "string" ? stored.destPageId : undefined;
    const demoted = jsonRecord(jsonRecord(operation.classifier).demotedAsset);
    const demotedBefore =
      typeof demoted.path === "string" ? illustrationPublicPath(demoted.path) : null;
    return [
      { assetId: stored.id, pageId: stored.pageId, before, after: null },
      ...(destPageId
        ? [{ assetId: stored.id, pageId: destPageId, before: demotedBefore, after: before }]
        : [])
    ];
  }
  const afterPath =
    typeof stored.afterPath === "string" && stored.afterPath
      ? stored.afterPath
      : afterPathFallback;
  return [
    {
      assetId: stored.id,
      pageId: stored.pageId,
      before,
      after: afterPath ? illustrationPublicPath(afterPath) : null,
      ...(afterPath ? { afterPath } : {})
    }
  ];
}

function matchesIllustrationChange(
  snapshot: EditSnapshotRecord,
  changes: IllustrationChange[],
  writtenCount: number
): IllustrationChange | null {
  if (changes.length === 0) {
    return null;
  }
  if (snapshot.pageId) {
    return changes.find((change) => change.pageId === snapshot.pageId) ?? null;
  }
  return writtenCount === 1 ? (changes[0] ?? null) : null;
}

/** Client-relative `/assets/images/...` so the app can resolve it against its API host. */
function illustrationPublicPath(path: string): string | null {
  try {
    if (path.startsWith("/assets/images/")) {
      return path.split(/[?#]/)[0] ?? null;
    }
    const url = new URL(path);
    if (url.pathname.startsWith("/assets/images/")) {
      return url.pathname;
    }
  } catch {
    const match = path.match(/\/assets\/images\/[^\s?#)]+/);
    return match?.[0] ?? null;
  }
  return null;
}

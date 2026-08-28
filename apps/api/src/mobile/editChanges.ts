import {
  assetsImagePathFrom,
  diffProse,
  parseStructuralApplication,
  proseChanged,
  structuralEditFromClassifier,
  type StructuralApplication,
  type StructuralPageEdit
} from "@book-maker/core";
import { prisma } from "@book-maker/db";

import { type MobileEditChangesDto, type MobileEditPageChangeDto } from "./dto.js";
import { demotedImageAssetsFromClassifier, previousImageAssetsFromClassifier } from "./imageEditRecords.js";
import { jsonRecord } from "./support.js";

/**
 * The before/after record of one applied edit, read back for review.
 *
 * Every page an edit *rewrites* is snapshotted with its text on both sides —
 * the rows undo restores from. Illustration replacements that leave markdown
 * unchanged still write a snapshot (so undo can restore the ImageAsset); they
 * are kept in this view via `classifier.previousAsset` rather than a word diff.
 *
 * A structural edit is the one kind that snapshots nothing, because it rewrites
 * nothing — its pages are read back off its stamp instead, see
 * `structuralPageChanges`.
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
  const structural = parseStructuralApplication(operation.classifier);
  if (structural) {
    // A structural edit has no illustration swap to resolve either — the layout
    // forks are what write `previousAssets` — so it settles here with the pages
    // its own record can answer for.
    return serializeEditChanges(
      operation,
      undefined,
      await structuralPageChanges(projectId, structural, structuralEditFromClassifier(operation.classifier))
    );
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
  illustrationAfterPath?: string,
  structuralPages?: MobileEditPageChangeDto[]
): MobileEditChangesDto {
  const changes = illustrationChangesFromClassifier(operation, illustrationAfterPath);
  const written = operation.snapshots.filter((snapshot) => snapshot.markdownAfter !== null);
  // A structural edit's pages come whole rather than filtered: a page that
  // arrived or left *is* the change, and the test below asks what a page's text
  // did — which for a moved page is nothing at all.
  const pages =
    structuralPages ??
    written
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

/**
 * What a structural edit did, page by page, read off its stamp.
 *
 * It is the one kind that writes no `PageEditSnapshot` — it rewrote no page, and
 * a removed page's snapshot would cascade away with the page it describes — so
 * this view used to answer with two word totals and nothing else. That was
 * honest about the snapshots and useless to the reader: an insert's whole point
 * is the pages it added, and "+240 −0" is not those pages. Each of the three
 * actions has a record of its own instead:
 *
 * - **inserted** pages are `Page` rows the drafting pass wrote, so the text is
 *   read live and shown wholly added;
 * - **removed** pages ride the stamp whole (it is the undo record), so their
 *   text is shown wholly removed;
 * - **moved** pages kept every word, so they carry where they came from rather
 *   than a diff — and which pages moved is the *request's* `pageIndexes`, not a
 *   comparison of the orders: shifting one page down renumbers every page it
 *   passed, and none of those moved in any sense the reader means.
 *
 * An *undone* insert has no rows left — the revert deletes the pages it made —
 * so it lists nothing and the card says the edit was undone, which is the same
 * bargain the stamp already makes with a deleted page's semantic memory.
 */
async function structuralPageChanges(
  projectId: string,
  application: StructuralApplication,
  requested: StructuralPageEdit | null
): Promise<MobileEditPageChangeDto[]> {
  const pages = [
    ...(await insertedPageChanges(projectId, application)),
    ...removedPageChanges(application),
    ...(await movedPageChanges(projectId, application, requested))
  ];
  return pages.sort((left, right) => left.pageIndex - right.pageIndex);
}

async function insertedPageChanges(
  projectId: string,
  application: StructuralApplication
): Promise<MobileEditPageChangeDto[]> {
  if (application.insertedPageIds.length === 0) {
    return [];
  }
  // Whichever of them the book still holds: a later edit may have taken one
  // away, and `insertedPageIds` is a record of what this edit made rather than
  // of what is there now.
  const inserted = await prisma.page.findMany({
    where: { projectId, id: { in: application.insertedPageIds } },
    orderBy: { index: "asc" },
    select: { index: true, title: true, markdown: true }
  });
  return inserted.map((page) => structuralPageChange("added", page.index, page.title, "", page.markdown));
}

function removedPageChanges(application: StructuralApplication): MobileEditPageChangeDto[] {
  return [...application.removedPages]
    .sort((left, right) => left.index - right.index)
    .map((page) => structuralPageChange("removed", page.index, page.title, page.markdown, ""));
}

async function movedPageChanges(
  projectId: string,
  application: StructuralApplication,
  requested: StructuralPageEdit | null
): Promise<MobileEditPageChangeDto[]> {
  if (application.action !== "move" || !requested || requested.pageIndexes.length === 0) {
    return [];
  }
  const idAt = new Map(application.pageOrderBefore.map((entry) => [entry.index, entry.pageId]));
  const indexOf = new Map(application.pageOrderBefore.map((entry) => [entry.pageId, entry.index]));
  const movedIds = requested.pageIndexes
    .map((index) => idAt.get(index))
    .filter((pageId): pageId is string => pageId !== undefined);
  if (movedIds.length === 0) {
    return [];
  }
  const moved = await prisma.page.findMany({
    where: { projectId, id: { in: movedIds } },
    orderBy: { index: "asc" },
    select: { id: true, index: true, title: true }
  });
  return moved.flatMap((page) => {
    const before = indexOf.get(page.id);
    // A page the reader named that ended up where it started is not a change to
    // report, and neither is one the stamp cannot place.
    if (before === undefined || before === page.index) {
      return [];
    }
    return [structuralPageChange("moved", page.index, page.title, "", "", before)];
  });
}

/**
 * One structural page, diffed against the emptiness on its other side.
 *
 * `titleChanged` is false for all three: a page that arrived or left did not
 * have its heading *rewritten*, and rendering "" struck through beside the
 * title is a change nobody made.
 */
function structuralPageChange(
  structuralChange: "added" | "removed" | "moved",
  pageIndex: number,
  title: string,
  markdownBefore: string,
  markdownAfter: string,
  pageIndexBefore?: number
): MobileEditPageChangeDto {
  const diff = diffProse(markdownBefore, markdownAfter);
  return {
    pageIndex,
    titleBefore: title,
    titleAfter: title,
    titleChanged: false,
    blocks: diff.blocks,
    addedWords: diff.addedWords,
    removedWords: diff.removedWords,
    illustrationChanged: false,
    structuralChange,
    ...(pageIndexBefore === undefined ? {} : { pageIndexBefore })
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
  const previous = previousImageAssetsFromClassifier(operation.classifier);
  if (previous.length === 0) {
    return [];
  }
  if (operation.kind === "REMOVE_IMAGE") {
    // One entry per picture: a bulk remove reports every page it emptied.
    return previous.map((asset) => ({
      assetId: asset.id,
      pageId: asset.pageId,
      before: illustrationPublicPath(asset.path),
      after: null
    }));
  }
  if (operation.kind === "MOVE_IMAGE") {
    const demoted = demotedImageAssetsFromClassifier(operation.classifier);
    return previous.flatMap((asset) => {
      const before = illustrationPublicPath(asset.path);
      // A move within one page has the same picture on both sides of the same
      // page. Reporting it as a leave-and-arrive pair would render as two
      // changes on one page, one of them a removal that never happened.
      if (asset.destPageId && asset.destPageId === asset.pageId) {
        return [{ assetId: asset.id, pageId: asset.pageId, before, after: before }];
      }
      const demotedBefore = demoted.find((entry) => entry.pageId === asset.destPageId);
      return [
        { assetId: asset.id, pageId: asset.pageId, before, after: null },
        ...(asset.destPageId
          ? [
              {
                assetId: asset.id,
                pageId: asset.destPageId,
                before: demotedBefore ? illustrationPublicPath(demotedBefore.path) : null,
                after: before
              }
            ]
          : [])
      ];
    });
  }
  const first = previous[0];
  if (!first) {
    return [];
  }
  const afterPath = first.afterPath ?? afterPathFallback;
  return [
    {
      assetId: first.id,
      pageId: first.pageId,
      before: illustrationPublicPath(first.path),
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

/**
 * Client-relative `/assets/images/...` so the app can resolve it against its API
 * host. Shared with the worker's demote path through `assetsImagePathFrom`,
 * because a stored path carries whatever prefix `PUBLIC_API_URL` has and the
 * hand-rolled copy this replaced dropped the whole thumbnail for those.
 */
function illustrationPublicPath(path: string): string | null {
  return assetsImagePathFrom(path);
}

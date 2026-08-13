import { type ImageLayoutEdit, type ImageLayoutTarget } from "../bookEditImage.js";
import {
  listReplaceableBookImages,
  resolveReplaceableImage,
  type ReplaceableBookImage
} from "./addImageTargets.js";
import { chatChaptersForProject, type ProjectForChat } from "./projectChat.js";
import { prisma } from "@book-maker/db";

/**
 * Which pictures a move or remove is actually about.
 *
 * Two different questions, deliberately answered by two functions. The
 * *proposal* asks the book what it has — one picture, a chapter's worth, or all
 * of them — and puts the answer on the card. The *Apply* asks only about the
 * pictures that card named, one by one. It must not re-run the bulk query: the
 * card said "Remove all 7 illustrations", so 7 is what Apply removes, and a
 * picture added between the card and the tap is not swept into an edit the
 * reader never saw. That is the same rule the charged edits follow about never
 * going past the number they quoted.
 */

/** Why a scope resolved to no pictures. The card says a different thing for each. */
export type LayoutScopeMiss = "no_images" | "chapter_empty" | "chapter_unknown";

const INTERIOR_ASSET_TYPES = ["SCENE_ILLUSTRATION", "DIAGRAM"] as const;

/**
 * Every picture a proposal covers, in reading order.
 *
 * `listReplaceableBookImages` already returns exactly the set a reader means by
 * "all the pictures" — each page's illustration, then its in-page refs, then
 * chat-added ones, skipping undone ones — in compile order. Bulk is that list;
 * a chapter is that list filtered; a single picture is the existing resolver.
 */
export async function resolveLayoutTargetImages(options: {
  project: ProjectForChat;
  layout: Pick<ImageLayoutEdit, "selection" | "pageIndex">;
}): Promise<{ images: ReplaceableBookImage[]; miss: LayoutScopeMiss | null }> {
  const { project, layout } = options;
  const selection = layout.selection;

  if (!selection) {
    const single = await resolveReplaceableImage(project.id, layout.pageIndex);
    return single ? { images: [single], miss: null } : { images: [], miss: "no_images" };
  }

  const { readingOrder } = await listReplaceableBookImages(project.id);
  if (selection.kind === "all") {
    return readingOrder.length > 0
      ? { images: readingOrder, miss: null }
      : { images: [], miss: "no_images" };
  }

  // The chapter's pages come from the same mapping the router was given, so a
  // chapter the reader can see in the chat is the chapter resolved here.
  const chapter = chatChaptersForProject(project).find((entry) => entry.index === selection.chapterIndex);
  if (!chapter) {
    return { images: [], miss: "chapter_unknown" };
  }
  const inChapter = new Set(chapter.pageIndexes);
  const images = readingOrder.filter((image) => inChapter.has(image.pageIndex));
  return images.length > 0 ? { images, miss: null } : { images: [], miss: "chapter_empty" };
}

/** A picture the worker can find again, plus where it sits right now. */
export type QueuedLayoutImage = {
  pageIndex: number;
  image: ReplaceableBookImage;
} & ({ kind: "asset"; assetId: string; marker?: undefined } | { kind: "markdown"; marker: string; assetId?: undefined });

/**
 * Re-resolves the pictures a card named, dropping any that have gone since.
 *
 * Each target is looked up the way it was recorded — by asset id, or by the
 * marker its markdown line carries — so this reports on exactly the set the
 * reader confirmed and never widens it.
 */
export async function reresolveLayoutTargets(
  projectId: string,
  targets: ImageLayoutTarget[]
): Promise<{ live: QueuedLayoutImage[]; vanished: number }> {
  const live: QueuedLayoutImage[] = [];
  let vanished = 0;
  for (const target of targets) {
    const resolved = await resolveStoredLayoutTarget(projectId, target);
    if (resolved) {
      live.push(resolved);
    } else {
      vanished += 1;
    }
  }
  return { live, vanished };
}

/**
 * One stored target against the live book. A picture whose page moved is still
 * this picture — the page index is re-read rather than trusted, because the
 * card was written before whatever else the reader has done since.
 */
export async function resolveStoredLayoutTarget(
  projectId: string,
  target: ImageLayoutTarget
): Promise<QueuedLayoutImage | null> {
  if (target.assetId) {
    const asset = await prisma.imageAsset.findFirst({
      where: { id: target.assetId, projectId, type: { in: [...INTERIOR_ASSET_TYPES] } },
      select: { id: true, page: { select: { index: true } } }
    });
    if (!asset?.page) {
      return null;
    }
    return {
      kind: "asset",
      assetId: asset.id,
      pageIndex: asset.page.index,
      image: {
        kind: "asset",
        assetId: asset.id,
        pageIndex: asset.page.index,
        ...(target.oldSubject ? { oldSubject: target.oldSubject } : {})
      }
    };
  }
  const marker = target.marker ?? (target.operationId ? `chat-image-${target.operationId}` : undefined);
  if (!marker) {
    return null;
  }
  const page = await prisma.page.findFirst({
    where: { projectId, markdown: { contains: marker } },
    select: { index: true }
  });
  if (!page) {
    return null;
  }
  return {
    kind: "markdown",
    marker,
    pageIndex: page.index,
    image: {
      kind: "markdown",
      marker,
      operationId: target.operationId,
      pageIndex: page.index,
      ...(target.oldSubject ? { oldSubject: target.oldSubject } : {})
    }
  };
}

/** The reply when a scope names no picture. Free, and nothing was queued. */
export function layoutScopeMissReply(
  miss: LayoutScopeMiss,
  action: "move" | "remove",
  selection: ImageLayoutEdit["selection"]
): string {
  if (miss === "chapter_unknown") {
    const index = selection?.kind === "chapter" ? selection.chapterIndex : undefined;
    return `I couldn’t find chapter ${index ?? ""} in this book. Nothing was changed or charged.`.replace("  ", " ");
  }
  if (miss === "chapter_empty") {
    const index = selection?.kind === "chapter" ? selection.chapterIndex : undefined;
    return `There are no illustrations in chapter ${index ?? ""} to remove. Nothing was changed or charged.`.replace(
      "  ",
      " "
    );
  }
  return selection
    ? "This book has no illustrations to remove. Nothing was changed or charged."
    : `I couldn’t find an illustration in this book to ${action}. Nothing was changed or charged.`;
}

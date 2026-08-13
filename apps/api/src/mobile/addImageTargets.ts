import { type ImageInsertionEdit, type ImageLayoutTarget } from "../bookEditImage.js";
import { jsonRecord } from "./support.js";
import { imageMarkdownRe, resolveBookImageAsset } from "@book-maker/core";
import { prisma } from "@book-maker/db";

/**
 * Interior pictures the compiled book actually shows, in compile order:
 * each page's SCENE_ILLUSTRATION / DIAGRAM (injected above the prose), then
 * each in-page `![...](/assets/images/<thisProject>/...)` line.
 *
 * Chat-added pictures are found via their ADD_IMAGE marker (the same
 * findFirst the replacement tests stub) rather than by scanning markdown
 * alone, so a marker that is still on a page stays reachable even when the
 * page list used for other refs is empty.
 */

export type ReplaceableBookImage = {
  pageIndex: number;
  oldSubject?: string;
} & (
  | { kind: "asset"; assetId: string }
  | { kind: "markdown"; marker: string; operationId: string }
);

const INTERIOR_ASSET_TYPES = ["SCENE_ILLUSTRATION", "DIAGRAM"] as const;

function asRows<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function illustrationOnPage(pageIndex: number): string {
  return `the illustration on page ${pageIndex}`;
}

export function replaceEditFromTarget(target: ReplaceableBookImage): NonNullable<ImageInsertionEdit["replace"]> {
  if (target.kind === "asset") {
    return {
      operationId: "",
      assetId: target.assetId,
      ...(target.oldSubject ? { oldSubject: target.oldSubject } : {})
    };
  }
  return {
    operationId: target.operationId,
    ...(target.operationId ? {} : { marker: target.marker }),
    ...(target.oldSubject ? { oldSubject: target.oldSubject } : {})
  };
}

export function layoutTargetFromReplaceable(target: ReplaceableBookImage): ImageLayoutTarget {
  const replace = replaceEditFromTarget(target);
  return { ...replace, pageIndex: target.pageIndex };
}

/**
 * The picture a replacement request targets.
 *
 * A named page takes that page's first image (asset, then markdown). With no
 * page, the newest still-visible chat-added picture wins — that is the
 * "no, I actually want…" correction — and only then the first image in
 * reading order, which is how "change the first image" finds a built-in
 * illustration when the book has no chat-added ones.
 */
export async function resolveReplaceableImage(
  projectId: string,
  pageIndexHint?: number
): Promise<ReplaceableBookImage | null> {
  const { readingOrder, latestChat } = await listReplaceableBookImages(projectId);
  if (pageIndexHint !== undefined) {
    return readingOrder.find((image) => image.pageIndex === pageIndexHint) ?? null;
  }
  return latestChat ?? readingOrder[0] ?? null;
}

export async function listReplaceableBookImages(projectId: string): Promise<{
  readingOrder: ReplaceableBookImage[];
  latestChat: ReplaceableBookImage | null;
}> {
  const [assetRows, chatRows] = await Promise.all([
    prisma.imageAsset.findMany({
      where: { projectId, type: { in: [...INTERIOR_ASSET_TYPES] } },
      select: { id: true, page: { select: { index: true } } }
    }),
    prisma.bookEditOperation.findMany({
      where: { projectId, kind: "ADD_IMAGE", status: "APPLIED" },
      orderBy: { createdAt: "desc" },
      take: 20
    })
  ]);

  const chatImages: ReplaceableBookImage[] = [];
  const chatMarkers = new Set<string>();
  for (const row of asRows(chatRows)) {
    const classifier = jsonRecord(row.classifier);
    if (classifier.undoneAt !== undefined) {
      continue;
    }
    const marker = `chat-image-${row.id}`;
    const page = await prisma.page.findFirst({
      where: { projectId, markdown: { contains: marker } },
      select: { index: true }
    });
    if (!page) {
      continue;
    }
    const oldSubject = jsonRecord(classifier.imageEdit).subject;
    const image: ReplaceableBookImage = {
      kind: "markdown",
      pageIndex: page.index,
      marker,
      operationId: row.id,
      ...(typeof oldSubject === "string" && oldSubject.trim() ? { oldSubject: oldSubject.trim() } : {})
    };
    chatImages.push(image);
    chatMarkers.add(marker);
  }

  const byPage = new Map<number, ReplaceableBookImage[]>();
  const push = (image: ReplaceableBookImage) => {
    const existing = byPage.get(image.pageIndex) ?? [];
    existing.push(image);
    byPage.set(image.pageIndex, existing);
  };

  for (const asset of asRows(assetRows)) {
    const pageIndex = asset.page?.index;
    if (typeof pageIndex !== "number") {
      continue;
    }
    push({
      kind: "asset",
      pageIndex,
      assetId: asset.id,
      oldSubject: illustrationOnPage(pageIndex)
    });
  }

  const markdownPages = asRows(
    await prisma.page.findMany({
      where: { projectId, markdown: { contains: "/assets/images/" } },
      select: { index: true, markdown: true },
      orderBy: { index: "asc" }
    })
  );
  for (const page of markdownPages) {
    for (const ref of scopedMarkdownImageRefs(page.markdown, projectId)) {
      if ([...chatMarkers].some((marker) => ref.src.includes(marker))) {
        continue;
      }
      push({
        kind: "markdown",
        pageIndex: page.index,
        marker: ref.filename,
        operationId: "",
        oldSubject: ref.alt || illustrationOnPage(page.index)
      });
    }
  }

  for (const image of chatImages) {
    push(image);
  }

  const readingOrder: ReplaceableBookImage[] = [];
  for (const pageIndex of [...byPage.keys()].sort((a, b) => a - b)) {
    const onPage = byPage.get(pageIndex) ?? [];
    readingOrder.push(
      ...onPage.filter((image) => image.kind === "asset"),
      ...onPage.filter((image) => image.kind === "markdown")
    );
  }

  return { readingOrder, latestChat: chatImages[0] ?? null };
}

function scopedMarkdownImageRefs(
  markdown: string,
  projectId: string
): Array<{ src: string; alt: string; filename: string }> {
  const refs: Array<{ src: string; alt: string; filename: string }> = [];
  const re = imageMarkdownRe();
  for (let match = re.exec(markdown); match; match = re.exec(markdown)) {
    const src = match[2] ?? "";
    const resolved = resolveBookImageAsset(src, {
      imageStorageDir: "/image-store",
      publicApiBase: "",
      projectId
    });
    if (!resolved) {
      continue;
    }
    const filename = resolved.localPath.split("/").pop();
    if (!filename) {
      continue;
    }
    refs.push({ src, alt: (match[1] ?? "").trim(), filename });
  }
  return refs;
}

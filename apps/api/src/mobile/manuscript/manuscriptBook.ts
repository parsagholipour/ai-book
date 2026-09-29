import { assetsImagePathFrom, joinManuscriptPages, type StudioLayout } from "@book-maker/core";
import { randomUUID } from "node:crypto";
import { hashString } from "../support.js";
import { publishedPageRefs, samePageRefs, type ManuscriptDb, type PublishedPageRef } from "./manuscriptStore.js";

/**
 * The book side of the Studio: the `Chapter` and `Page` rows people read and
 * export, read back as the working copy would write them.
 *
 * Publish writes the book from the working copy; derivation and drift
 * detection read it back. Both directions go through the one grouping below,
 * because a page the two disagree about the owner of is a chapter that
 * reports drift forever — derivation would never fold it in, and publish
 * would refuse on it every time.
 */

export type BookChapterRow = { id: string; index: number; title: string };

export type BookPageRow = {
  id: string;
  index: number;
  chapterId: string | null;
  title: string;
  markdown: string;
  status: string;
  revision: number;
  /** The illustration the compile prints above this page's prose, if any. */
  heroPath: string | null;
  /** Every non-cover image row attached to the page, for publish to detach. */
  imageIds: string[];
};

/** Group key for pages with no `Chapter` row at all — only a book with no chapter rows has any. */
export const UNCHAPTERED = "";

export type BookSnapshot = {
  chapters: BookChapterRow[];
  pages: BookPageRow[];
  /** Pages by owning chapter id (or {@link UNCHAPTERED}), in index order. */
  groups: Map<string, BookPageRow[]>;
};

export async function loadBookSnapshot(db: ManuscriptDb, projectId: string): Promise<BookSnapshot> {
  const [chapters, pages, images] = await Promise.all([
    db.chapter.findMany({
      where: { projectId },
      orderBy: { index: "asc" },
      select: { id: true, index: true, title: true }
    }),
    db.page.findMany({
      where: { projectId },
      orderBy: { index: "asc" },
      select: { id: true, index: true, chapterId: true, title: true, markdown: true, status: true, revision: true }
    }),
    db.imageAsset.findMany({
      where: { projectId, pageId: { not: null }, type: { not: "COVER" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, pageId: true, path: true }
    })
  ]);
  const imagesByPage = new Map<string, Array<{ id: string; path: string }>>();
  for (const image of images) {
    if (!image.pageId) continue;
    imagesByPage.set(image.pageId, [...(imagesByPage.get(image.pageId) ?? []), image]);
  }
  const bookPages = pages.map((page): BookPageRow => {
    const attached = imagesByPage.get(page.id) ?? [];
    const hero = attached[0];
    return {
      ...page,
      heroPath: hero ? (assetsImagePathFrom(hero.path) ?? hero.path) : null,
      imageIds: attached.map((image) => image.id)
    };
  });
  return { chapters, pages: bookPages, groups: groupBookPages(chapters, bookPages) };
}

/**
 * Pages by the chapter that owns them. A page whose `chapterId` names no row
 * — a structural insert's page, a chapter deleted underneath — belongs to the
 * chapter of the page before it, or the first chapter when it opens the book:
 * where the compile's reader chapters would print it.
 */
export function groupBookPages(chapters: readonly BookChapterRow[], pages: readonly BookPageRow[]): Map<string, BookPageRow[]> {
  const known = new Set(chapters.map((chapter) => chapter.id));
  const groups = new Map<string, BookPageRow[]>();
  let current = chapters[0]?.id ?? UNCHAPTERED;
  for (const page of [...pages].sort((left, right) => left.index - right.index)) {
    const key = page.chapterId && known.has(page.chapterId) ? page.chapterId : current;
    current = key;
    groups.set(key, [...(groups.get(key) ?? []), page]);
  }
  return groups;
}

export function pageRefsOf(pages: readonly BookPageRow[] | undefined): PublishedPageRef[] {
  return (pages ?? []).map((page) => ({ pageId: page.id, revision: page.revision }));
}

/**
 * A page as the working copy holds it: the compile prints a page's attached
 * illustration above its prose, so the working copy carries it as the image
 * line it will be once published — which is also what makes the first publish
 * of an illustrated book detach every hero rather than print it twice.
 */
export function workingPageText(page: Pick<BookPageRow, "markdown" | "heroPath">): string {
  const prose = page.markdown.trim();
  if (!page.heroPath) {
    return prose;
  }
  const line = `![Illustration](${page.heroPath})`;
  return prose ? `${line}\n\n${prose}` : line;
}

/** A chapter's working-copy text from its pages, joined exactly as the author compile prints them. */
export function chapterTextFromPages(pages: readonly BookPageRow[], layout: StudioLayout): string {
  return joinManuscriptPages(pages.map(workingPageText), layout);
}

/** The pieces of a working chapter drift detection reads. */
export type DriftChapter = {
  id: string;
  publishedChapterId: string | null;
  publishedPages: unknown;
  deletedAt: Date | null;
};

/**
 * Which working chapters the book changed underneath, and which book chapters
 * no working chapter covers (a continuation appended them).
 *
 * A chapter drifted when the pages its book chapter holds now — ids, order and
 * revisions — are not the pages it recorded at the last publish or sync. A
 * chat edit, an Edit Mode save, a picture added or moved, a restructure and an
 * undo or redo all bump the revision of every page they write, and a
 * restructure changes the ids, so this one comparison sees all of them without
 * knowing any of them.
 */
export function detectBookDrift(
  chapters: readonly DriftChapter[],
  book: BookSnapshot
): { drifted: Set<string>; unmapped: string[] } {
  const drifted = new Set<string>();
  const mapped = new Set<string>();
  for (const chapter of chapters) {
    const recorded = publishedPageRefs(chapter.publishedPages);
    if (recorded === null) {
      continue;
    }
    const key = chapter.publishedChapterId ?? UNCHAPTERED;
    if (recorded.length > 0 || chapter.publishedChapterId !== null) {
      mapped.add(key);
    }
    const live = recorded.length === 0 && chapter.publishedChapterId === null ? [] : pageRefsOf(book.groups.get(key));
    if (!samePageRefs(recorded, live)) {
      drifted.add(chapter.id);
    }
  }
  const unmapped = [...book.groups.entries()]
    .filter(([key, pages]) => pages.length > 0 && !mapped.has(key))
    .map(([key]) => key);
  return { drifted, unmapped };
}

/** A fresh row id for rows whose id has to be known before the insert returns (createMany). */
export function newRowId(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, "").slice(0, 22)}`;
}

/**
 * The id a retried create lands on. Deterministic from the scope and the
 * client's requestId, so a replay finds the row it made and a racing duplicate
 * meets the primary key instead of inserting a second one — no requestId
 * column needed on tables that have none.
 */
export function requestScopedId(prefix: string, scope: string, requestId: string): string {
  return `${prefix}${hashString(`${scope}:${requestId}`)}`;
}

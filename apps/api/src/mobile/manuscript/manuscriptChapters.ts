import { manuscriptWordCount } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { isPrismaUniqueConflict } from "../support.js";
import { chapterTextFromPages, loadBookSnapshot, pageRefsOf, requestScopedId, UNCHAPTERED } from "./manuscriptBook.js";
import type { ManuscriptProject } from "./manuscriptDerivation.js";
import {
  MANUSCRIPT_CHAPTER_LIMIT,
  type ManuscriptChapterCreateBody,
  type ManuscriptChapterSaveBody
} from "./manuscriptSchemas.js";
import {
  autoVersionDue,
  chapterStatusFromWire,
  claimManuscript,
  parseManuscriptSettings,
  writeChapterVersion,
  type ManuscriptChapterRow,
  type ManuscriptDb
} from "./manuscriptStore.js";

/**
 * Writing to the working copy: the autosave, and adding, deleting, restoring
 * and reordering chapters. Everything here is free and touches no book row —
 * the book changes only at publish.
 *
 * A refusal is thrown from inside the transaction rather than returned, so the
 * manuscript revision the claim already bumped rolls back with it: a refused
 * write must not look like a write to the next device that compares revisions.
 */

export class ManuscriptWriteRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

class ChapterRevisionConflict extends Error {}

const TRANSACTION_OPTIONS = { timeout: 20_000, maxWait: 10_000 } as const;

export type SaveChapterOutcome =
  | { kind: "saved"; chapter: ManuscriptChapterRow; manuscriptRevision: number; savedAt: Date }
  | { kind: "conflict"; chapter: ManuscriptChapterRow }
  | { kind: "not_found" };

/**
 * The autosave. `baseRevision` is the revision the device last saw; anything
 * else is another device's newer copy, answered with that copy so the app can
 * offer the three-way choice rather than overwrite it.
 *
 * `resolveConflict` settles the card derivation raised when the book changed
 * underneath unpublished edits. Either answer re-records the book's pages as
 * seen — that is what lets the next publish through — and keeps the losing
 * text as a version, so neither choice can lose a word.
 */
export async function saveManuscriptChapter(
  project: ManuscriptProject,
  manuscriptId: string,
  chapterId: string,
  body: ManuscriptChapterSaveBody
): Promise<SaveChapterOutcome> {
  try {
    return await prisma.$transaction(async (tx) => {
      const { revision: manuscriptRevision } = await claimManuscript(tx, manuscriptId);
      const chapter = await tx.manuscriptChapter.findFirst({ where: { id: chapterId, manuscriptId, deletedAt: null } });
      if (!chapter) {
        throw new ManuscriptWriteRefusal(404, "CHAPTER_NOT_FOUND", "That chapter no longer exists.");
      }
      if (chapter.revision !== body.baseRevision) {
        throw new ChapterRevisionConflict();
      }
      const now = new Date();
      const resolving = body.resolveConflict && chapter.conflictDetectedAt !== null ? body.resolveConflict : null;
      let title = body.title.trim();
      let markdown = body.markdown;
      let livePages: ReturnType<typeof pageRefsOf> | null = null;
      if (resolving) {
        const manuscript = await tx.manuscript.findUnique({ where: { id: manuscriptId }, select: { settings: true } });
        const book = await loadBookSnapshot(tx, project.id);
        const pages = book.groups.get(chapter.publishedChapterId ?? UNCHAPTERED) ?? [];
        livePages = pageRefsOf(pages);
        if (resolving === "book") {
          // Read now rather than taken from the stored conflict: the book may
          // have moved again since the card was raised, and "use the book's
          // version" means the version the book has.
          title = book.chapters.find((row) => row.id === chapter.publishedChapterId)?.title.trim() || chapter.conflictTitle || title;
          markdown = chapterTextFromPages(pages, parseManuscriptSettings(manuscript?.settings).layout);
        }
      }
      const wordCount = manuscriptWordCount(markdown);
      const previous = { title: chapter.title, markdown: chapter.markdown, wordCount: chapter.wordCount };
      if (body.checkpoint) {
        await writeChapterVersion(tx, chapter.id, body.checkpoint === "before_ai" ? "BEFORE_AI" : "RESTORE", previous);
      } else if (!resolving) {
        const last = await tx.manuscriptVersion.findFirst({
          where: { chapterId: chapter.id },
          orderBy: { createdAt: "desc" },
          select: { title: true, markdown: true, wordCount: true, createdAt: true }
        });
        if (autoVersionDue({ previous, next: { title, markdown, wordCount }, last, now })) {
          await writeChapterVersion(tx, chapter.id, "AUTO", previous);
        }
      }
      if (resolving === "mine") {
        await writeChapterVersion(tx, chapter.id, "CONFLICT", {
          title: chapter.conflictTitle ?? chapter.title,
          markdown: chapter.conflictMarkdown ?? "",
          wordCount: manuscriptWordCount(chapter.conflictMarkdown ?? "")
        });
      } else if (resolving === "book") {
        await writeChapterVersion(tx, chapter.id, "CONFLICT", previous);
      }
      const revision = chapter.revision + 1;
      const textChanged = title !== chapter.title || markdown !== chapter.markdown;
      // Notes and status are the author's own tracker and never print, so a
      // save that touched only them leaves a clean chapter clean.
      const staysPublished =
        (!textChanged && !resolving && chapter.publishedRevision === chapter.revision) || resolving === "book";
      const claimed = await tx.manuscriptChapter.updateMany({
        where: { id: chapter.id, revision: chapter.revision },
        data: {
          title,
          markdown,
          wordCount,
          revision,
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          ...(body.status ? { status: chapterStatusFromWire(body.status) } : {}),
          ...(staysPublished ? { publishedRevision: revision } : {}),
          ...(resolving
            ? { conflictTitle: null, conflictMarkdown: null, conflictDetectedAt: null, publishedPages: livePages ?? [] }
            : {})
        }
      });
      if (claimed.count === 0) {
        throw new ChapterRevisionConflict();
      }
      const saved = await tx.manuscriptChapter.findUnique({ where: { id: chapter.id } });
      if (!saved) {
        throw new ChapterRevisionConflict();
      }
      return { kind: "saved" as const, chapter: saved, manuscriptRevision, savedAt: now };
    }, TRANSACTION_OPTIONS);
  } catch (error) {
    if (error instanceof ChapterRevisionConflict) {
      const current = await prisma.manuscriptChapter.findFirst({ where: { id: chapterId, manuscriptId } });
      return current && current.deletedAt === null ? { kind: "conflict", chapter: current } : { kind: "not_found" };
    }
    if (error instanceof ManuscriptWriteRefusal && error.status === 404) {
      return { kind: "not_found" };
    }
    throw error;
  }
}

function defaultChapterTitle(position: number): string {
  return `Chapter ${position}`;
}

async function liveChapterRows(tx: ManuscriptDb, manuscriptId: string) {
  return tx.manuscriptChapter.findMany({
    where: { manuscriptId, deletedAt: null },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, position: true }
  });
}

/**
 * A new, empty chapter. Its id is minted from the requestId, so a retried add
 * finds the chapter the first attempt made and a racing duplicate meets the
 * primary key — the add is idempotent with no column to hold the key.
 */
export async function addManuscriptChapter(
  manuscriptId: string,
  body: ManuscriptChapterCreateBody
): Promise<ManuscriptChapterRow> {
  const id = requestScopedId("mc", manuscriptId, body.requestId);
  const replayed = await prisma.manuscriptChapter.findUnique({ where: { id } });
  if (replayed) {
    return replayed;
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await claimManuscript(tx, manuscriptId);
      const live = await liveChapterRows(tx, manuscriptId);
      if (live.length >= MANUSCRIPT_CHAPTER_LIMIT) {
        throw new ManuscriptWriteRefusal(409, "CHAPTER_LIMIT", `A book can have up to ${MANUSCRIPT_CHAPTER_LIMIT} chapters.`);
      }
      let position = live.length + 1;
      if (body.afterChapterId === null) {
        position = 1;
      } else if (body.afterChapterId !== undefined) {
        const anchor = live.find((chapter) => chapter.id === body.afterChapterId);
        if (!anchor) {
          throw new ManuscriptWriteRefusal(404, "CHAPTER_NOT_FOUND", "That chapter no longer exists.");
        }
        position = anchor.position + 1;
      }
      await tx.manuscriptChapter.updateMany({
        where: { manuscriptId, deletedAt: null, position: { gte: position } },
        data: { position: { increment: 1 } }
      });
      return tx.manuscriptChapter.create({
        data: {
          id,
          manuscriptId,
          position,
          title: body.title?.trim() || defaultChapterTitle(position),
          markdown: "",
          wordCount: 0
        }
      });
    }, TRANSACTION_OPTIONS);
  } catch (error) {
    if (isPrismaUniqueConflict(error)) {
      const winner = await prisma.manuscriptChapter.findUnique({ where: { id } });
      if (winner) return winner;
    }
    throw error;
  }
}

/**
 * A soft delete, so the snackbar's Undo is a restore. The row keeps its last
 * position and every version; the next publish purges it and takes its pages
 * out of the book.
 */
export async function deleteManuscriptChapter(manuscriptId: string, chapterId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await claimManuscript(tx, manuscriptId);
    const live = await liveChapterRows(tx, manuscriptId);
    const chapter = live.find((candidate) => candidate.id === chapterId);
    if (!chapter) {
      throw new ManuscriptWriteRefusal(404, "CHAPTER_NOT_FOUND", "That chapter no longer exists.");
    }
    if (live.length <= 1) {
      throw new ManuscriptWriteRefusal(409, "LAST_CHAPTER", "A book needs at least one chapter.");
    }
    await tx.manuscriptChapter.update({ where: { id: chapterId }, data: { deletedAt: new Date() } });
    await tx.manuscriptChapter.updateMany({
      where: { manuscriptId, deletedAt: null, position: { gt: chapter.position } },
      data: { position: { decrement: 1 } }
    });
  }, TRANSACTION_OPTIONS);
}

/** Undo of a delete: back at the position it left, or at the end if the book is shorter now. */
export async function restoreManuscriptChapter(manuscriptId: string, chapterId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await claimManuscript(tx, manuscriptId);
    const chapter = await tx.manuscriptChapter.findFirst({
      where: { id: chapterId, manuscriptId, deletedAt: { not: null } },
      select: { id: true, position: true }
    });
    if (!chapter) {
      throw new ManuscriptWriteRefusal(404, "CHAPTER_NOT_FOUND", "That chapter can't be restored.");
    }
    const live = await liveChapterRows(tx, manuscriptId);
    if (live.length >= MANUSCRIPT_CHAPTER_LIMIT) {
      throw new ManuscriptWriteRefusal(409, "CHAPTER_LIMIT", `A book can have up to ${MANUSCRIPT_CHAPTER_LIMIT} chapters.`);
    }
    const position = Math.max(1, Math.min(chapter.position, live.length + 1));
    await tx.manuscriptChapter.updateMany({
      where: { manuscriptId, deletedAt: null, position: { gte: position } },
      data: { position: { increment: 1 } }
    });
    await tx.manuscriptChapter.update({ where: { id: chapterId }, data: { deletedAt: null, position } });
  }, TRANSACTION_OPTIONS);
}

/** The outline's drag-and-drop: every live chapter, named once, in the new order. */
export async function reorderManuscriptChapters(manuscriptId: string, chapterIds: readonly string[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await claimManuscript(tx, manuscriptId);
    const live = await liveChapterRows(tx, manuscriptId);
    const liveIds = new Set(live.map((chapter) => chapter.id));
    if (
      chapterIds.length !== live.length ||
      new Set(chapterIds).size !== chapterIds.length ||
      chapterIds.some((id) => !liveIds.has(id))
    ) {
      throw new ManuscriptWriteRefusal(
        400,
        "ORDER_MISMATCH",
        "The chapter list changed on another device. Reload the outline and try again."
      );
    }
    const positions = new Map(live.map((chapter) => [chapter.id, chapter.position]));
    for (const [index, id] of chapterIds.entries()) {
      if (positions.get(id) !== index + 1) {
        await tx.manuscriptChapter.update({ where: { id }, data: { position: index + 1 } });
      }
    }
  }, TRANSACTION_OPTIONS);
}

import {
  manuscriptWordCount,
  parseBookMatter,
  studioSettingsFromMediaSettings,
  type StudioLayout
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { hasOpenProjectWork } from "../editOperations.js";
import { isPrismaUniqueConflict } from "../support.js";
import {
  chapterTextFromPages,
  detectBookDrift,
  loadBookSnapshot,
  newRowId,
  pageRefsOf,
  UNCHAPTERED,
  type BookSnapshot
} from "./manuscriptBook.js";
import type { ManuscriptPublishBlockedReason } from "./manuscriptDto.js";
import {
  chapterHasUnpublishedChanges,
  claimManuscript,
  currentPublishedMeta,
  liveChapters,
  loadManuscript,
  manuscriptIsPublished,
  manuscriptSource,
  parseManuscriptSettings,
  publishedOrderIds,
  settingsJson,
  type LoadedManuscript,
  type ManuscriptDb,
  type ManuscriptSettings
} from "./manuscriptStore.js";

/**
 * Working copy ← book.
 *
 * An imported book has pages and no working copy, and a published one can have
 * its pages changed from outside the Studio — by a chat edit, Edit Mode, a
 * picture added or moved, a restructure, a continuation, an undo or redo. So
 * opening the Studio reads the book back:
 *
 * - no working copy yet: one is made from the `Chapter` and `Page` rows, each
 *   chapter already "published" (it *is* the book);
 * - a chapter whose book pages drifted and that holds no unpublished edits of
 *   its own is refreshed silently — the author sees the chat's edit;
 * - one that *does* hold unpublished edits keeps them, and gets the book's
 *   version beside them as a conflict for the author to settle, because the
 *   next publish would otherwise overwrite a paid chat edit without a word;
 * - a book chapter no working chapter covers — a continuation appended it — is
 *   appended.
 */

export const MANUSCRIPT_PROJECT_SELECT = {
  id: true,
  userId: true,
  title: true,
  subtitle: true,
  authorName: true,
  bookMatter: true,
  coverTagline: true,
  prompt: true,
  category: true,
  subcategory: true,
  targetPages: true,
  complexity: true,
  temperature: true,
  language: true,
  mediaSettings: true,
  status: true,
  contentRevision: true,
  currentPlanId: true,
  pdfPageMap: true
} as const;

export type ManuscriptProject = {
  id: string;
  userId: string;
  title: string;
  subtitle: string | null;
  authorName: string | null;
  bookMatter: unknown;
  coverTagline: string | null;
  prompt: string;
  category: string;
  subcategory: string | null;
  targetPages: number;
  complexity: number;
  temperature: number;
  language: string;
  mediaSettings: unknown;
  status: string;
  contentRevision: number;
  currentPlanId: string | null;
  pdfPageMap: unknown;
};

export async function loadManuscriptProject(userId: string, projectId: string): Promise<ManuscriptProject | null> {
  return (await prisma.project.findFirst({
    where: { id: projectId, userId },
    select: MANUSCRIPT_PROJECT_SELECT
  })) as ManuscriptProject | null;
}

export type ManuscriptAccessRefusal = { status: number; code: string; message: string };

/**
 * Whether this book opens in the Studio at all. A generated book is not the
 * author's text (it keeps Edit Mode); an import is, once its pages exist.
 */
export function manuscriptAccessRefusal(project: ManuscriptProject): ManuscriptAccessRefusal | null {
  const source = manuscriptSource(project.mediaSettings);
  if (source === null) {
    return {
      status: 409,
      code: "NOT_AUTHOR_MANUSCRIPT",
      message: "This book was written by AI. Edit it from the book page instead."
    };
  }
  if (source === "imported" && (project.status === "GENERATING" || project.currentPlanId === null)) {
    return {
      status: 409,
      code: "BOOK_NOT_READY",
      message:
        project.status === "FAILED"
          ? "This book didn't finish importing, so there's nothing to open yet."
          : "Your book is still being imported. Open it again in a moment."
    };
  }
  return null;
}

/**
 * Why Publish would be refused right now, for the button — publish itself asks
 * again under the project lock. The one-definition predicate decides whether
 * anything is open at all (`hasOpenProjectWork`); this only names it.
 */
export async function publishBlockedReason(projectId: string): Promise<ManuscriptPublishBlockedReason | null> {
  const [openWork, openOperations] = await Promise.all([
    hasOpenProjectWork(projectId),
    prisma.bookEditOperation.count({ where: { projectId, status: { in: ["QUEUED", "ACTIVE"] } } })
  ]);
  if (!openWork && openOperations === 0) {
    return null;
  }
  const named = await prisma.generationJob.findMany({
    where: { projectId, status: { in: ["QUEUED", "ACTIVE"] }, type: { in: ["IMPORT_BOOK", "GENERATE_AUDIOBOOK"] } },
    select: { type: true }
  });
  if (named.some((job) => job.type === "IMPORT_BOOK")) return "importing";
  if (named.some((job) => job.type === "GENERATE_AUDIOBOOK")) return "audiobook";
  return "busy";
}

function defaultChapterTitle(position: number, layout: StudioLayout): string {
  return layout === "picture" && position === 1 ? "Your story" : `Chapter ${position}`;
}

/** The book chapters in reading order, each with the title the working copy gives it. */
export function bookChapterGroups(book: BookSnapshot, fallbackTitle: string) {
  const ordered = [...book.groups.entries()].map(([key, pages]) => {
    const chapter = book.chapters.find((candidate) => candidate.id === key);
    return {
      key,
      chapterId: key === UNCHAPTERED ? null : key,
      title: chapter?.title.trim() || fallbackTitle,
      pages,
      firstIndex: pages[0]?.index ?? Number.MAX_SAFE_INTEGER
    };
  });
  return ordered.sort((left, right) => left.firstIndex - right.firstIndex);
}

/**
 * The working copy of this book, made now if it has none. Idempotent under a
 * race: `Manuscript.projectId` is unique, so a second opener meets P2002 and
 * reads the winner's copy.
 */
export async function ensureManuscript(project: ManuscriptProject): Promise<LoadedManuscript> {
  const existing = await loadManuscript(prisma, project.id);
  if (existing) {
    return existing;
  }
  try {
    await prisma.$transaction(async (tx) => createWorkingCopy(tx, project), { timeout: 60_000, maxWait: 10_000 });
  } catch (error) {
    if (!isPrismaUniqueConflict(error)) {
      throw error;
    }
  }
  const created = await loadManuscript(prisma, project.id);
  if (!created) {
    throw new Error(`Working copy for project ${project.id} was not created.`);
  }
  return created;
}

async function createWorkingCopy(tx: ManuscriptDb, project: ManuscriptProject): Promise<void> {
  const studio = studioSettingsFromMediaSettings(project.mediaSettings);
  const layout: StudioLayout = studio?.layout ?? "flow";
  const baseSettings: ManuscriptSettings = {
    layout,
    kind: studio?.kind ?? "other",
    artStyle: studio?.artStyle ?? null,
    goalWords: null,
    dedication: parseBookMatter(project.bookMatter).dedication ?? null,
    castCharacterIds: [],
    published: null
  };
  const book = project.currentPlanId ? await loadBookSnapshot(tx, project.id) : null;
  const groups = book ? bookChapterGroups(book, project.title) : [];
  const fromBook = groups.length > 0;
  const manuscriptId = newRowId("ms");
  const chapters = fromBook
    ? groups.map((group, index) => {
        const markdown = chapterTextFromPages(group.pages, layout);
        return {
          id: newRowId("mc"),
          manuscriptId,
          position: index + 1,
          title: group.title,
          markdown,
          wordCount: manuscriptWordCount(markdown),
          revision: 1,
          publishedRevision: 1,
          publishedChapterId: group.chapterId,
          publishedPages: pageRefsOf(group.pages)
        };
      })
    : [{ id: newRowId("mc"), manuscriptId, position: 1, title: defaultChapterTitle(1, layout), markdown: "", wordCount: 0 }];
  const settings: ManuscriptSettings = fromBook
    ? { ...baseSettings, published: currentPublishedMeta(project, baseSettings) }
    : baseSettings;
  await tx.manuscript.create({
    data: {
      id: manuscriptId,
      projectId: project.id,
      settings: settingsJson(settings),
      ...(fromBook ? { publishedOrder: chapters.map((chapter) => chapter.id) } : {})
    }
  });
  await tx.manuscriptChapter.createMany({ data: chapters });
}

/**
 * Folds whatever the book did since the last publish into the working copy.
 * Writes nothing when nothing drifted, which is every open of a book nobody
 * changed from outside.
 */
export async function syncManuscriptWithBook(
  project: ManuscriptProject,
  manuscript: LoadedManuscript
): Promise<LoadedManuscript> {
  if (!manuscriptIsPublished(project.mediaSettings, manuscript.firstPublishedAt) || !project.currentPlanId) {
    return manuscript;
  }
  const book = await loadBookSnapshot(prisma, project.id);
  const drift = detectBookDrift(manuscript.chapters, book);
  const staleConflicts = manuscript.chapters.some(
    (chapter) => chapter.conflictDetectedAt !== null && !drift.drifted.has(chapter.id)
  );
  if (drift.drifted.size === 0 && drift.unmapped.length === 0 && !staleConflicts) {
    return manuscript;
  }
  await prisma.$transaction(
    async (tx) => {
      await claimManuscript(tx, manuscript.id);
      // Re-read under the lock: a save or a publish may have landed since the
      // unlocked read above, and every decision below is about these rows.
      const held = await loadManuscript(tx, project.id);
      if (!held) return;
      await applyBookDrift(tx, project, held, await loadBookSnapshot(tx, project.id));
    },
    { timeout: 60_000, maxWait: 10_000 }
  );
  return (await loadManuscript(prisma, project.id)) ?? manuscript;
}

async function applyBookDrift(
  tx: ManuscriptDb,
  project: ManuscriptProject,
  manuscript: LoadedManuscript,
  book: BookSnapshot
): Promise<void> {
  const settings = parseManuscriptSettings(manuscript.settings);
  const { drifted, unmapped } = detectBookDrift(manuscript.chapters, book);
  const now = new Date();
  for (const chapter of manuscript.chapters) {
    if (!drifted.has(chapter.id)) {
      if (chapter.conflictDetectedAt !== null) {
        // The book is back to what this chapter last published — an undo of
        // the chat edit that raised the conflict — so there is nothing left to
        // choose between.
        await tx.manuscriptChapter.update({
          where: { id: chapter.id },
          data: { conflictTitle: null, conflictMarkdown: null, conflictDetectedAt: null }
        });
      }
      continue;
    }
    const pages = book.groups.get(chapter.publishedChapterId ?? UNCHAPTERED) ?? [];
    if (chapter.deletedAt !== null) {
      // The author deleted this chapter and the next publish takes its pages
      // out whatever they say now. A conflict here would sit on a chapter the
      // outline no longer shows and refuse every publish, so the deletion
      // simply re-records what it is deleting.
      await tx.manuscriptChapter.update({
        where: { id: chapter.id },
        data: { publishedPages: pageRefsOf(pages), ...(pages.length === 0 ? { publishedChapterId: null } : {}) }
      });
      continue;
    }
    const bookTitle = book.chapters.find((row) => row.id === chapter.publishedChapterId)?.title.trim() || chapter.title;
    const bookMarkdown = chapterTextFromPages(pages, settings.layout);
    const clean = !chapterHasUnpublishedChanges(chapter) && chapter.conflictDetectedAt === null;
    if (clean) {
      const revision = chapter.revision + 1;
      await tx.manuscriptChapter.update({
        where: { id: chapter.id },
        data: {
          title: bookTitle,
          markdown: bookMarkdown,
          wordCount: manuscriptWordCount(bookMarkdown),
          revision,
          publishedRevision: revision,
          publishedPages: pageRefsOf(pages),
          ...(pages.length === 0 ? { publishedChapterId: null } : {})
        }
      });
      continue;
    }
    if (chapter.conflictMarkdown === bookMarkdown && chapter.conflictTitle === bookTitle) {
      continue;
    }
    await tx.manuscriptChapter.update({
      where: { id: chapter.id },
      data: {
        conflictTitle: bookTitle,
        conflictMarkdown: bookMarkdown,
        conflictDetectedAt: chapter.conflictDetectedAt ?? now
      }
    });
  }
  if (unmapped.length === 0) {
    return;
  }
  const live = liveChapters(manuscript.chapters);
  let position = live.reduce((max, chapter) => Math.max(max, chapter.position), 0);
  const appended = bookChapterGroups(book, project.title)
    .filter((group) => unmapped.includes(group.key))
    .map((group) => {
      position += 1;
      const markdown = chapterTextFromPages(group.pages, settings.layout);
      return {
        id: newRowId("mc"),
        manuscriptId: manuscript.id,
        position,
        title: group.title,
        markdown,
        wordCount: manuscriptWordCount(markdown),
        revision: 1,
        publishedRevision: 1,
        publishedChapterId: group.chapterId,
        publishedPages: pageRefsOf(group.pages)
      };
    });
  await tx.manuscriptChapter.createMany({ data: appended });
  // The book gained these chapters at its end, and so did the working copy:
  // recording them keeps the order comparison clean rather than reading a
  // continuation as an unpublished reorder.
  const order = publishedOrderIds(manuscript.publishedOrder);
  if (order !== null) {
    await tx.manuscript.update({
      where: { id: manuscript.id },
      data: { publishedOrder: [...order, ...appended.map((chapter) => chapter.id)] }
    });
  }
}

/** Open the working copy: make it if missing, then fold in the book's drift. */
export async function openManuscript(project: ManuscriptProject): Promise<LoadedManuscript> {
  return syncManuscriptWithBook(project, await ensureManuscript(project));
}

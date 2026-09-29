import {
  hasUnclosedFence,
  manuscriptExcerpt,
  manuscriptPageTargetChars,
  manuscriptPlaceholderIssues,
  normalizeManuscriptMarkdown,
  paginateManuscriptChapter,
  type StudioLayout
} from "@book-maker/core";
import { newRowId } from "./manuscriptBook.js";
import type { PublishChecklistDto } from "./manuscriptDto.js";
import { chapterHasUnpublishedChanges, type ChapterFlags } from "./manuscriptStore.js";

/**
 * The pure half of publish: what the working copy paginates to, and how that
 * lands on the book's existing `Chapter` and `Page` rows. No database here, so
 * the whole of "which row becomes what" is testable on its own.
 */

/** `createProjectSchema`'s ceiling, which every project — and so every published book — must fit. */
export const MAX_BOOK_PAGES = 600;

export type WorkingChapter = ChapterFlags & {
  id: string;
  position: number;
  title: string;
  markdown: string;
  conflictDetectedAt: Date | null;
};

export type PaginatedChapter = {
  /** The working chapter this book chapter is published from. */
  workingChapterId: string;
  title: string;
  summary: string;
  pages: string[];
};

export type PaginatedWorkingCopy = {
  /** Book chapters in order — the working copy minus its empty chapters. */
  chapters: PaginatedChapter[];
  /** Working chapters that paginated to nothing. */
  emptyChapterIds: string[];
  pageCount: number;
  targetChars: number;
};

/**
 * Pages for the whole working copy. The page target is sized off the whole
 * book (`manuscriptPageTargetChars`), so a long book fits under the 600-page
 * ceiling; the greedy cutter can still land a little over it, so a flow book
 * that does is paginated again at a wider target rather than refused. A picture
 * book's pages are the author's own, so one past the ceiling is simply too long.
 */
export function paginateWorkingCopy(chapters: readonly WorkingChapter[], layout: StudioLayout): PaginatedWorkingCopy {
  const ordered = [...chapters].sort((left, right) => left.position - right.position);
  const totalChars = ordered.reduce((sum, chapter) => sum + normalizeManuscriptMarkdown(chapter.markdown, layout).length, 0);
  let targetChars = manuscriptPageTargetChars(totalChars);
  for (let attempt = 0; ; attempt += 1) {
    const paginated = ordered.map((chapter) => ({
      chapter,
      pages: paginateManuscriptChapter(chapter.markdown, { layout, targetChars })
    }));
    const pageCount = paginated.reduce((sum, entry) => sum + entry.pages.length, 0);
    if (pageCount <= MAX_BOOK_PAGES || layout === "picture" || attempt >= 8) {
      return {
        chapters: paginated
          .filter((entry) => entry.pages.length > 0)
          .map((entry, index) => ({
            workingChapterId: entry.chapter.id,
            title: entry.chapter.title.trim() || `Chapter ${index + 1}`,
            summary: manuscriptExcerpt(entry.chapter.markdown, 240) || entry.chapter.title.trim() || `Chapter ${index + 1}`,
            pages: entry.pages
          })),
        emptyChapterIds: paginated.filter((entry) => entry.pages.length === 0).map((entry) => entry.chapter.id),
        pageCount,
        targetChars
      };
    }
    targetChars = Math.ceil(targetChars * 1.25);
  }
}

/** The page title every published page carries; an empty one trips the export's `EMPTY_PAGE` check. */
export function publishedPageTitle(chapterTitle: string, pageNumber: number): string {
  return `${chapterTitle} · ${pageNumber}`;
}

export type ExistingBookChapter = { id: string; index: number };

export type ExistingBookPage = {
  id: string;
  index: number;
  chapterId: string | null;
  title: string;
  markdown: string;
  status: string;
  revision: number;
  /** Non-cover image rows attached to the page. */
  imageIds: readonly string[];
};

export type ChapterSlotWrite = { id: string; index: number; title: string; summary: string; targetPages: number };

export type PageSlotWrite = {
  id: string;
  index: number;
  chapterId: string;
  title: string;
  markdown: string;
  summary: string;
  /** The revision the row holds once the write lands. */
  revision: number;
};

export type BookSlotPlan = {
  chapterUpdates: ChapterSlotWrite[];
  chapterCreates: ChapterSlotWrite[];
  chapterDeleteIds: string[];
  pageUpdates: PageSlotWrite[];
  pageCreates: PageSlotWrite[];
  pageDeleteIds: string[];
  /** Pages kept exactly as they were. */
  pageKeeps: Array<{ id: string; index: number; revision: number; chapterId: string | null }>;
  /** Image rows to detach — every attached image on a page this publish rewrites. */
  detachImageIds: string[];
  /** Per working chapter: the book chapter it became and the pages it now owns. */
  published: Map<string, { bookChapterId: string; pages: Array<{ pageId: string; revision: number }> }>;
  pageCount: number;
  shrank: boolean;
};

function pageSummary(markdown: string, fallback: string): string {
  return manuscriptExcerpt(markdown, 240) || fallback;
}

/**
 * Chapters and pages by **positional reuse**.
 *
 * Book chapter *i* is written onto the `Chapter` row whose index is *i*, and
 * book page *j* onto the `Page` row whose index is *j*; a missing slot is
 * created and a surplus one deleted. No row ever changes its index, and that is
 * the point: both tables carry `@@unique([projectId, index])` as a plain unique
 * index that Postgres checks row by row mid-statement, so any renumbering would
 * need the park-and-land passes structural edits use (`packages/db`
 * `pageOrdering.ts`). Reuse needs none.
 *
 * A reused page slot is rewritten only when its text, title or chapter differ
 * — or when it still has an image row attached: the working copy carried that
 * illustration as an inline image line (`workingPageText`), so the published
 * page prints it from its markdown and the hero must go, or the book prints it
 * twice (and a deleted line would not remove the picture at all) — or when it
 * is not COMPLETED: the compile waits for every page to be settled, so a page a
 * chat edit left flagged would hold a publish in EDITING for good.
 */
export function planBookSlots(input: {
  paginated: PaginatedWorkingCopy;
  existingChapters: readonly ExistingBookChapter[];
  existingPages: readonly ExistingBookPage[];
}): BookSlotPlan {
  const chapterByIndex = new Map(input.existingChapters.map((chapter) => [chapter.index, chapter]));
  const pageByIndex = new Map(input.existingPages.map((page) => [page.index, page]));
  const chapterCount = input.paginated.chapters.length;
  const plan: BookSlotPlan = {
    chapterUpdates: [],
    chapterCreates: [],
    chapterDeleteIds: input.existingChapters
      .filter((chapter) => chapter.index < 1 || chapter.index > chapterCount)
      .map((chapter) => chapter.id),
    pageUpdates: [],
    pageCreates: [],
    pageDeleteIds: [],
    pageKeeps: [],
    detachImageIds: [],
    published: new Map(),
    pageCount: input.paginated.pageCount,
    shrank: input.paginated.pageCount < input.existingPages.length
  };
  plan.pageDeleteIds = input.existingPages
    .filter((page) => page.index < 1 || page.index > plan.pageCount)
    .map((page) => page.id);

  let pageIndex = 0;
  input.paginated.chapters.forEach((chapter, chapterOffset) => {
    const index = chapterOffset + 1;
    const existing = chapterByIndex.get(index);
    const slot: ChapterSlotWrite = {
      id: existing?.id ?? newRowId("ch"),
      index,
      title: chapter.title,
      summary: chapter.summary,
      targetPages: chapter.pages.length
    };
    (existing ? plan.chapterUpdates : plan.chapterCreates).push(slot);
    const owned: Array<{ pageId: string; revision: number }> = [];
    chapter.pages.forEach((markdown, pageOffset) => {
      pageIndex += 1;
      const title = publishedPageTitle(chapter.title, pageOffset + 1);
      const current = pageByIndex.get(pageIndex);
      if (!current) {
        const created = {
          id: newRowId("pg"),
          index: pageIndex,
          chapterId: slot.id,
          title,
          markdown,
          summary: pageSummary(markdown, title),
          revision: 1
        };
        plan.pageCreates.push(created);
        owned.push({ pageId: created.id, revision: created.revision });
        return;
      }
      const unchanged =
        current.title === title &&
        current.markdown === markdown &&
        current.chapterId === slot.id &&
        current.status === "COMPLETED" &&
        current.imageIds.length === 0;
      if (unchanged) {
        plan.pageKeeps.push({ id: current.id, index: pageIndex, revision: current.revision, chapterId: current.chapterId });
        owned.push({ pageId: current.id, revision: current.revision });
        return;
      }
      const updated = {
        id: current.id,
        index: pageIndex,
        chapterId: slot.id,
        title,
        markdown,
        summary: pageSummary(markdown, title),
        revision: current.revision + 1
      };
      plan.pageUpdates.push(updated);
      plan.detachImageIds.push(...current.imageIds);
      owned.push({ pageId: updated.id, revision: updated.revision });
    });
    plan.published.set(chapter.workingChapterId, { bookChapterId: slot.id, pages: owned });
  });
  return plan;
}

const CHECKLIST_COPY = {
  empty_book: "There's nothing to publish yet. Write something in a chapter first.",
  conflict: (title: string) =>
    `“${title}” was changed in the book while you were writing. Choose which version to keep before publishing.`,
  empty_chapter: (title: string) => `“${title}” is empty, so it won't be in the book.`,
  untitled_chapter: (position: number) => `Chapter ${position} has no title.`,
  placeholder: (title: string, hits: string[]) => `“${title}” still contains ${hits.map((hit) => `“${hit}”`).join(", ")}.`,
  unclosed_fence: (title: string) => `“${title}” has a code block that is never closed; everything after it prints as code.`
} as const;

function displayTitle(chapter: WorkingChapter): string {
  return chapter.title.trim() || `Chapter ${chapter.position}`;
}

/**
 * The pre-publish checklist (`dryRun`). Only an empty book and an unsettled
 * conflict block — the rest are things an author may mean (a placeholder in a
 * draft, a chapter kept empty as a part divider).
 */
export function buildPublishChecklist(input: {
  liveChapters: readonly WorkingChapter[];
  deletedPublishedChapters: number;
  layout: StudioLayout;
  firstPublish: boolean;
}): PublishChecklistDto {
  const ordered = [...input.liveChapters].sort((left, right) => left.position - right.position);
  const paginated = paginateWorkingCopy(ordered, input.layout);
  const empty = new Set(paginated.emptyChapterIds);
  const items: PublishChecklistDto["items"] = [];
  if (paginated.pageCount === 0) {
    items.push({ kind: "empty_book", chapterId: null, message: CHECKLIST_COPY.empty_book, blocking: true });
  }
  for (const chapter of ordered) {
    if (chapter.conflictDetectedAt !== null) {
      items.push({ kind: "conflict", chapterId: chapter.id, message: CHECKLIST_COPY.conflict(displayTitle(chapter)), blocking: true });
    }
    if (empty.has(chapter.id) && paginated.pageCount > 0) {
      items.push({ kind: "empty_chapter", chapterId: chapter.id, message: CHECKLIST_COPY.empty_chapter(displayTitle(chapter)), blocking: false });
    }
    if (!chapter.title.trim()) {
      items.push({ kind: "untitled_chapter", chapterId: chapter.id, message: CHECKLIST_COPY.untitled_chapter(chapter.position), blocking: false });
    }
    const placeholders = manuscriptPlaceholderIssues(chapter.markdown);
    if (placeholders.length > 0) {
      items.push({
        kind: "placeholder",
        chapterId: chapter.id,
        message: CHECKLIST_COPY.placeholder(displayTitle(chapter), placeholders),
        blocking: false
      });
    }
    if (hasUnclosedFence(chapter.markdown)) {
      items.push({ kind: "unclosed_fence", chapterId: chapter.id, message: CHECKLIST_COPY.unclosed_fence(displayTitle(chapter)), blocking: false });
    }
  }
  return {
    firstPublish: input.firstPublish,
    words: ordered.reduce((sum, chapter) => sum + chapter.wordCount, 0),
    estimatedPages: paginated.pageCount,
    changedChapters: ordered.filter(chapterHasUnpublishedChanges).length + input.deletedPublishedChapters,
    items
  };
}

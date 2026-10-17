import {
  readerChaptersFromPublishedMarkdown,
  readerFacingResearchSources,
  type ReaderChapter,
  type StoredBookPdfPageMap
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { objectKey, objectStore } from "@book-maker/storage";
import { bookPageMapForProject } from "../bookPageNumbering.js";
import type { MobileVoiceCharacterDto } from "./dto.js";
import { loadVoiceCast } from "./voiceCast.js";

/**
 * "Behind the book": what a finished book's card says about how it was made,
 * beyond the job steps every book shares.
 *
 * The cast is `loadVoiceCast`'s, the very rows the "Talk to characters" sheet
 * lists, and only once the book is COMPLETE, as `…/voice/cast` answers; the
 * price and the balance a call needs stay on that route, which the app reads
 * at the moment someone taps Call. Beside it are the two things no other read
 * sends: where each chapter starts, so a chapter is a door into the reader,
 * and the sources the writer read, which otherwise reach a reader only as
 * printed back matter, and only in the categories that print it.
 *
 * The chapters are the ones the book *prints*, read back from the published
 * `book.md`'s Contents (`readerChaptersFromPublishedMarkdown`, the reader of a
 * Writing Studio takeover). They are not the `Chapter` rows: a short book is
 * written page by page and printed in the chapters the export grouped its pages
 * into, so "The Last Table" plans five chapters and prints three, and a list of
 * the five named chapters the reader would never find. A book that prints no
 * Contents lists none. Each one carries the PDF sheet it starts on, from the
 * page map measured off the published file's own bytes, with that file's
 * digest: a sheet number belongs to one file (`apps/mobile/lib/features/reader/CLAUDE.md`),
 * and the reader goes to it only when the file it has open is that file,
 * falling back to finding the book page by its text.
 *
 * The sources are the printed Sources list's own rule
 * (`readerFacingResearchSources`), so the card never names a source the book
 * would not, and they are listed whether or not the book prints them: the
 * reader turning the printed list off is a choice about the book's pages, not
 * about whether it was researched. Nothing here says a source was checked,
 * because nothing on any tier checks one.
 */

export type MobileMakingOfChapterDto = {
  index: number;
  title: string;
  summary: string;
  /** The book page index the chapter opens on — the reader's `?page=` — or null when it has no pages. */
  firstPageIndex: number | null;
  /** The sheet of the published PDF it starts on, in the file {@link MobileMakingOfDto.pdfDigest} names. */
  pdfPage: number | null;
};

export type MobileMakingOfSourceDto = {
  title: string;
  /** The site without `www.`; null when the address does not parse. */
  host: string | null;
  url: string;
};

export type MobileMakingOfDto = {
  cast: MobileVoiceCharacterDto[];
  chapters: MobileMakingOfChapterDto[];
  /** The digest of the PDF every `pdfPage` was measured in; null when no chapter has one. */
  pdfDigest: string | null;
  sources: MobileMakingOfSourceDto[];
  /** Every linked source the book read, which `sources` stops listing at {@link MAKING_OF_SOURCE_LIMIT}. */
  sourceCount: number;
};

/** More than anyone scrolls through on a card, and a bound on the response. */
export const MAKING_OF_SOURCE_LIMIT = 60;

/** Rows read before deduplication; a composed book's leads and expansion stay well under it. */
const RESEARCH_ROW_LIMIT = 500;

export type MakingOfProject = {
  id: string;
  status: string;
  contentRevision: number;
  pdfPageMap: unknown;
};

export async function loadMakingOf(project: MakingOfProject): Promise<MobileMakingOfDto> {
  const projectId = project.id;
  const [cast, printed, research] = await Promise.all([
    project.status === "COMPLETE" ? loadVoiceCast(projectId) : Promise.resolve([]),
    printedChapters(projectId),
    prisma.researchSource.findMany({
      where: { projectId, url: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { title: true, url: true },
      take: RESEARCH_ROW_LIMIT
    })
  ]);
  // The app opens these in a browser, so a stored address that is not a web
  // page is left off the card even though the printed list would print it.
  const sources = readerFacingResearchSources(research).filter((source) => /^https?:\/\//i.test(source.url));
  const map = bookPageMapForProject(project) as StoredBookPdfPageMap | undefined;
  const pdfDigest = map?.pdfDigest ?? null;
  const sheetOf = (pageIndex: number): number | null =>
    (pdfDigest && map?.pages.find((page) => page.index === pageIndex)?.startPdfPage) || null;
  const chapters = printed.map((chapter) => ({
    index: chapter.index,
    title: chapter.title.trim(),
    summary: chapter.summary.trim(),
    firstPageIndex: chapter.startPageIndex,
    pdfPage: sheetOf(chapter.startPageIndex)
  }));
  return {
    cast,
    chapters,
    pdfDigest: chapters.some((chapter) => chapter.pdfPage !== null) ? pdfDigest : null,
    sources: sources.slice(0, MAKING_OF_SOURCE_LIMIT),
    sourceCount: sources.length
  };
}

/**
 * The chapters the published book prints, with a summary each where one is
 * known to describe that very chapter: the export's own grouping of a short
 * book's pages, or a composed book's planned chapter of the same title and
 * first page. A book with no published file, or whose Contents cannot be read,
 * lists none rather than guessing.
 */
async function printedChapters(projectId: string): Promise<ReaderChapter[]> {
  const [markdown, pages, rows, grouping] = await Promise.all([
    readText(objectKey("books", projectId, "book.md")),
    prisma.page.findMany({ where: { projectId }, orderBy: { index: "asc" }, select: { index: true } }),
    prisma.chapter.findMany({
      where: { projectId },
      orderBy: { index: "asc" },
      select: { title: true, summary: true, pages: { select: { index: true }, orderBy: { index: "asc" }, take: 1 } }
    }),
    readText(objectKey("books", projectId, "reader-chapters.json"))
  ]);
  if (markdown === null) {
    return [];
  }
  const chapters = readerChaptersFromPublishedMarkdown(markdown, pages) ?? [];
  const summaries = new Map<string, string>();
  const remember = (title: string, startPageIndex: number | undefined, summary: string) => {
    if (startPageIndex !== undefined && summary.trim()) {
      summaries.set(`${startPageIndex}\u0000${title.trim()}`, summary);
    }
  };
  for (const row of rows) {
    remember(row.title, row.pages[0]?.index, row.summary);
  }
  for (const chapter of groupedChapters(grouping)) {
    remember(chapter.title, chapter.startPageIndex, chapter.summary);
  }
  return chapters.map((chapter) => ({
    ...chapter,
    summary: summaries.get(`${chapter.startPageIndex}\u0000${chapter.title.trim()}`) ?? chapter.summary
  }));
}

/** The export's stored grouping of a per-page book (`readerChapterCache.ts` in the worker), read leniently. */
function groupedChapters(raw: string | null): Array<{ title: string; summary: string; startPageIndex: number }> {
  if (raw === null) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { chapters?: unknown };
    if (!Array.isArray(parsed.chapters)) {
      return [];
    }
    return parsed.chapters.flatMap((entry: unknown) => {
      const chapter = entry as { title?: unknown; summary?: unknown; startPageIndex?: unknown };
      return typeof chapter.title === "string" &&
        typeof chapter.summary === "string" &&
        typeof chapter.startPageIndex === "number"
        ? [{ title: chapter.title, summary: chapter.summary, startPageIndex: chapter.startPageIndex }]
        : [];
    });
  } catch {
    return [];
  }
}

/** A published file's text, or null when it is not there. A storage failure still throws. */
async function readText(key: string): Promise<string | null> {
  const bytes = await objectStore().get(key);
  return bytes ? Buffer.from(bytes).toString("utf8") : null;
}

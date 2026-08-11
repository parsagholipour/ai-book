import type { ReaderChapter, ReaderChapterResult } from "@book-maker/core";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The reader-chapter model call, memoized on disk per project.
 *
 * `createReaderChaptersForExport` is one LLM call on *every* compile, including
 * the ones the user was told are free and instant — a presentation toggle
 * ("don't say Chapter"), an undo, a manual page edit. The manuscript those
 * recompiles chapterize is byte-identical to the one already chapterized, so
 * the call is pure latency and spend.
 *
 * Only `source === "model"` is written — the model's own usable answer, empty
 * ones included. Neither of the others may be: `"fallback"` is the deterministic
 * grouping standing in for a provider that happened to be down, and `"rejected"`
 * is a reply we could not read. Pinning either would make one bad moment
 * permanent for this book, since the fingerprint only changes when its text
 * does.
 *
 * That write rule is also why a miss is not the same thing as "this compile has
 * not run yet", and why `readerChaptersWithCache` takes `allowModelCall` rather
 * than treating the cache as the whole cost control: an uncharged, self-repeating
 * compile must be free on a *miss* too. See below.
 */

const CACHE_FILENAME = "reader-chapters.json";

type ReaderChapterCacheFile = {
  fingerprint: string;
  chapters: ReaderChapter[];
};

type IndexedReaderPage = {
  index: number;
};

export function readerChapterCachePath(projectDir: string): string {
  return join(projectDir, CACHE_FILENAME);
}

export async function readCachedReaderChapters(
  projectDir: string,
  fingerprint: string
): Promise<ReaderChapter[] | undefined> {
  const cached = await readReaderChapterCacheFile(projectDir);
  return cached && cached.fingerprint === fingerprint ? cached.chapters : undefined;
}

/**
 * The latest model-authored layout, even when the manuscript fingerprint moved.
 *
 * A manual page edit changes the fingerprint but not the page partition. If its
 * recompile could not be queued, the repair lane is the only route back after
 * the edit invalidated `book.md`; reusing the prior layout is both model-free
 * and closer to the published book than inventing new deterministic chapters.
 * The full coverage check is what makes that safe: a continuation, deletion or
 * reindex that changed the partition gets a miss instead.
 */
export async function readCompatibleCachedReaderChapters(
  projectDir: string,
  pages: ReadonlyArray<IndexedReaderPage>
): Promise<ReaderChapter[] | undefined> {
  const cached = await readReaderChapterCacheFile(projectDir);
  return cached && readerChapterLayoutFitsPages(cached.chapters, pages) ? cached.chapters : undefined;
}

export async function writeCachedReaderChapters(
  projectDir: string,
  fingerprint: string,
  result: ReaderChapterResult
): Promise<void> {
  if (result.source !== "model") {
    return;
  }
  const file: ReaderChapterCacheFile = { fingerprint, chapters: result.chapters };
  try {
    await writeFile(readerChapterCachePath(projectDir), JSON.stringify(file), "utf8");
  } catch {
    // The cache is an optimization; a book must still export without it.
  }
}

/**
 * Resolves the chapters for one compile, calling the model only on a miss — and
 * only when this compile is allowed to spend at all.
 *
 * `allowModelCall: false` is for a compile nobody was charged for and that
 * repeats on its own: the detached export repair a status read or a download
 * queues while a compiled file is missing. The cache is what usually makes such
 * a compile free, but it is only ever written by a compile that got a *model*
 * answer — a book compiled before the cache existed has no entry, and neither
 * does one whose chapterization fell back or came back unreadable — so a miss is
 * not the rare case. On a miss the repair takes the deterministic grouping, the
 * same stand-in `createReaderChaptersForExport` produces when the provider is
 * down, and writes nothing: the next charged compile is still free to ask.
 */
export async function readerChaptersWithCache(options: {
  projectDir: string;
  fingerprint: string;
  /** Whether this compile may pay for the chapterization call on a miss. */
  allowModelCall: boolean;
  /** The chapterization call. Made only on a miss, and only when allowed. */
  compute: () => Promise<ReaderChapterResult>;
  /** Model-free grouping, used on a miss when the call is not allowed. */
  deterministic: () => ReaderChapter[];
}): Promise<ReaderChapter[]> {
  const cached = await readCachedReaderChapters(options.projectDir, options.fingerprint);
  if (cached) {
    return cached;
  }
  if (!options.allowModelCall) {
    // Not cached: a deterministic grouping is a stand-in, not a verdict, and
    // pinning it would deny the manuscript the model answer it has paid for.
    return options.deterministic();
  }
  const result = await options.compute();
  await writeCachedReaderChapters(options.projectDir, options.fingerprint, result);
  return result.chapters;
}

/**
 * Recovers the chapter partition printed into a previously published book.
 *
 * Presentation-only recompiles change heading wording or Sources back matter,
 * never page prose. A pre-cache book therefore has no reason to be regrouped on
 * its first presentation edit: the generated Contents markup already records
 * each chapter title and starting page. Reconstituting that small structural
 * input keeps the recompile model-free and preserves the published layout.
 *
 * No Contents section is a valid answer and returns `[]`: `compileBookMarkdown`
 * then falls back to the unchanged plan exactly as the preceding publication
 * did. A section that exists but cannot be parsed returns `undefined`, allowing
 * the caller to choose a conservative fallback instead of trusting partial data.
 */
export function readerChaptersFromPublishedMarkdown(
  markdown: string,
  pages: ReadonlyArray<IndexedReaderPage>
): ReaderChapter[] | undefined {
  const section = markdown.match(
    /<section\b[^>]*class=["'][^"']*\bbook-contents\b[^"']*["'][^>]*>([\s\S]*?)<\/section>/i
  );
  if (!section) {
    return [];
  }

  const starts: Array<{ title: string; pageIndex: number }> = [];
  const itemPattern = /<li\b[^>]*class=["'][^"']*\bbook-contents__item\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  for (const item of section[1]?.matchAll(itemPattern) ?? []) {
    const body = item[1] ?? "";
    const title = body.match(/<span\s+class=["']book-contents__name["']>([\s\S]*?)<\/span>/i)?.[1];
    const page = body.match(/<span\s+class=["']book-contents__page["']>([\s\S]*?)<\/span>/i)?.[1];
    const pageIndex = Number(page?.trim());
    if (title === undefined || !Number.isInteger(pageIndex) || pageIndex <= 0) {
      return undefined;
    }
    starts.push({ title: decodePublishedHtmlText(title), pageIndex });
  }
  if (starts.length < 2) {
    return undefined;
  }

  const pageIndexes = normalizedPageIndexes(pages);
  const pagePositions = new Map(pageIndexes.map((pageIndex, position) => [pageIndex, position]));
  const chapters: ReaderChapter[] = [];
  for (const [offset, start] of starts.entries()) {
    const startPosition = pagePositions.get(start.pageIndex);
    const nextStart = starts[offset + 1];
    const nextPosition = nextStart ? pagePositions.get(nextStart.pageIndex) : pageIndexes.length;
    if (startPosition === undefined || nextPosition === undefined || nextPosition <= startPosition) {
      return undefined;
    }
    const endPageIndex = pageIndexes[nextPosition - 1];
    if (endPageIndex === undefined) {
      return undefined;
    }
    chapters.push({
      index: offset + 1,
      title: start.title,
      summary: "",
      startPageIndex: start.pageIndex,
      endPageIndex
    });
  }
  return readerChapterLayoutFitsPages(chapters, pages) ? chapters : undefined;
}

async function readReaderChapterCacheFile(projectDir: string): Promise<ReaderChapterCacheFile | undefined> {
  try {
    const raw = JSON.parse(await readFile(readerChapterCachePath(projectDir), "utf8")) as unknown;
    return parseReaderChapterCacheFile(raw);
  } catch {
    // A missing, unreadable or malformed cache is a miss, never a failure.
    return undefined;
  }
}

function readerChapterLayoutFitsPages(
  chapters: ReadonlyArray<ReaderChapter>,
  pages: ReadonlyArray<IndexedReaderPage>
): boolean {
  if (chapters.length === 0) {
    // An empty model verdict carries no boundaries, so once its fingerprint no
    // longer matches there is nothing proving it describes this page set.
    return false;
  }
  if (chapters.length < 2) {
    return false;
  }
  const pageIndexes = normalizedPageIndexes(pages);
  let nextPageOffset = 0;
  for (const chapter of chapters) {
    if (chapter.startPageIndex !== pageIndexes[nextPageOffset]) {
      return false;
    }
    const endOffset = pageIndexes.indexOf(chapter.endPageIndex, nextPageOffset);
    if (endOffset < nextPageOffset) {
      return false;
    }
    nextPageOffset = endOffset + 1;
  }
  return nextPageOffset === pageIndexes.length;
}

function normalizedPageIndexes(pages: ReadonlyArray<IndexedReaderPage>): number[] {
  return [...new Set(pages.map((page) => page.index).filter((index) => Number.isInteger(index) && index > 0))]
    .sort((left, right) => left - right);
}

function decodePublishedHtmlText(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function parseReaderChapterCacheFile(raw: unknown): ReaderChapterCacheFile | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record.fingerprint !== "string" ||
    !Array.isArray(record.chapters) ||
    !record.chapters.every(isReaderChapter)
  ) {
    return undefined;
  }
  return { fingerprint: record.fingerprint, chapters: record.chapters };
}

function isReaderChapter(value: unknown): value is ReaderChapter {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const chapter = value as Record<string, unknown>;
  return (
    Number.isInteger(chapter.index) &&
    typeof chapter.title === "string" &&
    typeof chapter.summary === "string" &&
    Number.isInteger(chapter.startPageIndex) &&
    Number.isInteger(chapter.endPageIndex)
  );
}

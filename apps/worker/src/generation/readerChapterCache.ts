import { readerChapterLayoutFitsPages, type ReaderChapter, type ReaderChapterResult } from "@book-maker/core";
import { objectKey, objectStore } from "@book-maker/storage";

// The published-Contents parser moved to core so the API (a Writing Studio
// takeover) reads the same partition; re-exported for this module's callers.
export { readerChaptersFromPublishedMarkdown } from "@book-maker/core";

/**
 * The reader-chapter model call, memoized in object storage per project.
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

export function readerChapterCachePath(projectId: string): string {
  return objectKey("books", projectId, CACHE_FILENAME);
}

export async function readCachedReaderChapters(
  projectId: string,
  fingerprint: string
): Promise<ReaderChapter[] | undefined> {
  const cached = await readReaderChapterCacheFile(projectId);
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
  projectId: string,
  pages: ReadonlyArray<IndexedReaderPage>
): Promise<ReaderChapter[] | undefined> {
  const cached = await readReaderChapterCacheFile(projectId);
  return cached && readerChapterLayoutFitsPages(cached.chapters, pages) ? cached.chapters : undefined;
}

export async function writeCachedReaderChapters(
  projectId: string,
  fingerprint: string,
  result: ReaderChapterResult
): Promise<void> {
  if (result.source !== "model") {
    return;
  }
  const file: ReaderChapterCacheFile = { fingerprint, chapters: result.chapters };
  try {
    await objectStore().put(readerChapterCachePath(projectId), JSON.stringify(file), { contentType: "application/json" });
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
  projectId: string;
  fingerprint: string;
  /** Whether this compile may pay for the chapterization call on a miss. */
  allowModelCall: boolean;
  /** The chapterization call. Made only on a miss, and only when allowed. */
  compute: () => Promise<ReaderChapterResult>;
  /** Model-free grouping, used on a miss when the call is not allowed. */
  deterministic: () => ReaderChapter[];
}): Promise<ReaderChapter[]> {
  const cached = await readCachedReaderChapters(options.projectId, options.fingerprint);
  if (cached) {
    return cached;
  }
  if (!options.allowModelCall) {
    // Not cached: a deterministic grouping is a stand-in, not a verdict, and
    // pinning it would deny the manuscript the model answer it has paid for.
    return options.deterministic();
  }
  const result = await options.compute();
  await writeCachedReaderChapters(options.projectId, options.fingerprint, result);
  return result.chapters;
}

async function readReaderChapterCacheFile(projectId: string): Promise<ReaderChapterCacheFile | undefined> {
  try {
    const bytes = await objectStore().get(readerChapterCachePath(projectId));
    if (!bytes) return undefined;
    const raw = JSON.parse(bytes.toString("utf8")) as unknown;
    return parseReaderChapterCacheFile(raw);
  } catch {
    // A missing, unreadable or malformed cache is a miss, never a failure.
    return undefined;
  }
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

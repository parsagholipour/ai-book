import type { ReaderChapter } from "./markdown.js";

/**
 * The chapter partition a published book was printed in, read back from its
 * own `book.md`.
 *
 * Two readers, one parser. The worker's presentation-only recompiles use it to
 * keep a published layout model-free (`readerChapterCache.ts`), and a Writing
 * Studio takeover uses it to give the author the chapters they read — a
 * per-page book was printed in the model's reader chapters, not its `Chapter`
 * rows, and the Contents markup is the one record of which. It lives in core so
 * the API can read it too.
 */

type IndexedReaderPage = {
  index: number;
};

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

/**
 * Whether a reader-chapter layout covers exactly these pages, in order, in two
 * or more chapters — the proof that a layout recorded for an earlier compile
 * still describes the page set in hand.
 */
export function readerChapterLayoutFitsPages(
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

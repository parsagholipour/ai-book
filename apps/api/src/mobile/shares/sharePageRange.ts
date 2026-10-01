import { parseStoredBookPdfNumbering, parseStoredBookPdfPageMap, printedPageOffset } from "@book-maker/core";

/**
 * Which sheets of the published `book.pdf` a preview share may show.
 *
 * The author picks N **reading pages**, not sheets: front matter — the cover,
 * the fallback title sheet and the Contents — is always shown and never counts
 * toward N. "Reading pages" are the sheets from the first page of prose to the
 * end of the file, which is what the published page map measures
 * (`packages/core/src/generation/pdfPageMap.ts`); the Sources back matter
 * counts, because it is part of what the reader reads.
 *
 * A map is trusted only when it describes *these* bytes: its `pdfDigest` is the
 * published file's digest and its sheet count is the file's. A map from another
 * compile, a cover-numbering stub, or no map at all falls back to the one thing
 * a stub still proves — whether sheet 1 is the unnumbered cover — and, failing
 * even that, to no front matter at all. Every fallback errs toward counting a
 * furniture sheet as a reading page, which shows *less* of the book, never more.
 */

/**
 * The most a free preview may show: half of the book's reading pages, rounded
 * down, and never fewer than one.
 *
 * **This cap is the export loophole's only lock.** A preview is a real PDF,
 * free to anyone with the link. Without a cap, a 29-of-30 preview is the whole
 * book for nothing, and the export unlock — the one thing a full share costs,
 * and what the PDF download charges — buys nothing a preview does not already
 * give away. It is applied again at serve time, because a later edit can
 * shrink the book under a preview that was legal when it was saved.
 */
export const PREVIEW_MAX_FRACTION = 0.5;

export function maxPreviewPages(readingPages: number): number {
  return Math.max(1, Math.floor(Math.max(0, readingPages) * PREVIEW_MAX_FRACTION));
}

export type SharedPdfLayout = {
  totalSheets: number;
  /** Sheets before the first reading page: always shown, never counted. */
  frontMatterSheets: number;
  /** Whether the front matter came from a measured map of these exact bytes. */
  measured: boolean;
};

export function sharedPdfLayout(input: { totalSheets: number; pdfDigest: string; storedPageMap: unknown }): SharedPdfLayout {
  const totalSheets = Math.max(0, Math.floor(input.totalSheets));
  const bounded = (front: number, measured: boolean): SharedPdfLayout => ({
    totalSheets,
    // At least one reading page, whatever a map claims.
    frontMatterSheets: Math.max(0, Math.min(front, totalSheets - 1)),
    measured
  });
  const map = parseStoredBookPdfPageMap(input.storedPageMap);
  if (map && map.pdfDigest === input.pdfDigest && map.totalPdfPages === totalSheets && map.pages.length > 0) {
    const firstContentSheet = Math.min(...map.pages.map((page) => page.startPdfPage));
    return bounded(firstContentSheet - 1, true);
  }
  const numbering = parseStoredBookPdfNumbering(input.storedPageMap);
  if (numbering && numbering.pdfDigest === input.pdfDigest) {
    return bounded(printedPageOffset(numbering), false);
  }
  return bounded(0, false);
}

export function readingPageCount(layout: SharedPdfLayout): number {
  return Math.max(0, layout.totalSheets - layout.frontMatterSheets);
}

/**
 * The sheets a preview of `requestedPages` serves: every front-matter sheet,
 * then the requested reading pages clamped to the cap. `sheets` is a count
 * from sheet 1, so the served file is exactly sheets `1..sheets`.
 */
export function previewSheetRange(
  layout: SharedPdfLayout,
  requestedPages: number
): { readingPages: number; visiblePages: number; sheets: number } {
  const readingPages = readingPageCount(layout);
  const cap = maxPreviewPages(readingPages);
  const visiblePages = Math.max(1, Math.min(Math.floor(requestedPages), cap, Math.max(1, readingPages)));
  return {
    readingPages,
    visiblePages,
    sheets: Math.min(layout.totalSheets, layout.frontMatterSheets + visiblePages)
  };
}

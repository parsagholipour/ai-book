import { parseStoredBookPdfNumbering, parseStoredBookPdfPageMap, pdfPageZone, printedPageOffset } from "@book-maker/core";

/**
 * Which sheets of the published `book.pdf` a preview share may show.
 *
 * The author picks N **reading pages**, not sheets: front matter — the cover,
 * the fallback title sheet and the Contents — is always shown and never counts
 * toward N. "Reading pages" are the sheets of prose, from the first page of it
 * to the last, which is what the published page map measures
 * (`packages/core/src/generation/pdfPageMap.ts`). Back matter — the Sources
 * list and the About the Author page, which the map knows only as one start
 * (`backMatterStartPdfPage`, anchored on whichever of them prints first) — is
 * not reading: counted, About the Author let a nine-page book preview five of
 * its pages. A sheet the back matter shares with the last prose stays a reading
 * page, because `pdfPageZone` calls it content. Back matter is never served in
 * a preview either way: it sits after every reading page, past the cap.
 *
 * A map is trusted only when it describes *these* bytes: its `pdfDigest` is the
 * published file's digest and its sheet count is the file's. A map from another
 * compile, a cover-numbering stub, or no map at all falls back to the one thing
 * a stub still proves — whether sheet 1 is the unnumbered cover — and, failing
 * even that, to no front matter at all. These fallbacks cannot establish how
 * many sheets hold prose: a long biography can occupy most of the file. Their
 * reading count stays unknown and their preview is limited to one sheet after
 * any verified cover, so they never expose more than the minimum-one cap.
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

export function maxPreviewPages(readingPages: number | null): number {
  // Total PDF sheets cannot stand in for an unmeasured prose count: padding
  // the back matter would otherwise raise the cap until all prose is free.
  if (readingPages === null) {
    return 1;
  }
  return Math.max(1, Math.floor(Math.max(0, readingPages) * PREVIEW_MAX_FRACTION));
}

export type SharedPdfLayout = {
  totalSheets: number;
  /** Sheets before the first reading page: always shown, never counted. */
  frontMatterSheets: number;
  /**
   * Sheets after the last reading page — Sources, About the Author — never
   * counted and never served. Zero unless a measured map says otherwise.
   */
  backMatterSheets: number;
  /** Whether the furniture came from a measured map of these exact bytes. */
  measured: boolean;
};

export function sharedPdfLayout(input: { totalSheets: number; pdfDigest: string; storedPageMap: unknown }): SharedPdfLayout {
  const totalSheets = Math.max(0, Math.floor(input.totalSheets));
  const bounded = (front: number, back: number, measured: boolean): SharedPdfLayout => {
    // At least one reading page, whatever a map claims.
    const frontMatterSheets = Math.max(0, Math.min(front, totalSheets - 1));
    return {
      totalSheets,
      frontMatterSheets,
      backMatterSheets: Math.max(0, Math.min(back, totalSheets - frontMatterSheets - 1)),
      measured
    };
  };
  const map = parseStoredBookPdfPageMap(input.storedPageMap);
  if (map && map.pdfDigest === input.pdfDigest && map.totalPdfPages === totalSheets && map.pages.length > 0) {
    const firstContentSheet = Math.min(...map.pages.map((page) => page.startPdfPage));
    // The trailing run of back-matter sheets: the file ends in it, and a
    // shared last sheet holding prose is "content", so it stops there.
    let backMatterSheets = 0;
    while (
      backMatterSheets < totalSheets &&
      pdfPageZone(map, totalSheets - backMatterSheets) === "back_matter"
    ) {
      backMatterSheets += 1;
    }
    return bounded(firstContentSheet - 1, backMatterSheets, true);
  }
  const numbering = parseStoredBookPdfNumbering(input.storedPageMap);
  if (numbering && numbering.pdfDigest === input.pdfDigest) {
    return bounded(printedPageOffset(numbering), 0, false);
  }
  return bounded(0, 0, false);
}

/** The prose count is unknown when this compile has no measured boundaries. */
export function readingPageCount(layout: SharedPdfLayout): number | null {
  return layout.measured ? Math.max(0, layout.totalSheets - layout.frontMatterSheets - layout.backMatterSheets) : null;
}

/**
 * The sheets a preview of `requestedPages` serves: every front-matter sheet,
 * then the requested reading pages clamped to the cap. `sheets` is a count
 * from sheet 1, so the served file is exactly sheets `1..sheets`.
 */
export function previewSheetRange(
  layout: SharedPdfLayout,
  requestedPages: number
): { readingPages: number | null; visiblePages: number; sheets: number } {
  const readingPages = readingPageCount(layout);
  const cap = maxPreviewPages(readingPages);
  const visiblePages = Math.max(1, Math.min(Math.floor(requestedPages), cap, Math.max(1, readingPages ?? 1)));
  return {
    readingPages,
    visiblePages,
    sheets: Math.min(layout.totalSheets, layout.frontMatterSheets + visiblePages)
  };
}

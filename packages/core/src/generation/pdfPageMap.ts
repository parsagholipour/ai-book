/**
 * The map from model pages — the `Page` rows a book is written and edited as —
 * to the physical sheets of the compiled PDF.
 *
 * Stored ranges are physical (pdfrx, named destinations, bookmarks): PDF page 1
 * is the cover or fallback title page when `hasCoverPage` is set. Printed
 * numbers — the footer, the Contents column, chat copy — skip that sheet only
 * on version-2 maps, measured after `@page pdf-cover { counter-reset: page 0 }`.
 * Version-1 maps were measured against PDFs that counted the cover, and stay
 * on physical numbering. {@link printedPageForPdfPage} and
 * {@link pdfPageForPrintedPage} convert; do not subtract 1 at a call site.
 *
 * The two numberings genuinely diverge: the PDF adds a cover, sometimes a title
 * page and a Contents, and each model page's prose flows across however many
 * printed pages it needs — adjacent model pages can even share one paragraph.
 * So the map is *measured*, never estimated: the renderer plants an anchor at
 * the first content of every model page, a hidden `<nav>` of internal links
 * makes Chrome emit a named destination for each (Skia writes `/Dests` only for
 * ids some link points at), and `pdfNamedDestinations.ts` reads those
 * destinations back out of the exact bytes that were published — that module is
 * the dependency-free byte parser, this one is the model built on top of it.
 * Anchor ids stay ASCII `[a-z0-9-]` so PDF name escaping never applies to ours.
 *
 * Every structural surprise returns `undefined` rather than throwing: a book
 * without a translatable map falls back to the old model-index chat behaviour,
 * and no compile may fail over it. New PDFs still skip the cover in CSS, so a
 * failed measurement still records {@link bookPdfCoverNumbering} — chrome can
 * match the footer even when chat cannot translate.
 */

import type { PdfNamedDestination, PdfNamedDestinations } from "./pdfNamedDestinations.js";

export type BookPageAnchor = {
  /** The model page this anchor marks. */
  pageIndex: number;
  /**
   * The id whose destination locates the page: `chapter-N` when the page opens
   * a printed chapter (that id already exists on the heading), `bp-N` otherwise.
   */
  destName: string;
  /**
   * Where in the compiled markdown the page's content begins — the insertion
   * point for the marker. Absent for `chapter-*` anchors, which are already in
   * the markdown.
   */
  markdownOffset?: number | undefined;
};

export type BookPdfPageRange = {
  index: number;
  startPdfPage: number;
  /**
   * Inclusive. When the next model page starts mid-page, the shared PDF page
   * belongs to both ranges; when it starts at the top of a page, it does not.
   */
  endPdfPage: number;
};

/**
 * Maps measured after `@page pdf-cover { counter-reset: page 0 }`. Printed
 * numbers skip the cover; version 1 does not.
 */
export const BOOK_PDF_PAGE_MAP_VERSION = 2 as const;

export type BookPdfPageMap = {
  version: 1 | typeof BOOK_PDF_PAGE_MAP_VERSION;
  totalPdfPages: number;
  /** True when PDF page 1 is the cover (or the fallback title page). */
  hasCoverPage: boolean;
  contentsStartPdfPage?: number;
  /** First PDF page of the Sources back matter; it may share the last prose page. */
  backMatterStartPdfPage?: number;
  pages: BookPdfPageRange[];
};

/**
 * The discriminant a cover-numbering stub wears in the stored column.
 *
 * A stub says what it is rather than being inferred from what it lacks:
 * "carries no ranges" and "is not a map at all" are different rows, and only
 * the second one may never reach chat. Reading the refusal off empty `pages`
 * conflated them, so a measured map that happened to hold no ranges — a row
 * that still states its file's totals, cover sheet and furniture starts — was
 * retired along with the stubs. {@link repointBookPdfPageMap} read it off
 * `pages` too, and degraded such a row into a stub on the next renumber.
 */
export const BOOK_PDF_COVER_NUMBERING_KIND = "cover-numbering" as const;

/**
 * Cover-skip recorded when the translatable map cannot be measured.
 *
 * New PDFs always `counter-reset: page 0` on the cover / title sheet, so
 * chrome still needs `hasCoverPage` after a failed measurement. {@link
 * BOOK_PDF_COVER_NUMBERING_KIND} is what keeps chat on model indexes:
 * {@link parseStoredBookPdfPageMap} refuses the row by that marker, while
 * {@link parseStoredBookPdfNumbering} reads the cover-skip out of it. A row
 * that predates the marker is refused anyway, because a stub describes no file
 * and so carries no `totalPdfPages`, which a map must have.
 *
 * A render writes version 2, the numbering it just produced. A stub standing in
 * for a *stored* map keeps that map's version instead: a version-1 PDF numbered
 * its own cover, and restamping it 2 makes chrome skip a number it prints.
 */
export type BookPdfCoverNumbering = {
  kind: typeof BOOK_PDF_COVER_NUMBERING_KIND;
  version: 1 | typeof BOOK_PDF_PAGE_MAP_VERSION;
  hasCoverPage: boolean;
  pages: [];
};

/** What a PDF publication may persist: a measured map, or a cover-skip stub. */
export type PersistableBookPdfPageMap = BookPdfPageMap | BookPdfCoverNumbering;

/** Version + cover-skip, enough for chrome. Full maps and stubs both qualify. */
export type BookPdfPageNumbering = Pick<BookPdfPageMap, "version" | "hasCoverPage"> & {
  totalPdfPages?: number;
  contentRevision?: number;
  pdfDigest?: string;
};

export function bookPdfCoverNumbering(
  hasCoverPage: boolean,
  version: BookPdfCoverNumbering["version"] = BOOK_PDF_PAGE_MAP_VERSION
): BookPdfCoverNumbering {
  return { kind: BOOK_PDF_COVER_NUMBERING_KIND, version, hasCoverPage, pages: [] };
}

/**
 * What to persist after a PDF render.
 *
 * A version-2 map measured against this file wins even when it carries no
 * ranges — "holds no ranges" and "was never a measurement" are different rows
 * ({@link BOOK_PDF_COVER_NUMBERING_KIND}), and only the second may become a
 * stub. Every other result — `null`/`undefined` (failed measurement) or a
 * version-1 map about different pagination — becomes a version-2
 * cover-numbering stub: replacing the PDF bytes without a successful current
 * measurement also replaces any stored translatable ranges, because neither
 * matching manuscript text nor a prior map proves the new render has the same
 * pagination.
 */
export function persistablePdfPageMapAfterRender(input: {
  pageMap: BookPdfPageMap | null | undefined;
  hasCoverPage: boolean;
}): PersistableBookPdfPageMap {
  if (input.pageMap?.version === BOOK_PDF_PAGE_MAP_VERSION) {
    return input.pageMap;
  }
  return bookPdfCoverNumbering(input.hasCoverPage);
}

/**
 * The same map with its model indexes moved to where those pages now live, or
 * `undefined` when it can no longer describe the file whole.
 *
 * A structural edit renumbers `Page.index` under a PDF that has not been
 * recompiled yet, and the reader keeps looking at that PDF for as long as the
 * exports rebuild — so the *ranges* are still true and only the indexes have
 * gone stale. Re-pointing them is exactly what `repointPageEmbeddings` does to
 * the semantic-memory scopes in the same transaction, and for the same reason:
 * an index another page now holds does not degrade, it lies.
 *
 * `moves` must name **every** page the map mentions, keyed by the index it
 * holds now. A page that is missing has been removed from the book, and the
 * whole map is refused rather than losing that one range: the ranges of a
 * measured map are contiguous from the first anchor to the last content page,
 * and {@link pdfPageZone} rests on that — a sheet covered by no range would be
 * classified as front or back matter, so a hole answers "printed page 5 is the
 * Sources list" about a page the reader can still read. A partial map that
 * translates some pages and mistranslates others is worse than no map, which is
 * the same call {@link buildBookPdfPageMap} makes about a partial measurement.
 *
 * A map that carries **no** ranges is not that refusal. It names no model page,
 * so this renumber moved nothing it says and took no sheet out from under it:
 * it comes back unchanged, totals and cover flag and furniture starts intact.
 * Reading the refusal off `map.pages` instead conflated "lost a range" with
 * "never had one" — the same conflation {@link BOOK_PDF_COVER_NUMBERING_KIND}
 * describes on the parse side — and degraded a row
 * {@link parseStoredBookPdfPageMap} deliberately keeps as live data into a stub
 * it refuses outright, taking `totalPdfPages` and the furniture with it.
 *
 * Array order is left alone — it is `startPdfPage` order, which
 * {@link nearestModelPageForPdfPage} walks — and everything describing the
 * *file* (the totals, the cover flag, the furniture starts, the publication
 * stamp) is carried through unchanged, because none of it moved.
 */
export function repointBookPdfPageMap<T extends BookPdfPageMap>(
  map: T,
  moves: ReadonlyMap<number, number>
): T | undefined {
  const pages: BookPdfPageRange[] = [];
  for (const page of map.pages) {
    const index = moves.get(page.index);
    if (index === undefined) {
      return undefined;
    }
    pages.push({ ...page, index });
  }
  return { ...map, pages };
}

/** What the publishers persist: the map stamped with the publication it measured. */
export type StoredBookPdfPageMap = BookPdfPageMap & {
  contentRevision?: number;
  pdfDigest?: string;
};

/** The id `formatContentsSection` already puts on the Contents heading. */
export const CONTENTS_DEST_NAME = "book-contents-title";
/** The id the renderer plants on the Sources heading. */
export const SOURCES_DEST_NAME = "bp-sources";

export function bookPageDestName(pageIndex: number): string {
  return `bp-${pageIndex}`;
}

export type BuildBookPdfPageMapInput = {
  anchors: BookPageAnchor[];
  hasCoverPage: boolean;
  extracted: PdfNamedDestinations;
  /**
   * The stylesheet's `@page` top margin in points — `bookPdfCss` owns the
   * value, so the renderer passes it rather than this module guessing it.
   */
  topMarginPt?: number | undefined;
};

/**
 * Derives per-model-page PDF ranges from the measured destinations.
 *
 * Whether the page that a model page *ends on* also belongs to the next one is
 * decided by the next anchor's y coordinate: a destination sitting in the
 * top-of-page band (the /MediaBox height minus the caller's top margin, with a
 * couple of lines' tolerance for a heading's own margin) means the previous
 * model page ended on the PDF page before. When the band cannot be computed the
 * boundary page stays exclusive: a too-wide range widens an edit quote, a
 * too-narrow one merely loses one shared page that quoted text still finds.
 *
 * Returns `undefined` unless every anchor resolved and the starts are
 * monotonic — a partial map would translate some pages and silently mistranslate
 * others, which is worse than the old behaviour.
 */
export function buildBookPdfPageMap(input: BuildBookPdfPageMapInput): BookPdfPageMap | undefined {
  const { anchors, extracted } = input;
  if (anchors.length === 0) {
    return undefined;
  }
  const ordered = [...anchors].sort((a, b) => a.pageIndex - b.pageIndex);
  const starts: Array<{ index: number; pdfPage: number; y: number | undefined }> = [];
  for (const anchor of ordered) {
    const dest = extracted.destinations.get(anchor.destName);
    if (!dest || dest.pdfPage < 1 || dest.pdfPage > extracted.pageCount) {
      return undefined;
    }
    starts.push({ index: anchor.pageIndex, pdfPage: dest.pdfPage, y: dest.y });
  }
  for (let i = 1; i < starts.length; i += 1) {
    if ((starts[i]?.pdfPage ?? 0) < (starts[i - 1]?.pdfPage ?? 0)) {
      return undefined;
    }
  }

  const topOfPageY = topOfPageBand(extracted.mediaBoxHeight, input.topMarginPt);
  const backMatter = extracted.destinations.get(SOURCES_DEST_NAME);
  const contents = extracted.destinations.get(CONTENTS_DEST_NAME);
  // Sources usually share the last prose page; when they open at the top of a
  // fresh one, that page belongs to the back matter and not to the last model
  // page — the same boundary rule the pages use between themselves.
  const lastContentPage =
    backMatter === undefined
      ? extracted.pageCount
      : startsAtTopOfPage(backMatter.y, topOfPageY)
        ? backMatter.pdfPage - 1
        : backMatter.pdfPage;

  const pages: BookPdfPageRange[] = starts.map((start, position) => {
    const next = starts[position + 1];
    let endPdfPage: number;
    if (!next) {
      endPdfPage = Math.max(start.pdfPage, lastContentPage);
    } else if (next.pdfPage === start.pdfPage) {
      endPdfPage = start.pdfPage;
    } else if (startsAtTopOfPage(next.y, topOfPageY)) {
      endPdfPage = next.pdfPage - 1;
    } else {
      endPdfPage = next.pdfPage;
    }
    return { index: start.index, startPdfPage: start.pdfPage, endPdfPage: Math.max(start.pdfPage, endPdfPage) };
  });

  return {
    version: BOOK_PDF_PAGE_MAP_VERSION,
    totalPdfPages: extracted.pageCount,
    hasCoverPage: input.hasCoverPage,
    ...(contents ? { contentsStartPdfPage: contents.pdfPage } : {}),
    ...(backMatter ? { backMatterStartPdfPage: backMatter.pdfPage } : {}),
    pages
  };
}

/** The model pages a reader-visible PDF page holds, in order. Empty for furniture pages. */
export function modelPageIndexesForPdfPage(map: BookPdfPageMap, pdfPage: number): number[] {
  return map.pages
    .filter((page) => page.startPdfPage <= pdfPage && pdfPage <= page.endPdfPage)
    .map((page) => page.index);
}

/**
 * The single model page a PDF page most plausibly names — for channels that
 * take one target, like an image placement. A page that *starts* on the PDF
 * page wins over one that merely runs into it, because what starts there is
 * what the reader is looking at.
 */
export function primaryModelPageForPdfPage(map: BookPdfPageMap, pdfPage: number): number | undefined {
  const covering = map.pages.filter((page) => page.startPdfPage <= pdfPage && pdfPage <= page.endPdfPage);
  const starting = covering.find((page) => page.startPdfPage === pdfPage);
  return (starting ?? covering[0])?.index;
}

/** The PDF range a set of model pages occupies, for reader-facing labels. */
export function pdfSpanForModelPages(
  map: BookPdfPageMap,
  indexes: readonly number[]
): { startPdfPage: number; endPdfPage: number } | undefined {
  const ranges = map.pages.filter((page) => indexes.includes(page.index));
  if (ranges.length === 0 || ranges.length !== new Set(indexes).size) {
    return undefined;
  }
  return {
    startPdfPage: Math.min(...ranges.map((range) => range.startPdfPage)),
    endPdfPage: Math.max(...ranges.map((range) => range.endPdfPage))
  };
}

/**
 * Like {@link primaryModelPageForPdfPage}, but a furniture page resolves to the
 * nearest content instead of nothing: the first model page starting at or after
 * it (a Contents reference lands on page one), or the last model page for the
 * back matter. Only for read-style targets — an edit target must never be
 * silently moved to a neighbouring page.
 *
 * "Nearest" is a rule for a page the book *has*. A number the book does not
 * print is not a furniture page and has no nearest prose: without this guard the
 * back-matter fallback answered every one of them, so "show me page 40" of a
 * ten-page PDF read the last page and "add a dragon on page 40" illustrated it —
 * a wrong page rather than the "there is no printed page 40" the reader asked
 * for. Anything outside resolves to nothing, matching {@link pdfPageZone}.
 */
export function nearestModelPageForPdfPage(map: BookPdfPageMap, pdfPage: number): number | undefined {
  if (pdfPageZone(map, pdfPage) === "outside") {
    return undefined;
  }
  const primary = primaryModelPageForPdfPage(map, pdfPage);
  if (primary !== undefined) {
    return primary;
  }
  const following = map.pages.find((page) => page.startPdfPage >= pdfPage);
  return (following ?? map.pages[map.pages.length - 1])?.index;
}

export type PdfPageZone = "cover" | "front_matter" | "contents" | "content" | "back_matter" | "outside";

/** What kind of page a reader is pointing at — furniture pages hold no editable text. */
export function pdfPageZone(map: BookPdfPageMap, pdfPage: number): PdfPageZone {
  if (pdfPage < 1 || pdfPage > map.totalPdfPages) {
    return "outside";
  }
  if (modelPageIndexesForPdfPage(map, pdfPage).length > 0) {
    return "content";
  }
  if (map.hasCoverPage && pdfPage === 1) {
    return "cover";
  }
  if (
    map.contentsStartPdfPage !== undefined &&
    pdfPage >= map.contentsStartPdfPage &&
    pdfPage < firstContentPdfPage(map)
  ) {
    return "contents";
  }
  if (map.backMatterStartPdfPage !== undefined && pdfPage >= map.backMatterStartPdfPage) {
    return "back_matter";
  }
  return pdfPage < firstContentPdfPage(map) ? "front_matter" : "back_matter";
}

function firstContentPdfPage(map: BookPdfPageMap): number {
  return map.pages[0]?.startPdfPage ?? map.totalPdfPages + 1;
}

/**
 * How many physical sheets sit before printed page 1. Version-2 maps skip the
 * cover (or title-page fallback); version-1 maps were measured against PDFs
 * that counted that sheet, so the offset is 0.
 *
 * The one is a guarantee held in two places, not an assumption: a manuscript
 * carries a cover *or* the fallback title page, never both (`compileBookMarkdown`),
 * and both sheets are height-capped and clipped in `pdfCss.ts` so neither can
 * fragment into a second sheet that resets the page counter again.
 */
export function printedPageOffset(map: Pick<BookPdfPageMap, "version" | "hasCoverPage">): number {
  return map.version >= BOOK_PDF_PAGE_MAP_VERSION && map.hasCoverPage ? 1 : 0;
}

/** How many numbers the footer / Contents / chat will actually print. */
export function totalPrintedPages(
  map: Pick<BookPdfPageMap, "version" | "hasCoverPage" | "totalPdfPages">
): number {
  return Math.max(0, map.totalPdfPages - printedPageOffset(map));
}

/**
 * The number printed on a physical PDF sheet. Undefined for an unnumbered cover
 * (version 2+) and for a sheet the book does not have.
 */
export function printedPageForPdfPage(
  map: Pick<BookPdfPageMap, "version" | "hasCoverPage" | "totalPdfPages">,
  pdfPage: number
): number | undefined {
  if (!Number.isInteger(pdfPage) || pdfPage < 1 || pdfPage > map.totalPdfPages) {
    return undefined;
  }
  if (printedPageOffset(map) > 0 && pdfPage === 1) {
    return undefined;
  }
  return pdfPage - printedPageOffset(map);
}

/**
 * The numbers to reprint into the Contents column — one per chapter anchor, in
 * plan order.
 *
 * `undefined` when a chapter has no printed number, which means its anchor was
 * measured onto the unnumbered cover sheet. There is no honest number for that
 * row: the physical sheet is a number from the *other* system, and writing it
 * beside rows that skip the cover puts a one-off row in a column the reader
 * compares against the footer. The Contents is rewritten whole or not at all
 * (`rewriteContentsPdfPageNumbers`), so refusing here keeps every row on the
 * compiled model indexes instead of mixing two numberings in one column.
 *
 * A missing destination is the same refusal, and unreachable besides:
 * {@link buildBookPdfPageMap} already returns `undefined` unless every anchor
 * resolved inside the document.
 */
export function contentsChapterPrintedPages(
  map: BookPdfPageMap,
  anchors: readonly BookPageAnchor[],
  destinations: ReadonlyMap<string, PdfNamedDestination>
): number[] | undefined {
  const printedPages: number[] = [];
  for (const anchor of anchors) {
    if (!anchor.destName.startsWith("chapter-")) {
      continue;
    }
    const destination = destinations.get(anchor.destName);
    if (!destination) {
      return undefined;
    }
    const printed = printedPageForPdfPage(map, destination.pdfPage);
    if (printed === undefined) {
      return undefined;
    }
    printedPages.push(printed);
  }
  return printedPages;
}

/**
 * The physical PDF sheet a spoken / footer / Contents number names. Undefined
 * when that number is not printed: below 1, not a whole number, or past the
 * end of the file.
 *
 * **No printed number can name a version-2 cover, and the arithmetic is what
 * says so — not a guard.** There used to be a third refusal here, rejecting
 * `pdfPage === 1` when the offset was positive, and it could never fire: by the
 * time it ran, `printed` was a whole number ≥ 1 (`Number.isInteger` refuses
 * `NaN` and `Infinity`, `< 1` refuses `0` and `-0`) and
 * {@link printedPageOffset} is a `1 : 0` ternary, so `printed + offset` is at
 * least 1 and *equals* 1 only when the offset is 0 — a map with no cover sheet
 * to protect. Dead code that reads like the enforcement of an invariant is
 * worse than none: the next reader has to redo this proof before they may
 * touch either line. On a covered version-2 map printed 1 is sheet 2 and every
 * later number follows; that is why `furniturePageDescription`
 * (`apps/api/src/bookPageNumbering.ts`) can say its `cover` arm is reachable
 * only through a version-1 map, whose PDF numbered its own cover sheet.
 */
export function pdfPageForPrintedPage(
  map: Pick<BookPdfPageMap, "version" | "hasCoverPage" | "totalPdfPages">,
  printed: number
): number | undefined {
  if (!Number.isInteger(printed) || printed < 1) {
    return undefined;
  }
  const pdfPage = printed + printedPageOffset(map);
  if (pdfPage < 1 || pdfPage > map.totalPdfPages) {
    return undefined;
  }
  return pdfPage;
}

/**
 * Revives a stored map (`Project.pdfPageMap`) into a typed one, or `undefined`
 * for anything malformed — rows written by a future or past shape must degrade
 * to "no map", never to a wrong translation.
 *
 * A {@link BookPdfCoverNumbering} stub is refused **by its marker**, which is
 * the one thing that says the row was never a measurement. What it holds is
 * not: a version-1 map is live data, and one whose `pages` came back empty
 * still describes its file — `totalPdfPages`, the cover flag and the furniture
 * starts are all true of it, so {@link pdfPageZone} and the printed-number
 * conversions keep working while every page target simply resolves to nothing.
 * Refusing that row too would retire a usable map to enforce a rule about a
 * different shape.
 */
export function parseStoredBookPdfPageMap(raw: unknown): StoredBookPdfPageMap | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.kind === BOOK_PDF_COVER_NUMBERING_KIND) {
    return undefined;
  }
  const version = record.version === 1 || record.version === BOOK_PDF_PAGE_MAP_VERSION ? record.version : undefined;
  if (version === undefined) {
    return undefined;
  }
  const totalPdfPages = positiveInteger(record.totalPdfPages);
  if (totalPdfPages === undefined || typeof record.hasCoverPage !== "boolean" || !Array.isArray(record.pages)) {
    return undefined;
  }
  const pages: BookPdfPageRange[] = [];
  for (const entry of record.pages) {
    if (!entry || typeof entry !== "object") {
      return undefined;
    }
    const page = entry as Record<string, unknown>;
    const index = positiveInteger(page.index);
    const startPdfPage = positiveInteger(page.startPdfPage);
    const endPdfPage = positiveInteger(page.endPdfPage);
    if (index === undefined || startPdfPage === undefined || endPdfPage === undefined || endPdfPage < startPdfPage) {
      return undefined;
    }
    pages.push({ index, startPdfPage, endPdfPage });
  }
  const contentsStartPdfPage = positiveInteger(record.contentsStartPdfPage);
  const backMatterStartPdfPage = positiveInteger(record.backMatterStartPdfPage);
  // Zero is a real stamp: Project.contentRevision starts at 0, so every
  // never-edited book publishes its map under it. Dropping it here would
  // revive the map unstamped and slip it past the staleness gate during the
  // book's first edit.
  const contentRevision = nonNegativeInteger(record.contentRevision);
  return {
    version,
    totalPdfPages,
    hasCoverPage: record.hasCoverPage,
    pages,
    ...(contentsStartPdfPage !== undefined ? { contentsStartPdfPage } : {}),
    ...(backMatterStartPdfPage !== undefined ? { backMatterStartPdfPage } : {}),
    ...(contentRevision !== undefined ? { contentRevision } : {}),
    ...(typeof record.pdfDigest === "string" ? { pdfDigest: record.pdfDigest } : {})
  };
}

/**
 * Cover-skip for chrome, from a measured map or a numbering stub — the marker
 * a stub wears is ignored here, because the cover-skip fact under it is exactly
 * what a stub is for. Chat still goes through
 * {@link parseStoredBookPdfPageMap}, which refuses one.
 */
export function parseStoredBookPdfNumbering(raw: unknown): BookPdfPageNumbering | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const version = record.version === 1 || record.version === BOOK_PDF_PAGE_MAP_VERSION ? record.version : undefined;
  if (version === undefined || typeof record.hasCoverPage !== "boolean") {
    return undefined;
  }
  const totalPdfPages = positiveInteger(record.totalPdfPages);
  const contentRevision = nonNegativeInteger(record.contentRevision);
  return {
    version,
    hasCoverPage: record.hasCoverPage,
    ...(totalPdfPages !== undefined ? { totalPdfPages } : {}),
    ...(contentRevision !== undefined ? { contentRevision } : {}),
    ...(typeof record.pdfDigest === "string" ? { pdfDigest: record.pdfDigest } : {})
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Tolerance under the top text line for an anchor that still counts as
 * "starting this page" — roughly two lines, covering a heading's own top
 * margin at a fragmentation break.
 */
const TOP_OF_PAGE_TOLERANCE_PT = 30;

function topOfPageBand(mediaBoxHeight: number | undefined, topMarginPt: number | undefined): number | undefined {
  if (mediaBoxHeight === undefined || topMarginPt === undefined) {
    return undefined;
  }
  return mediaBoxHeight - topMarginPt - TOP_OF_PAGE_TOLERANCE_PT;
}

function startsAtTopOfPage(y: number | undefined, bandFloorY: number | undefined): boolean {
  // Without a band the boundary page is left exclusive: a too-wide range
  // widens an edit quote, a too-narrow one merely loses a shared page.
  if (bandFloorY === undefined) {
    return true;
  }
  return y !== undefined && y >= bandFloorY;
}

/**
 * The map from model pages — the `Page` rows a book is written and edited as —
 * to the pages of the compiled PDF, which are the only page numbers a reader
 * ever sees: the pdfrx page indicator, the printed footer and the Contents
 * column all count physical PDF pages, cover included.
 *
 * The two numberings genuinely diverge: the PDF adds a cover, sometimes a title
 * page and a Contents, and each model page's prose flows across however many
 * printed pages it needs — adjacent model pages can even share one paragraph.
 * So the map is *measured*, never estimated: the renderer plants an anchor at
 * the first content of every model page, a hidden `<nav>` of internal links
 * makes Chrome emit a named destination for each (Skia writes `/Dests` only for
 * ids some link points at), and this module reads those destinations back out
 * of the exact bytes that were published.
 *
 * The parser is deliberately dependency-free. Skia (Chrome's PDF backend, m148
 * and m151 verified) writes a classic cross-reference table, a flat `/Dests`
 * dictionary of `name → [pageRef /XYZ x y z]` entries and a nested page tree
 * capped at 8 kids per node; only content streams are compressed. Anchor ids
 * stay ASCII `[a-z0-9-]` so PDF name escaping never applies to ours. Every
 * structural surprise returns `undefined` rather than throwing: a book without
 * a map falls back to the old behaviour, and no compile may fail over it.
 */

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

export type BookPdfPageMap = {
  version: 1;
  totalPdfPages: number;
  /** True when PDF page 1 is the cover (or the fallback title page). */
  hasCoverPage: boolean;
  contentsStartPdfPage?: number;
  /** First PDF page of the Sources back matter; it may share the last prose page. */
  backMatterStartPdfPage?: number;
  pages: BookPdfPageRange[];
};

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

export type PdfNamedDestination = { pdfPage: number; y: number | undefined };

export type PdfNamedDestinations = {
  pageCount: number;
  destinations: Map<string, PdfNamedDestination>;
  /** Height of the first page's /MediaBox in points — the y axis destinations are measured on. */
  mediaBoxHeight?: number;
};

/**
 * Reads the named destinations and the page count out of a Skia PDF.
 *
 * Object offsets come from the cross-reference table rather than a whole-file
 * scan, so the byte pattern `N 0 obj` inside a compressed stream can never
 * fabricate an object. Anything off the expected shape — an xref stream, an
 * object-stream catalog, a missing trailer — returns `undefined`.
 */
export function extractPdfNamedDestinations(pdf: Buffer): PdfNamedDestinations | undefined {
  try {
    const text = pdf.toString("latin1");
    const objects = indexObjectsFromXref(text);
    if (!objects) {
      return undefined;
    }
    const trailer = trailerDictionary(text);
    if (!trailer) {
      return undefined;
    }
    const rootRef = referenceIn(trailer, "Root");
    const catalog = rootRef === undefined ? undefined : objects.get(rootRef);
    if (!catalog) {
      return undefined;
    }

    const pagesRootRef = referenceIn(catalog, "Pages");
    if (pagesRootRef === undefined) {
      return undefined;
    }
    const pageOrder: number[] = [];
    walkPageTree(objects, pagesRootRef, pageOrder, new Set(), 0);
    if (pageOrder.length === 0) {
      return undefined;
    }
    const rootBody = objects.get(pagesRootRef) ?? "";
    const countMatch = rootBody.match(/\/Count\s+(\d+)/);
    const declaredCount = countMatch ? Number.parseInt(countMatch[1] ?? "", 10) : undefined;
    if (declaredCount !== undefined && declaredCount !== pageOrder.length) {
      return undefined;
    }
    const pageNumberOf = new Map<number, number>();
    pageOrder.forEach((objectNumber, index) => pageNumberOf.set(objectNumber, index + 1));

    const destinations = new Map<string, PdfNamedDestination>();
    const destsBody = dictionaryIn(objects, catalog, "Dests");
    if (destsBody) {
      harvestDestinations(destsBody, pageNumberOf, destinations);
    } else {
      // Defensive branch: a future Skia could move to the /Names name tree.
      const names = dictionaryIn(objects, catalog, "Names");
      const namesDests = names ? dictionaryIn(objects, names, "Dests") : undefined;
      if (namesDests) {
        harvestNameTree(objects, namesDests, pageNumberOf, destinations, new Set(), 0);
      }
    }

    const mediaBoxHeight = mediaBoxHeightIn(objects, pageOrder, pagesRootRef);
    return {
      pageCount: pageOrder.length,
      destinations,
      ...(mediaBoxHeight !== undefined ? { mediaBoxHeight } : {})
    };
  } catch {
    return undefined;
  }
}

/** The /MediaBox height, read from the first leaf that carries one, else the tree root. */
function mediaBoxHeightIn(
  objects: Map<number, string>,
  pageOrder: number[],
  pagesRootRef: number
): number | undefined {
  for (const objectNumber of [...pageOrder, pagesRootRef]) {
    const body = objects.get(objectNumber) ?? "";
    const box = body.match(/\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/);
    if (box) {
      const height = Number.parseFloat(box[4] ?? "") - Number.parseFloat(box[2] ?? "");
      if (Number.isFinite(height) && height > 0) {
        return height;
      }
    }
  }
  return undefined;
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
    version: 1,
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
 * Revives a stored map (`Project.pdfPageMap`) into a typed one, or `undefined`
 * for anything malformed — rows written by a future or past shape must degrade
 * to "no map", never to a wrong translation.
 */
export function parseStoredBookPdfPageMap(raw: unknown): StoredBookPdfPageMap | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) {
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
    version: 1,
    totalPdfPages,
    hasCoverPage: record.hasCoverPage,
    pages,
    ...(contentsStartPdfPage !== undefined ? { contentsStartPdfPage } : {}),
    ...(backMatterStartPdfPage !== undefined ? { backMatterStartPdfPage } : {}),
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

/** Object bodies by number, located through the classic cross-reference table. */
function indexObjectsFromXref(text: string): Map<number, string> | undefined {
  const tail = text.slice(-256);
  const startxref = tail.match(/startxref\s+(\d+)\s+%%EOF\s*$/);
  if (!startxref) {
    return undefined;
  }
  let xrefOffset = Number.parseInt(startxref[1] ?? "", 10);
  const offsets = new Map<number, number>();
  const seen = new Set<number>();

  // A Skia file has a single table, but an incrementally-updated PDF chains
  // /Prev sections; walk them, newest first, first offset wins.
  while (Number.isInteger(xrefOffset) && xrefOffset >= 0 && xrefOffset < text.length && !seen.has(xrefOffset)) {
    seen.add(xrefOffset);
    const section = text.slice(xrefOffset, xrefOffset + 8);
    if (!section.startsWith("xref")) {
      return undefined;
    }
    let cursor = xrefOffset + 4;
    for (;;) {
      const header = /^\s*(\d+)\s+(\d+)\s*/.exec(text.slice(cursor, cursor + 64));
      if (!header) {
        break;
      }
      const firstObject = Number.parseInt(header[1] ?? "", 10);
      const entryCount = Number.parseInt(header[2] ?? "", 10);
      cursor += header[0].length;
      for (let i = 0; i < entryCount; i += 1) {
        // Entries are fixed-width: 10-digit offset, 5-digit generation, f/n.
        const entry = text.slice(cursor, cursor + 20);
        const parsed = /^(\d{10})\s(\d{5})\s([nf])/.exec(entry);
        if (!parsed) {
          return undefined;
        }
        const objectNumber = firstObject + i;
        if (parsed[3] === "n" && !offsets.has(objectNumber)) {
          offsets.set(objectNumber, Number.parseInt(parsed[1] ?? "", 10));
        }
        cursor += 20;
      }
    }
    const trailerStart = text.indexOf("trailer", cursor);
    if (trailerStart < 0) {
      break;
    }
    const prev = /\/Prev\s+(\d+)/.exec(text.slice(trailerStart, trailerStart + 512));
    if (!prev) {
      break;
    }
    xrefOffset = Number.parseInt(prev[1] ?? "", 10);
  }

  if (offsets.size === 0) {
    return undefined;
  }
  const objects = new Map<number, string>();
  for (const [objectNumber, offset] of offsets) {
    const head = /^\s*(\d+)\s+\d+\s+obj\b/.exec(text.slice(offset, offset + 64));
    if (!head || Number.parseInt(head[1] ?? "", 10) !== objectNumber) {
      return undefined;
    }
    const bodyStart = offset + head[0].length;
    const bodyEnd = text.indexOf("endobj", bodyStart);
    if (bodyEnd < 0) {
      return undefined;
    }
    objects.set(objectNumber, text.slice(bodyStart, bodyEnd));
  }
  return objects;
}

function trailerDictionary(text: string): string | undefined {
  const trailerStart = text.lastIndexOf("trailer");
  if (trailerStart < 0) {
    return undefined;
  }
  return text.slice(trailerStart, trailerStart + 1024);
}

function referenceIn(body: string, key: string): number | undefined {
  const match = body.match(new RegExp(`\\/${key}\\s+(\\d+)\\s+\\d+\\s+R`));
  return match ? Number.parseInt(match[1] ?? "", 10) : undefined;
}

/** The dictionary a key holds, whether written inline or as an indirect reference. */
function dictionaryIn(objects: Map<number, string>, body: string, key: string): string | undefined {
  const reference = referenceIn(body, key);
  if (reference !== undefined) {
    return objects.get(reference);
  }
  const inline = body.match(new RegExp(`\\/${key}\\s*<<`));
  if (inline?.index === undefined) {
    return undefined;
  }
  let depth = 0;
  const start = body.indexOf("<<", inline.index);
  for (let i = start; i < body.length; ) {
    if (body.startsWith("<<", i)) {
      depth += 1;
      i += 2;
    } else if (body.startsWith(">>", i)) {
      depth -= 1;
      i += 2;
      if (depth === 0) {
        return body.slice(start, i);
      }
    } else {
      i += 1;
    }
  }
  return undefined;
}

function walkPageTree(
  objects: Map<number, string>,
  objectNumber: number,
  pageOrder: number[],
  visited: Set<number>,
  depth: number
): void {
  if (depth > 64 || visited.has(objectNumber)) {
    return;
  }
  visited.add(objectNumber);
  const body = objects.get(objectNumber);
  if (!body) {
    return;
  }
  if (/\/Type\s*\/Page\b/.test(body) && !/\/Type\s*\/Pages\b/.test(body)) {
    pageOrder.push(objectNumber);
    return;
  }
  const kids = body.match(/\/Kids\s*\[([^\]]*)\]/);
  if (!kids) {
    return;
  }
  const kidRe = /(\d+)\s+\d+\s+R/g;
  let kid: RegExpExecArray | null;
  while ((kid = kidRe.exec(kids[1] ?? "")) !== null) {
    walkPageTree(objects, Number.parseInt(kid[1] ?? "", 10), pageOrder, visited, depth + 1);
  }
}

/** `name → [P G R /XYZ x y z]` entries out of a flat destination dictionary. */
function harvestDestinations(
  dictionary: string,
  pageNumberOf: Map<number, number>,
  destinations: Map<string, PdfNamedDestination>
): void {
  const entryRe =
    /\/((?:[^\s/[\]<>()]|#[0-9a-fA-F]{2})+)\s*\[\s*(\d+)\s+\d+\s+R\s*\/(?:XYZ|Fit\w*)\s*([^\]]*)\]/g;
  let entry: RegExpExecArray | null;
  while ((entry = entryRe.exec(dictionary)) !== null) {
    const name = decodePdfName(entry[1] ?? "");
    const pdfPage = pageNumberOf.get(Number.parseInt(entry[2] ?? "", 10));
    if (pdfPage === undefined) {
      continue;
    }
    const coordinates = (entry[3] ?? "").trim().split(/\s+/);
    const y = Number.parseFloat(coordinates[1] ?? "");
    destinations.set(name, { pdfPage, y: Number.isFinite(y) ? y : undefined });
  }
}

/** The /Names-tree shape of the same data, flattened. Skia does not write it today. */
function harvestNameTree(
  objects: Map<number, string>,
  node: string,
  pageNumberOf: Map<number, number>,
  destinations: Map<string, PdfNamedDestination>,
  visited: Set<string>,
  depth: number
): void {
  if (depth > 64 || visited.has(node)) {
    return;
  }
  visited.add(node);
  const names = node.match(/\/Names\s*\[([\s\S]*?)\]/);
  if (names) {
    const pairRe = /\(((?:[^()\\]|\\.)*)\)\s*\[\s*(\d+)\s+\d+\s+R\s*\/(?:XYZ|Fit\w*)\s*([^\]]*)\]/g;
    let pair: RegExpExecArray | null;
    while ((pair = pairRe.exec(names[1] ?? "")) !== null) {
      const pdfPage = pageNumberOf.get(Number.parseInt(pair[2] ?? "", 10));
      if (pdfPage === undefined) {
        continue;
      }
      const coordinates = (pair[3] ?? "").trim().split(/\s+/);
      const y = Number.parseFloat(coordinates[1] ?? "");
      destinations.set(decodePdfString(pair[1] ?? ""), { pdfPage, y: Number.isFinite(y) ? y : undefined });
    }
  }
  const kids = node.match(/\/Kids\s*\[([^\]]*)\]/);
  if (kids) {
    const kidRe = /(\d+)\s+\d+\s+R/g;
    let kid: RegExpExecArray | null;
    while ((kid = kidRe.exec(kids[1] ?? "")) !== null) {
      const child = objects.get(Number.parseInt(kid[1] ?? "", 10));
      if (child) {
        harvestNameTree(objects, child, pageNumberOf, destinations, visited, depth + 1);
      }
    }
  }
}

/** `#xx` escapes in a PDF name. Our own anchor ids are ASCII and pass through. */
function decodePdfName(name: string): string {
  return name.replace(/#([0-9a-fA-F]{2})/g, (_full, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}

function decodePdfString(value: string): string {
  return value.replace(/\\([nrtbf()\\])/g, (_full, escaped: string) => {
    switch (escaped) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return escaped;
    }
  });
}

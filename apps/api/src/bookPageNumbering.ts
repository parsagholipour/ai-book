import {
  modelPageIndexesForPdfPage,
  parseStoredBookPdfNumbering,
  parseStoredBookPdfPageMap,
  pdfPageForPrintedPage,
  pdfPageZone,
  pdfSpanForModelPages,
  printedPageForPdfPage,
  primaryModelPageForPdfPage,
  type BookPdfPageMap,
  type BookPdfPageNumbering,
  type PdfPageZone,
  type StoredBookPdfPageMap
} from "@book-maker/core";
import type { BookEditIntent, BookEditPageContext } from "./bookEditIntent.js";
import { pageIndexesFromMessage, quotedTexts, spokenPageNumbersFromMessage } from "./bookEditMessage.js";

/**
 * Turning model page indexes into the numbers a reader can actually see.
 *
 * The reader's page numbers are the compiled PDF's printed numbers: the footer,
 * the Contents column and the pdfrx chrome skip the cover sheet on version-2
 * maps. Version-1 maps stay on physical numbering. Stored map ranges stay
 * physical. The system's pages are model pages. Every reply,
 * proposal card and progress string that names a page number to the user goes
 * through here so the two numbering systems can never leak into one sentence.
 *
 * Without a current map (books compiled before the map existed, measurement
 * failure) `displayPages` is the identity on model indexes — byte-for-byte the
 * copy the chat always produced. A failed measurement still records cover-skip
 * numbering so chrome can match the footer; that stub is not a map.
 *
 * DB-free on purpose: bookEditIntent.ts and its leaves run without the mobile
 * db mocks, so the map arrives as plain data.
 */
export type ReaderPageNumbering = {
  /** Present when user-visible numbers are PDF pages; parsers read it too. */
  pdfPageMap: BookPdfPageMap | undefined;
  /**
   * The manuscript revision the map was measured from, when the compile
   * stamped one. A structured `readerContext.pdfPage` is only translated
   * when the reader's cached file is this revision.
   */
  mapContentRevision?: number;
  /**
   * sha256 of the exact PDF the map was measured from, when the publication
   * recorded one. A revision cannot tell two publications apart — a repair
   * republishes the same `contentRevision` over different bytes — so this is
   * what actually authorizes translating a physical `readerContext.pdfPage`.
   */
  mapPdfDigest?: string;
  /**
   * The numbers the reader sees for these model pages: the union of their PDF
   * ranges, deduped and sorted — or the model indexes themselves without a map.
   */
  displayPages(indexes: readonly number[]): number[];
  /** The first number the reader sees for one model page. */
  displayPage(index: number): number;
  /**
   * The last number the reader sees for one model page.
   *
   * A model page is a *range* of printed sheets, so "after page N" and
   * "page N" are not the same number: model page 10 printed on sheets 12–13
   * is page 12 to a reader naming it, and the thing new pages land after is
   * sheet 13. Every "after" anchor renders through this end.
   */
  displayPageEnd(index: number): number;
  /**
   * The same end of the span, or `undefined` when a map is **in force** and
   * cannot place the page.
   *
   * `displayPageEnd` answers the model index for such a page, and in a list of
   * pages that is the right degradation — dropping a page out of "pages 3 and
   * 4" is worse than an approximate number, and it is what
   * {@link ReaderPageNumbering.displayPages} already does. Standing alone as a
   * *place* it is not: "after page 8" is read as a printed number, and a model
   * index that the map has no range for names a different sheet to the reader —
   * the one number that may never reach them. A caller that can leave the place
   * out of its sentence asks this instead and does.
   *
   * With no map at all this is the model index, exactly as `displayPageEnd` is:
   * that book's whole chat speaks model indexes, so the number is the one the
   * reader has always been given.
   */
  printedPageEnd(index: number): number | undefined;
};

/** The project fields the page-map gate reads. */
export type ProjectPageMapSource = {
  pdfPageMap?: unknown;
  contentRevision: number;
  /** When `EDITING`, a behind map still describes the PDF on screen. */
  status?: string;
};

/**
 * The project's stored map, provided it still describes the PDF the reader
 * can see. Every publication stamps the map with the revision it claimed, so
 * a map from a *settled* other revision — a row written before the compile,
 * an unmeasured repair that should have cleared the column — translates
 * nothing rather than translating wrongly.
 *
 * During EDITING that rule would do the wrong thing. The compile has not
 * published yet, the reader deliberately keeps showing the previous file, and
 * refusing the map makes a typed "page 12" fall back to a model index while
 * printed page 12 is still on screen. A behind map is kept only in that
 * window; once the project has settled it is a different PDF.
 */
export function bookPageMapForProject(project: ProjectPageMapSource): BookPdfPageMap | undefined {
  const stored = parseStoredBookPdfPageMap(project.pdfPageMap);
  if (!stored || !storedRecordDescribesProject(stored, project)) {
    return undefined;
  }
  return stored;
}

/**
 * Cover-skip for chrome: a measured map or a numbering stub, gated the same
 * way as {@link bookPageMapForProject}. Chat does not read this — a stub has
 * no ranges, so `displayPages` stays on model indexes.
 */
export function bookPdfNumberingForProject(project: ProjectPageMapSource): BookPdfPageNumbering | undefined {
  const stored = parseStoredBookPdfNumbering(project.pdfPageMap);
  if (!stored || !storedRecordDescribesProject(stored, project)) {
    return undefined;
  }
  return stored;
}

function storedRecordDescribesProject(
  stored: { contentRevision?: number },
  project: ProjectPageMapSource
): boolean {
  if (stored.contentRevision === undefined || stored.contentRevision === project.contentRevision) {
    return true;
  }
  return stored.contentRevision < project.contentRevision && project.status === "EDITING";
}

export function readerPageNumbering(pdfPageMap: BookPdfPageMap | undefined): ReaderPageNumbering {
  const mapContentRevision = (pdfPageMap as StoredBookPdfPageMap | undefined)?.contentRevision;
  const mapPdfDigest = (pdfPageMap as StoredBookPdfPageMap | undefined)?.pdfDigest;
  // One model page, one end of its printed span. Without a map at all the model
  // index *is* what this book's chat says, so that is the answer rather than a
  // failure; with one in force, a page it cannot place has no printed number,
  // and only a caller that can say nothing at all may hear the difference.
  const printedEdge = (index: number, edge: "startPdfPage" | "endPdfPage"): number | undefined => {
    if (!pdfPageMap) {
      return index;
    }
    const span = pdfSpanForModelPages(pdfPageMap, [index]);
    if (!span) {
      return undefined;
    }
    return printedPageForPdfPage(pdfPageMap, span[edge]);
  };
  return {
    pdfPageMap,
    ...(mapContentRevision !== undefined ? { mapContentRevision } : {}),
    ...(mapPdfDigest !== undefined ? { mapPdfDigest } : {}),
    displayPages(indexes: readonly number[]): number[] {
      if (!pdfPageMap) {
        return [...new Set(indexes)].sort((a, b) => a - b);
      }
      const numbers = new Set<number>();
      for (const index of indexes) {
        const span = pdfSpanForModelPages(pdfPageMap, [index]);
        if (!span) {
          // A page the map has never seen (mid-edit additions): show the raw
          // index rather than dropping the page from the sentence.
          numbers.add(index);
          continue;
        }
        for (let pdfPage = span.startPdfPage; pdfPage <= span.endPdfPage; pdfPage += 1) {
          const printed = printedPageForPdfPage(pdfPageMap, pdfPage);
          if (printed !== undefined) {
            numbers.add(printed);
          }
        }
      }
      return [...numbers].sort((a, b) => a - b);
    },
    displayPage(index: number): number {
      // The model index is the fallback both display ends have always had: a
      // page the map has never seen (a mid-edit addition) still has to appear
      // in the sentence naming it.
      return printedEdge(index, "startPdfPage") ?? index;
    },
    displayPageEnd(index: number): number {
      return printedEdge(index, "endPdfPage") ?? index;
    },
    printedPageEnd(index: number): number | undefined {
      return printedEdge(index, "endPdfPage");
    }
  };
}

/** The numbering every caller without a map already had. */
export const MODEL_PAGE_NUMBERING: ReaderPageNumbering = readerPageNumbering(undefined);

/** One-step helper for callers holding the project row. */
export function numberingForProject(project: ProjectPageMapSource): ReaderPageNumbering {
  return readerPageNumbering(bookPageMapForProject(project));
}

/**
 * The model page a selection's physical `pdfPage` refers to, when that sheet
 * was read from the very PDF the in-force map was measured from.
 *
 * The reader keeps showing a cached PDF while exports rebuild, so the
 * project's current revision is the wrong check: during EDITING the map in
 * force is the previous compile's, and after publish a stale cache must not
 * be translated through the new one.
 *
 * **The digest is the gate, not the revision.** A repair republishes the same
 * `contentRevision` over different bytes and stamps the new map with it, so
 * revision equality holds across two different PDFs: sheet 7 of the file still
 * open resolves through the map of the file that replaced it, and the edit
 * lands on whatever page that sheet holds in the *other* book. Only byte
 * identity tells those two apart — the same call
 * `coverPageMapDescribes` makes on the client
 * (`apps/mobile/lib/features/reader/domain/reader_models.dart`). Missing
 * identity on either side — a legacy map with no digest, a client that sends
 * none — is refused rather than guessed at: this channel is an optimization
 * over the page numbers the message itself already speaks, and the caller
 * falls back to parsing those.
 *
 * The revision check stays as the second half of the same assertion. A digest
 * match implies it, but an unstamped legacy map still has to be refused, and
 * saying so here keeps the reader's declared provenance load-bearing.
 */
export function modelPageForReaderContext(
  numbering: ReaderPageNumbering,
  reader: { pdfPage?: number | undefined; contentRevision?: number | undefined; pdfDigest?: string | undefined },
  projectContentRevision: number
): number | undefined {
  const map = numbering.pdfPageMap;
  if (reader.pdfPage === undefined || reader.contentRevision === undefined || !map) {
    return undefined;
  }
  const mapDigest = numbering.mapPdfDigest;
  if (mapDigest === undefined || reader.pdfDigest !== mapDigest) {
    return undefined;
  }
  const mapRevision = numbering.mapContentRevision;
  const describesReader =
    mapRevision !== undefined
      ? reader.contentRevision === mapRevision
      : reader.contentRevision === projectContentRevision;
  if (!describesReader) {
    return undefined;
  }
  return primaryModelPageForPdfPage(map, reader.pdfPage);
}

/**
 * Re-reads the router's page channels as model pages when the model copied the
 * printed numbers out of the message instead of translating them.
 *
 * `pageIndexes` is a model-index channel, and the router prompt tells the model
 * to resolve a spoken "page 12" through each page entry's `readerPages` before
 * filling it. Nothing checked that it had: a copied "12" edits model page 12,
 * which is a different page from the one printed page 12 holds — the divergence
 * the map exists to describe. The deterministic parsers translate already
 * (`pageIndexesFromMessage`), and `show_content` re-reads the message rather
 * than trusting the model; this is the same refusal for the propose/insert path.
 *
 * Returns null when the guard does not fire, which is the usual answer. It
 * fires only on the signature of a copy: every page the router named is a
 * printed number the message itself speaks, and every number spoken was named.
 * A model that translated emits indexes the message never mentions and keeps
 * them. Spoken numbers include the same page-words the length parser already
 * knows — "صفحه ۵" and "página 3" are copies just as much as "page 5".
 *
 * Channel order is the caller's: a move reads its source and destination out of
 * one channel by position, so the mapping must not re-sort them. A channel
 * whose printed numbers hold no prose (the cover, the Contents) is left exactly
 * as the router wrote it — the router has `readerPageContext` for those pages,
 * and quietly sliding an edit onto a neighbouring page is what
 * `pageIndexesFromMessage` refuses to do.
 */
export function modelPagesForCopiedPrintedPages(
  message: string,
  numbering: ReaderPageNumbering,
  channels: ReadonlyArray<readonly number[] | null | undefined>
): number[][] | null {
  const map = numbering.pdfPageMap;
  if (!map) {
    return null;
  }
  const spoken = spokenPageNumbersFromMessage(message);
  if (spoken.length === 0) {
    return null;
  }
  const named = new Set<number>();
  for (const channel of channels) {
    for (const value of channel ?? []) {
      if (Number.isInteger(value) && value > 0) {
        named.add(value);
      }
    }
  }
  if (named.size !== spoken.length || spoken.some((value) => !named.has(value))) {
    return null;
  }
  return channels.map((channel) => {
    const printed = (channel ?? []).filter((value) => Number.isInteger(value) && value > 0);
    const mapped = [
      ...new Set(
        printed.flatMap((value) => {
          const pdfPage = pdfPageForPrintedPage(map, value);
          return pdfPage === undefined ? [] : modelPageIndexesForPdfPage(map, pdfPage);
        })
      )
    ];
    return mapped.length > 0 ? mapped : [...(channel ?? [])];
  });
}

/**
 * A deterministic answer for a request aimed at a furniture page — the cover,
 * the Contents, the Sources — used on the model-less routing paths only.
 *
 * The router model gets `readerPageContext` and answers these itself; without
 * a model, a furniture number resolves to no page, the heuristics fall to
 * their catch-all clarify, and once the clarification budget is spent
 * `forcedDecision` widens the request into a whole-book rewrite card — the
 * same shape as the 960-credit heading incident. Nothing is charged before
 * Apply, but the card is still a whole-book quote for a page with no prose.
 *
 * Deliberately narrow: only when the message speaks page numbers, none of them
 * resolves to book text (through the map, the titles, or a quoted passage),
 * and every spoken number lands off the prose. Anything else routes as before.
 */
export function furniturePageIntentFromMessage(
  message: string,
  pages: BookEditPageContext[],
  numbering: ReaderPageNumbering
): BookEditIntent | null {
  const map = numbering.pdfPageMap;
  if (!map) {
    return null;
  }
  const spoken = spokenPageNumbersFromMessage(message);
  if (spoken.length === 0 || quotedTexts(message).length > 0) {
    return null;
  }
  if (pageIndexesFromMessage(message, pages, { pdfPageMap: map }).length > 0) {
    return null;
  }
  const zones = spoken.map((value) => {
    const pdfPage = pdfPageForPrintedPage(map, value);
    return pdfPage === undefined ? "outside" : pdfPageZone(map, pdfPage);
  });
  if (zones.some((zone) => zone === "content")) {
    return null;
  }
  const first = spoken[0]!;
  const storyStart = map.pages[0] ? printedPageForPdfPage(map, map.pages[0].startPdfPage) : undefined;
  const storyEnd = map.pages.length
    ? printedPageForPdfPage(map, map.pages[map.pages.length - 1]!.endPdfPage)
    : undefined;
  const story =
    storyStart !== undefined && storyEnd !== undefined
      ? ` The story runs on printed pages ${storyStart}–${storyEnd}.`
      : "";
  return {
    kind: "answer",
    confidence: 0.95,
    reasoning: "The named printed page holds no book text.",
    affectedPageIndexes: [],
    assistantMessage: `${furniturePageDescription(first, zones[0]!)}${story}`,
    scope: "none",
    impact: "small_text",
    clarification: "none"
  };
}

/**
 * The sentence for one furniture zone, named by the number the reader spoke.
 *
 * **`cover` is a version-1 answer and only ever that**, which is a property of
 * the two numbering systems rather than an oversight. A version-2 PDF resets the
 * counter on the cover sheet, so that sheet carries no printed number at all:
 * `pdfPageForPrintedPage` refuses to resolve any printed number onto sheet 1,
 * the app's chrome labels it "Cover" instead of "Page 1"
 * (`printedPageLabel`, `apps/mobile/lib/features/reader/domain/reader_models.dart`),
 * and the router prompt is told the same thing — so a version-2 reader can never
 * *mean* the cover by a number, and "page 1" is the first numbered sheet. A
 * version-1 PDF counted its cover, `printedPageOffset` is 0 for those maps, and
 * that book's footer and chrome both call the cover page 1 — so this arm is the
 * live path there, and the `default` would tell that reader their book has no
 * printed page 1. Both halves are pinned in `bookPageNumbering.test.ts`; the arm
 * looks dead against a version-2 map and is not.
 */
function furniturePageDescription(printedPage: number, zone: PdfPageZone): string {
  switch (zone) {
    case "cover":
      return `That’s the book’s cover — there’s no page text on it to edit. To change the cover, tell me what you’d like it to show.`;
    case "contents":
      return `Printed page ${printedPage} is the table of contents. It’s rebuilt from the chapters at every export, so there’s nothing on it to edit directly — say “don’t use the word Chapter” or similar to restyle its headings.`;
    case "back_matter":
      return `Printed page ${printedPage} is the Sources list at the back of the book. It’s rebuilt at every export — say “remove the sources list” if you’d like it gone.`;
    case "front_matter":
      return `Printed page ${printedPage} is the book’s front matter — there’s no page text on it to edit.`;
    default:
      return `This book’s PDF doesn’t have a printed page ${printedPage}.`;
  }
}

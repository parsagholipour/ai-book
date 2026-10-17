import {
  hasReaderFacingSources,
  includeSourcesPreference,
  modelPageIndexesForPdfPage,
  parseBookMatter,
  parseStoredBookPdfNumbering,
  parseStoredBookPdfPageMap,
  pdfPageForPrintedPage,
  pdfPageZone,
  pdfSpanForModelPages,
  printedPageForPdfPage,
  primaryModelPageForPdfPage,
  shouldPrintSourcesBackMatter,
  type BookPdfPageMap,
  type BookPdfPageNumbering,
  type ConversationLanguage,
  type PdfPageZone,
  type StoredBookPdfPageMap
} from "@book-maker/core";
import type { BookEditIntent, BookEditPageContext } from "./bookEditIntent.js";
import { bookMatterIntent } from "./bookEditMatter.js";
import { furnitureReply } from "./bookFurnitureReplyCopy.js";
import { pageIndexesFromMessage, pageIndexesMatchingText, quotedTexts, spokenPageNumbersFromMessage } from "./bookEditMessage.js";

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
  /** The first sheet of one model page, or `undefined` when a map in force cannot place it. */
  printedPageStart(index: number): number | undefined;
  /**
   * What the pages after the book's text hold, when the caller had the row to
   * say. Absent is unknown, and the chat then names them neutrally.
   */
  backMatter?: BookBackMatterContents;
  /**
   * The printed pages before the Contents that hold no book text, and what each
   * one is, when the map measured any. Absent without a map.
   */
  frontMatter?: BookFrontMatterPage[];
};

/**
 * One printed page of front matter. Since the matter pages, a covered book
 * prints its title page and then the dedication-and-publication sheets ahead of
 * the Contents; the map calls them all `front_matter` (`pdfPageZone`) without
 * recording whether the skipped first sheet was a cover or the title page.
 *
 * `title_or_matter` is the honest answer when the row cannot settle it: a
 * coverless book's title sheet is the unnumbered first sheet, so a dedication
 * spanning several pages starts at printed page 1, just as a covered book's
 * title page does. A map measured before the row last changed (EDITING keeps
 * the previous map) cannot use the current matter to narrow that answer.
 */
export type BookFrontMatterPage = {
  page: number;
  holds: "title_page" | "matter_sheet" | "title_or_matter";
};

/**
 * What the back matter the map's one start (`backMatterStartPdfPage`) opens
 * holds. The compiler anchors that start on the first back-matter heading —
 * the Sources list, or About the Author when no Sources print — so the map
 * alone cannot say which, and naming it "the Sources list" told a reader
 * asking about their bio's page to remove their sources.
 */
export type BookBackMatterContents = {
  /** The Sources list prints (and comes first). */
  sources: boolean;
  /** The About the Author page prints (always last). */
  aboutAuthor: boolean;
};

/**
 * The gap after model page `anchor` and before model page `next`, named from the
 * side the reader named it.
 *
 * "After page N" is the last sheet the anchor prints on; "before page N" is the
 * sheet `next` begins on. Both are true of every gap, and on most books they
 * are neighbouring numbers. On a book of short pages two of them can share a
 * sheet, and there they are the *same* number: "move page 6 before page 4",
 * "swap pages 4 and 5" and "put a new page before page 7" were all confirmed
 * "… after page 4/7", which reads as the opposite of the request (2026-10-02).
 * So the side follows the request, and "after" — what every stored edit means —
 * is the answer whenever "before" has no page to name. `next` is undefined past
 * the last page.
 */
export function readerPlaceOfGap(
  numbering: ReaderPageNumbering,
  anchor: number,
  next: number | undefined,
  side: "after" | "before" = "after"
): { side: "after" | "before"; readerPage: number } | undefined {
  const nextStart = side === "before" && next !== undefined ? numbering.printedPageStart(next) : undefined;
  if (nextStart !== undefined) {
    return { side: "before", readerPage: nextStart };
  }
  const readerPage = numbering.printedPageEnd(anchor);
  return readerPage === undefined ? undefined : { side: "after", readerPage };
}

/** The project fields the page-map gate reads. */
export type ProjectPageMapSource = {
  pdfPageMap?: unknown;
  contentRevision: number;
  /** When `EDITING`, a behind map still describes the PDF on screen. */
  status?: string;
  /**
   * What the compile prints after the text is read off these when every one
   * of them was loaded (`backMatterContentsForProject`); a caller without them
   * gets a numbering that names the back matter neutrally.
   */
  research?: ReadonlyArray<{ title: string; url: string | null; summary: string }>;
  bookMatter?: unknown;
  /** With `bookMatter`, says whether a matter sheet prints (`frontMatterForProject`). */
  authorName?: string | null;
  category?: string | null;
  mediaSettings?: unknown;
};

/**
 * What the book's back matter holds, decided the way the compile decides it:
 * the Sources list when the category or the reader's preference prints it and
 * a source carries a link (`backMatterEdits.ts` asks the same two questions),
 * About the Author when the book's matter has a biography. Undefined when the
 * caller did not load the fields that say.
 */
export function backMatterContentsForProject(project: ProjectPageMapSource): BookBackMatterContents | undefined {
  if (!project.research || !("bookMatter" in project) || !("category" in project) || !("mediaSettings" in project)) {
    return undefined;
  }
  const sources =
    shouldPrintSourcesBackMatter({
      category: project.category ?? undefined,
      includeSources: includeSourcesPreference(project.mediaSettings)
    }) && hasReaderFacingSources(project.research.map((source) => ({ ...source, url: source.url ?? undefined })));
  return { sources, aboutAuthor: Boolean(parseBookMatter(project.bookMatter).aboutAuthor) };
}

/** What a reader calls the back matter, from what it holds. */
export function backMatterName(contents: BookBackMatterContents | undefined): string {
  if (contents?.sources && contents.aboutAuthor) return "the Sources list and the About the Author page";
  if (contents?.sources) return "the Sources list";
  if (contents?.aboutAuthor) return "the About the Author page";
  return "the pages at the end of the book";
}

/**
 * The printed front-matter pages of the book the map measured, named from the
 * row when it describes the same revision. A matter sheet prints when the book
 * has a dedication — the compile's own test (`formatBookMatter`); the © line,
 * the imprint and the ISBN sit at the title page's foot. A book compiled before
 * 2026-10-17 printed them on a sheet of their own, and its pages are named as
 * the title page until its next compile, which is the same book_matter edit.
 */
export function frontMatterForProject(map: BookPdfPageMap, project: ProjectPageMapSource): BookFrontMatterPage[] {
  const firstText = map.pages[0]?.startPdfPage ?? map.totalPdfPages + 1;
  const printed: number[] = [];
  for (let pdfPage = 1; pdfPage < firstText; pdfPage += 1) {
    const page = pdfPageZone(map, pdfPage) === "front_matter" ? printedPageForPdfPage(map, pdfPage) : undefined;
    if (page !== undefined) printed.push(page);
  }
  if (printed.length === 0) return [];
  const known =
    "bookMatter" in project &&
    "authorName" in project &&
    (map as StoredBookPdfPageMap).contentRevision === project.contentRevision;
  const matter = parseBookMatter(project.bookMatter);
  const sheet = Boolean(matter.dedication);
  return printed.map((page, offset) => ({
    page,
    holds: !known
      ? "title_or_matter"
      : !sheet
        ? "title_page"
        // The compiler keeps the title to one sheet. After the first numbered
        // sheet, only the dedication/publication section can still continue.
        : offset > 0
          ? "matter_sheet"
          : "title_or_matter"
  }));
}

const FRONT_MATTER_NAMES: Record<BookFrontMatterPage["holds"], string> = {
  title_page: "the title page — the book's title, subtitle and author name, with the © line, the publisher and the ISBN at its foot",
  matter_sheet: "the dedication page",
  title_or_matter: "front matter — the title page (title, subtitle, author name, © line, publisher and ISBN), or the dedication page"
};

/** The front matter as the router and the matter composer are told it. */
export function frontMatterForPrompt(numbering: ReaderPageNumbering): Array<{ page: number; holds: string }> | undefined {
  return numbering.frontMatter?.length
    ? numbering.frontMatter.map((entry) => ({ page: entry.page, holds: FRONT_MATTER_NAMES[entry.holds] }))
    : undefined;
}

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

export function readerPageNumbering(
  pdfPageMap: BookPdfPageMap | undefined,
  options: { backMatter?: BookBackMatterContents | undefined; frontMatter?: BookFrontMatterPage[] | undefined } = {}
): ReaderPageNumbering {
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
    ...(options.backMatter ? { backMatter: options.backMatter } : {}),
    ...(pdfPageMap && options.frontMatter?.length ? { frontMatter: options.frontMatter } : {}),
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
    },
    printedPageStart(index: number): number | undefined {
      return printedEdge(index, "startPdfPage");
    }
  };
}

/** The numbering every caller without a map already had. */
export const MODEL_PAGE_NUMBERING: ReaderPageNumbering = readerPageNumbering(undefined);

/** One-step helper for callers holding the project row. */
export function numberingForProject(project: ProjectPageMapSource): ReaderPageNumbering {
  const map = bookPageMapForProject(project);
  const backMatter = map?.backMatterStartPdfPage !== undefined ? backMatterContentsForProject(project) : undefined;
  const frontMatter = map ? frontMatterForProject(map, project) : undefined;
  return readerPageNumbering(map, { ...(backMatter ? { backMatter } : {}), ...(frontMatter?.length ? { frontMatter } : {}) });
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
 * the Contents, the back matter — used on model-less paths and to replace a
 * routed edit that still targets furniture. The words are the conversation
 * language's entry in `FURNITURE_REPLY_COPY` (English when none was chosen),
 * settled before the reply can become the grounded answer's fallback.
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
  numbering: ReaderPageNumbering,
  responseLanguage?: ConversationLanguage
): BookEditIntent | null {
  const map = numbering.pdfPageMap;
  const zones = spokenFurnitureZones(message, pages, numbering);
  if (!map || !zones) {
    return null;
  }
  const first = zones[0]!;
  const storyStart = map.pages[0] ? printedPageForPdfPage(map, map.pages[0].startPdfPage) : undefined;
  const storyEnd = map.pages.length
    ? printedPageForPdfPage(map, map.pages[map.pages.length - 1]!.endPdfPage)
    : undefined;
  const storyRange =
    storyStart !== undefined && storyEnd !== undefined
      ? `${storyStart}–${storyEnd}`
      : undefined;
  return {
    kind: "answer",
    confidence: 0.95,
    reasoning: "The named printed page holds no book text.",
    ...(responseLanguage ? { responseLanguage } : {}),
    affectedPageIndexes: [],
    assistantMessage: furnitureReply(
      responseLanguage, first.page, first.zone,
      numbering.frontMatter?.find((entry) => entry.page === first.page)?.holds,
      numbering.backMatter, storyRange
    ),
    scope: "none",
    impact: "small_text",
    clarification: "none"
  };
}

/**
 * The printed pages a message speaks, with what each one is, when every one of
 * them lands off the book's text — null when the message speaks none, quotes a
 * passage found in the body context, or names a page of prose by number or title.
 */
export function spokenFurnitureZones(
  message: string,
  pages: BookEditPageContext[],
  numbering: ReaderPageNumbering
): Array<{ page: number; zone: PdfPageZone }> | null {
  const map = numbering.pdfPageMap;
  if (!map) {
    return null;
  }
  const spoken = spokenPageNumbersFromMessage(message);
  if (spoken.length === 0) {
    return null;
  }
  // Quotes may contain new replacement words, not a passage locating prose:
  // `change page 1 to "by Sam Lee"` still targets the printed title page.
  if (quotedTexts(message).some((quote) => pageIndexesMatchingText(quote, pages).length > 0)) {
    return null;
  }
  if (pageIndexesFromMessage(message, pages, { pdfPageMap: map }).length > 0) {
    return null;
  }
  const zones = spoken.map((page) => {
    const pdfPage = pdfPageForPrintedPage(map, page);
    return { page, zone: pdfPage === undefined ? ("outside" as const) : pdfPageZone(map, pdfPage) };
  });
  return zones.some(({ zone }) => zone === "content") ? null : zones;
}

/**
 * A routed edit aimed only at printed pages that hold no prose, taken off them.
 *
 * The router is told which printed pages are furniture (`readerPageContext`)
 * and asked not to edit them, but nothing checked that it listened, and a page
 * channel naming a furniture number is left as the router wrote it
 * (`modelPagesForCopiedPrintedPages`) — so "change page 1" on a covered book,
 * whose printed pages 1 and 2 are now the title page and the dedication sheet,
 * could be priced as a rewrite of whichever model page shares the number.
 * A text edit of front matter is a change to the book's matter, so it goes to
 * the free matter edit, whose composer is told what each printed page holds;
 * a delete or a move of it, and any edit of other furniture, gets the answer
 * the model-free path gives. An insert is left alone: "a new page after page 2"
 * names a place, and the front of the book is one.
 *
 * The router may omit its `responseLanguage`, so the reply falls back to the
 * established conversation language as the model-free path does — or a
 * Persian chat was answered in English only while the router was up.
 */
export function withoutFurniturePageEdit(
  intent: BookEditIntent,
  message: string,
  pages: BookEditPageContext[],
  numbering: ReaderPageNumbering,
  conversationLanguage?: ConversationLanguage
): BookEditIntent {
  const aimsAtPages =
    intent.kind === "page_rewrite" ||
    intent.kind === "local_patch" ||
    intent.kind === "clarify" ||
    (intent.kind === "restructure_pages" && intent.structuralEdit?.action !== "insert");
  const zones = aimsAtPages ? spokenFurnitureZones(message, pages, numbering) : null;
  if (!zones) {
    return intent;
  }
  const language = intent.responseLanguage ?? conversationLanguage;
  // Deleting or moving a front-matter page is not a matter edit: "delete page 2"
  // would clear every field on the sheet, so it is answered with what is there.
  if (intent.kind !== "restructure_pages" && zones.every(({ zone }) => zone === "front_matter")) {
    return bookMatterIntent({
      confidence: Math.max(intent.confidence, 0.8),
      reasoning: "The named printed page is front matter, printed from the book's details rather than a page.",
      assistantMessage: "I’ll change that on the book’s front matter.",
      ...(language ? { responseLanguage: language } : {})
    });
  }
  return furniturePageIntentFromMessage(message, pages, numbering, language) ?? intent;
}

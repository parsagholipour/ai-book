import {
  modelPageIndexesForPdfPage,
  parseStoredBookPdfPageMap,
  pdfPageZone,
  pdfSpanForModelPages,
  type BookPdfPageMap,
  type PdfPageZone
} from "@book-maker/core";
import type { BookEditIntent, BookEditPageContext } from "./bookEditIntent.js";
import { pageIndexesFromMessage, quotedTexts, spokenPageNumbersFromMessage } from "./bookEditMessage.js";

/**
 * Turning model page indexes into the numbers a reader can actually see.
 *
 * The reader's page numbers are the compiled PDF's: the pdfrx indicator, the
 * printed footer and the Contents column all count physical PDF pages. The
 * system's pages are model pages. Every reply, proposal card and progress
 * string that names a page number to the user goes through here so the two
 * numbering systems can never leak into one sentence.
 *
 * Without a current map (books compiled before the map existed, measurement
 * failure) `displayPages` is the identity on model indexes — byte-for-byte the
 * copy the chat always produced.
 *
 * DB-free on purpose: bookEditIntent.ts and its leaves run without the mobile
 * db mocks, so the map arrives as plain data.
 */
export type ReaderPageNumbering = {
  /** Present when user-visible numbers are PDF pages; parsers read it too. */
  pdfPageMap: BookPdfPageMap | undefined;
  /**
   * The numbers the reader sees for these model pages: the union of their PDF
   * ranges, deduped and sorted — or the model indexes themselves without a map.
   */
  displayPages(indexes: readonly number[]): number[];
  /** The first number the reader sees for one model page. */
  displayPage(index: number): number;
};

/**
 * The project's stored map, provided it still describes the published book:
 * every publication stamps the map with the revision it claimed, so a map from
 * any other revision — an edit mid-flight, a row written before the compile —
 * translates nothing rather than translating wrongly.
 */
export function bookPageMapForProject(project: {
  pdfPageMap?: unknown;
  contentRevision: number;
}): BookPdfPageMap | undefined {
  const stored = parseStoredBookPdfPageMap(project.pdfPageMap);
  if (!stored) {
    return undefined;
  }
  if (stored.contentRevision !== undefined && stored.contentRevision !== project.contentRevision) {
    return undefined;
  }
  return stored;
}

export function readerPageNumbering(pdfPageMap: BookPdfPageMap | undefined): ReaderPageNumbering {
  return {
    pdfPageMap,
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
          numbers.add(pdfPage);
        }
      }
      return [...numbers].sort((a, b) => a - b);
    },
    displayPage(index: number): number {
      if (!pdfPageMap) {
        return index;
      }
      return pdfSpanForModelPages(pdfPageMap, [index])?.startPdfPage ?? index;
    }
  };
}

/** The numbering every caller without a map already had. */
export const MODEL_PAGE_NUMBERING: ReaderPageNumbering = readerPageNumbering(undefined);

/** One-step helper for callers holding the project row. */
export function numberingForProject(project: {
  pdfPageMap?: unknown;
  contentRevision: number;
}): ReaderPageNumbering {
  return readerPageNumbering(bookPageMapForProject(project));
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
 * them; so does a message that speaks no page number this module can read —
 * "در صفحه ۵" carries no English "page N", so a Persian-only request still
 * rides on the model's own answer.
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
    const mapped = [...new Set(printed.flatMap((value) => modelPageIndexesForPdfPage(map, value)))];
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
  const zones = spoken.map((value) => pdfPageZone(map, value));
  if (zones.some((zone) => zone === "content")) {
    return null;
  }
  const first = spoken[0]!;
  const story = map.pages.length
    ? ` The story runs on printed pages ${map.pages[0]!.startPdfPage}–${map.pages[map.pages.length - 1]!.endPdfPage}.`
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

function furniturePageDescription(pdfPage: number, zone: PdfPageZone): string {
  switch (zone) {
    case "cover":
      return `Printed page ${pdfPage} is the book’s cover — there’s no page text on it to edit. To change the cover, tell me what you’d like it to show.`;
    case "contents":
      return `Printed page ${pdfPage} is the table of contents. It’s rebuilt from the chapters at every export, so there’s nothing on it to edit directly — say “don’t use the word Chapter” or similar to restyle its headings.`;
    case "back_matter":
      return `Printed page ${pdfPage} is the Sources list at the back of the book. It’s rebuilt at every export — say “remove the sources list” if you’d like it gone.`;
    case "front_matter":
      return `Printed page ${pdfPage} is the book’s front matter — there’s no page text on it to edit.`;
    default:
      return `This book’s PDF doesn’t have a printed page ${pdfPage}.`;
  }
}

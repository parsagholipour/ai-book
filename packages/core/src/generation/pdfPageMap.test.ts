import { describe, expect, it } from "vitest";
import {
  BOOK_PDF_COVER_NUMBERING_KIND,
  BOOK_PDF_PAGE_MAP_VERSION,
  bookPdfCoverNumbering,
  buildBookPdfPageMap,
  contentsChapterPrintedPages,
  modelPageIndexesForPdfPage,
  nearestModelPageForPdfPage,
  parseStoredBookPdfNumbering,
  parseStoredBookPdfPageMap,
  persistablePdfPageMapAfterRender,
  pdfPageForPrintedPage,
  pdfPageZone,
  pdfSpanForModelPages,
  printedPageForPdfPage,
  printedPageOffset,
  primaryModelPageForPdfPage,
  repointBookPdfPageMap,
  totalPrintedPages,
  type BookPageAnchor,
  type BookPdfPageMap
} from "./pdfPageMap.js";
import type { PdfNamedDestination, PdfNamedDestinations } from "./pdfNamedDestinations.js";

function extractedFixture(
  entries: Array<[string, number, number?]>,
  pageCount: number,
  mediaBoxHeight?: number
): PdfNamedDestinations {
  return {
    pageCount,
    destinations: new Map(entries.map(([name, pdfPage, y]) => [name, { pdfPage, y }] as const)),
    ...(mediaBoxHeight !== undefined ? { mediaBoxHeight } : {})
  };
}

/** A4 with the book stylesheet's 20mm top margin, as the renderer passes them. */
const A4_HEIGHT_PT = 841.89;
const TOP_MARGIN_PT = 56.69;

describe("buildBookPdfPageMap", () => {
  it("maps starts, shared boundary pages and back matter", () => {
    // Page 1 starts on PDF 3 top, runs into PDF 4 where page 2 starts mid-page;
    // page 3 starts at the top of PDF 6, so page 2 ends on PDF 5. Sources open
    // on the last prose page.
    const map = buildBookPdfPageMap({
      hasCoverPage: true,
      topMarginPt: TOP_MARGIN_PT,
      anchors: [
        { pageIndex: 1, destName: "bp-1" },
        { pageIndex: 2, destName: "bp-2" },
        { pageIndex: 3, destName: "bp-3" }
      ],
      extracted: extractedFixture(
        [
          ["bp-1", 3, 781.9],
          ["bp-2", 4, 300.2],
          ["bp-3", 6, 781.9],
          ["book-contents-title", 2, 781.9],
          ["bp-sources", 7, 200]
        ],
        7,
        A4_HEIGHT_PT
      )
    });
    expect(map).toEqual({
      version: BOOK_PDF_PAGE_MAP_VERSION,
      totalPdfPages: 7,
      hasCoverPage: true,
      contentsStartPdfPage: 2,
      backMatterStartPdfPage: 7,
      pages: [
        { index: 1, startPdfPage: 3, endPdfPage: 4 },
        { index: 2, startPdfPage: 4, endPdfPage: 5 },
        { index: 3, startPdfPage: 6, endPdfPage: 7 }
      ]
    });
  });

  it("returns undefined when an anchor has no destination", () => {
    const map = buildBookPdfPageMap({
      hasCoverPage: false,
      anchors: [
        { pageIndex: 1, destName: "bp-1" },
        { pageIndex: 2, destName: "bp-2" }
      ],
      extracted: extractedFixture([["bp-1", 1, 700]], 4)
    });
    expect(map).toBeUndefined();
  });

  it("returns undefined when starts go backwards", () => {
    const map = buildBookPdfPageMap({
      hasCoverPage: false,
      anchors: [
        { pageIndex: 1, destName: "bp-1" },
        { pageIndex: 2, destName: "bp-2" }
      ],
      extracted: extractedFixture(
        [
          ["bp-1", 5, 700],
          ["bp-2", 2, 700]
        ],
        6
      )
    });
    expect(map).toBeUndefined();
  });

  it("treats the boundary as exclusive when the page geometry is unknown", () => {
    // No /MediaBox (or no top margin passed) means no top-of-page band; the
    // shared page stays with the later model page.
    const map = buildBookPdfPageMap({
      hasCoverPage: false,
      anchors: [
        { pageIndex: 1, destName: "bp-1" },
        { pageIndex: 2, destName: "bp-2" }
      ],
      extracted: extractedFixture(
        [
          ["bp-1", 1, 700],
          ["bp-2", 3, 450]
        ],
        4
      )
    });
    expect(map?.pages).toEqual([
      { index: 1, startPdfPage: 1, endPdfPage: 2 },
      { index: 2, startPdfPage: 3, endPdfPage: 4 }
    ]);
  });
});

const sampleMap: BookPdfPageMap = {
  version: BOOK_PDF_PAGE_MAP_VERSION,
  totalPdfPages: 10,
  hasCoverPage: true,
  contentsStartPdfPage: 2,
  backMatterStartPdfPage: 9,
  pages: [
    { index: 1, startPdfPage: 3, endPdfPage: 4 },
    { index: 2, startPdfPage: 4, endPdfPage: 5 },
    { index: 3, startPdfPage: 6, endPdfPage: 9 }
  ]
};

describe("lookups", () => {
  it("resolves a PDF page to the model pages it holds", () => {
    expect(modelPageIndexesForPdfPage(sampleMap, 4)).toEqual([1, 2]);
    expect(modelPageIndexesForPdfPage(sampleMap, 6)).toEqual([3]);
    expect(modelPageIndexesForPdfPage(sampleMap, 2)).toEqual([]);
  });

  it("prefers the model page that starts on the PDF page", () => {
    expect(primaryModelPageForPdfPage(sampleMap, 4)).toBe(2);
    expect(primaryModelPageForPdfPage(sampleMap, 3)).toBe(1);
    expect(primaryModelPageForPdfPage(sampleMap, 1)).toBeUndefined();
  });

  it("snaps a furniture page to the nearest prose page", () => {
    // The cover and the Contents read as the first page of prose after them.
    expect(nearestModelPageForPdfPage(sampleMap, 1)).toBe(1);
    expect(nearestModelPageForPdfPage(sampleMap, 2)).toBe(1);
    // A content page still resolves to itself.
    expect(nearestModelPageForPdfPage(sampleMap, 4)).toBe(2);
    // The back matter has no following prose, so it reads as the last page.
    expect(nearestModelPageForPdfPage(sampleMap, 10)).toBe(3);
  });

  it("resolves a page the book does not print to nothing", () => {
    // Not furniture — no page at all. The last-page fallback used to answer
    // these, so "page 40" of a ten-page PDF read and illustrated the last page.
    expect(nearestModelPageForPdfPage(sampleMap, 11)).toBeUndefined();
    expect(nearestModelPageForPdfPage(sampleMap, 40)).toBeUndefined();
    expect(nearestModelPageForPdfPage(sampleMap, 0)).toBeUndefined();
  });

  it("spans model pages back to a PDF range", () => {
    expect(pdfSpanForModelPages(sampleMap, [1, 2])).toEqual({ startPdfPage: 3, endPdfPage: 5 });
    expect(pdfSpanForModelPages(sampleMap, [3])).toEqual({ startPdfPage: 6, endPdfPage: 9 });
    expect(pdfSpanForModelPages(sampleMap, [3, 99])).toBeUndefined();
    expect(pdfSpanForModelPages(sampleMap, [])).toBeUndefined();
  });

  it("classifies furniture pages", () => {
    expect(pdfPageZone(sampleMap, 1)).toBe("cover");
    expect(pdfPageZone(sampleMap, 2)).toBe("contents");
    expect(pdfPageZone(sampleMap, 4)).toBe("content");
    expect(pdfPageZone(sampleMap, 9)).toBe("content");
    expect(pdfPageZone(sampleMap, 10)).toBe("back_matter");
    expect(pdfPageZone(sampleMap, 11)).toBe("outside");
    expect(pdfPageZone(sampleMap, 0)).toBe("outside");
  });
});

describe("carrying a map across a renumber", () => {
  it("moves the model indexes and leaves everything about the file alone", () => {
    // Two pages inserted after the first: the PDF on screen is unchanged, so
    // only the indexes on the far side of the insertion move.
    const repointed = repointBookPdfPageMap(sampleMap, new Map([[1, 1], [2, 4], [3, 5]]));

    expect(repointed).toEqual({
      ...sampleMap,
      pages: [
        { index: 1, startPdfPage: 3, endPdfPage: 4 },
        { index: 4, startPdfPage: 4, endPdfPage: 5 },
        { index: 5, startPdfPage: 6, endPdfPage: 9 }
      ]
    });
  });

  it("carries the publication stamp through, because the file it names is the same one", () => {
    const stored = { ...sampleMap, contentRevision: 4, pdfDigest: "abc" };

    expect(repointBookPdfPageMap(stored, new Map([[1, 2], [2, 3], [3, 1]]))).toMatchObject({
      contentRevision: 4,
      pdfDigest: "abc"
    });
  });

  it("refuses the whole map when a range loses its page", () => {
    // PDF page 6 to 9 still holds page 3's prose in the file on screen. Keeping
    // the other two ranges would leave those sheets covered by nothing, which
    // `pdfPageZone` reads as back matter — a wrong sentence about a page the
    // reader can see, where no map at all is merely the old behaviour.
    expect(repointBookPdfPageMap(sampleMap, new Map([[1, 1], [2, 2]]))).toBeUndefined();
  });

  it("carries a measured map with no ranges through unchanged", () => {
    // The other emptiness, and not the same one: this map named no page, so
    // this renumber took no sheet out from under it. Refusing it here read
    // "lost a range" off `pages.length` and degraded a row
    // `parseStoredBookPdfPageMap` deliberately keeps into the stub it refuses,
    // losing the totals and the furniture starts that still describe the file.
    const rangeless: BookPdfPageMap = { ...sampleMap, pages: [] };

    expect(repointBookPdfPageMap(rangeless, new Map())).toEqual(rangeless);
    // Even a move naming pages this map never mentioned leaves it whole.
    expect(repointBookPdfPageMap(rangeless, new Map([[1, 2], [2, 1]]))).toEqual(rangeless);
    // What survives is what the reader still needs: the sheet count, the cover
    // skip and where the furniture starts.
    const carried = repointBookPdfPageMap({ ...rangeless, contentRevision: 3 }, new Map());
    expect(carried).toMatchObject({
      totalPdfPages: 10,
      hasCoverPage: true,
      contentsStartPdfPage: 2,
      backMatterStartPdfPage: 9,
      contentRevision: 3
    });
    expect(carried && pdfPageZone(carried, 1)).toBe("cover");
    expect(carried && printedPageForPdfPage(carried, 4)).toBe(3);
  });
});

describe("printed page numbers skip the cover", () => {
  it("offsets by one when the first sheet is a cover", () => {
    expect(printedPageOffset(sampleMap)).toBe(1);
    expect(totalPrintedPages(sampleMap)).toBe(9);
    expect(printedPageForPdfPage(sampleMap, 1)).toBeUndefined();
    expect(printedPageForPdfPage(sampleMap, 2)).toBe(1);
    expect(printedPageForPdfPage(sampleMap, 3)).toBe(2);
    expect(printedPageForPdfPage(sampleMap, 10)).toBe(9);
    expect(printedPageForPdfPage(sampleMap, 11)).toBeUndefined();
    expect(pdfPageForPrintedPage(sampleMap, 1)).toBe(2);
    expect(pdfPageForPrintedPage(sampleMap, 9)).toBe(10);
    expect(pdfPageForPrintedPage(sampleMap, 10)).toBeUndefined();
  });

  it("refuses a number the book does not print, and cannot land on the cover sheet", () => {
    // The refusals that are real: below 1, not a whole number, past the end.
    for (const printed of [0, -0, -1, 1.5, NaN, Infinity]) {
      expect(pdfPageForPrintedPage(sampleMap, printed)).toBeUndefined();
    }
    expect(pdfPageForPrintedPage(sampleMap, 10)).toBeUndefined();
    // And the one that is not a refusal at all but a consequence of them: with
    // `printed >= 1` and an offset of 1, sheet 1 is simply unreachable. This is
    // asserted rather than guarded — a guard for it would be dead code.
    const sheets = Array.from({ length: 12 }, (_, i) => pdfPageForPrintedPage(sampleMap, i + 1));
    expect(sheets).not.toContain(1);
    expect(sheets[0]).toBe(2);
    expect(pdfPageZone(sampleMap, 1)).toBe("cover");
  });

  it("is the identity when there is no cover sheet", () => {
    const uncovered = { ...sampleMap, hasCoverPage: false };
    expect(printedPageOffset(uncovered)).toBe(0);
    expect(totalPrintedPages(uncovered)).toBe(10);
    expect(printedPageForPdfPage(uncovered, 1)).toBe(1);
    expect(pdfPageForPrintedPage(uncovered, 1)).toBe(1);
    expect(pdfPageForPrintedPage(uncovered, 10)).toBe(10);
  });

  it("leaves version-1 maps on physical numbering, matching the PDFs they describe", () => {
    const legacy: BookPdfPageMap = { ...sampleMap, version: 1 };
    expect(printedPageOffset(legacy)).toBe(0);
    expect(totalPrintedPages(legacy)).toBe(10);
    expect(printedPageForPdfPage(legacy, 1)).toBe(1);
    expect(printedPageForPdfPage(legacy, 2)).toBe(2);
    expect(pdfPageForPrintedPage(legacy, 2)).toBe(2);
    expect(pdfPageForPrintedPage(legacy, 1)).toBe(1);
  });
});

describe("contentsChapterPrintedPages", () => {
  const anchors: BookPageAnchor[] = [
    { pageIndex: 1, destName: "chapter-1" },
    { pageIndex: 2, destName: "bp-2" },
    { pageIndex: 3, destName: "chapter-2" }
  ];
  const destinations = (pages: Record<string, number>): Map<string, PdfNamedDestination> =>
    new Map(Object.entries(pages).map(([name, pdfPage]) => [name, { pdfPage, y: 700 }]));

  it("returns one printed number per chapter, in plan order", () => {
    expect(
      contentsChapterPrintedPages(sampleMap, anchors, destinations({ "chapter-1": 3, "bp-2": 4, "chapter-2": 6 }))
    ).toEqual([2, 5]);
  });

  it("refuses the column when a chapter landed on a sheet the book does not number", () => {
    // The cover carries no printed number, so there is nothing honest to put in
    // that row. Answering with the physical sheet — 1, beside a 5 that skips the
    // cover — would print one row of a different numbering system in a column
    // the reader checks against the footer.
    expect(
      contentsChapterPrintedPages(sampleMap, anchors, destinations({ "chapter-1": 1, "bp-2": 4, "chapter-2": 6 }))
    ).toBeUndefined();
    expect(
      contentsChapterPrintedPages(sampleMap, anchors, destinations({ "chapter-1": 3, "bp-2": 4, "chapter-2": 11 }))
    ).toBeUndefined();
    expect(contentsChapterPrintedPages(sampleMap, anchors, destinations({ "chapter-1": 3, "bp-2": 4 }))).toBeUndefined();
  });

  it("numbers a coverless book from its first sheet", () => {
    const uncovered = { ...sampleMap, hasCoverPage: false };
    expect(
      contentsChapterPrintedPages(uncovered, anchors, destinations({ "chapter-1": 1, "bp-2": 4, "chapter-2": 6 }))
    ).toEqual([1, 6]);
  });
});

describe("parseStoredBookPdfPageMap", () => {
  it("round-trips a stored map with its publication stamp", () => {
    const stored = { ...sampleMap, contentRevision: 7, pdfDigest: "abc" };
    expect(parseStoredBookPdfPageMap(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it("keeps a revision-0 stamp — every never-edited book publishes under it", () => {
    const stored = { ...sampleMap, contentRevision: 0 };
    expect(parseStoredBookPdfPageMap(JSON.parse(JSON.stringify(stored)))?.contentRevision).toBe(0);
  });

  it("rejects a cover-numbering stub by its marker, at either version", () => {
    // The stub says what it is. Nothing about its *contents* is what refuses
    // it, so a stub carrying a total — or a version-1 one standing in for an
    // older stored map — is refused just the same.
    expect(parseStoredBookPdfPageMap({ ...bookPdfCoverNumbering(true), contentRevision: 7 })).toBeUndefined();
    expect(parseStoredBookPdfPageMap({ ...bookPdfCoverNumbering(false, 1), contentRevision: 7 })).toBeUndefined();
    expect(
      parseStoredBookPdfPageMap({ ...bookPdfCoverNumbering(true), totalPdfPages: 8, contentRevision: 7 })
    ).toBeUndefined();
    // A stub written before the marker existed still describes no file, and a
    // map without `totalPdfPages` is not a map.
    expect(parseStoredBookPdfPageMap({ version: 2, hasCoverPage: true, pages: [] })).toBeUndefined();
  });

  it("keeps a measured map that came back with no ranges", () => {
    // Empty `pages` is not the stub marker: this row was measured against a
    // real file, so the cover sheet and the printed-number conversions still
    // hold for it. Every page target simply resolves to nothing, which is the
    // same fallback no map at all produces — so refusing the row buys nothing
    // and costs the numbering.
    const rangeless = { ...sampleMap, version: 1 as const, pages: [], contentRevision: 3 };
    const parsed = parseStoredBookPdfPageMap(JSON.parse(JSON.stringify(rangeless)));

    expect(parsed).toEqual(rangeless);
    expect(parsed && pdfPageZone(parsed, 1)).toBe("cover");
    expect(parsed && pdfPageZone(parsed, 11)).toBe("outside");
    expect(parsed && printedPageForPdfPage(parsed, 4)).toBe(4);
    expect(parsed && nearestModelPageForPdfPage(parsed, 4)).toBeUndefined();
  });

  it("rejects malformed shapes rather than half-parsing them", () => {
    expect(parseStoredBookPdfPageMap(null)).toBeUndefined();
    expect(parseStoredBookPdfPageMap({ version: 3 })).toBeUndefined();
    expect(parseStoredBookPdfPageMap({ ...sampleMap, pages: [{ index: 1, startPdfPage: 4, endPdfPage: 2 }] })).toBeUndefined();
    expect(parseStoredBookPdfPageMap({ ...sampleMap, totalPdfPages: 0 })).toBeUndefined();
  });

  it("revives version-1 maps without promoting them", () => {
    const stored = { ...sampleMap, version: 1 as const, contentRevision: 3 };
    expect(parseStoredBookPdfPageMap(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });
});

describe("parseStoredBookPdfNumbering", () => {
  it("reads cover-skip from a measured map and from a stub", () => {
    expect(parseStoredBookPdfNumbering(sampleMap)).toEqual({
      version: BOOK_PDF_PAGE_MAP_VERSION,
      hasCoverPage: true,
      totalPdfPages: 10
    });
    expect(
      parseStoredBookPdfNumbering({ ...bookPdfCoverNumbering(true), contentRevision: 7 })
    ).toEqual({ version: 2, hasCoverPage: true, contentRevision: 7 });
    expect(printedPageOffset({ version: 2, hasCoverPage: true })).toBe(1);
    expect(printedPageOffset({ version: 2, hasCoverPage: false })).toBe(0);
  });

  it("rejects anything that is not versioned cover-skip", () => {
    expect(parseStoredBookPdfNumbering(null)).toBeUndefined();
    expect(parseStoredBookPdfNumbering({ version: 2 })).toBeUndefined();
    expect(parseStoredBookPdfNumbering({ hasCoverPage: true })).toBeUndefined();
  });
});

describe("persistablePdfPageMapAfterRender", () => {
  it("keeps a complete map measured by the current renderer", () => {
    expect(persistablePdfPageMapAfterRender({ pageMap: sampleMap, hasCoverPage: false })).toBe(sampleMap);
  });

  it("keeps a measured version-2 map that holds no ranges", () => {
    // Empty `pages` is still a measurement of this file: totals, cover skip
    // and furniture starts describe the PDF that was just rendered. Degrading
    // it to a stub because it "has no ranges" is the same conflation
    // `BOOK_PDF_COVER_NUMBERING_KIND` exists to stop on parse, and the same
    // one `repointBookPdfPageMap` already refuses to make.
    const rangeless: BookPdfPageMap = { ...sampleMap, pages: [] };
    const persisted = persistablePdfPageMapAfterRender({ pageMap: rangeless, hasCoverPage: false });

    expect(persisted).toBe(rangeless);
    expect(persisted).toEqual(rangeless);
    expect(persisted).not.toEqual(bookPdfCoverNumbering(rangeless.hasCoverPage));
    expect(persisted).not.toEqual(bookPdfCoverNumbering(false));
  });

  it.each([
    ["a legacy version-1 map", { ...sampleMap, version: 1 as const }],
    ["a null map", null],
    ["an absent map", undefined]
  ])("replaces %s with honest version-2 cover numbering", (_label, pageMap) => {
    expect(persistablePdfPageMapAfterRender({ pageMap, hasCoverPage: true })).toEqual(
      bookPdfCoverNumbering(true)
    );
  });

  it("does not preserve an existing version-2 map when this render failed to measure", () => {
    // The helper intentionally receives only this render's result. A stored
    // version-2 map is not proof about newly rendered bytes, so a failed pass
    // is represented by `undefined`, never by feeding the stored map back in.
    const existingMap = sampleMap;
    const update = persistablePdfPageMapAfterRender({ pageMap: undefined, hasCoverPage: true });
    expect(update).toEqual(bookPdfCoverNumbering(true));
    expect(update).not.toBe(existingMap);
  });

  it("stubs a render as version 2 but takes an older map's version when told to", () => {
    // A render just produced version-2 numbering. A stub standing in for a
    // *stored* map (`repointedPageMapUpdate`, when a renumber loses a range)
    // describes a file that may predate the cover counter-reset, and calling
    // that one version 2 makes chrome skip a number the footer prints.
    expect(bookPdfCoverNumbering(true)).toEqual({
      kind: BOOK_PDF_COVER_NUMBERING_KIND,
      version: 2,
      hasCoverPage: true,
      pages: []
    });
    expect(printedPageOffset(bookPdfCoverNumbering(true, 1))).toBe(0);
    expect(printedPageOffset(bookPdfCoverNumbering(true, 2))).toBe(1);
  });
});

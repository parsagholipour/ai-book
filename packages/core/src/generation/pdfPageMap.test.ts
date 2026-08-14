import { describe, expect, it } from "vitest";
import {
  buildBookPdfPageMap,
  extractPdfNamedDestinations,
  modelPageIndexesForPdfPage,
  parseStoredBookPdfPageMap,
  pdfPageZone,
  pdfSpanForModelPages,
  primaryModelPageForPdfPage,
  type BookPdfPageMap,
  type PdfNamedDestinations
} from "./pdfPageMap.js";

/**
 * A minimal PDF in the shape Skia writes: classic xref table with real byte
 * offsets, uncompressed object dictionaries, a `trailer` keyword. Object 1 must
 * be the catalog; bodies are given without the `N 0 obj` / `endobj` wrappers.
 */
function syntheticPdf(bodies: string[]): Buffer {
  let text = "%PDF-1.4\n";
  const offsets: number[] = [];
  bodies.forEach((body, index) => {
    offsets.push(text.length);
    text += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = text.length;
  text += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    text += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  text += `trailer\n<</Size ${bodies.length + 1}\n/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(text, "latin1");
}

/** Three leaves under a nested tree, destinations for two anchors and a chapter. */
function threePagePdf(): Buffer {
  return syntheticPdf([
    "<</Type /Catalog\n/Pages 2 0 R\n/Dests 6 0 R>>",
    "<</Type /Pages\n/Count 3\n/MediaBox [0 0 595.28 841.89]\n/Kids [3 0 R 7 0 R]>>",
    "<</Type /Page\n/Parent 2 0 R>>",
    "<</Type /Page\n/Parent 7 0 R>>",
    "<</Type /Page\n/Parent 7 0 R>>",
    "<</bp-1 [3 0 R /XYZ 6 781.9 0]\n/chapter-2 [4 0 R /XYZ 6 400.5 0]\n/bp-3 [5 0 R /XYZ 6 781.9 0]>>",
    "<</Type /Pages\n/Count 2\n/Parent 2 0 R\n/Kids [4 0 R 5 0 R]>>"
  ]);
}

describe("extractPdfNamedDestinations", () => {
  it("reads destinations and the page order through a nested page tree", () => {
    const extracted = extractPdfNamedDestinations(threePagePdf());
    expect(extracted).toBeDefined();
    expect(extracted?.pageCount).toBe(3);
    expect(extracted?.mediaBoxHeight).toBeCloseTo(841.89);
    expect(extracted?.destinations.get("bp-1")).toEqual({ pdfPage: 1, y: 781.9 });
    expect(extracted?.destinations.get("chapter-2")).toEqual({ pdfPage: 2, y: 400.5 });
    expect(extracted?.destinations.get("bp-3")).toEqual({ pdfPage: 3, y: 781.9 });
  });

  it("refuses a page tree whose /Count disagrees with its leaves", () => {
    const pdf = syntheticPdf([
      "<</Type /Catalog\n/Pages 2 0 R>>",
      "<</Type /Pages\n/Count 5\n/Kids [3 0 R]>>",
      "<</Type /Page\n/Parent 2 0 R>>"
    ]);
    expect(extractPdfNamedDestinations(pdf)).toBeUndefined();
  });

  it("never fabricates an object from stream content, because offsets come from the xref", () => {
    // A stream body containing the byte pattern of an object header.
    const pdf = syntheticPdf([
      "<</Type /Catalog\n/Pages 2 0 R\n/Dests 4 0 R>>",
      "<</Type /Pages\n/Count 1\n/Kids [3 0 R]>>",
      "<</Type /Page\n/Parent 2 0 R>>\nstream\n99 0 obj <</Type /Page>> endobj\nendstream",
      "<</bp-1 [3 0 R /XYZ 6 700 0]>>"
    ]);
    const extracted = extractPdfNamedDestinations(pdf);
    expect(extracted?.pageCount).toBe(1);
    expect(extracted?.destinations.get("bp-1")?.pdfPage).toBe(1);
  });

  it("returns undefined for bytes with no trailer", () => {
    expect(extractPdfNamedDestinations(Buffer.from("%PDF-1.4 not a real file"))).toBeUndefined();
  });

  it("decodes #-escaped destination names", () => {
    const pdf = syntheticPdf([
      "<</Type /Catalog\n/Pages 2 0 R\n/Dests 4 0 R>>",
      "<</Type /Pages\n/Count 1\n/Kids [3 0 R]>>",
      "<</Type /Page\n/Parent 2 0 R>>",
      "<</with#20space [3 0 R /XYZ 0 10 0]>>"
    ]);
    expect(extractPdfNamedDestinations(pdf)?.destinations.get("with space")?.pdfPage).toBe(1);
  });
});

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
      version: 1,
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
  version: 1,
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

describe("parseStoredBookPdfPageMap", () => {
  it("round-trips a stored map with its publication stamp", () => {
    const stored = { ...sampleMap, contentRevision: 7, pdfDigest: "abc" };
    expect(parseStoredBookPdfPageMap(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it("rejects malformed shapes rather than half-parsing them", () => {
    expect(parseStoredBookPdfPageMap(null)).toBeUndefined();
    expect(parseStoredBookPdfPageMap({ version: 2 })).toBeUndefined();
    expect(parseStoredBookPdfPageMap({ ...sampleMap, pages: [{ index: 1, startPdfPage: 4, endPdfPage: 2 }] })).toBeUndefined();
    expect(parseStoredBookPdfPageMap({ ...sampleMap, totalPdfPages: 0 })).toBeUndefined();
  });
});

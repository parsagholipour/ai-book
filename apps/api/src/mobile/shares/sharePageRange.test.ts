import { describe, expect, it } from "vitest";
import { maxPreviewPages, previewSheetRange, readingPageCount, sharedPdfLayout } from "./sharePageRange.js";

/**
 * A 30-sheet book: sheet 1 the cover, 2 a title sheet, 3–4 the Contents, prose
 * from sheet 5 to 30 (26 reading pages). The map is stamped with the digest of
 * the bytes it measured, as the publisher writes it.
 */
const DIGEST = "d".repeat(64);
const MAP = {
  version: 2,
  totalPdfPages: 30,
  hasCoverPage: true,
  contentsStartPdfPage: 3,
  pages: [
    { index: 1, startPdfPage: 5, endPdfPage: 9 },
    { index: 2, startPdfPage: 9, endPdfPage: 20 },
    { index: 3, startPdfPage: 21, endPdfPage: 30 }
  ],
  contentRevision: 4,
  pdfDigest: DIGEST
};

describe("the preview cap", () => {
  it("is half the reading pages, rounded down, never below one", () => {
    expect(maxPreviewPages(30)).toBe(15);
    expect(maxPreviewPages(29)).toBe(14);
    expect(maxPreviewPages(3)).toBe(1);
    expect(maxPreviewPages(1)).toBe(1);
    expect(maxPreviewPages(0)).toBe(1);
  });
});

describe("sharedPdfLayout", () => {
  it("shows the cover, title sheet and Contents without counting them", () => {
    const layout = sharedPdfLayout({ totalSheets: 30, pdfDigest: DIGEST, storedPageMap: MAP });

    expect(layout).toEqual({ totalSheets: 30, frontMatterSheets: 4, measured: true });
    expect(readingPageCount(layout)).toBe(26);
    // N = 6 reading pages → sheets 1..10: four of furniture, six of prose.
    expect(previewSheetRange(layout, 6)).toEqual({ readingPages: 26, visiblePages: 6, sheets: 10 });
  });

  it("clamps a request past the cap to the cap, so the preview is never most of the book", () => {
    const layout = sharedPdfLayout({ totalSheets: 30, pdfDigest: DIGEST, storedPageMap: MAP });

    expect(previewSheetRange(layout, 25)).toEqual({ readingPages: 26, visiblePages: 13, sheets: 17 });
    expect(previewSheetRange(layout, 0).visiblePages).toBe(1);
  });

  it("does not trust a map measured against other bytes, and falls back to the cover alone", () => {
    const layout = sharedPdfLayout({ totalSheets: 30, pdfDigest: "e".repeat(64), storedPageMap: MAP });

    expect(layout).toEqual({ totalSheets: 30, frontMatterSheets: 0, measured: false });
  });

  it("reads a cover-numbering stub for these bytes as a one-sheet front matter", () => {
    const stub = { kind: "cover-numbering", version: 2, hasCoverPage: true, pages: [], pdfDigest: DIGEST };

    const layout = sharedPdfLayout({ totalSheets: 12, pdfDigest: DIGEST, storedPageMap: stub });

    expect(layout).toEqual({ totalSheets: 12, frontMatterSheets: 1, measured: false });
    expect(previewSheetRange(layout, 5)).toEqual({ readingPages: 11, visiblePages: 5, sheets: 6 });
  });

  it("counts every sheet as a reading page when nothing describes the file — the side that shows less", () => {
    const layout = sharedPdfLayout({ totalSheets: 10, pdfDigest: DIGEST, storedPageMap: null });

    expect(previewSheetRange(layout, 99)).toEqual({ readingPages: 10, visiblePages: 5, sheets: 5 });
  });

  it("refuses a map whose sheet count disagrees with the file", () => {
    const layout = sharedPdfLayout({ totalSheets: 31, pdfDigest: DIGEST, storedPageMap: MAP });

    expect(layout.measured).toBe(false);
  });

  it("keeps at least one reading page whatever a map claims", () => {
    const odd = { ...MAP, totalPdfPages: 4, pages: [{ index: 1, startPdfPage: 9, endPdfPage: 9 }] };

    const layout = sharedPdfLayout({ totalSheets: 4, pdfDigest: DIGEST, storedPageMap: odd });

    expect(layout.frontMatterSheets).toBe(3);
    expect(previewSheetRange(layout, 1)).toEqual({ readingPages: 1, visiblePages: 1, sheets: 4 });
  });
});

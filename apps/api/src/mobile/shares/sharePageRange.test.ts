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
    expect(maxPreviewPages(null)).toBe(1);
  });
});

describe("sharedPdfLayout", () => {
  it("shows the cover, title sheet and Contents without counting them", () => {
    const layout = sharedPdfLayout({ totalSheets: 30, pdfDigest: DIGEST, storedPageMap: MAP });

    expect(layout).toEqual({ totalSheets: 30, frontMatterSheets: 4, backMatterSheets: 0, measured: true });
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

    expect(layout).toEqual({ totalSheets: 30, frontMatterSheets: 0, backMatterSheets: 0, measured: false });
  });

  it("reads a cover-numbering stub for these bytes as a one-sheet front matter", () => {
    const stub = { kind: "cover-numbering", version: 2, hasCoverPage: true, pages: [], pdfDigest: DIGEST };

    const layout = sharedPdfLayout({ totalSheets: 12, pdfDigest: DIGEST, storedPageMap: stub });

    expect(layout).toEqual({ totalSheets: 12, frontMatterSheets: 1, backMatterSheets: 0, measured: false });
    expect(previewSheetRange(layout, 5)).toEqual({ readingPages: null, visiblePages: 1, sheets: 2 });
  });

  it("serves only the first sheet when nothing describes the file", () => {
    const layout = sharedPdfLayout({ totalSheets: 10, pdfDigest: DIGEST, storedPageMap: null });

    expect(previewSheetRange(layout, 99)).toEqual({ readingPages: null, visiblePages: 1, sheets: 1 });
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

/**
 * A nine-page book behind a cover: sheet 1 the cover, one prose page a sheet
 * on 2–10, and the About the Author page opening a fresh sheet 11 — the first
 * back matter when no Sources print, so the map's back-matter start points at
 * it.
 */
const NINE_PAGES = {
  version: 2,
  totalPdfPages: 11,
  hasCoverPage: true,
  backMatterStartPdfPage: 11,
  pages: Array.from({ length: 9 }, (_, i) => ({ index: i + 1, startPdfPage: i + 2, endPdfPage: i + 2 })),
  contentRevision: 1,
  pdfDigest: DIGEST
};

describe("back matter", () => {
  it("does not count the About the Author sheet, so a nine-page book previews four pages, not five", () => {
    const layout = sharedPdfLayout({ totalSheets: 11, pdfDigest: DIGEST, storedPageMap: NINE_PAGES });

    expect(layout).toEqual({ totalSheets: 11, frontMatterSheets: 1, backMatterSheets: 1, measured: true });
    expect(readingPageCount(layout)).toBe(9);
    expect(maxPreviewPages(readingPageCount(layout))).toBe(4);
    // The cover and four pages of prose: never the bio.
    expect(previewSheetRange(layout, 99)).toEqual({ readingPages: 9, visiblePages: 4, sheets: 5 });
  });

  it("does not count a Sources list running over several sheets either", () => {
    const withSources = { ...NINE_PAGES, totalPdfPages: 13 };

    const layout = sharedPdfLayout({ totalSheets: 13, pdfDigest: DIGEST, storedPageMap: withSources });

    expect(layout.backMatterSheets).toBe(3);
    expect(readingPageCount(layout)).toBe(9);
  });

  it("keeps a sheet the back matter shares with the last prose as a reading page", () => {
    // The Sources heading lands mid-sheet on 10, after the last page's prose,
    // and runs on to 11 and 12.
    const shared = { ...NINE_PAGES, totalPdfPages: 12, backMatterStartPdfPage: 10 };

    const layout = sharedPdfLayout({ totalSheets: 12, pdfDigest: DIGEST, storedPageMap: shared });

    expect(layout.backMatterSheets).toBe(2);
    expect(readingPageCount(layout)).toBe(9);
  });

  it("only ever lowers what a measured map serves, and never reaches the back matter", () => {
    for (let back = 0; back <= 6; back += 1) {
      const total = 10 + back;
      const map = { ...NINE_PAGES, totalPdfPages: total, ...(back ? { backMatterStartPdfPage: 11 } : {}) };
      const layout = sharedPdfLayout({ totalSheets: total, pdfDigest: DIGEST, storedPageMap: map });
      const counted = { ...layout, backMatterSheets: 0 };
      for (const requested of [1, 4, 5, 99]) {
        const range = previewSheetRange(layout, requested);
        expect(range.sheets).toBeLessThanOrEqual(previewSheetRange(counted, requested).sheets);
        expect(range.sheets).toBeLessThanOrEqual(total - layout.backMatterSheets);
      }
    }
  });

  it("limits unmeasured fallbacks to one sheet beyond any verified cover", () => {
    const stub = { kind: "cover-numbering", version: 2, hasCoverPage: true, pages: [], pdfDigest: DIGEST };

    const fromStub = sharedPdfLayout({ totalSheets: 11, pdfDigest: DIGEST, storedPageMap: stub });
    const fromNothing = sharedPdfLayout({ totalSheets: 11, pdfDigest: DIGEST, storedPageMap: null });
    const fromOtherBytes = sharedPdfLayout({ totalSheets: 11, pdfDigest: "e".repeat(64), storedPageMap: NINE_PAGES });

    expect(fromStub).toEqual({ totalSheets: 11, frontMatterSheets: 1, backMatterSheets: 0, measured: false });
    expect(previewSheetRange(fromStub, 99)).toEqual({ readingPages: null, visiblePages: 1, sheets: 2 });
    expect(fromNothing.backMatterSheets).toBe(0);
    expect(previewSheetRange(fromNothing, 99)).toEqual({ readingPages: null, visiblePages: 1, sheets: 1 });
    expect(fromOtherBytes.backMatterSheets).toBe(0);
    expect(previewSheetRange(fromOtherBytes, 99)).toEqual({ readingPages: null, visiblePages: 1, sheets: 1 });
  });

  it("keeps at least one reading page whatever a map claims about the back matter", () => {
    // A map whose only page starts past the file's end: every sheet after the
    // cover reads as back matter.
    const odd = { ...NINE_PAGES, totalPdfPages: 3, backMatterStartPdfPage: 2, pages: [{ index: 1, startPdfPage: 9, endPdfPage: 9 }] };

    const layout = sharedPdfLayout({ totalSheets: 3, pdfDigest: DIGEST, storedPageMap: odd });

    expect(readingPageCount(layout)).toBe(1);
    expect(previewSheetRange(layout, 1).visiblePages).toBe(1);
  });
});

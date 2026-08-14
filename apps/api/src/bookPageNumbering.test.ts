import { describe, expect, it } from "vitest";
import { bookPageMapForProject, furniturePageIntentFromMessage, readerPageNumbering } from "./bookPageNumbering.js";

const map = {
  version: 1,
  totalPdfPages: 10,
  hasCoverPage: true,
  contentsStartPdfPage: 2,
  pages: [
    { index: 1, startPdfPage: 3, endPdfPage: 4 },
    { index: 2, startPdfPage: 4, endPdfPage: 5 },
    { index: 3, startPdfPage: 6, endPdfPage: 9 }
  ],
  contentRevision: 7
};

describe("bookPageMapForProject", () => {
  it("uses the stored map only while its revision is the project's", () => {
    expect(bookPageMapForProject({ pdfPageMap: map, contentRevision: 7 })).toBeDefined();
    // An edit bumped the revision: the map describes the old PDF and must not translate.
    expect(bookPageMapForProject({ pdfPageMap: map, contentRevision: 8 })).toBeUndefined();
    // A never-edited book is stamped 0; that stamp must gate too.
    const fresh = { ...map, contentRevision: 0 };
    expect(bookPageMapForProject({ pdfPageMap: fresh, contentRevision: 0 })).toBeDefined();
    expect(bookPageMapForProject({ pdfPageMap: fresh, contentRevision: 1 })).toBeUndefined();
    expect(bookPageMapForProject({ pdfPageMap: null, contentRevision: 7 })).toBeUndefined();
    expect(bookPageMapForProject({ pdfPageMap: { junk: true }, contentRevision: 7 })).toBeUndefined();
  });
});

describe("readerPageNumbering", () => {
  it("shows printed pages with a map and model indexes without", () => {
    const numbering = readerPageNumbering(bookPageMapForProject({ pdfPageMap: map, contentRevision: 7 }));
    expect(numbering.displayPage(1)).toBe(3);
    expect(numbering.displayPages([1])).toEqual([3, 4]);
    // Adjacent model pages share printed page 4; the union dedupes it.
    expect(numbering.displayPages([1, 2])).toEqual([3, 4, 5]);
    // A page the map has never seen keeps its raw index.
    expect(numbering.displayPages([99])).toEqual([99]);

    const fallback = readerPageNumbering(undefined);
    expect(fallback.displayPage(1)).toBe(1);
    expect(fallback.displayPages([2, 1, 2])).toEqual([1, 2]);
  });
});

describe("furniturePageIntentFromMessage", () => {
  const numbering = readerPageNumbering(bookPageMapForProject({ pdfPageMap: map, contentRevision: 7 }));
  const pages = [1, 2, 3].map((index) => ({
    id: `page-${index}`,
    index,
    title: `The ${index} Winds`,
    summary: "",
    previewText: ""
  }));

  it("answers a contents-page reference instead of leaving it to the whole-book widening", () => {
    const intent = furniturePageIntentFromMessage("fix page 2", pages, numbering);
    expect(intent?.kind).toBe("answer");
    expect(intent?.clarification).toBe("none");
    expect(intent?.assistantMessage).toContain("table of contents");
    expect(intent?.assistantMessage).toContain("pages 3–9");
  });

  it("answers cover and out-of-range references", () => {
    expect(furniturePageIntentFromMessage("edit page 1", pages, numbering)?.assistantMessage).toContain("cover");
    expect(furniturePageIntentFromMessage("rewrite page 40", pages, numbering)?.assistantMessage).toContain(
      "doesn’t have a printed page 40"
    );
  });

  it("stands aside whenever the message can be routed as content", () => {
    // A number that reaches prose routes normally.
    expect(furniturePageIntentFromMessage("fix page 5", pages, numbering)).toBeNull();
    // A quoted passage can be found regardless of the number.
    expect(furniturePageIntentFromMessage('on page 2, replace "storm" with "gale"', pages, numbering)).toBeNull();
    // No spoken number at all.
    expect(furniturePageIntentFromMessage("make the ending warmer", pages, numbering)).toBeNull();
    // Without a map the numbers are model indexes and route as before.
    expect(furniturePageIntentFromMessage("fix page 2", pages, readerPageNumbering(undefined))).toBeNull();
  });
});

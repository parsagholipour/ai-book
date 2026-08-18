import { describe, expect, it } from "vitest";
import {
  anchorModelPageIndex,
  imagePlacementFromMessage,
  pageAnchorFromMessage,
  pageIndexesFromMessage,
  replanTargetPagesFromMessage,
  showContentTargetFromMessage,
  targetLanguageFromLanguageVersionRequest
} from "./bookEditMessage.js";

describe("pageIndexesFromMessage", () => {
  // Titles that share no words with the messages below, so only the numeral
  // path can produce a match.
  const pages = ["Opening", "Rising", "Middle", "Turning", "Close"].map((title, offset) => ({
    id: `page-${offset + 1}`,
    index: offset + 1,
    title,
    summary: "",
    previewText: ""
  }));

  it("reads a page reference typed in the user's own numerals", () => {
    // The reader writes "On page 4" itself, but a reader typing by hand uses the
    // digits their keyboard produces — and, in Persian, the word for page too.
    expect(pageIndexesFromMessage("page ۴ needs a rewrite", pages)).toEqual([4]);
    expect(pageIndexesFromMessage("pages ۲-۴", pages)).toEqual([2, 3, 4]);
    expect(pageIndexesFromMessage("صفحه ۵ را بامزه‌تر بنویس", pages)).toEqual([5]);
    expect(pageIndexesFromMessage("در صفحه ۵ یک عکس از اژدها اضافه کن", pages)).toEqual([5]);
    expect(pageIndexesFromMessage("صفحهٔ ۵", pages)).toEqual([5]);
    expect(pageIndexesFromMessage("الصفحة 4", pages)).toEqual([4]);
  });

  it("still reads the reader's own English references", () => {
    expect(pageIndexesFromMessage('On page 3, rewrite this passage: "x".', pages)).toEqual([3]);
  });

  it("reads ordinal and word-number page references", () => {
    expect(pageIndexesFromMessage("fix the typo on the 3rd page", pages)).toEqual([3]);
    expect(pageIndexesFromMessage("the second page is too long", pages)).toEqual([2]);
    expect(pageIndexesFromMessage("rewrite page four", pages)).toEqual([4]);
    // Named pages that don't exist are still filtered against the real book.
    expect(pageIndexesFromMessage("the twelfth page", pages)).toEqual([]);
  });

  it("reads every page of a list, not just the first", () => {
    // Reading only "3" here is not a smaller answer than [3,5]: the router may
    // still name both, and then the copy guard sees a spoken set that does not
    // match the router's, declines to translate, and printed numbers get used
    // as model indexes. The parser has to see the whole list.
    expect(pageIndexesFromMessage("edit pages 1, 3 and 5", pages)).toEqual([1, 3, 5]);
    expect(pageIndexesFromMessage("polish pages 1-3, 5", pages)).toEqual([1, 2, 3, 5]);
    expect(pageIndexesFromMessage("صفحات ۱، ۳ و ۵ را بامزه‌تر بنویس", pages)).toEqual([1, 3, 5]);
  });

  it("stops a list at the first thing that is not a page number", () => {
    // A separator only continues the list when a number follows it, so an
    // ordinary "and" clause cannot drag an unrelated count into the target set.
    expect(pageIndexesFromMessage("rewrite page 3 and make the ending warmer", pages)).toEqual([3]);
    expect(pageIndexesFromMessage("rewrite page 3 and add 5 pictures", pages)).toEqual([3]);
  });
});

describe("replanTargetPagesFromMessage", () => {
  it("still reads a real length request", () => {
    expect(replanTargetPagesFromMessage("make it 3 pages without illustrations")).toBe(3);
    expect(replanTargetPagesFromMessage("I want a 24 page workbook")).toBe(24);
  });

  it("never reads pages being added as the book's new length", () => {
    // A length routes the request as book_replan, which regenerates the whole
    // book into a copy at that size — so "add 3 pages" used to hand the reader
    // a three-page book. The anchored form is caught by the page-reference
    // guard, the bare one by the additive guard in explicitTargetPagesFromText.
    expect(replanTargetPagesFromMessage("add 3 pages after page 10")).toBeUndefined();
    expect(replanTargetPagesFromMessage("add 3 pages at the end")).toBeUndefined();
    expect(replanTargetPagesFromMessage("insert 2 more pages")).toBeUndefined();
  });
});

describe("targetLanguageFromLanguageVersionRequest", () => {
  it("reads a real request for another language version", () => {
    expect(targetLanguageFromLanguageVersionRequest("create a Spanish version of this book")).toBe(
      "Spanish"
    );
    expect(targetLanguageFromLanguageVersionRequest("translate the whole book into German")).toBe(
      "German"
    );
    expect(targetLanguageFromLanguageVersionRequest("change the language to Korean")).toBe("Korean");
    expect(targetLanguageFromLanguageVersionRequest("make a Japanese copy")).toBe("Japanese");
  });

  // A hit here forces kind "book_replan" in bookEditHeuristics, i.e. a paid
  // regeneration of the whole book in a language nobody asked for.
  it("ignores a language named as subject matter", () => {
    expect(
      targetLanguageFromLanguageVersionRequest(
        "make chapter 2 about how aliens are portrayed in Chinese media"
      )
    ).toBeNull();
    expect(
      targetLanguageFromLanguageVersionRequest("rewrite page 4 so the alien lands in Japanese waters")
    ).toBeNull();
    expect(
      targetLanguageFromLanguageVersionRequest("create a chapter on jazz in French colonial Africa")
    ).toBeNull();
    expect(targetLanguageFromLanguageVersionRequest("make the ending more hopeful")).toBeNull();
  });
});

describe("reader page numbers through the PDF page map", () => {
  const map = {
    version: 2 as const,
    totalPdfPages: 12,
    hasCoverPage: true,
    contentsStartPdfPage: 2,
    backMatterStartPdfPage: 12,
    pages: [
      { index: 1, startPdfPage: 3, endPdfPage: 4 },
      { index: 2, startPdfPage: 4, endPdfPage: 6 },
      { index: 3, startPdfPage: 7, endPdfPage: 11 }
    ]
  };
  const pages = [1, 2, 3].map((index) => ({
    id: `page-${index}`,
    index,
    title: `Page ${index}`,
    summary: "",
    previewText: ""
  }));

  it("reads a spoken page number as the printed page", () => {
    expect(pageIndexesFromMessage("rewrite page 5", pages, { pdfPageMap: map })).toEqual([2]);
    // Printed page 3 is physical 4, the shared boundary of model pages 1 and 2.
    expect(pageIndexesFromMessage("rewrite page 3", pages, { pdfPageMap: map })).toEqual([1, 2]);
    expect(pageIndexesFromMessage("polish pages 3-6", pages, { pdfPageMap: map })).toEqual([1, 2, 3]);
    // Printed 3 is the boundary of model 1 and 2; printed 7 is model 3.
    expect(pageIndexesFromMessage("rewrite pages 3 and 7", pages, { pdfPageMap: map })).toEqual([1, 2, 3]);
    expect(pageIndexesFromMessage("the 5th page needs work", pages, { pdfPageMap: map })).toEqual([2]);
    expect(pageIndexesFromMessage("صفحه ۵ را بامزه‌تر بنویس", pages, { pdfPageMap: map })).toEqual([2]);
    expect(pageIndexesFromMessage("در صفحهٔ ۵ یک عکس اضافه کن", pages, { pdfPageMap: map })).toEqual([2]);
  });

  it("does not treat a book length as a page target", () => {
    // Number-then-word is "how long", word-then-number is "which page".
    expect(pageIndexesFromMessage("یک کتاب ۳ صفحه ای بساز", pages)).toEqual([]);
    expect(pageIndexesFromMessage("24 صفحه", pages)).toEqual([]);
    expect(pageIndexesFromMessage("make it 5 pages", pages)).toEqual([]);
  });

  it("drops numbers that land on furniture rather than renumbering them", () => {
    // Printed page 1 is the table of contents; nothing editable lives there.
    expect(pageIndexesFromMessage("fix page 1", pages, { pdfPageMap: map })).toEqual([]);
  });

  it("leaves a version-1 map on physical numbering", () => {
    const legacy = { ...map, version: 1 as const };
    // Footer on sheet 2 said Page 2; translating it as sheet 3 would edit the
    // first prose page instead of landing on the Contents.
    expect(pageIndexesFromMessage("rewrite page 2", pages, { pdfPageMap: legacy })).toEqual([]);
    expect(pageIndexesFromMessage("rewrite page 3", pages, { pdfPageMap: legacy })).toEqual([1]);
  });

  it("keeps the old model-index reading without a map", () => {
    expect(pageIndexesFromMessage("fix page 2", pages)).toEqual([2]);
  });

  it("resolves a read request through the map, nearest page for furniture", () => {
    expect(showContentTargetFromMessage("show me page 5", { pdfPageMap: map })).toEqual({ type: "page", index: 2 });
    // The Contents (printed page 1) reads as the page right after it.
    expect(showContentTargetFromMessage("show me page 1", { pdfPageMap: map })).toEqual({ type: "page", index: 1 });
  });

  it("resolves an image placement to the page of prose the reader pointed at", () => {
    expect(imagePlacementFromMessage("add a dragon on page 7", { pdfPageMap: map })).toEqual({
      placement: "page",
      pageIndex: 3
    });
    expect(imagePlacementFromMessage("در صفحه ۷ یک عکس از اژدها اضافه کن", { pdfPageMap: map })).toEqual({
      placement: "page",
      pageIndex: 3
    });
    // A furniture page takes the nearest prose page rather than a same-number guess.
    expect(imagePlacementFromMessage("add a dragon on page 1", { pdfPageMap: map })).toEqual({
      placement: "page",
      pageIndex: 1
    });
  });

  it("names no page for a number the book does not print", () => {
    // Snapping is for furniture, not for a page that does not exist: reading or
    // illustrating the last page is a wrong answer, where none lets the router
    // (or furniturePageIntentFromMessage) say the book has no printed page 40.
    expect(showContentTargetFromMessage("show me page 40", { pdfPageMap: map })).toBeNull();
    expect(imagePlacementFromMessage("add a dragon on page 40", { pdfPageMap: map })).toBeNull();
    // Without a map the number is a model index and keeps its old reading.
    expect(imagePlacementFromMessage("add a dragon on page 40")).toEqual({ placement: "page", pageIndex: 40 });
  });
});

describe("an anchor on a printed sheet that carries several model pages", () => {
  // Printed page 10 is physical sheet 11, and three short model pages share it:
  // 7 ends there, 8 lies wholly within it, 9 starts there. Nothing exotic —
  // pages join on a single newline, so adjacent ones routinely share a sheet —
  // and it is the only shape in which the two ends of an anchor are different
  // pages.
  const map = {
    version: 2 as const,
    totalPdfPages: 13,
    hasCoverPage: true,
    contentsStartPdfPage: 2,
    pages: [
      { index: 1, startPdfPage: 3, endPdfPage: 3 },
      { index: 2, startPdfPage: 4, endPdfPage: 4 },
      { index: 3, startPdfPage: 5, endPdfPage: 5 },
      { index: 4, startPdfPage: 6, endPdfPage: 6 },
      { index: 5, startPdfPage: 7, endPdfPage: 7 },
      { index: 6, startPdfPage: 8, endPdfPage: 9 },
      { index: 7, startPdfPage: 10, endPdfPage: 11 },
      { index: 8, startPdfPage: 11, endPdfPage: 11 },
      { index: 9, startPdfPage: 11, endPdfPage: 12 },
      { index: 10, startPdfPage: 13, endPdfPage: 13 }
    ]
  };

  it("resolves the anchor to every model page the sheet holds", () => {
    expect(pageAnchorFromMessage("add a page after page 10", { pdfPageMap: map })).toEqual({
      position: "after",
      pageIndexes: [7, 8, 9]
    });
    expect(pageAnchorFromMessage("add a page before page 10", { pdfPageMap: map })).toEqual({
      position: "before",
      pageIndexes: [7, 8, 9]
    });
  });

  it("puts 'after' past the last page of the sheet and 'before' ahead of the first", () => {
    // A single-page anchor answered this sheet with model page 8 — the first to
    // *start* on it, which is what `primaryModelPageForPdfPage` prefers — so
    // "add a page after page 10" opened the gap between model pages 8 and 9:
    // mid-sheet, one page short of what the reader asked for.
    expect(anchorModelPageIndex("after", [7, 8, 9])).toBe(9);
    expect(anchorModelPageIndex("before", [7, 8, 9])).toBe(6);
    // The head of the book is a place a reader can name; nothing named is not.
    expect(anchorModelPageIndex("before", [1])).toBe(0);
    expect(anchorModelPageIndex("after", [])).toBeNull();
  });

  it("still snaps a furniture anchor to the nearest prose, and names nothing off the book", () => {
    // Printed 1 is the Contents. An anchor is a place, not an edit target, so
    // it reads as the front of the book rather than a request with no answer.
    expect(pageAnchorFromMessage("add a page before page 1", { pdfPageMap: map })).toEqual({
      position: "before",
      pageIndexes: [1]
    });
    // Snapping is for furniture: a number the book does not print names nothing.
    expect(pageAnchorFromMessage("add a page after page 40", { pdfPageMap: map })).toBeNull();
    // Without a map the spoken number is a model index, exactly as before.
    expect(pageAnchorFromMessage("add a page after page 10")).toEqual({ position: "after", pageIndexes: [10] });
  });
});

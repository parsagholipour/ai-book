import { describe, expect, it } from "vitest";
import {
  imagePlacementFromMessage,
  pageIndexesFromMessage,
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
    // digits their keyboard produces.
    expect(pageIndexesFromMessage("page ۴ needs a rewrite", pages)).toEqual([4]);
    expect(pageIndexesFromMessage("pages ۲-۴", pages)).toEqual([2, 3, 4]);
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
    version: 1 as const,
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
    // The shared boundary page belongs to both model pages.
    expect(pageIndexesFromMessage("rewrite page 4", pages, { pdfPageMap: map })).toEqual([1, 2]);
    expect(pageIndexesFromMessage("polish pages 4-7", pages, { pdfPageMap: map })).toEqual([1, 2, 3]);
    expect(pageIndexesFromMessage("the 5th page needs work", pages, { pdfPageMap: map })).toEqual([2]);
  });

  it("drops numbers that land on furniture rather than renumbering them", () => {
    // Printed page 2 is the table of contents; nothing editable lives there.
    expect(pageIndexesFromMessage("fix page 2", pages, { pdfPageMap: map })).toEqual([]);
    expect(pageIndexesFromMessage("fix page 1", pages, { pdfPageMap: map })).toEqual([]);
  });

  it("keeps the old model-index reading without a map", () => {
    expect(pageIndexesFromMessage("fix page 2", pages)).toEqual([2]);
  });

  it("resolves a read request through the map, nearest page for furniture", () => {
    expect(showContentTargetFromMessage("show me page 5", { pdfPageMap: map })).toEqual({ type: "page", index: 2 });
    // The Contents page reads as the page right after it.
    expect(showContentTargetFromMessage("show me page 2", { pdfPageMap: map })).toEqual({ type: "page", index: 1 });
  });

  it("resolves an image placement to the page of prose the reader pointed at", () => {
    expect(imagePlacementFromMessage("add a dragon on page 7", { pdfPageMap: map })).toEqual({
      placement: "page",
      pageIndex: 3
    });
    // A furniture page takes the nearest prose page rather than a same-number guess.
    expect(imagePlacementFromMessage("add a dragon on page 2", { pdfPageMap: map })).toEqual({
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

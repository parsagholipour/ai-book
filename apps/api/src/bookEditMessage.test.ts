import { describe, expect, it } from "vitest";
import { pageIndexesFromMessage, targetLanguageFromLanguageVersionRequest } from "./bookEditMessage.js";

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

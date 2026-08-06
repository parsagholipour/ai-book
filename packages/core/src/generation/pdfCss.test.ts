import { describe, expect, it } from "vitest";
import { scriptProfileForLanguage } from "../prompting/script.js";
import { BOOK_PDF_CSS, bookPdfCss } from "./pdfCss.js";

describe("bookPdfCss", () => {
  it("returns the base stylesheet unchanged for a Latin book", () => {
    // The strongest no-regression guarantee available: overrides are appended,
    // never interleaved, so a new script cannot reach an English book.
    for (const language of ["en", "English", "", undefined, "es", "fr"]) {
      expect(bookPdfCss(scriptProfileForLanguage(language)), String(language)).toBe(BOOK_PDF_CSS);
    }
  });

  it("keeps the base stylesheet as the prefix of every other script's", () => {
    for (const language of ["fa", "ar", "he", "hi", "th", "zh", "ja", "ko"]) {
      expect(bookPdfCss(scriptProfileForLanguage(language)).startsWith(BOOK_PDF_CSS)).toBe(true);
    }
  });

  it("turns a Persian book right to left and isolates its LTR runs", () => {
    const css = bookPdfCss(scriptProfileForLanguage("fa"));
    expect(css).toContain("direction: rtl");
    expect(css).toContain("text-align: end");
    // Without this every URL and code sample in an RTL book renders mirrored.
    expect(css).toContain("unicode-bidi: isolate");
    // md-to-pdf's own markdown.css positions these with physical properties.
    expect(css).toContain("border-right: 4px solid gainsboro");
    expect(css).toContain("margin-inline-start: 1em");
  });

  it("drops tracking and uppercasing for joining scripts only", () => {
    // letter-spacing pulls a joined Arabic word apart into isolated letters.
    expect(bookPdfCss(scriptProfileForLanguage("fa"))).toContain("letter-spacing: normal");
    expect(bookPdfCss(scriptProfileForLanguage("hi"))).toContain("text-transform: none");
    // Hebrew and CJK do not join; their tracking is fine as designed.
    expect(bookPdfCss(scriptProfileForLanguage("he"))).not.toContain("letter-spacing: normal");
    expect(bookPdfCss(scriptProfileForLanguage("zh"))).not.toContain("letter-spacing: normal");
  });

  it("forbids a synthetic oblique where no italic face exists", () => {
    for (const language of ["fa", "ar", "he", "hi", "th", "zh", "ja", "ko"]) {
      expect(bookPdfCss(scriptProfileForLanguage(language)), language).toContain("font-style: normal");
    }
    expect(bookPdfCss(scriptProfileForLanguage("ru"))).not.toContain("font-style: normal");
  });

  it("opens up the line height a taller script needs", () => {
    expect(bookPdfCss(scriptProfileForLanguage("fa"))).toMatch(/line-height: 1\.9/);
    expect(bookPdfCss(scriptProfileForLanguage("zh"))).toMatch(/line-height: 1\.75/);
  });

  it("leaves the page footer alone", () => {
    // The @page margin box is live in headless Chrome, not dead CSS.
    expect(bookPdfCss(scriptProfileForLanguage("fa"))).toContain('content: "Page " counter(page)');
  });
});

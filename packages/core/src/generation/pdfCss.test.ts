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

  it("gives the title page a page of its own and sets the byline plain", () => {
    expect(BOOK_PDF_CSS).toMatch(/\.book-title-page \{[^}]*page-break-after: always/);
    // No book numbers its title page — a named @page is how the cover already
    // drops its footer, and a named selector outranks the bare one.
    expect(BOOK_PDF_CSS).toMatch(/\.book-title-page \{[^}]*page: pdf-title/);
    expect(BOOK_PDF_CSS).toMatch(/@page pdf-title \{[\s\S]*?content: none/);
    // No break-before: the cover ahead of it already breaks after itself, and
    // a title page with no cover is the first thing on page one.
    expect(BOOK_PDF_CSS).not.toMatch(/\.book-title-page \{[^}]*break-before/);
    // A name is not chrome — nothing here to undo per script.
    expect(BOOK_PDF_CSS).not.toMatch(/\.book-title-page__byline \{[^}]*letter-spacing/);
    expect(BOOK_PDF_CSS).not.toMatch(/\.book-title-page__byline \{[^}]*text-transform/);
  });

  it("takes the title page's Latin typography back for other scripts", () => {
    const persianOverrides = bookPdfCss(scriptProfileForLanguage("fa")).slice(BOOK_PDF_CSS.length);
    // Tracking on the title pulls a joined Persian word apart, and Chrome's
    // synthetic oblique on the subtitle skews the joining baseline.
    expect(persianOverrides).toContain(".book-title-page__title");
    expect(persianOverrides).toContain(".book-title-page__subtitle");
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

  it("keeps the English page footer for every script that counts in Western digits", () => {
    // The @page margin box is live in headless Chrome, not dead CSS.
    for (const language of ["en", "fr", "ru", "he", "zh", "ja", "ko"]) {
      const css = bookPdfCss(scriptProfileForLanguage(language));
      expect(css, language).toContain('content: "Page " counter(page)');
      expect(css, language).not.toContain("book-page-number");
    }
  });

  it("numbers the pages of a Persian book in Persian digits, and only the number", () => {
    const css = bookPdfCss(scriptProfileForLanguage("fa"));
    expect(css).toContain('symbols: "۰" "۱" "۲" "۳" "۴" "۵" "۶" "۷" "۸" "۹"');
    expect(css).toContain("content: counter(page, book-page-number)");
    // Appended, so the base rule is still there — the override has to come last.
    expect(css.lastIndexOf("content: counter(page, book-page-number)")).toBeGreaterThan(
      css.lastIndexOf('content: "Page " counter(page)')
    );
    // The footer's own family, or the digits render as tofu: the host's
    // `sans-serif` is whatever the container happens to have installed.
    expect(css).toContain('font-family: "InterBook", sans-serif');
  });

  it("gives each numbering script its own digits", () => {
    // Arabic-Indic and the extended Persian set are different code points, and
    // a Persian reader reads ٤٥٦ as the wrong shapes for four, five and six.
    expect(bookPdfCss(scriptProfileForLanguage("ar"))).toContain('"٤" "٥" "٦"');
    expect(bookPdfCss(scriptProfileForLanguage("ur"))).toContain('"۴" "۵" "۶"');
    expect(bookPdfCss(scriptProfileForLanguage("hi"))).toContain('"४" "५" "६"');
    expect(bookPdfCss(scriptProfileForLanguage("th"))).toContain('"๔" "๕" "๖"');
  });
});

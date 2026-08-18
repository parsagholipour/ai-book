import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scriptProfileForLanguage } from "../prompting/script.js";
import { BOOK_PDF_CSS, bookPdfCss } from "./pdfCss.js";

/**
 * `BOOK_PDF_CSS` with its comments, its indentation and its colour values gone.
 *
 * Everything that survives either sizes a box, names a page, sets a metric that
 * decides where a line wraps, or controls fragmentation — so the digest below
 * fires on anything that can move a page break and stays quiet for a recolour.
 * Subtractive rather than an allowlist of interesting properties, because a
 * property nobody thought of is then in scope by default: that is the only way
 * round a tripwire can fail safe.
 *
 * Only the colour *value* is dropped, not the declaration, so moving a colour
 * from `color` to `background` still fires.
 */
function pageGeometryProjection(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/#[0-9a-f]{3,8}\b/gi, "")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n");
}

/**
 * Recorded, never derived. Recompute it only after rendering the fixture corpus
 * on both sides — `pnpm render:fixtures --baseline HEAD …` then `--compare`, per
 * the `verify-pdf-typography` skill. A digest bumped without that render is the
 * silent re-typeset this assertion exists to catch.
 */
const PAGE_GEOMETRY_SHA256 = "d00492477ab6888a4090f47418bb2e9c6d1327365f2bdf168d7d5fdc4b31a68d";

describe("bookPdfCss", () => {
  it("still lays every book out on the same page boxes", () => {
    // The sibling alarm to pdfDocument.test.ts's stylesheet digests, which pin
    // md-to-pdf's *bundled* sheets and say nothing about this one. A page-box
    // rule here — the @page margins and counter resets, the title sheet's
    // clipped height, the Contents furniture, the cover geometry — re-typesets
    // every book ever compiled, and nothing else in the repo notices: pdf.test.ts
    // records one page count, for one twelve-chapter book, and skips itself
    // without poppler-utils.
    //
    // This firing is not a failure. It means: render the corpus, look at the
    // comparison, then record the new digest with what the comparison said.
    expect(createHash("sha256").update(pageGeometryProjection(BOOK_PDF_CSS), "utf8").digest("hex")).toBe(
      PAGE_GEOMETRY_SHA256
    );
  });

  it("keeps the alarm above pointed at geometry rather than at colour", () => {
    // A recolour must not fire it, or the digest becomes something people bump
    // without rendering anything.
    const recoloured = BOOK_PDF_CSS.replace(/#[0-9a-f]{6}\b/gi, "#000000");
    expect(recoloured).not.toBe(BOOK_PDF_CSS);
    expect(pageGeometryProjection(recoloured)).toBe(pageGeometryProjection(BOOK_PDF_CSS));

    // Everything that sizes a sheet must.
    for (const [from, to] of [
      ["margin: 20mm 18mm 22mm", "margin: 20mm 18mm 21mm"],
      ["height: 245mm", "height: 246mm"],
      ["counter-reset: page 0", "counter-reset: page 1"],
      ["overflow: hidden", "overflow: visible"],
      ["margin-top: auto", "margin-top: 0"],
      ["font-size: 34pt", "font-size: 35pt"]
    ] as const) {
      // replaceAll: several of these appear in a comment above the rule they
      // explain, and a comment is exactly what the projection drops.
      const moved = BOOK_PDF_CSS.replaceAll(from, to);
      expect(moved, from).not.toBe(BOOK_PDF_CSS);
      expect(pageGeometryProjection(moved), from).not.toBe(pageGeometryProjection(BOOK_PDF_CSS));
    }
  });

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
    expect(BOOK_PDF_CSS).toMatch(/@page pdf-cover \{[\s\S]*?counter-reset:\s*page 0/);
    expect(BOOK_PDF_CSS).toMatch(/@page pdf-title \{[\s\S]*?counter-reset:\s*page 0/);
    // The special `page` counter is a page-box property. The named @page
    // rules above are the mechanism the cover and title-page renders lock.
    expect(BOOK_PDF_CSS).not.toMatch(/\.book-title-page \{[^}]*counter-reset/);
    expect(BOOK_PDF_CSS).not.toMatch(/\.pdf-cover-page \{[^}]*counter-reset/);
    // No break-before: the cover ahead of it already breaks after itself, and
    // a title page with no cover is the first thing on page one.
    expect(BOOK_PDF_CSS).not.toMatch(/\.book-title-page \{[^}]*break-before/);
    // And exactly one sheet, clipped like the cover: @page pdf-title resets the
    // counter on every sheet it names, so a title page that fragmented would
    // leave two unnumbered sheets where printedPageOffset counts one.
    expect(BOOK_PDF_CSS).toMatch(/\.book-title-page \{[^}]*height: 245mm/);
    expect(BOOK_PDF_CSS).not.toMatch(/\.book-title-page \{[^}]*min-height/);
    expect(BOOK_PDF_CSS).toMatch(/\.book-title-page \{[^}]*overflow: hidden/);
    // Centred by auto margins, and *not* by justify-content: a centred flex
    // column overflows both ends, so the clip above cut the opening off the top
    // — a 30-clause title printed a sheet beginning mid-title at clause 10.
    // Auto margins collapse to zero on negative free space, so the stack pins to
    // the top and only its tail is lost.
    expect(BOOK_PDF_CSS).not.toMatch(/\.book-title-page \{[^}]*justify-content/);
    expect(BOOK_PDF_CSS).toMatch(/\.book-title-page > :first-child \{[^}]*margin-top: auto/);
    expect(BOOK_PDF_CSS).toMatch(/\.book-title-page > :last-child \{[^}]*margin-bottom: auto/);
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

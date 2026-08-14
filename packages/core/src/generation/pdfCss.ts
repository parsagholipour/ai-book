import type { ScriptProfile } from "../prompting/script.js";

/**
 * The `@page` top margin below, in points. The PDF page map's top-of-page band
 * reads it to decide whether an anchor starts its page; it lives here so the
 * number and the rule cannot drift apart.
 */
export const BOOK_PAGE_TOP_MARGIN_PT = (20 / 25.4) * 72;

/**
 * The manuscript stylesheet. Calibrated for Latin at 11pt; every deviation a
 * script needs is appended by {@link bookPdfCss} rather than written in here,
 * so an English book keeps rendering byte-for-byte what it always did.
 */
export const BOOK_PDF_CSS = `
  @page {
    size: A4;
    margin: 20mm 18mm 22mm;
    @bottom-center {
      content: "Page " counter(page);
      font-family: sans-serif;
      font-size: 8pt;
      color: #6b7280;
    }
  }
  @page pdf-cover {
    size: A4;
    margin: 0;
    @bottom-center {
      content: none;
    }
  }
  /* Keeps the normal margins, drops only the footer: no book numbers its title page. */
  @page pdf-title {
    size: A4;
    @bottom-center {
      content: none;
    }
  }
  html,
  body {
    margin: 0;
    padding: 0;
  }
  body {
    font-family: "SourceSerifBook", Georgia, "Times New Roman", serif;
    font-size: 11pt;
    line-height: 1.55;
    color: #1a1a1a;
    max-width: 100%;
  }
  h1, h2, h3 {
    font-family: "SourceSerifBook", Georgia, "Times New Roman", serif;
  }
  h1 { font-size: 22pt; margin-top: 0; page-break-after: avoid; font-weight: 700; }
  h2 { font-size: 14pt; margin-top: 1.4em; page-break-after: avoid; font-weight: 700; }
  h3 { font-size: 12pt; page-break-after: avoid; font-weight: 700; }
  .book-title-page {
    page: pdf-title;
    box-sizing: border-box;
    min-height: 245mm;
    padding: 22mm 8mm 14mm;
    display: flex;
    flex-direction: column;
    justify-content: center;
    text-align: center;
    color: #211a14;
    break-after: page;
    page-break-after: always;
  }
  .book-title-page__title {
    margin: 0;
    font-size: 34pt;
    font-weight: 500;
    line-height: 1.15;
    letter-spacing: 0.01em;
  }
  .book-title-page__subtitle {
    margin: 8mm auto 0;
    width: min(140mm, 100%);
    font-size: 14pt;
    font-style: italic;
    color: #4a4038;
  }
  /*
   * Set plain, unlike the sibling eyebrows: a name is not chrome to decorate,
   * and tracking it would need undoing again in CURSIVE_OVERRIDES for every
   * joining script.
   */
  .book-title-page__byline {
    margin: 18mm 0 0;
    font-size: 12pt;
    color: #6b5c4c;
  }
  .book-contents {
    box-sizing: border-box;
    min-height: 245mm;
    padding: 22mm 8mm 14mm;
    display: flex;
    flex-direction: column;
    justify-content: center;
    color: #211a14;
    break-before: page;
    break-after: page;
    page-break-before: always;
    page-break-after: always;
  }
  .book-contents__eyebrow {
    margin: 0 0 0.65rem;
    text-align: center;
    font-family: "InterBook", "Segoe UI", system-ui, sans-serif;
    font-size: 8.5pt;
    font-weight: 700;
    letter-spacing: 0.28em;
    text-transform: uppercase;
    color: #9a7448;
  }
  .book-contents h2 {
    margin: 0;
    text-align: center;
    font-family: "SourceSerifBook", Georgia, "Times New Roman", serif;
    font-size: 28pt;
    font-weight: 500;
    letter-spacing: 0.02em;
  }
  .book-contents__ornament {
    width: 56mm;
    height: 1px;
    margin: 7mm auto 13mm;
    background: linear-gradient(90deg, transparent, #c9b79f 18%, #8b6f4e 50%, #c9b79f 82%, transparent);
  }
  .book-contents__list {
    list-style: none;
    margin: 0 auto;
    padding: 0;
    width: min(150mm, 100%);
  }
  .book-contents__item {
    margin: 0 0 7mm;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .book-contents__link {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(22mm, 42mm) max-content;
    column-gap: 3mm;
    align-items: end;
    color: inherit;
    text-decoration: none;
  }
  .book-contents__chapter {
    grid-column: 1 / 4;
    margin-bottom: 1.3mm;
    font-family: "InterBook", "Segoe UI", system-ui, sans-serif;
    font-size: 8pt;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: #9a7448;
  }
  .book-contents__name {
    grid-column: 1;
    font-family: "SourceSerifBook", Georgia, "Times New Roman", serif;
    font-size: 13.5pt;
    line-height: 1.25;
  }
  .book-contents__leader {
    grid-column: 2;
    border-bottom: 1px dotted #b7a38a;
    transform: translateY(-1.8mm);
  }
  .book-contents__page {
    grid-column: 3;
    min-width: 7mm;
    text-align: right;
    font-family: "SourceSerifBook", Georgia, "Times New Roman", serif;
    font-size: 11pt;
    color: #6f5842;
  }
  .book-contents--compact,
  .book-contents--dense {
    justify-content: flex-start;
    padding-top: 16mm;
  }
  .book-contents--compact .book-contents__ornament,
  .book-contents--dense .book-contents__ornament {
    margin-bottom: 9mm;
  }
  .book-contents--compact .book-contents__item {
    margin-bottom: 4.5mm;
  }
  .book-contents--dense h2 {
    font-size: 24pt;
  }
  .book-contents--dense .book-contents__item {
    margin-bottom: 3mm;
  }
  .book-contents--dense .book-contents__chapter {
    margin-bottom: 0.7mm;
    font-size: 7.2pt;
  }
  .book-contents--dense .book-contents__name {
    font-size: 11.2pt;
  }
  img {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 1em auto;
    page-break-inside: avoid;
  }
  pre, code { font-family: ui-monospace, monospace; font-size: 9pt; }
  a { color: #2563eb; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.5em 0; }
  .page-break { break-after: page; page-break-after: always; }
  .pdf-cover-page {
    page: pdf-cover;
    width: 210mm;
    height: 297mm;
    margin: 0;
    padding: 0;
    overflow: hidden;
    background: #fff;
    break-after: page;
    page-break-after: always;
  }
  .pdf-cover-page img {
    width: 100%;
    height: 100%;
    max-width: none;
    margin: 0;
    object-fit: cover;
  }
`;

/**
 * Right-to-left books.
 *
 * `direction: rtl` on the root is bidi-equivalent to `dir="rtl"` — it sets the
 * paragraph embedding level, and md-to-pdf's HTML wrapper gives us nowhere to
 * put the attribute. The grid in `.book-contents__link` needs nothing: its
 * `grid-column` values are line numbers and mirror on their own.
 *
 * The `blockquote` and list rules undo md-to-pdf's bundled `markdown.css`,
 * which we never override and which positions both with physical properties.
 * The last rule is the load-bearing one: without it every URL and code sample
 * in an RTL book renders mirrored.
 */
const RTL_OVERRIDES = `
  html {
    direction: rtl;
  }
  .book-contents__page {
    text-align: end;
  }
  blockquote {
    padding-left: 0.5em;
    padding-right: 1em;
    border-left: none;
    border-right: 4px solid gainsboro;
  }
  ul, ol {
    margin-left: 0;
    margin-inline-start: 1em;
  }
  pre, code, a[href^="http"] {
    direction: ltr;
    unicode-bidi: isolate;
    text-align: left;
  }
`;

/**
 * Scripts whose letters join. Tracking and uppercasing are decorative for
 * Latin and destructive here — `letter-spacing` pulls the joined forms of a
 * word apart into unreadable isolated letters.
 */
const CURSIVE_OVERRIDES = `
  .book-contents__eyebrow,
  .book-contents__chapter {
    letter-spacing: normal;
    text-transform: none;
  }
  .book-contents h2,
  .book-title-page__title {
    letter-spacing: normal;
  }
`;

/**
 * Scripts with no italic face. Chrome would synthesize an oblique, which for
 * Arabic skews the joining baseline into something that reads as broken —
 * and Persian prose does use `_emphasis_`, so this fires in practice.
 */
const NO_ITALIC_OVERRIDES = `
  em, i, cite, blockquote, .book-title-page__subtitle {
    font-style: normal;
  }
  em, i {
    font-weight: 600;
  }
`;

/**
 * The page footer, for a script that writes its own digits.
 *
 * The footer is the only number the exporter itself prints — everything else on
 * the page was written by a model in the book's language — so a Persian book
 * carried an English "Page 12" at the foot of every leaf. It now prints the
 * number alone, in the book's own digits: "Page" is an English word, and the
 * bare number is what a book in any language sets there anyway.
 *
 * The counter style is written out rather than named (`persian`, `devanagari`,
 * … are all predefined in Chrome) so the glyphs the PDF will contain are the
 * same ones `pdf.ts` seeds into the embedded font subset — a footer whose face
 * was never embedded renders as tofu, which is worse than English digits.
 *
 * `@page pdf-cover` still wins on the cover: a named page selector outranks the
 * bare one however the two are ordered.
 */
function pageNumeralOverrides(profile: ScriptProfile): string {
  if (!profile.numerals) {
    return "";
  }
  const symbols = [...profile.numerals].map((digit) => `"${digit}"`).join(" ");
  return `
  @counter-style book-page-number {
    system: numeric;
    symbols: ${symbols};
  }
  @page {
    @bottom-center {
      content: counter(page, book-page-number);
      font-family: "InterBook", sans-serif;
    }
  }
`;
}

function typographyOverrides(profile: ScriptProfile): string {
  if (profile.fontSizeScale === 1 && profile.lineHeight === 1.55) {
    return "";
  }
  return `
  body {
    font-size: ${round(11 * profile.fontSizeScale)}pt;
    line-height: ${profile.lineHeight};
  }
`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * `BOOK_PDF_CSS` plus whatever the book's script needs on top.
 *
 * Overrides are appended, never interleaved, and a Latin profile appends
 * nothing at all — which is what makes it impossible for a new script to
 * regress an English book.
 */
export function bookPdfCss(profile: ScriptProfile): string {
  const overrides = [
    profile.direction === "rtl" ? RTL_OVERRIDES : "",
    profile.cursive ? CURSIVE_OVERRIDES : "",
    profile.hasItalic ? "" : NO_ITALIC_OVERRIDES,
    typographyOverrides(profile),
    pageNumeralOverrides(profile)
  ].filter(Boolean);

  return overrides.length > 0 ? [BOOK_PDF_CSS, ...overrides].join("\n") : BOOK_PDF_CSS;
}

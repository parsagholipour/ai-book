import { scriptProfileForLanguage } from "../prompting/script.js";
import type { BookMatter } from "../schemas/bookMatter.js";
import type { MarkdownLabels } from "./markdownLabels.js";
import { aboutAuthorLayout, matterSheetLayout, type MatterSheetText } from "./matterSheetLayout.js";

/**
 * The matter a compile prints around the book's text, as the compile sees it:
 * the book's own copy (`Project.bookMatter`) plus the two things the compile
 * decides rather than stores.
 *
 * Both compiles — the worker's and the API's inline rebuild — build it through
 * `bookMatterForExport` in `packages/db`, so the two cannot print different
 * front matter for the same book.
 */
export type BookMatterForCompile = Omit<BookMatter, "copyrightYear"> & {
  /**
   * The © year (`bookMatterYear`): an imported manuscript's own, as its © page
   * wrote it, or the year the book was created — never the year it compiled,
   * so a recompile in January prints the same bytes as the one in December.
   */
  year: number | string;
  /** The free tier's "Made with Tomeza" line. Decided per compile from the owner's plan. */
  madeWithCredit: boolean;
};

export type FormattedBookMatter = {
  /** Every book's title page — after the cover when there is one. */
  titlePage: string;
  /** The dedication and the publication details, on one sheet. `""` when it would be empty. */
  matterSheet: string;
  /** The About the Author back matter. `""` without a biography. */
  aboutAuthor: string;
};

/**
 * The front and back matter, as markdown blocks for `compileBookMarkdownWithPageAnchors`.
 *
 * **Every book gets a title page**, cover or not. A cover is a picture, and a
 * book's own first leaf naming its title and author is what makes the file
 * read as a book rather than a stack of pages. Behind a cover it is set on
 * `@page pdf-front`, which is counted but unnumbered, so only the book's first
 * sheet ever resets the page counter and `printedPageOffset` stays a `1 : 0`.
 *
 * **The dedication and the publication details share one sheet**, the
 * dedication in its upper third and the publication lines at its foot. Two
 * sheets is the print convention, but a twelve-page picture book should not
 * grow by four; one sheet is how many illustrated books set it.
 *
 * **The free tier's credit goes where it costs no page**: at the foot of the
 * matter sheet when there is one, or the foot of the title page — where a
 * publisher's imprint sits — when there is not.
 *
 * Everything the reader typed is escaped here, as HTML in the front matter and
 * as markdown text in the back, so no field can open a tag, a link or a
 * heading of its own — and every one-line field is folded onto one line
 * (`singleLine`), so none can end the HTML block it sits in either.
 */
export function formatBookMatter(input: {
  title: string;
  subtitle?: string | undefined;
  authorName?: string | undefined;
  matter?: BookMatterForCompile | undefined;
  afterCover: boolean;
  labels: MarkdownLabels;
  /** The book's language: the © year is set in its digits. */
  language?: string | undefined;
}): FormattedBookMatter {
  const { labels, matter } = input;
  const authorName = singleLine(input.authorName);
  const publication = publicationLines(matter, authorName, labels, input.language);
  // `\r` is a line ending to marked, so a dedication written past the schema's
  // normalisation would end the block at "\r\r" exactly as "\n\n" would.
  const dedication = matter?.dedication?.replace(/\r\n?/g, "\n").trim();
  const hasSheet = publication.length > 0 || Boolean(dedication);
  const credit = matter?.madeWithCredit ? labels.madeWithTomeza : undefined;
  return {
    titlePage: formatTitlePage({
      title: singleLine(input.title) ?? "",
      subtitle: singleLine(input.subtitle),
      authorName,
      afterCover: input.afterCover,
      foot: hasSheet ? undefined : credit,
      labels
    }),
    matterSheet: hasSheet ? formatMatterSheet(dedication, publication, credit) : "",
    aboutAuthor: formatAboutAuthor(matter, labels)
  };
}

function publicationLines(
  matter: BookMatterForCompile | undefined,
  authorName: string | undefined,
  labels: MarkdownLabels,
  language: string | undefined
): string[] {
  if (!matter) return [];
  const holder = singleLine(matter.copyrightHolder) ?? authorName;
  const imprint = singleLine(matter.imprint);
  const isbn = singleLine(matter.isbn);
  return [
    ...(holder ? [`© ${yearInBookDigits(matter.year, language)} ${holder}`] : []),
    // A rights claim names whose rights; with no holder there is no claim to print.
    ...(holder && matter.allRightsReserved ? [labels.allRightsReserved] : []),
    ...(imprint ? [imprint] : []),
    ...(isbn ? [`ISBN ${isbn}`] : [])
  ];
}

/**
 * The © year in the digits the book's script writes its own numbers in —
 * ۲۰۲۶ in a Persian book, ٢٠٢٦ in an Arabic one — as the PDF footer already
 * numbers its pages (`pageNumeralOverrides` in `pdfCss.ts`). The year is the
 * one number on the matter pages the compiler writes rather than the reader,
 * so it is the compiler's to spell; an ISBN is printed as typed. A script that
 * counts in Western digits (`numerals: null`) keeps them.
 */
export function yearInBookDigits(year: number | string, language: string | undefined): string {
  const numerals = scriptProfileForLanguage(language).numerals;
  if (!numerals) return String(year);
  const digits = [...numerals];
  return String(year).replace(/\d/g, (digit) => digits[Number(digit)] ?? digit);
}

/**
 * A field the front matter prints on one line, with every run of whitespace —
 * line breaks included — set as one space. The title page and the matter sheet
 * are each one HTML block, and a blank line ends an HTML block: a byline of
 * `"Bob\n\n![x](…)"` left the rest of the title page to be read as live
 * markdown, image and all. The schema folds a run of blank lines but keeps one,
 * the title and the byline come from other rows, and a matter row can be
 * written past the schema, so the fold happens here, where the block is built.
 * ASCII whitespace and the Unicode line separators only: a no-break or an
 * ideographic space (山田　太郎) is the reader's own typography and ends no line.
 */
function singleLine(text: string | undefined): string | undefined {
  return text?.replace(/[\t\n\v\f\r \u0085\u2028\u2029]+/g, " ").trim() || undefined;
}

function formatTitlePage(input: {
  title: string;
  subtitle: string | undefined;
  authorName: string | undefined;
  afterCover: boolean;
  foot: string | undefined;
  labels: MarkdownLabels;
}): string {
  const { title, subtitle } = input;
  if (!title) return "";
  const modifier = input.afterCover ? " book-title-page--after-cover" : "";
  return [
    `<section class="book-title-page${modifier}">`,
    `  <h1 class="book-title-page__title">${escapeHtml(title)}</h1>`,
    ...(subtitle ? [`  <p class="book-title-page__subtitle">${escapeHtml(subtitle)}</p>`] : []),
    ...(input.authorName
      ? [`  <p class="book-title-page__byline">${escapeHtml(`${input.labels.by} ${input.authorName}`)}</p>`]
      : []),
    ...(input.foot ? [`  ${CREDIT_ON_TITLE_PAGE}${escapeHtml(input.foot)}</p>`] : []),
    "</section>"
  ].join("\n");
}

/**
 * One HTML block: no line inside it may be blank, or marked ends the block
 * there and reads the rest as markdown.
 */
function formatMatterSheet(dedication: string | undefined, publication: string[], credit: string | undefined): string {
  const paragraphs = dedication ? dedication.split(/\n{2,}/).map((paragraph) => paragraph.split("\n")) : [];
  // A long dedication is set smaller, so the sheet the fitter counts is the one that prints.
  const { className } = matterSheetLayout({ dedication: paragraphs, publication, credit });
  const lines = [`<section class="${className}">`];
  if (paragraphs.length > 0) {
    lines.push('  <div class="book-matter-sheet__dedication">');
    for (const paragraph of paragraphs) {
      lines.push(`    <p>${paragraph.map(escapeHtml).join("<br />")}</p>`);
    }
    lines.push("  </div>");
  }
  if (publication.length > 0 || credit) {
    lines.push('  <div class="book-matter-sheet__publication">');
    for (const line of publication) lines.push(`    <p>${escapeHtml(line)}</p>`);
    if (credit) lines.push(`    ${CREDIT_ON_MATTER_SHEET}${escapeHtml(credit)}</p>`);
    lines.push("  </div>");
  }
  lines.push("</section>");
  return lines.join("\n");
}

/**
 * A markdown heading, so the EPUB gives it its own file and navigation entry
 * and the Word export sets it as a heading, then the biography as escaped
 * paragraphs. The empty marker after the heading is how the PDF stylesheet
 * starts the page on a fresh sheet (`h2:has(+ .book-about-author)`): the
 * heading's own id is marked's slug of a translated label, and nothing else
 * tells it apart from a chapter of the same name. It also carries the size the
 * biography is set at (`aboutAuthorLayout`), as the matter sheet's class does.
 *
 * The biography is written in one shape — trimmed lines, a hard break between
 * two, one blank line between paragraphs — so `bookMatterSheetCount` reads back
 * exactly the paragraphs marked renders. A row written past the schema could
 * otherwise open an indented code block, or turn a line of spaces into a
 * paragraph break nobody counted.
 */
function formatAboutAuthor(matter: BookMatterForCompile | undefined, labels: MarkdownLabels): string {
  const paragraphs = biographyParagraphs(matter?.aboutAuthor ?? "");
  if (paragraphs.length === 0) return "";
  const website = singleLine(matter?.authorWebsite);
  const printed = [...paragraphs, ...(website ? [[website]] : [])];
  return [
    `## ${escapeMarkdownText(labels.aboutAuthor)}`,
    "",
    `<div class="${aboutAuthorLayout(printed).className}"></div>`,
    "",
    ...printed.flatMap((paragraph) => [paragraph.map(escapeMarkdownText).join("  \n"), ""])
  ]
    .join("\n")
    .trimEnd();
}

/** Paragraphs of trimmed lines; a line that is blank once trimmed ends a paragraph, as it does in markdown. */
function biographyParagraphs(text: string): string[][] {
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (trimmed) {
      current.push(trimmed);
    } else if (current.length > 0) {
      paragraphs.push(current);
      current = [];
    }
  }
  return current.length > 0 ? [...paragraphs, current] : paragraphs;
}

/**
 * The markers only the compiler writes: every reader value inside them is
 * escaped, so no text a reader typed can spell one.
 */
const TITLE_PAGE_OPEN = '<section class="book-title-page';
const TITLE_PAGE_AFTER_COVER_OPEN = '<section class="book-title-page book-title-page--after-cover">';
const TITLE_PAGE_BYLINE = '<p class="book-title-page__byline">';
/** Followed by a size modifier when the dedication is long (`matterSheetLayout`). */
const MATTER_SHEET_OPEN = '<section class="book-matter-sheet';
/** Followed by a size modifier when the biography is long (`aboutAuthorLayout`), then `"></div>`. */
const ABOUT_AUTHOR_OPEN = '<div class="book-about-author';
const ABOUT_AUTHOR_CLOSE = '"></div>';
/** The free tier's credit, in each of the two places `formatBookMatter` sets it. */
const CREDIT_ON_MATTER_SHEET = '<p class="book-matter-sheet__credit">';
const CREDIT_ON_TITLE_PAGE = '<p class="book-title-page__imprint">';

/**
 * Whether a compiled manuscript prints the free tier's "Made with Tomeza"
 * credit, read off the markup only the compiler writes — so it answers for the
 * bytes a book was published with, in whatever language the label was set.
 *
 * The plan tier says whether the *next* compile prints it (`madeWithCredit`);
 * this says whether the published one did, which is what a subscriber asking
 * for it to come off a book is asking about. Every reader value in the front
 * matter is escaped, so a dedication or an imprint that spells the markup
 * prints `&lt;p …` and never reads as the credit.
 */
export function bookCarriesTomezaCredit(markdown: string): boolean {
  return markdown.includes(CREDIT_ON_MATTER_SHEET) || markdown.includes(CREDIT_ON_TITLE_PAGE);
}

/**
 * How much of a published `book.md` the credit question reads first, so the
 * book's "Title & credits" sheet does not download a 600-page manuscript every
 * time it opens.
 *
 * The credit is only ever set inside the title page or the matter sheet, and
 * `compileBookMarkdownWithPageAnchors` writes nothing ahead of them but the
 * cover line (an alt of at most 120 characters and an asset URL) or, for a
 * blank title, its `#` heading. The matter sheet is bounded by
 * `BOOK_MATTER_LIMITS`: a 2,000-character dedication at its widest escape
 * (`&quot;`, six bytes a character) is 12 KB, and every other field it prints
 * is under 200 characters. The title page holds the title, subtitle and byline.
 * Only the plan's title and subtitle have no schema limit, so a front matter
 * longer than this is not refused but answered by the whole file
 * (`tomezaCreditInManuscriptHead` says when).
 */
export const TOMEZA_CREDIT_HEAD_BYTES = 64 * 1024;

/**
 * `bookCarriesTomezaCredit` read off the first `TOMEZA_CREDIT_HEAD_BYTES` of a
 * compiled manuscript: `undefined` when they end before its front matter does,
 * so only the whole file can say. `complete` is true when they are the whole
 * file.
 *
 * A credit found is found, and a whole file is its own answer. Otherwise the
 * head settles "not printed" once it holds the close of each compiler section
 * that opens in it — the title page, then the matter sheet, which always
 * follows it directly — and more text after the last close than a matter
 * sheet's cut-off opening could be. That text is counted without whitespace,
 * because a title that is all whitespace prints no title page but a `#`
 * heading of that whitespace, and a matter sheet can sit behind it. Past the
 * front matter the head is page text, where the compiler sets no credit.
 */
export function tomezaCreditInManuscriptHead(head: string, complete: boolean): boolean | undefined {
  if (bookCarriesTomezaCredit(head)) return true;
  if (complete) return false;
  let end = 0;
  for (const open of [TITLE_PAGE_OPEN, MATTER_SHEET_OPEN]) {
    const start = head.indexOf(open, end);
    if (start < 0) continue;
    const close = head.indexOf("</section>", start);
    if (close < 0) return undefined;
    end = close + "</section>".length;
  }
  // `\s` is what `trim` drops, and NEL is the one line break `singleLine` folds that `\s` does not name.
  return head.slice(end).replace(/[\s\u0085]+/g, "").length > MATTER_SHEET_OPEN.length ? false : undefined;
}

/**
 * The sheets the matter pages add to the printed book.
 *
 * The PDF fitter sizes the type so the file has the paid number of sheets, and
 * it always counted the cover, the Contents, the Sources and a coverless book's
 * title sheet among them — the one a byline printed. Everything else here is
 * new, so it comes on top of the paid count (`generateBookPdfWithPageMap`):
 * counted against it, a ten-page book with a cover, a dedication and a bio set
 * its text at ten points to make room for three pages nobody paid for.
 *
 * - **The title page** behind a cover, and a coverless one with no byline:
 *   that book used to open on an inline `# Title`, not a sheet of its own.
 * - **The matter sheet**, as many sheets as its dedication prints
 *   (`matterSheetLayout`, the estimate its tier was chosen by).
 * - **About the Author**, as many sheets as its biography prints
 *   (`aboutAuthorLayout`, likewise). It was counted as one, and a biography
 *   written as thirty short paragraphs printed two.
 *
 * Read off the markdown rather than the compile plan, so a repair that renders
 * published bytes with no plan fits them the same way.
 */
export function bookMatterSheetCount(markdown: string): number {
  const titlePage = compilerSection(markdown, TITLE_PAGE_OPEN);
  const titleSheet =
    titlePage !== undefined && (titlePage.startsWith(TITLE_PAGE_AFTER_COVER_OPEN) || !titlePage.includes(TITLE_PAGE_BYLINE));
  const matterSheet = compilerSection(markdown, MATTER_SHEET_OPEN);
  const biography = aboutAuthorText(markdown);
  return (
    (titleSheet ? 1 : 0) +
    (matterSheet === undefined ? 0 : matterSheetLayout(matterSheetText(matterSheet)).sheets) +
    (biography === undefined ? 0 : aboutAuthorLayout(biography).sheets)
  );
}

/**
 * The paragraphs About the Author prints, read back out of what
 * `formatAboutAuthor` wrote: everything after its marker, which is the last
 * thing in the book, with the reader's escapes undone.
 */
function aboutAuthorText(markdown: string): string[][] | undefined {
  // The last one: About the Author ends the book, and a page's own raw HTML may spell the marker.
  const start = markdown.lastIndexOf(`\n\n${ABOUT_AUTHOR_OPEN}`);
  if (start < 0) return undefined;
  const close = markdown.indexOf(ABOUT_AUTHOR_CLOSE, start);
  if (close < 0) return undefined;
  const text = markdown.slice(close + ABOUT_AUTHOR_CLOSE.length).trim();
  return text ? text.split(/\n{2,}/).map((paragraph) => paragraph.split("  \n").map(unescapeMarkdownText)) : [];
}

/** The first section that opens with `open`, through its `</section>`; every reader value inside is escaped. */
function compilerSection(markdown: string, open: string): string | undefined {
  const start = markdown.indexOf(open);
  if (start < 0) return undefined;
  const end = markdown.indexOf("</section>", start);
  return markdown.slice(start, end < 0 ? markdown.length : end);
}

/** The text a matter sheet prints, read back out of the markup `formatMatterSheet` wrote. */
function matterSheetText(section: string): MatterSheetText {
  const block = (name: string) =>
    section.match(new RegExp(`<div class="book-matter-sheet__${name}">([\\s\\S]*?)</div>`))?.[1] ?? "";
  const paragraphs = (html: string) => [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((match) => match[1] ?? "");
  const publication = block("publication");
  const credit = publication.match(/<p class="book-matter-sheet__credit">([\s\S]*?)<\/p>/)?.[1];
  return {
    dedication: paragraphs(block("dedication")).map((paragraph) => paragraph.split("<br />").map(unescapeHtml)),
    publication: paragraphs(publication).map(unescapeHtml),
    credit: credit === undefined ? undefined : unescapeHtml(credit)
  };
}

/**
 * Where a title page or matter sheet the compiler wrote ends, when one opens at
 * `at`; `undefined` otherwise. The math pass (`markdownMath.ts`) steps over
 * them: a `$x$` in a pen name or a `\(y\)` in an imprint is the reader's text,
 * and every reader value inside is escaped, so the first `</section>` is the
 * section's own.
 */
export function bookMatterSectionEnd(text: string, at: number): number | undefined {
  if (!text.startsWith(TITLE_PAGE_OPEN, at) && !text.startsWith(MATTER_SHEET_OPEN, at)) return undefined;
  const end = text.indexOf("</section>", at);
  return end < 0 ? undefined : end + "</section>".length;
}

/**
 * The book without its matter pages: the title page, the matter sheet and the
 * About the Author back matter, which is always last. What remains is what the
 * generation-leak checks are about — a reader's own website or imprint
 * (`generatedat.com`) is not a pipeline leak, and failing every compile of the
 * book over it would be.
 */
export function withoutBookMatter(markdown: string): string {
  let text = markdown;
  const about = text.lastIndexOf(`\n\n${ABOUT_AUTHOR_OPEN}`);
  if (about >= 0) {
    const heading = text.lastIndexOf("\n## ", about);
    text = text.slice(0, heading >= 0 ? heading : about);
  }
  for (const open of [TITLE_PAGE_OPEN, MATTER_SHEET_OPEN]) {
    const start = text.indexOf(open);
    if (start < 0) continue;
    const end = text.indexOf("</section>", start);
    text = end < 0 ? text.slice(0, start) : text.slice(0, start) + text.slice(end + "</section>".length);
  }
  return text;
}

/** `escapeMarkdownText` undone: a backslash before ASCII punctuation is the escape, not the text. */
function unescapeMarkdownText(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Reader text set as a markdown paragraph and nothing else. Every ASCII
 * punctuation character is backslash-escaped — CommonMark's whole escape set —
 * so `# `, `> `, `1. `, a setext `===`, `*`, `<`, `|` and the `$` of the math
 * pass all print as the characters they are.
 *
 * Except `(` and `[`, because `\(` and `\[` are not escapes to the math pass
 * (`markdownMath.ts`) but the openers of inline and display TeX: a bio reading
 * "Ada (born 1815)" printed "born1815" in math italic, in the PDF, the EPUB
 * and the Word file alike. Neither needs escaping once `]` and `)` are — no
 * link, image or reference can close — and a reader's own backslash is escaped
 * to `\\`, a pair the math pass steps over, so nothing they type can open TeX.
 */
export function escapeMarkdownText(text: string): string {
  return text.replace(/[!-')-/:-@\\-`{-~]/g, (character) => `\\${character}`);
}

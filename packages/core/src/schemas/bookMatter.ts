import { withoutXmlIllegalCharacters } from "../xmlCharacters.js";
import { isRecord } from "./jsonCoercion.js";

/**
 * The pages around a book's text that the reader supplies rather than the
 * model: the dedication, the publication details and the author's biography.
 *
 * A book keeps its own copy (`Project.bookMatter`), taken from the author
 * profile when the book is created and edited on the book after that, so
 * changing the profile never silently reprints a published book. The byline is
 * not here: it is `Project.authorName`, which the cover, the app and the
 * shares already read.
 *
 * Every value is the reader's own words and is printed as text, never read as
 * markdown or HTML (`bookMatterPages.ts`). Nothing here is generated: a book
 * with no biography prints no About the Author page rather than an invented one.
 */
export type BookMatter = {
  dedication?: string;
  /** The biography printed as the About the Author page. Absent: no page. */
  aboutAuthor?: string;
  authorWebsite?: string;
  /** The name after the © line. Absent: the byline (`Project.authorName`). */
  copyrightHolder?: string;
  /** Publisher or imprint name, printed as given. */
  imprint?: string;
  isbn?: string;
  /** "All rights reserved." under the © line — the author's claim to make, never a default. */
  allRightsReserved?: boolean;
  /**
   * The year after ©, as an imported manuscript's own © page printed it
   * ("2019", "2015–2023"), in Western digits. Set only by an import, whose © page
   * comes out of its pages into this matter (`manuscriptMatter.ts`) — a book
   * first published in 2019 is not © the year it was imported. Absent: the year
   * the book was created (`bookMatterYear`), which is every other book.
   */
  copyrightYear?: string;
};

/** What a stored © year may be: one year, or a few joined as a © page writes them. */
const COPYRIGHT_YEAR = /^\d{4}(?:\s*(?:[-–—,]|and|&)\s*\d{4}){0,3}$/;

/**
 * The year a book's © line prints: its own (`copyrightYear`), else the year it
 * was created — never the compile's, so a recompile in January prints the
 * same bytes as the one in December. Every © line reads it here: both compiles
 * through `bookMatterForExport`, and the chat when it quotes the line.
 */
export function bookMatterYear(matter: BookMatter, createdAt: Date): number | string {
  return matter.copyrightYear ?? createdAt.getUTCFullYear();
}

/** Every ceiling a matter field or author-profile field is held to, on both sides of the wire. */
export const BOOK_MATTER_LIMITS = {
  authorName: 120,
  dedication: 2000,
  aboutAuthor: 1500,
  authorWebsite: 200,
  copyrightHolder: 160,
  imprint: 120,
  isbn: 24
} as const;

const TEXT_FIELDS = ["dedication", "aboutAuthor", "authorWebsite", "copyrightHolder", "imprint", "isbn"] as const;
export type BookMatterTextField = (typeof TEXT_FIELDS)[number];
export const BOOK_MATTER_TEXT_FIELDS: readonly BookMatterTextField[] = TEXT_FIELDS;

/** The fields the pages print on one line; the dedication and the biography keep their breaks. */
const SINGLE_LINE_FIELDS: ReadonlySet<BookMatterTextField> = new Set(["authorWebsite", "copyrightHolder", "imprint", "isbn"]);

/**
 * The stored column read back tolerantly: a field of the wrong type, or one
 * that is only whitespace, is absent; an overlong one is clipped to its
 * ceiling. A malformed row prints a book without that page — never fails the
 * compile it belongs to. Every value is cleaned as it is read, so one stored
 * with a control character before the cleaning existed — or written past it —
 * prints as if it had been saved today.
 */
export function parseBookMatter(value: unknown): BookMatter {
  if (!isRecord(value)) return {};
  const matter: BookMatter = {};
  for (const field of TEXT_FIELDS) {
    const text = cleanMatterText(value[field], BOOK_MATTER_LIMITS[field], { singleLine: SINGLE_LINE_FIELDS.has(field) });
    if (text) matter[field] = text;
  }
  if (value.allRightsReserved === true) matter.allRightsReserved = true;
  const year = typeof value.copyrightYear === "string" ? value.copyrightYear.replace(/\s+/g, " ").trim() : "";
  if (year.length <= 24 && COPYRIGHT_YEAR.test(year)) matter.copyrightYear = year;
  return matter;
}

/**
 * A line break spelled other than `\n`: CR and CRLF, the vertical tab Word and
 * PowerPoint write for Shift+Enter, the form feed of a page break, NEL, and the
 * Unicode line and paragraph separators.
 */
const OTHER_LINE_BREAKS = /\r\n?|[\v\f\u0085\u2028\u2029]/g;

/**
 * The whitespace a one-line field folds into one space: ASCII whitespace and
 * the Unicode line separators — the class the matter pages fold the same field
 * by when they print it (`singleLine` in `bookMatterPages.ts`). A no-break or
 * an ideographic space (山田　太郎) is the reader's typography and ends no line.
 */
const LINE_FOLDING_WHITESPACE = /[\t\n\v\f\r \u0085\u2028\u2029]+/g;

/**
 * The two invisible marks the book chat keeps a quoted value literal with
 * (`chatMarkdownLiteral` in apps/api): U+FEFF and U+2060. A model that copies a
 * value out of a reply copies them too, and stored they print invisibly in every
 * export and split the words the chat's grounding and equality checks compare.
 * Nobody types either for print. U+200C and U+200D shape Persian, Indic scripts
 * and emoji, and are kept.
 */
const CHAT_LITERAL_MARKS = /[\ufeff\u2060]/g;

/**
 * Trims a matter value and normalises its line breaks. Runs of blank lines
 * collapse to one, which is the paragraph break the pages print; `singleLine`
 * folds every break and run of whitespace into one space instead.
 *
 * Every character XML 1.0 forbids is dropped, because the EPUB and the Word
 * export are XML and one such character makes the whole file unreadable — a
 * dedication pasted from Word carries U+000B for every Shift+Enter, which is
 * why that one is read as the line break it stands for rather than dropped.
 * So are the chat's literal marks (`CHAT_LITERAL_MARKS`), which XML allows.
 * The ceiling is applied in UTF-16 units, as the request schemas count, and a
 * clip that halves a surrogate pair drops the half it left behind.
 */
export function cleanMatterText(value: unknown, limit: number, options: { singleLine?: boolean } = {}): string | undefined {
  if (typeof value !== "string") return undefined;
  const legal = withoutXmlIllegalCharacters(value.replace(OTHER_LINE_BREAKS, "\n").replace(CHAT_LITERAL_MARKS, ""));
  const text = (options.singleLine ? legal.replace(LINE_FOLDING_WHITESPACE, " ") : legal)
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return withoutXmlIllegalCharacters(text.slice(0, limit)).trim() || undefined;
}

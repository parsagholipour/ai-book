import { proseWordCount } from "./figures/figureBlocks.js";

/**
 * Words of prose room one table row takes on the printed page beyond the
 * words in its cells. A worksheet row prints a full row with padding whether
 * its cells are filled or blank, so a word count reads a table-heavy chapter
 * as short while it fills its pages. Sixteen stored guides and workbooks
 * (2026-09-29/30), rendered at the house layout with and without their
 * tables, printed 13–38 words of prose room a row (median 26) against 4–20
 * counted words. A row's own words plus 10 is the fit that never credits more
 * than the measured room by over 6% (mean error 22%; plus 12 is the unbiased
 * fit), so the measure under-credits a table rather than excusing a thin book.
 */
export const TABLE_ROW_ROOM_WORDS = 10;

/**
 * The share of its word minimum at which a chapter or a book still prints the
 * pages paid for at the house typography. The PDF fitter
 * (`fitBookPdfPageCount`) loosens type and spacing within fixed bounds to
 * reach the paid count. The densest stored book, a prose-only 28-page history,
 * cut paragraph by paragraph and rendered through it, printed all 28 pages at
 * 0.98 of its floor (the fitter at 0.375 of its loosening range), 0.89 (0.625),
 * 0.85 (0.75) and 0.80 (the whole range), and lost a page at 0.74; a sparser
 * history held 0.85 at 0.375. At 0.85 the page reads as the house page, a
 * little airier. The 75 composed books stored from 2026-09-20 to 2026-10-01 all
 * printed their paid count; the seven that the full floor blocked as books were
 * 0.94–1.0 of it, and the fitter had to tighten five of them.
 */
export const LENGTH_FLOOR_SHARE = 0.85;

const FENCE = /^\s*(`{3,}|~{3,})/;
const isDelimiterRow = (line: string | undefined) =>
  line !== undefined && line.includes("|") && line.includes("-") && /^[\s|:-]+$/.test(line);

/** Rows of every pipe table in the markdown (header and body, never the delimiter), outside fenced blocks. */
export function tableRowCount(markdown: string): number {
  const lines = markdown.split(/\r?\n/);
  let rows = 0;
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const marker = line.match(FENCE)?.[1]?.[0];
    if (marker) {
      fence = fence === undefined ? marker : fence === marker ? undefined : fence;
      continue;
    }
    if (fence !== undefined || !line.includes("|") || isDelimiterRow(line) || !isDelimiterRow(lines[index + 1])) continue;
    rows += 1;
    index += 2;
    while (index < lines.length && lines[index]!.trim() && lines[index]!.includes("|")) {
      rows += 1;
      index += 1;
    }
    index -= 1;
  }
  return rows;
}

/**
 * A chapter's length as the length checks read it: its readable words, table
 * cells included, plus the room its table rows print beyond their own words.
 * Figures are left to the budget (`chapterWordBudget`'s `figureWords`).
 */
export function printedWordCount(markdown: string): number {
  return proseWordCount(markdown) + tableRowCount(markdown) * TABLE_ROW_ROOM_WORDS;
}

/**
 * An edit that cuts a chapter past the length floor it was judged at, measured
 * as it prints. A chapter already under that floor may not be cut deeper; one
 * over it may be cut to it, since a cut that only removes restatements is the
 * edit that reads better and still fills the pages.
 */
export function editShortensPastFloor(draft: string, candidate: string, minimum: number): boolean {
  return printedWordCount(candidate) < Math.min(printedWordCount(draft), minimum * LENGTH_FLOOR_SHARE);
}

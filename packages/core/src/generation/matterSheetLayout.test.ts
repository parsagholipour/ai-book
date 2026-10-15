import { describe, expect, it } from "vitest";
import {
  ABOUT_AUTHOR_CSS,
  aboutAuthorLayout,
  MATTER_PAGE_MARGIN_RULE,
  MATTER_SHEET_CSS,
  matterSheetLayout,
  textEms,
  type MatterSheetText
} from "./matterSheetLayout.js";
import { DEFAULT_BOOK_PAGE_MARGIN_RULE } from "./pdfPagination.js";

const PROSE = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";
const prose = (length: number) => PROSE.repeat(Math.ceil(length / PROSE.length)).slice(0, length).trim();
const PUBLICATION = ["© 2026 Ada Lovelace", "All rights reserved.", "Analytical Press", "ISBN 978-0-00-000000-0"];

function text(dedication: string, publication = true): MatterSheetText {
  return {
    dedication: dedication.split(/\n{2,}/).map((paragraph) => paragraph.split("\n")),
    publication: publication ? PUBLICATION : [],
    credit: publication ? "Made with Tomeza" : undefined
  };
}

// Every count below was rendered and read back with pdfinfo when the table was set (2026-10-06):
// 668 renders of these, of all-caps and wide-glyph dedications, and of 8–200 one-line lines and
// 20–140 one-line paragraphs, with and without the publication lines, all matching.
// `pdf.test.ts` keeps rendering a few of them.
describe("matterSheetLayout", () => {
  it("sets a short dedication on the house sheet", () => {
    expect(matterSheetLayout(text("For Sara,\nwho asked for a dragon."))).toEqual({
      tier: undefined,
      sheets: 1,
      className: "book-matter-sheet"
    });
  });

  it("sets a long dedication smaller rather than running it onto a second sheet", () => {
    expect(matterSheetLayout(text(prose(2000)))).toMatchObject({ tier: "long", sheets: 1 });
    expect(matterSheetLayout(text([prose(660), prose(660), prose(660)].join("\n\n")))).toMatchObject({
      tier: "longer",
      sheets: 1
    });
    const poem = Array.from({ length: 40 }, (_, line) => `For the ones who stayed up with me, night ${line}`).join("\n");
    expect(matterSheetLayout(text(poem))).toMatchObject({ tier: "longest", sheets: 1 });
  });

  it("counts every sheet a dedication too long for every size runs onto", () => {
    const words = (count: number, separator: string) => Array.from({ length: count }, (_, i) => `word ${i}`).join(separator);
    expect(matterSheetLayout(text(words(50, "\n")))).toMatchObject({ sheets: 1 });
    expect(matterSheetLayout(text(words(51, "\n")))).toMatchObject({ sheets: 2 });
    expect(matterSheetLayout(text(words(63, "\n"), false))).toMatchObject({ sheets: 1 });
    expect(matterSheetLayout(text(words(64, "\n"), false))).toMatchObject({ sheets: 2 });
    expect(matterSheetLayout(text(words(127, "\n"), false))).toMatchObject({ sheets: 2 });
    expect(matterSheetLayout(text(words(128, "\n"), false))).toMatchObject({ sheets: 3 });
    expect(matterSheetLayout(text(words(128, "\n\n"), false))).toMatchObject({ sheets: 3 });
    expect(matterSheetLayout(text(Array.from({ length: 1000 }, () => "a").join("\n")))).toEqual({
      tier: "longest",
      sheets: 16,
      className: "book-matter-sheet book-matter-sheet--longest book-matter-sheet--runs-on"
    });
  });

  it("reads capitals and wide letters wider than lowercase prose", () => {
    // Read at half an em, an all-caps 2,000 characters set at 11pt and spilled onto a second sheet.
    expect(matterSheetLayout(text(prose(2000).toUpperCase()))).toMatchObject({ tier: "longer", sheets: 1 });
    expect(matterSheetLayout(text("W".repeat(2000)))).toMatchObject({ tier: "longest", sheets: 1 });
    const ampersands = Array.from({ length: 30 }, () => "&".repeat(60)).join("\n");
    expect(matterSheetLayout(text(ampersands, false))).toMatchObject({ tier: "longest", sheets: 1 });
  });

  it("measures a CJK dedication by its full-width characters", () => {
    const zh = "献给我的母亲，她教会了我耐心和勇气。".repeat(120).slice(0, 2000);
    expect(matterSheetLayout(text(zh))).toMatchObject({ tier: "longest", sheets: 1 });
  });

  it("reads an ideographic space as the full-width character it is", () => {
    // Rendered: read as an ordinary space (0.28em), the first was set at 11pt and the second at
    // 9.5pt, and each printed two sheets counted as one. `bookMatterPdf.test.ts` renders both.
    const zh = Array.from("献给我的母亲，她教会了我耐心和勇气。".repeat(70))
      .map((character, index) => (index % 3 === 2 ? `${character}\u3000` : character))
      .join("")
      .slice(0, 1200);
    expect(matterSheetLayout(text(zh))).toMatchObject({ tier: "longer", sheets: 1 });
    const spacedOut = Array.from({ length: 32 }, () => Array.from("献给我的母亲她教会了我耐心和勇气献给我").join("\u3000\u3000")).join("\n");
    expect(matterSheetLayout(text(spacedOut))).toEqual({
      tier: "longest",
      sheets: 2,
      className: "book-matter-sheet book-matter-sheet--longest book-matter-sheet--runs-on"
    });
    for (const dedication of [zh, spacedOut]) {
      expect(matterSheetLayout(text(dedication))).toEqual(matterSheetLayout(text(dedication.replaceAll("\u3000", "献"))));
    }
  });

  it("reads an emoji as the one glyph Chrome draws for it, whatever it is spelled with", () => {
    // Rendered: every emoji below is one 1.25em glyph. Read per code point at half an em,
    // a thousand of them were set at the house size and printed two sheets counted as one.
    expect(matterSheetLayout(text("🎉".repeat(1000)))).toMatchObject({ tier: "longer", sheets: 1 });
    for (const count of [100, 400, 700, 1000]) {
      const single = matterSheetLayout(text("🐉".repeat(count)));
      for (const spelled of ["👨‍👩‍👧", "🇮🇷", "1️⃣", "❤️", "👍🏽"]) {
        expect(matterSheetLayout(text(spelled.repeat(count))), `${spelled} x${count}`).toEqual(single);
      }
    }
  });

  it("reads the symbols no book face draws at the width of the fallback that does", () => {
    const symbols = "★✓☀♥ ".repeat(400).trim();
    expect(matterSheetLayout(text(symbols))).toMatchObject({ tier: "longest", sheets: 1 });
  });

  it("never sets a dedication larger because its publication lines are gone", () => {
    const tiers = [undefined, "long", "longer", "longest"];
    for (const length of [200, 800, 1400, 2000]) {
      const withLines = tiers.indexOf(matterSheetLayout(text(prose(length))).tier);
      const without = tiers.indexOf(matterSheetLayout(text(prose(length), false)).tier);
      expect(without, String(length)).toBeLessThanOrEqual(withLines);
    }
  });
});

describe("textEms", () => {
  it("reads each fixed-width space at the width Unicode gives it, never as an ordinary space", () => {
    const widths: readonly (readonly [string, number])[] = [
      ["\u3000", 1], // ideographic
      ["\u2001", 1], // em quad
      ["\u2003", 1], // em
      ["\u2000", 1 / 2], // en quad
      ["\u2002", 1 / 2], // en
      ["\u2004", 1 / 3],
      ["\u2005", 1 / 4],
      ["\u2006", 1 / 6],
      ["\u2009", 1 / 5], // thin
      ["\u200a", 1 / 16] // hair
    ];
    for (const [space, ems] of widths) {
      expect(textEms(space), `U+${space.codePointAt(0)!.toString(16).toUpperCase()}`).toBeCloseTo(ems, 9);
    }
    expect(textEms("\u3000")).toBe(textEms("献"));
    // An em is an em in either face; a figure space is a digit, in either face.
    expect(textEms("\u3000\u2003", "roman")).toBe(2);
    expect(textEms("\u2007")).toBe(textEms("0"));
    expect(textEms("\u2007", "roman")).toBe(textEms("0", "roman"));
    // The no-break spaces stay ordinary spaces.
    expect(textEms("\u00a0")).toBe(textEms(" "));
    expect(textEms("\u202f")).toBe(textEms(" "));
  });
});

describe("aboutAuthorLayout", () => {
  const paragraphs = (bio: string, website?: string) => [
    ...bio.split(/\n{2,}/).map((paragraph) => paragraph.split("\n")),
    ...(website ? [[website]] : [])
  ];
  const lines = (count: number, line: (index: number) => string) => Array.from({ length: count }, (_, index) => line(index));

  // Every count below was rendered and read back with pdfinfo (2026-10-06): 2,523 biographies —
  // 1 to 140 short paragraphs, 1 to 750 one-word lines, 1 to 300 one-word paragraphs, prose of
  // 100 to 1,500 characters, emoji lines, Persian, Arabic and Chinese, with and without a website —
  // and all but one matched (a 3,700-character Chinese biography, over the limit, counted one more).
  it("sets a biography that fits at the body's own house size, on one sheet", () => {
    expect(aboutAuthorLayout(paragraphs("Ada writes about engines.", "ada.example"))).toEqual({
      tier: undefined,
      sheets: 1,
      className: "book-about-author"
    });
    expect(aboutAuthorLayout(paragraphs(prose(1500), "ada-lovelace.example"))).toMatchObject({ tier: undefined, sheets: 1 });
  });

  it("sets a long one smaller rather than running it onto a sheet nobody counted", () => {
    // Thirty short paragraphs printed three sheets where two were counted, in the body's type.
    const short = (count: number) => lines(count, (index) => `A short paragraph ${index}.`).join("\n\n");
    expect(aboutAuthorLayout(paragraphs(short(30)))).toMatchObject({ tier: "long", sheets: 1 });
    expect(aboutAuthorLayout(paragraphs(short(45)))).toMatchObject({ tier: "longest", sheets: 1 });
    expect(aboutAuthorLayout(paragraphs(lines(50, () => "word").join("\n")))).toMatchObject({ tier: "longer", sheets: 1 });
  });

  it("counts every sheet one too long for every size runs onto, never clipping it", () => {
    const short = (count: number) => lines(count, (index) => `A short paragraph ${index}.`).join("\n\n");
    expect(aboutAuthorLayout(paragraphs(short(50)))).toMatchObject({ tier: "longest", sheets: 2 });
    expect(aboutAuthorLayout(paragraphs(short(40), "ada-lovelace.example"))).toMatchObject({ sheets: 1 });
    expect(aboutAuthorLayout(paragraphs(short(45), "ada-lovelace.example"))).toMatchObject({ sheets: 2 });
    const list = (count: number) => lines(count, (index) => (index % 3 ? "word" : "Engines")).join("\n");
    expect(aboutAuthorLayout(paragraphs(list(80))).sheets).toBe(2);
    expect(aboutAuthorLayout(paragraphs(list(200))).sheets).toBe(4);
    expect(aboutAuthorLayout(paragraphs(list(750)))).toEqual({
      tier: "longest",
      sheets: 12,
      className: "book-about-author book-about-author--longest"
    });
    expect(aboutAuthorLayout(paragraphs(lines(60, () => "word").join("\n\n"))).sheets).toBe(2);
    expect(aboutAuthorLayout(paragraphs(lines(300, () => "word").join("\n\n"))).sheets).toBe(7);
  });

  it("reads an emoji list at the emoji face's width", () => {
    const emoji = ["😀", "🐉", "🎉", "❤️", "👍🏽", "🇮🇷", "👨‍👩‍👧", "1️⃣", "✨", "🌟"];
    const list = (count: number) => lines(count, (index) => `${emoji[index % 10]} ${emoji[(index + 3) % 10]}`).join("\n");
    expect(aboutAuthorLayout(paragraphs(list(150))).sheets).toBe(3);
    expect(aboutAuthorLayout(paragraphs(list(300))).sheets).toBe(5);
  });
});

describe("ABOUT_AUTHOR_CSS", () => {
  it("has a rule for every size the layout can choose, in points the fitter never moves", () => {
    for (const tier of ["long", "longer", "longest"]) {
      expect(ABOUT_AUTHOR_CSS).toMatch(new RegExp(`\\.book-about-author--${tier} ~ p \\{ font-size: [\\d.]+pt; line-height: [\\d.]+; margin: [\\d.]+pt 0 [\\d.]+pt; \\}`));
    }
    // The house size is the body's at the house layout, so a biography that fits prints as it did.
    expect(ABOUT_AUTHOR_CSS).toMatch(/\.book-about-author ~ p \{\s*font-size: 11pt;\s*line-height: 1\.55;\s*margin: 2\.75pt 0 11pt;/);
    expect(ABOUT_AUTHOR_CSS).toMatch(/\.book-about-author ~ \* \{\s*page: pdf-back;/);
    expect(ABOUT_AUTHOR_CSS).not.toMatch(/\d(?:em|%)/);
  });
});

describe("MATTER_SHEET_CSS", () => {
  it("has a rule for every size the layout can choose", () => {
    for (const tier of ["long", "longer", "longest", "runs-on"]) {
      expect(MATTER_SHEET_CSS).toContain(`.book-matter-sheet--${tier} {`);
    }
    expect(MATTER_SHEET_CSS).toMatch(/\.book-matter-sheet--runs-on \{\s*display: block;/);
  });

  it("keeps the matter pages' margins out of the fitter's reach", () => {
    // `bookPdfPaginationCss` swaps the first occurrence of the body's rule; this one must never be it.
    expect(MATTER_PAGE_MARGIN_RULE).not.toContain(DEFAULT_BOOK_PAGE_MARGIN_RULE);
    expect(MATTER_PAGE_MARGIN_RULE).toBe("margin: 20mm 18mm 22mm 18mm;");
  });
});

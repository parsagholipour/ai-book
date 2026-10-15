/**
 * How the matter pages whose length the reader decides are set, and how many
 * sheets they print — the dedication and publication sheet, and About the
 * Author. One table each, that both the stylesheet and the estimate are built
 * from, so the size a page is given and the size it is counted at cannot drift
 * apart (the way `STORY_SCENE_TIERS` fits a story sheet).
 *
 * A dedication may be 2,000 characters on any number of lines
 * (`BOOK_MATTER_LIMITS`), and at the house 13pt a long one ran onto a second
 * sheet that `bookMatterSheetCount` called one: the PDF fitter, aiming the
 * whole file at the paid count plus that one, shrank the body type by a page
 * to pay for it. So the dedication takes the largest tier whose estimated
 * height fits one sheet — a 2,000-character paragraph sets at 11pt, a forty-line
 * poem at 8pt — and only a dedication too long for every tier (hundreds of
 * one-word lines) runs on. That one is counted by laying its lines out the way
 * Chrome breaks them, never clipped: a dedication's words are the reader's.
 *
 * The run-on is made countable on purpose. The sheet's pages keep the house
 * margins whatever the fitter does to the body's (`MATTER_PAGE_MARGIN_RULE`),
 * it is block flow rather than flex (`--runs-on`), its lines break greedily
 * (`orphans`/`widows` 1), and the publication block moves to the next sheet
 * whole rather than splitting — so where every line lands is arithmetic, not a
 * guess about Chrome's breaking.
 *
 * About the Author is the same problem a page later (`aboutAuthorLayout`).
 */

export type MatterSheetText = {
  /** Paragraphs, each a list of the lines a `<br />` separates. */
  dedication: readonly (readonly string[])[];
  publication: readonly string[];
  credit: string | undefined;
};

export type MatterSheetLayout = {
  /** The `book-matter-sheet--<tier>` modifier; `undefined` is the house sheet. */
  tier: string | undefined;
  sheets: number;
  /** The section's `class`: the sheet, its tier, and `--runs-on` past one sheet. */
  className: string;
};

type DedicationTier = {
  name: string | undefined;
  fontPt: number;
  lineHeight: number;
  /** The dedication column, capped by the sheet's own width. */
  measureMm: number;
  /** Space between paragraphs. */
  gapMm: number;
  /** The sheet's top padding: the house sheet sets a dedication in its upper third. */
  topMm: number;
};

const DEDICATION_TIERS: readonly DedicationTier[] = [
  { name: undefined, fontPt: 13, lineHeight: 1.6, measureMm: 120, gapMm: 4, topMm: 30 },
  { name: "long", fontPt: 11, lineHeight: 1.5, measureMm: 140, gapMm: 3, topMm: 20 },
  { name: "longer", fontPt: 9.5, lineHeight: 1.45, measureMm: 150, gapMm: 2.5, topMm: 12 },
  { name: "longest", fontPt: 8, lineHeight: 1.4, measureMm: 150, gapMm: 2, topMm: 6 }
];

const PUBLICATION = { fontPt: 8.5, lineHeight: 1.5, gapMm: 1.2, creditGapMm: 4, paddingTopMm: 12, paddingBottomMm: 6 };

/** The matter pages' margins; the A4 sheet less them is what one page holds. */
const PAGE_MARGIN_MM = { top: 20, side: 18, bottom: 22 };
const PAGE_HEIGHT_MM = 297 - PAGE_MARGIN_MM.top - PAGE_MARGIN_MM.bottom;
const PAGE_WIDTH_MM = 210 - 2 * PAGE_MARGIN_MM.side;
/**
 * The sheet's designed height: a dedication that fits it never reaches the
 * page's foot. It is also the budget either page is held to before it is set
 * a size smaller — the 10mm left below it absorbs a line the estimate missed.
 */
const SHEET_MIN_HEIGHT_MM = 245;
const SHEET_PADDING_X_MM = 12;
const SHEET_WIDTH_MM = PAGE_WIDTH_MM - 2 * SHEET_PADDING_X_MM;
const PT_PER_MM = 72 / 25.4;

/**
 * Written out with four values so `bookPdfPaginationCss`, which swaps the
 * body's `DEFAULT_BOOK_PAGE_MARGIN_RULE` for a fitted one, never matches it.
 */
export const MATTER_PAGE_MARGIN_RULE = `margin: ${PAGE_MARGIN_MM.top}mm ${PAGE_MARGIN_MM.side}mm ${PAGE_MARGIN_MM.bottom}mm ${PAGE_MARGIN_MM.side}mm;`;

/**
 * Width of `text` in ems, set in the dedication's own face (Source Serif 4
 * italic, measured in Chrome): lowercase prose runs 0.45em a character with
 * its spaces and is read at half an em, but capitals run 0.64 — an all-caps
 * dedication read at half an em was set a size too large and spilled onto a
 * sheet it was not counted for — and `M`, `W`, `m`, `%` and `@` run 0.87 to
 * 0.94. Each class is read a little wide: too narrow spills a sheet nobody
 * counted, too wide counts one that never prints (`&` read at 0.95 did). A
 * full-width character is a whole em.
 *
 * An emoji is read per *grapheme*, because that is what Chrome draws: every
 * one measured — a single code point, a heart with its variation selector, a
 * flag's two regional indicators, a skin tone, a keycap, a ZWJ family — is one
 * 1.25em glyph from the colour-emoji face, whatever the book's face. Read per
 * code point at half an em, a dedication of emoji was set at the house size
 * and printed on more sheets than it was counted for.
 *
 * The roman face the biography is set in reads 6% wider than the italic
 * letter for letter (lowercase 0.52em against 0.47, `W` 1.01 against 0.92);
 * the emoji, symbol and full-width faces are the same in both.
 */
export function textEms(text: string, face: "italic" | "roman" = "italic"): number {
  const scale = face === "roman" ? ROMAN_SCALE : 1;
  let ems = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    if (EMOJI_GRAPHEME.test(segment)) {
      ems += EMOJI_EMS;
      continue;
    }
    for (const character of segment) {
      const width = characterEms(character);
      ems += width >= 1 ? width : width * scale;
    }
  }
  return ems;
}

const ROMAN_SCALE = 1.06;
const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });
/** Measured at 1.245em (Noto Color Emoji, which the host and the worker image both fall back to). */
const EMOJI_EMS = 1.3;
/**
 * A grapheme Chrome draws from the colour-emoji face: emoji presentation by
 * default, or asked for by a variation selector or a keycap; a skin tone; a
 * flag; and the supplementary pictograph blocks no text face carries.
 */
const EMOJI_GRAPHEME = /\p{Emoji_Presentation}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[\u{1F000}-\u{1FAFF}]|\ufe0f|\u20e3/u;

/**
 * The fixed-width spaces, at the widths Unicode gives them — which are also
 * what HarfBuzz draws when a face has no glyph of its own. Read as ordinary
 * spaces, an ideographic space (a full-width character, set from the CJK face)
 * counted 0.28em of the em it prints: a Chinese dedication spaced with them,
 * and a Latin one spaced with em spaces, printed a sheet more than counted, and
 * the fitter shrank the paid body text to pay for it. The figure space is a
 * digit's width, read as the digits are. The no-break, narrow no-break and
 * punctuation spaces stay ordinary spaces. The roman face's scale reads the
 * fractions of an em 6% wide, which is the safe side.
 */
const FIXED_SPACE_EMS: ReadonlyMap<string, number> = new Map([
  ["\u2000", 1 / 2], // en quad
  ["\u2001", 1], // em quad
  ["\u2002", 1 / 2], // en space
  ["\u2003", 1], // em space
  ["\u2004", 1 / 3], // three-per-em space
  ["\u2005", 1 / 4], // four-per-em space
  ["\u2006", 1 / 6], // six-per-em space
  ["\u2007", 0.6], // figure space
  ["\u2009", 1 / 5], // thin space
  ["\u200a", 1 / 16], // hair space
  ["\u3000", 1] // ideographic space
]);

function characterEms(character: string): number {
  const fixedSpace = FIXED_SPACE_EMS.get(character);
  if (fixedSpace !== undefined) return fixedSpace;
  if (/\s/u.test(character)) return 0.28;
  // Hangul, CJK through Yi, compatibility forms, full width, and the
  // supplementary ideographs a surrogate pair spells.
  if (/[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u{20000}-\u{3fffd}]/u.test(character)) return 1;
  // Arrows, dingbats, geometric shapes and the text-presentation symbols (★ ✓ ☀):
  // no book face draws them, and the fallbacks Chrome finds run 0.6em (●) to 1.02 (☺).
  if (/[\u2190-\u2bff]/u.test(character)) return 1;
  if (/[MWm@%]/u.test(character)) return 0.95;
  if (/[w\u2014]/u.test(character)) return 0.85;
  if (/[\p{Lu}&]/u.test(character)) return 0.7;
  if (/[\d\u0400-\u04ff]/u.test(character)) return 0.6;
  return 0.5;
}

/** The line boxes `ems` of text take in a column `measureMm` wide at `fontPt`. */
function wrappedLines(ems: number, fontPt: number, measureMm: number): number {
  const emsPerLine = ((measureMm * PT_PER_MM) / fontPt) * 0.92;
  return Math.max(1, Math.ceil(ems / emsPerLine));
}

/** The publication block, padding and collapsed margins included. Zero when there is none. */
function publicationHeightMm(text: MatterSheetText): number {
  const lines = [
    ...text.publication.map((line) => ({ line, marginTop: 0 })),
    ...(text.credit ? [{ line: text.credit, marginTop: PUBLICATION.creditGapMm }] : [])
  ];
  if (lines.length === 0) return 0;
  const lineMm = (PUBLICATION.fontPt * PUBLICATION.lineHeight) / PT_PER_MM;
  let height = PUBLICATION.paddingTopMm;
  let pendingMargin = 0;
  for (const { line, marginTop } of lines) {
    // Adjacent block margins collapse to the larger.
    height += Math.max(pendingMargin, marginTop) + wrappedLines(textEms(line), PUBLICATION.fontPt, SHEET_WIDTH_MM) * lineMm;
    pendingMargin = PUBLICATION.gapMm;
  }
  return height + pendingMargin + PUBLICATION.paddingBottomMm;
}

/** Each paragraph's line boxes at `fontPt`, from the ems of each of its lines. */
function lineBoxes(ems: readonly (readonly number[])[], fontPt: number, measureMm: number): number[] {
  return ems.map((paragraph) => paragraph.reduce((count, line) => count + wrappedLines(line, fontPt, measureMm), 0));
}

/**
 * Lays line boxes down a sheet at a time, the way Chrome breaks a block flow
 * whose `orphans` and `widows` are 1: a line goes where it fits, the margin
 * above a paragraph is dropped where it falls at a break, and `topMm` — what
 * the first sheet carries above the first paragraph — is on that sheet only.
 */
function layDown(
  paragraphs: readonly number[],
  flow: { topMm: number; firstGapMm: number; gapMm: number; lineMm: number }
): { sheets: number; endMm: number } {
  let sheets = 1;
  let y = flow.topMm;
  for (const [index, lines] of paragraphs.entries()) {
    y += index === 0 ? flow.firstGapMm : flow.gapMm;
    for (let line = 0; line < lines; line += 1) {
      if (y + flow.lineMm > PAGE_HEIGHT_MM) {
        sheets += 1;
        y = 0;
      }
      y += flow.lineMm;
    }
  }
  return { sheets, endMm: y };
}

/**
 * The tier a dedication is set at, and the sheets it prints: the largest tier
 * whose sheet holds it, or the smallest, run on over as many sheets as it
 * takes.
 */
export function matterSheetLayout(text: MatterSheetText): MatterSheetLayout {
  const publication = publicationHeightMm(text);
  const ems = text.dedication.map((paragraph) => paragraph.map((line) => textEms(line)));
  for (const tier of DEDICATION_TIERS) {
    const lineMm = (tier.fontPt * tier.lineHeight) / PT_PER_MM;
    const paragraphs = dedicationLineBoxes(ems, tier);
    const dedication =
      paragraphs.reduce((height, lines) => height + lines * lineMm, 0) + Math.max(0, paragraphs.length - 1) * tier.gapMm;
    if (tier.topMm + dedication + publication <= SHEET_MIN_HEIGHT_MM) {
      return withClassName(tier, 1);
    }
  }
  const tier = DEDICATION_TIERS[DEDICATION_TIERS.length - 1]!;
  return withClassName(tier, runOnSheets(dedicationLineBoxes(ems, tier), tier, publication));
}

function dedicationLineBoxes(ems: readonly (readonly number[])[], tier: DedicationTier): number[] {
  return lineBoxes(ems, tier.fontPt, Math.min(tier.measureMm, SHEET_WIDTH_MM));
}

function withClassName(tier: DedicationTier, sheets: number): MatterSheetLayout {
  const modifiers = [...(tier.name ? [tier.name] : []), ...(sheets > 1 ? [RUNS_ON] : [])];
  const className = ["book-matter-sheet", ...modifiers.map((name) => `book-matter-sheet--${name}`)].join(" ");
  return { tier: tier.name, sheets, className };
}

const RUNS_ON = "runs-on";

/**
 * The dedication's lines laid down from the sheet's top padding, and then the
 * publication block, which moves to the next sheet whole.
 */
function runOnSheets(paragraphs: readonly number[], tier: DedicationTier, publicationMm: number): number {
  const lineMm = (tier.fontPt * tier.lineHeight) / PT_PER_MM;
  const { sheets, endMm } = layDown(paragraphs, { topMm: tier.topMm, firstGapMm: 0, gapMm: tier.gapMm, lineMm });
  return publicationMm > 0 && endMm + publicationMm > PAGE_HEIGHT_MM ? sheets + 1 : sheets;
}

const dedicationRules = (tier: DedicationTier, separator = " ") =>
  [`width: min(${tier.measureMm}mm, 100%);`, `font-size: ${tier.fontPt}pt;`, `line-height: ${tier.lineHeight};`].join(separator);

const [HOUSE_TIER, ...SMALLER_TIERS] = DEDICATION_TIERS as [DedicationTier, ...DedicationTier[]];

/**
 * The sheet's stylesheet, from the same numbers the estimate reads. The
 * publication block carries the sheet's bottom padding, so the block that moves
 * whole takes it along; the house sheet prints exactly as it did with the
 * padding on the section. A word too long for its line breaks where it must,
 * which is what the estimate assumes: unbroken, `W` two thousand times ran off
 * the sheet's side and Chrome shrank the whole sheet to fit it. The last
 * paragraph has no bottom margin, and a sheet
 * that runs on is block flow rather than flex: Chrome does not drop a flex
 * item's trailing margin at the page's foot, nor the paragraph margins it
 * truncates at each break from the flex container's height, and both printed
 * a blank sheet after a full one (63 one-line paragraphs; 128 one-line
 * paragraphs). Past one sheet the auto margins are zero anyway; on the house
 * sheet they pin both blocks, so neither change moves a line.
 */
export const MATTER_SHEET_CSS = `
  .book-matter-sheet {
    page: pdf-front;
    box-sizing: border-box;
    min-height: ${SHEET_MIN_HEIGHT_MM}mm;
    padding: ${HOUSE_TIER.topMm}mm ${SHEET_PADDING_X_MM}mm 0;
    display: flex;
    flex-direction: column;
    color: #211a14;
    overflow-wrap: anywhere;
    break-before: page;
    break-after: page;
    page-break-before: always;
    page-break-after: always;
  }
  .book-matter-sheet__dedication {
    margin: 0 auto;
    ${dedicationRules(HOUSE_TIER, "\n    ")}
    text-align: center;
    font-style: italic;
  }
  .book-matter-sheet__dedication p {
    margin: 0 0 ${HOUSE_TIER.gapMm}mm;
    orphans: 1;
    widows: 1;
  }
  .book-matter-sheet__publication {
    margin-top: auto;
    padding: ${PUBLICATION.paddingTopMm}mm 0 ${PUBLICATION.paddingBottomMm}mm;
    font-size: ${PUBLICATION.fontPt}pt;
    line-height: ${PUBLICATION.lineHeight};
    color: #4a4038;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .book-matter-sheet__publication p {
    margin: 0 0 ${PUBLICATION.gapMm}mm;
  }
  .book-matter-sheet__publication .book-matter-sheet__credit {
    margin-top: ${PUBLICATION.creditGapMm}mm;
    color: #8a7a6a;
  }
${SMALLER_TIERS.map(
  (tier) => `  .book-matter-sheet--${tier.name} { padding-top: ${tier.topMm}mm; }
  .book-matter-sheet--${tier.name} .book-matter-sheet__dedication { ${dedicationRules(tier)} }
  .book-matter-sheet--${tier.name} .book-matter-sheet__dedication p { margin-bottom: ${tier.gapMm}mm; }`
).join("\n")}
  .book-matter-sheet .book-matter-sheet__dedication p:last-child {
    margin-bottom: 0;
  }
  .book-matter-sheet--${RUNS_ON} {
    display: block;
  }
`;

export type AboutAuthorLayout = {
  /** The `book-about-author--<tier>` modifier; `undefined` is the house size. */
  tier: string | undefined;
  sheets: number;
  /** The marker's `class`: the marker, and its tier. */
  className: string;
};

type AboutTier = {
  name: string | undefined;
  fontPt: number;
  lineHeight: number;
  /** A paragraph's margins; between two paragraphs they collapse to the larger. */
  marginTopPt: number;
  marginBottomPt: number;
};

/**
 * The house size is the body's own at the house layout — 11pt, 1.55, and
 * md-to-pdf's `p { margin: 0.25em 0 1em }` — so a biography that fits prints
 * exactly as it did when it was set in the body's type.
 */
const ABOUT_TIERS: readonly AboutTier[] = [
  { name: undefined, fontPt: 11, lineHeight: 1.55, marginTopPt: 2.75, marginBottomPt: 11 },
  { name: "long", fontPt: 10, lineHeight: 1.5, marginTopPt: 2.5, marginBottomPt: 7 },
  { name: "longer", fontPt: 9, lineHeight: 1.45, marginTopPt: 2, marginBottomPt: 5 },
  { name: "longest", fontPt: 8, lineHeight: 1.4, marginTopPt: 1.5, marginBottomPt: 4 }
];

/** The heading, as md-to-pdf pads every `h2` and `BOOK_PDF_CSS` sizes it; pinned here so neither can move it. */
const ABOUT_HEADING = { fontPt: 14, lineHeight: 1.55, paddingTopPt: 7, paddingBottomPt: 3.5 };
const ABOUT_HEADING_MM =
  (ABOUT_HEADING.paddingTopPt + ABOUT_HEADING.fontPt * ABOUT_HEADING.lineHeight + ABOUT_HEADING.paddingBottomPt) / PT_PER_MM;

/**
 * The size About the Author is set at, and the sheets it prints, from the
 * biography's paragraphs (each the lines a hard break separates) and the
 * website line after them.
 *
 * It used to be set in the body's type and counted as one sheet, and nothing
 * bounds its height but 1,500 characters: a biography written as a list, or as
 * thirty short paragraphs, printed three sheets where two were counted, and
 * the fitter — which moves the body's size, leading, paragraph spacing and
 * page margins — set the *biography* smaller along with the book while it
 * shrank a six-page book to pay for the sheet nobody counted. Now it is set in
 * points the fitter never touches, on pages with the house margins
 * (`@page pdf-back`), at the largest tier that holds it on one sheet — and a
 * biography too long for the smallest (hundreds of one-word lines) runs on,
 * counted line by line exactly as the dedication is. Never clipped.
 */
export function aboutAuthorLayout(paragraphs: readonly (readonly string[])[]): AboutAuthorLayout {
  const ems = paragraphs.map((paragraph) => paragraph.map((line) => textEms(line, "roman")));
  for (const tier of ABOUT_TIERS) {
    const lineMm = (tier.fontPt * tier.lineHeight) / PT_PER_MM;
    const boxes = lineBoxes(ems, tier.fontPt, PAGE_WIDTH_MM);
    const height =
      ABOUT_HEADING_MM +
      tier.marginTopPt / PT_PER_MM +
      boxes.reduce((total, lines) => total + lines * lineMm, 0) +
      (Math.max(0, boxes.length - 1) * Math.max(tier.marginTopPt, tier.marginBottomPt)) / PT_PER_MM;
    if (height <= SHEET_MIN_HEIGHT_MM) return aboutClassName(tier, 1);
  }
  const tier = ABOUT_TIERS[ABOUT_TIERS.length - 1]!;
  const { sheets } = layDown(lineBoxes(ems, tier.fontPt, PAGE_WIDTH_MM), {
    topMm: ABOUT_HEADING_MM,
    firstGapMm: tier.marginTopPt / PT_PER_MM,
    gapMm: Math.max(tier.marginTopPt, tier.marginBottomPt) / PT_PER_MM,
    lineMm: (tier.fontPt * tier.lineHeight) / PT_PER_MM
  });
  return aboutClassName(tier, sheets);
}

function aboutClassName(tier: AboutTier, sheets: number): AboutAuthorLayout {
  return { tier: tier.name, sheets, className: ["book-about-author", ...(tier.name ? [`book-about-author--${tier.name}`] : [])].join(" ") };
}

const aboutRules = (tier: AboutTier, separator = " ") =>
  [`font-size: ${tier.fontPt}pt;`, `line-height: ${tier.lineHeight};`, `margin: ${tier.marginTopPt}pt 0 ${tier.marginBottomPt}pt;`].join(
    separator
  );

const [ABOUT_HOUSE_TIER, ...ABOUT_SMALLER_TIERS] = ABOUT_TIERS as [AboutTier, ...AboutTier[]];

/**
 * About the Author's stylesheet, from the same numbers `aboutAuthorLayout`
 * reads. The heading opens a fresh sheet; the empty marker after it is what
 * names it (`bookMatterPages.ts`), because the heading's own id is marked's slug
 * of a translated label. Everything from the heading on is `@page pdf-back`,
 * numbered like the body but with the house margins whatever the fitter does
 * to the body's; the biography's size, leading and paragraph spacing are
 * points, which the fitter's `body` and `body > p` rules cannot reach, and it
 * breaks greedily, as the estimate lays it down. A word too long for its line
 * — a URL, a pen name with no spaces — breaks where it must rather than
 * widening the page.
 */
export const ABOUT_AUTHOR_CSS = `
  h2:has(+ .book-about-author) {
    break-before: page;
    page-break-before: always;
    margin-top: 0;
    padding: ${ABOUT_HEADING.paddingTopPt}pt 0 ${ABOUT_HEADING.paddingBottomPt}pt;
    font-size: ${ABOUT_HEADING.fontPt}pt;
    line-height: ${ABOUT_HEADING.lineHeight};
  }
  h2:has(+ .book-about-author),
  .book-about-author,
  .book-about-author ~ * {
    page: pdf-back;
  }
  .book-about-author ~ p {
    ${aboutRules(ABOUT_HOUSE_TIER, "\n    ")}
    overflow-wrap: anywhere;
    orphans: 1;
    widows: 1;
  }
${ABOUT_SMALLER_TIERS.map((tier) => `  .book-about-author--${tier.name} ~ p { ${aboutRules(tier)} }`).join("\n")}
`;

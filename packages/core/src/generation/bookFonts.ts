import { scriptProfileForLanguage } from "../prompting/script.js";

/**
 * One Fontsource package contributing `@font-face` rules to a family.
 *
 * The CSS is read from the package itself rather than hand-written, because a
 * hand-written `unicode-range` is exactly the bug this registry exists to fix:
 * a face declared without one claims all of Unicode and stops Chrome ever
 * falling back.
 */
export type FontsourcePackage = {
  /** Package name, e.g. "@fontsource-variable/vazirmatn". */
  readonly package: string;
  /** CSS files inside it, in declaration order. */
  readonly css: readonly string[];
  /**
   * Keep only the faces whose `unicode-range` intersects this range. Used to
   * take a package's own script and leave Latin to its companion. Omit to keep
   * every face — which is what CJK wants, since a CJK family's Latin is drawn
   * to match its own metrics and reads better than a mismatched serif.
   *
   * It has to be a range rather than a subset name: Noto Serif SC calls its
   * 101 subsets `[4]`, `[5]`, … so there is no name to match on.
   */
  readonly limitTo?: string;
};

/**
 * The faces behind the two family names `BOOK_PDF_CSS` and the cover templates
 * refer to. Both lists are **fallback first, preferred last**: two faces of one
 * family with overlapping ranges resolve to the later declaration, and the
 * script's own package must win that overlap. Vazirmatn's Arabic subset claims
 * ZWNJ (U+200C) along with the letters, and Persian sets ZWNJ inside words
 * ("می‌رود") — letting a Latin face claim it would split the shaping run in the
 * middle of a word.
 */
export type BookFontSet = {
  readonly id: string;
  /** Registered under the body family name ("SourceSerifBook"). */
  readonly body: readonly FontsourcePackage[];
  /** Registered under the display family name ("InterBook"). */
  readonly display: readonly FontsourcePackage[];
};

const ARABIC_RANGE = "U+0600-06FF";
const HEBREW_RANGE = "U+0590-05FF";
const DEVANAGARI_RANGE = "U+0900-097F";
const THAI_RANGE = "U+0E00-0E7F";

const SOURCE_SERIF: FontsourcePackage = {
  package: "@fontsource-variable/source-serif-4",
  css: ["index.css", "wght-italic.css"]
};
const INTER: FontsourcePackage = {
  package: "@fontsource-variable/inter",
  css: ["index.css"]
};

function script(pkg: string, limitTo?: string): FontsourcePackage {
  return { package: pkg, css: ["index.css"], ...(limitTo ? { limitTo } : {}) };
}

const VAZIRMATN = script("@fontsource-variable/vazirmatn", ARABIC_RANGE);
const NASKH = script("@fontsource-variable/noto-naskh-arabic", ARABIC_RANGE);
const HEBREW = script("@fontsource-variable/noto-serif-hebrew", HEBREW_RANGE);
const DEVANAGARI_SERIF = script("@fontsource-variable/noto-serif-devanagari", DEVANAGARI_RANGE);
const DEVANAGARI_SANS = script("@fontsource-variable/noto-sans", DEVANAGARI_RANGE);
const THAI = script("@fontsource-variable/noto-serif-thai", THAI_RANGE);
const HAN_SIMPLIFIED = script("@fontsource-variable/noto-serif-sc");
const JAPANESE = script("@fontsource-variable/noto-serif-jp");
const KOREAN = script("@fontsource-variable/noto-serif-kr");

/**
 * Cyrillic, Greek and Vietnamese have no entry: Source Serif 4 and Inter
 * already ship those subsets, and they rendered as tofu only because the old
 * loader took the `-latin-` file and dropped the `unicode-range`.
 */
const BOOK_FONT_SETS: Record<string, BookFontSet> = {
  latin: { id: "latin", body: [SOURCE_SERIF], display: [INTER] },
  // Persian sets in a humanist sans, not naskh, and Vazirmatn's default forms
  // are Persian yeh and keheh. Its 100-900 axis also carries the 700 headings
  // that Noto Naskh's 400-700 axis would silently clamp.
  "arabic-persian": { id: "arabic-persian", body: [SOURCE_SERIF, VAZIRMATN], display: [INTER, VAZIRMATN] },
  "arabic-naskh": { id: "arabic-naskh", body: [SOURCE_SERIF, NASKH], display: [INTER, NASKH] },
  hebrew: { id: "hebrew", body: [SOURCE_SERIF, HEBREW], display: [INTER, HEBREW] },
  devanagari: { id: "devanagari", body: [SOURCE_SERIF, DEVANAGARI_SERIF], display: [INTER, DEVANAGARI_SANS] },
  thai: { id: "thai", body: [SOURCE_SERIF, THAI], display: [INTER, THAI] },
  // CJK reuses the serif for the display role rather than pulling in another
  // 6 MB sans for two eyebrow lines.
  "han-simplified": { id: "han-simplified", body: [SOURCE_SERIF, HAN_SIMPLIFIED], display: [INTER, HAN_SIMPLIFIED] },
  japanese: { id: "japanese", body: [SOURCE_SERIF, JAPANESE], display: [INTER, JAPANESE] },
  korean: { id: "korean", body: [SOURCE_SERIF, KOREAN], display: [INTER, KOREAN] }
};

export const LATIN_BOOK_FONT_SET = BOOK_FONT_SETS.latin as BookFontSet;

export function bookFontSetForLanguage(language: string | null | undefined): BookFontSet {
  return BOOK_FONT_SETS[scriptProfileForLanguage(language).fontSet] ?? LATIN_BOOK_FONT_SET;
}

/** Every set in the registry, for tests that resolve each package on disk. */
export function allBookFontSets(): readonly BookFontSet[] {
  return Object.values(BOOK_FONT_SETS);
}

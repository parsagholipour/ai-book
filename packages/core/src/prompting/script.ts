import { isEnglishLanguage, languageLabel } from "./language.js";

/**
 * The writing systems the exporters know how to typeset. A book's language
 * resolves to exactly one of these; anything unrecognised falls back to
 * `latin`, which is also what an English book uses.
 */
export type BookScript =
  | "latin"
  | "cyrillic"
  | "greek"
  | "arabic"
  | "hebrew"
  | "devanagari"
  | "thai"
  | "han-simplified"
  | "japanese"
  | "korean";

/**
 * Everything the PDF, EPUB and cover renderers need to know about a language
 * that is not "which words to use". Read it with {@link scriptProfileForLanguage}
 * rather than branching on the raw language value: `Project.language` is a
 * free-form string that has been written as "fa", "Farsi" and "Persian" by
 * three different routes.
 */
export type ScriptProfile = {
  readonly script: BookScript;
  readonly direction: "ltr" | "rtl";
  /** BCP-47, for `<html lang>`, `<dc:language>` and `xml:lang`. */
  readonly code: string;
  /**
   * True when letters join. `letter-spacing` and `text-transform: uppercase`
   * break the joining forms of a cursive script, so every rule carrying them
   * has to be neutralised.
   */
  readonly cursive: boolean;
  /**
   * False when the script has no italic face. Chrome synthesizes an oblique
   * otherwise, which skews an Arabic baseline into nonsense.
   */
  readonly hasItalic: boolean;
  /** Multiplies the PDF body size, which is calibrated for Latin at 11pt. */
  readonly fontSizeScale: number;
  readonly lineHeight: number;
  /** Cover title line-height: 0.94 clips the descenders of taller scripts. */
  readonly coverTitleLineHeight: number;
  /**
   * Multiplies the cover's `maxCharsPerLine`, which each template calibrated
   * against its own Latin display face. Below 1 for every non-Latin script,
   * because those faces are condensed and their substitutes are not — a title
   * that overflows does not just look wrong, it widens the RTL layout enough
   * to slide the artwork off the cover and expose the backdrop.
   */
  readonly charWidthScale: number;
  /** Key into the font registry in `generation/bookFonts.ts`. */
  readonly fontSet: string;
  /**
   * The script's own decimal digits, "0" through "9" in order, or null when it
   * numbers with Western digits. Only scripts whose digits are in everyday use
   * are listed: Hebrew and CJK both have numeral systems, but a modern book in
   * either numbers its pages 1, 2, 3.
   */
  readonly numerals: string | null;
};

const LATIN_PROFILE: ScriptProfile = {
  script: "latin",
  direction: "ltr",
  code: "en",
  cursive: false,
  hasItalic: true,
  fontSizeScale: 1,
  lineHeight: 1.55,
  coverTitleLineHeight: 0.94,
  charWidthScale: 1,
  fontSet: "latin",
  numerals: null
};

/** Extended Arabic-Indic, U+06F0-06F9 — Persian and Urdu. */
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
/** Arabic-Indic, U+0660-0669. Visibly not the Persian four, six and seven. */
const ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
/** Devanagari, U+0966-096F. */
const DEVANAGARI_DIGITS = "०१२३४५६७८९";
/** Thai, U+0E50-0E59. */
const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";

function profile(overrides: Partial<ScriptProfile> & Pick<ScriptProfile, "code">): ScriptProfile {
  return { ...LATIN_PROFILE, ...overrides };
}

const ARABIC_DEFAULTS = {
  script: "arabic",
  direction: "rtl",
  cursive: true,
  hasItalic: false,
  fontSizeScale: 1.06,
  lineHeight: 1.9,
  coverTitleLineHeight: 1.25,
  charWidthScale: 0.72
} as const satisfies Partial<ScriptProfile>;

const CJK_DEFAULTS = {
  hasItalic: false,
  lineHeight: 1.75,
  coverTitleLineHeight: 1.15,
  charWidthScale: 0.5
} as const satisfies Partial<ScriptProfile>;

/**
 * Keyed by `languageLabel(...).toLowerCase()`, the same way
 * `MARKDOWN_LABELS_BY_LANGUAGE` is — which is what makes "fa", "Farsi" and
 * "Persian" all land on the same entry.
 */
const SCRIPT_PROFILES: Record<string, ScriptProfile> = {
  persian: profile({ ...ARABIC_DEFAULTS, code: "fa", fontSet: "arabic-persian", numerals: PERSIAN_DIGITS }),
  arabic: profile({ ...ARABIC_DEFAULTS, code: "ar", fontSet: "arabic-naskh", numerals: ARABIC_INDIC_DIGITS }),
  urdu: profile({
    ...ARABIC_DEFAULTS,
    code: "ur",
    fontSizeScale: 1.08,
    lineHeight: 2,
    fontSet: "arabic-naskh",
    // Urdu counts in the Persian digits, not the Arabic ones its letters share.
    numerals: PERSIAN_DIGITS
  }),
  hebrew: profile({
    script: "hebrew",
    direction: "rtl",
    code: "he",
    hasItalic: false,
    lineHeight: 1.7,
    coverTitleLineHeight: 1.25,
    charWidthScale: 0.85,
    fontSet: "hebrew"
  }),
  hindi: profile({
    script: "devanagari",
    code: "hi",
    cursive: true,
    hasItalic: false,
    lineHeight: 1.8,
    coverTitleLineHeight: 1.35,
    charWidthScale: 0.8,
    fontSet: "devanagari",
    numerals: DEVANAGARI_DIGITS
  }),
  thai: profile({
    script: "thai",
    code: "th",
    cursive: true,
    hasItalic: false,
    fontSizeScale: 1.05,
    lineHeight: 1.9,
    coverTitleLineHeight: 1.35,
    charWidthScale: 0.85,
    fontSet: "thai",
    numerals: THAI_DIGITS
  }),
  chinese: profile({ ...CJK_DEFAULTS, script: "han-simplified", code: "zh", fontSet: "han-simplified" }),
  japanese: profile({ ...CJK_DEFAULTS, script: "japanese", code: "ja", fontSet: "japanese" }),
  korean: profile({ ...CJK_DEFAULTS, script: "korean", code: "ko", charWidthScale: 0.55, fontSet: "korean" }),
  russian: profile({ script: "cyrillic", code: "ru" }),
  ukrainian: profile({ script: "cyrillic", code: "uk" }),
  greek: profile({ script: "greek", code: "el" }),
  vietnamese: profile({ code: "vi", lineHeight: 1.6 }),
  // Latin-script languages whose only need is a correct `lang` attribute.
  spanish: profile({ code: "es" }),
  french: profile({ code: "fr" }),
  german: profile({ code: "de" }),
  italian: profile({ code: "it" }),
  portuguese: profile({ code: "pt" }),
  dutch: profile({ code: "nl" }),
  turkish: profile({ code: "tr" }),
  polish: profile({ code: "pl" }),
  swedish: profile({ code: "sv" }),
  norwegian: profile({ code: "no" }),
  danish: profile({ code: "da" })
};

export function scriptProfileForLanguage(language: string | null | undefined): ScriptProfile {
  if (isEnglishLanguage(language)) {
    return LATIN_PROFILE;
  }
  const known = SCRIPT_PROFILES[languageLabel(language).toLowerCase()];
  if (known) {
    return known;
  }
  // An unmapped language still gets a usable `lang` attribute; the fonts fall
  // back to Latin plus whatever the host has installed.
  return { ...LATIN_PROFILE, code: bcp47LanguageCode(language) };
}

/**
 * The stored language as a BCP-47 code, or "en" when it is a display label we
 * have no mapping for. The only producer of language codes in the codebase —
 * `<dc:language>`, `<html lang>` and `Intl.Segmenter` all read it.
 */
export function bcp47LanguageCode(language: string | null | undefined): string {
  const trimmed = language?.trim().toLowerCase();
  if (!trimmed) {
    return "en";
  }
  const candidate = trimmed.split(/[_\s]/)[0] ?? trimmed;
  return /^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(candidate) ? candidate : "en";
}

const RTL_LANGUAGES = new Set([
  "ar",
  "arabic",
  "fa",
  "farsi",
  "persian",
  "he",
  "iw",
  "hebrew",
  "ur",
  "urdu",
  "ps",
  "pashto",
  "sd",
  "sindhi",
  "yi",
  "yiddish",
  "dv",
  "ku",
  "kurdish"
]);

export function isRtlLanguage(language: string | null | undefined): boolean {
  const normalized = (language ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const base = normalized.split(/[-_]/)[0] ?? normalized;
  return RTL_LANGUAGES.has(normalized) || RTL_LANGUAGES.has(base);
}

/**
 * The one definition of what a "rebuild this book differently" request changes.
 *
 * A structural edit ("make it 3 pages without illustrations") names generation
 * settings, not prose. Those settings have to be resolved once and then agree in
 * four places that run at different times and in different processes: the quote
 * the user is shown, the charge, the copied project row, and the plan the worker
 * revises. When they disagreed, the request was priced as the old book and
 * planned as the old book while only the images half landed.
 *
 * Hence one applier here, in the leaf package both `apps/api` and `apps/worker`
 * can import — `apps/api` cannot import the worker, and the worker must not be
 * the first place a setting takes effect.
 */

import { mediaSettingsSchema, type CreateProjectInput, type MediaSettings } from "../schemas/book.js";
import { jsonRecord } from "../schemas/jsonCoercion.js";

/**
 * Generation settings a replan request asked to change. Every field is optional
 * and absent means "keep what the book already has" — a replan that only
 * changes the premise must not quietly resize or de-illustrate the book.
 */
export type ReplanSettings = {
  targetPages?: number | undefined;
  fullIllustrations?: boolean | undefined;
  includeCover?: boolean | undefined;
};

export type NegativeMediaPreference = {
  disableIllustrations: boolean;
  disableCover: boolean;
};

/**
 * The machine-generated plan-question answer messages, by their fixed headers.
 *
 * Those messages routinely put "no" next to a media noun without meaning it —
 * "Skipped questions with no preference:" followed by a prompt that mentions
 * illustrations, or "Answer: No preference." before one that mentions the
 * cover — and a false positive here is an unpriced, silent de-illustration of
 * a book the user already paid an illustrated price to plan.
 */
export function isPlanQuestionResponseMessage(message: string): boolean {
  return (
    /^\s*planning question responses:/i.test(message) ||
    /^\s*please revise the plan using these planning answers:/i.test(message) ||
    /\bskipped questions with no preference:/i.test(message)
  );
}

/**
 * Reads "no pictures" out of a request. One-way by design: there is no positive
 * form, because turning images back on changes what a book costs and that
 * belongs to an explicit settings change rather than to a sentence.
 *
 * Never fires on structured question-answer messages: the planner model still
 * reads those in full, so a genuine "no illustrations" answer shapes the plan —
 * only the settings flip is withheld, because flipping it silently is a
 * downgrade of something already priced.
 */
export function negativeMediaPreferenceFromMessage(message: string): NegativeMediaPreference | null {
  if (isPlanQuestionResponseMessage(message)) {
    return null;
  }
  const normalized = message.replace(/\s+/g, " ").trim();
  // The negation must reach the media noun without crossing clause punctuation:
  // "no preference. Keep the cover simple" is not a request to drop the cover.
  const negativeMedia = /\b(?:i\s+(?:do\s+not|don't|dont)\s+want|no|without|skip|remove|disable|turn\s+off)\b[^.,;:!?،؛؟]{0,80}\b(?:images?|covers?|visuals?|illustrations?|artwork|pictures?)\b/i.test(
    normalized
  );
  if (!negativeMedia) {
    return null;
  }

  const cover = /\bcovers?\b/i.test(normalized);
  const broadImages = /\b(?:images?|visuals?|artwork|pictures?)\b/i.test(normalized);
  const illustrations = /\billustrations?\b/i.test(normalized);
  return {
    disableIllustrations: broadImages || illustrations,
    disableCover: cover || broadImages
  };
}

/** The same reader as {@link negativeMediaPreferenceFromMessage}, as settings. */
export function replanSettingsFromMessage(message: string): ReplanSettings {
  const preference = negativeMediaPreferenceFromMessage(message);
  if (!preference) {
    return {};
  }
  return {
    ...(preference.disableIllustrations ? { fullIllustrations: false } : {}),
    ...(preference.disableCover ? { includeCover: false } : {})
  };
}

/**
 * First code point of each contiguous decimal-digit block we accept, covering
 * the scripts the export fonts already ship for (see `bookFonts.ts`).
 */
const NUMERAL_BLOCK_STARTS = [
  0x0660, // Arabic-Indic
  0x06f0, // Extended Arabic-Indic (Persian, Urdu)
  0x0966, // Devanagari
  0x09e6, // Bengali
  0x0e50, // Thai
  0xff10 // Fullwidth (CJK input)
];

const NON_ASCII_DIGITS = /[٠-٩۰-۹०-९০-৯๐-๙０-９]/g;

/**
 * Rewrites non-ASCII decimal digits as ASCII ones.
 *
 * Every number the chats read is matched with `\d`, which in JavaScript is ASCII
 * only — so "۳ صفحه" and "3 pages" mean the same thing to a reader and nothing
 * at all to the same regex. Normalizing once at the top of each reader is what
 * keeps a Persian book's length from being silently discarded.
 */
export function normalizeNumerals(text: string): string {
  return text.replace(NON_ASCII_DIGITS, (digit) => {
    const codePoint = digit.codePointAt(0) ?? 0;
    const start = NUMERAL_BLOCK_STARTS.find((block) => codePoint >= block && codePoint <= block + 9);
    return start === undefined ? digit : String.fromCharCode(48 + codePoint - start);
  });
}

/**
 * How the languages we ship fonts for write "page(s)".
 *
 * Number-then-word ("۳ صفحه", "3 pages") is a book length —
 * {@link explicitTargetPagesFromText}. Word-then-number ("صفحه ۵", "page 5")
 * is a page reference — the edit-chat parsers. Both interpolate this pattern
 * so a language we already size a book in is one we can also target a page in.
 *
 * Matched as a prefix on the length side so Persian agglutination
 * ("صفحه‌ای", joined by a ZWNJ) is absorbed without listing every form.
 */
export const BOOK_PAGE_WORD_PATTERN = [
  "pages?",
  "pgs?",
  "صفحه",
  "صفحات",
  "صفحة",
  "صفحہ",
  "páginas?",
  "paginas?",
  "seiten?",
  "pagine",
  "pagina",
  "страниц\\w*",
  "पृष्ठ",
  "पेज",
  "หน้า",
  "页",
  "頁",
  "ページ",
  "페이지",
  "쪽",
  "עמודים",
  "עמוד"
].join("|");

const TARGET_PAGE_PATTERNS = [
  /\b(\d{1,3})\s*[- ]?\s*(?:page|pages|pg|pgs)\s*(?:book|ebook|story|guide|workbook|project|plan)?\b/gi,
  /\b(?:make|create|write|build|draft|set|keep|turn)\s+(?:it|this|the\s+book|the\s+story|the\s+guide)?\s*(?:to|at|as)?\s*(\d{1,3})\s*(?:page|pages|pg|pgs)\b/gi,
  /\b(?:page|pages|pg|pgs)\s*(?:count|length)?\s*(?:is|=|:|to|should\s+be)?\s*(\d{1,3})\b/gi,
  // The multilingual number-then-word form. It must not use `\b`: JavaScript
  // word boundaries are ASCII, so `\b` never matches beside "ص" or "页". The
  // digit lookarounds do that job and also stop "1200 pages" reading as 120.
  new RegExp(`(?<!\\d)(\\d{1,3})(?!\\d)\\s*[-–]?\\s*(?:${BOOK_PAGE_WORD_PATTERN})`, "giu")
];

/**
 * Wording that rules a length out or bounds it instead of naming it. Only
 * high-precision cues belong here — a cue that also appears inside an ordinary
 * word (Persian "نه" is a substring of "خانه") would suppress real requests, and
 * this reader is the only thing standing between "۳ صفحه" and being asked again.
 */
const NEGATION_CUES =
  /\bnot\b|n't\b|\bdont\b|\bdoesnt\b|\bshouldnt\b|\bisnt\b|\bwont\b|\bno\b|\bnever\b|\binstead\s+of\b|\brather\s+than\b|\bmore\s+than\b|\bless\s+than\b|\bfewer\s+than\b|\bat\s+least\b|\bat\s+most\b|\bover\b|\bunder\b|\bup\s+to\b|\bnicht\b|\bkein\w*\b|\bmás\s+de\b|\bmenos\s+de\b|نباید|نیست|نشود|کمتر\s+از|بیشتر\s+از|بیش\s+از|حداقل|حداکثر|ليس|أكثر\s+من|أقل\s+من/iu;

/** Punctuation a negation does not reach across. */
const CLAUSE_BREAK = /[.,;:!?\n،؛؟、。，]/;

const NEGATION_WINDOW = 40;

/**
 * Wording that makes a page count a *delta* rather than the book's length.
 *
 * "Add 3 pages after page 10" asks for three more pages. Read as a length it
 * routes as a whole-book replan and quotes, plans and regenerates a **three
 * page** book: the reader asked for N+3 and got 3. Kept apart from
 * {@link NEGATION_CUES} because it is a different claim about the same number,
 * and matched structurally rather than through a flat window because a delta
 * can be stated on either side of the count — English puts the verb first
 * ("add 3 pages"), Persian and Arabic put it last ("۳ صفحه اضافه کن") — and a
 * loose window would read the "add" in "make it 3 pages and add a dragon" as
 * one, suppressing a length the reader really did name.
 */
const ADDITIVE_LEAD =
  /(?:\badds?|\badding|\binserts?|\binserting|\bappends?|\bappending|\banother|\bextra)\s+(?:\w+\s+){0,2}$/i;
const ADDITIVE_TRAIL_VERB = /^[\s\p{P}]{0,3}(?:اضافه|بیفزا|أضف|أضيف)/u;
const ADDITIVE_TRAIL_QUANTIFIER = /^\s*(?:more|extra|additional)\b/i;
/**
 * What may follow a postposed "more"/"extra" and leave it a quantifier.
 *
 * Stranded, it counts pages: "3 pages more", "3 pages more please", "I want 3
 * pages more at the end". Give it a word to modify and English reads it as a
 * degree adverb instead — "20 pages more detailed" is a twenty-page book
 * written in more detail, and "20 pages more or less" is that book's length
 * approximated — so the delta is claimed only at a clause boundary or before a
 * continuation that cannot be what the adverb modifies. Read the other way it
 * dropped a length the reader plainly named, which is the failure this whole
 * guard exists to prevent, only inverted.
 */
const ADDITIVE_TRAIL_STRANDED =
  /^(?:[\s\p{P}]*$|[.,;:!?،؛؟\n]|\s+(?:please|pls|plz|thanks|than|and|then|at|in|on|to|for|after|before)\b)/iu;
const ADDITIVE_LEAD_WINDOW = 30;

/**
 * The book length a piece of prose asks for, or undefined.
 *
 * Shared between the creation chat, which sizes a book before it exists, and the
 * book-edit chat, which routes "make it 3 pages" as a whole-book replan. The two
 * have to agree on what a length request looks like, or the same sentence sizes
 * a book on the way in and is ignored forever after.
 *
 * It is a pattern matcher and nothing more: the creation chat's model outranks
 * it (`resolveMobilePageCount` reads a tool-set `pageCountMode: "custom"` first
 * and only then falls back here), so this must be *silent* rather than clever
 * when the phrasing is not plainly a length. Returning undefined asks the user;
 * returning a wrong number sizes and charges for a book they ruled out.
 *
 * The last match wins by position in the text: a message that revises itself
 * ("8 pages, actually make it 3 pages") means the number it ended on.
 */
export function explicitTargetPagesFromText(text: string): number | undefined {
  const normalized = normalizeNumerals(text);
  const matches = TARGET_PAGE_PATTERNS.flatMap((pattern) => capturePageCounts(normalized, pattern)).sort(
    (a, b) => b.index - a.index
  );
  for (const match of matches) {
    if (Number.isInteger(match.value) && match.value >= 1 && match.value <= 600) {
      return match.value;
    }
  }
  return undefined;
}

function capturePageCounts(text: string, pattern: RegExp): { index: number; value: number }[] {
  const matches: { index: number; value: number }[] = [];
  for (const match of text.matchAll(pattern)) {
    const digits = match[1] ?? "";
    const value = Number.parseInt(digits, 10);
    const index = (match.index ?? 0) + match[0].indexOf(digits);
    const end = (match.index ?? 0) + match[0].length;
    if (Number.isFinite(value) && !isNegatedPageCount(text, index) && !isAdditivePageCount(text, index, end)) {
      matches.push({ index, value });
    }
  }
  return matches;
}

/** Whether this count is pages being *added* rather than the book's length. */
function isAdditivePageCount(text: string, numberAt: number, matchEnd: number): boolean {
  const lead = text.slice(Math.max(0, numberAt - ADDITIVE_LEAD_WINDOW), numberAt);
  return ADDITIVE_LEAD.test(lead) || hasAdditiveTrail(text.slice(matchEnd));
}

/** The delta stated after the count: "۳ صفحه اضافه کن", "3 pages more". */
function hasAdditiveTrail(trail: string): boolean {
  if (ADDITIVE_TRAIL_VERB.test(trail)) {
    return true;
  }
  const quantifier = trail.match(ADDITIVE_TRAIL_QUANTIFIER);
  return quantifier !== null && ADDITIVE_TRAIL_STRANDED.test(trail.slice(quantifier[0].length));
}

/**
 * Whether the clause immediately before a number rules it out or bounds it.
 *
 * Scoped to the clause rather than a flat character window so it cannot reach
 * across punctuation: "I do not want illustrations, 10 pages" is a 10-page book,
 * and "make it 5 pages, not 10" is a 5-page one. Approximators ("about 12
 * pages") are deliberately absent — they state a real intent.
 */
function isNegatedPageCount(text: string, numberAt: number): boolean {
  const window = text.slice(Math.max(0, numberAt - NEGATION_WINDOW), numberAt);
  const parts = window.split(CLAUSE_BREAK);
  return NEGATION_CUES.test(parts[parts.length - 1] ?? "");
}

export function isEmptyReplanSettings(settings: ReplanSettings | null | undefined): boolean {
  return (
    !settings ||
    (settings.targetPages === undefined &&
      settings.fullIllustrations === undefined &&
      settings.includeCover === undefined)
  );
}

/**
 * Applies a replan's settings to a media-settings object.
 *
 * `mobile.imagesEnabled` is derived rather than passed in: the mobile metadata
 * has a single flag for what the settings sheet draws, so it stays true when a
 * cover survives a "no illustrations" request.
 *
 * `targetPages` is written into that metadata too, alongside the mode and source
 * the creation flow writes for a chat-chosen count — the app reads its length
 * from `mobile.targetPages`, so a book left holding the old number would go on
 * describing itself as the length nobody asked for.
 */
export function mediaSettingsWithReplanSettings(
  mediaSettings: MediaSettings,
  settings: ReplanSettings | null | undefined
): MediaSettings {
  if (isEmptyReplanSettings(settings) || !settings) {
    return mediaSettings;
  }
  const fullIllustrations = settings.fullIllustrations ?? mediaSettings.fullIllustrations;
  const includeCover = settings.includeCover ?? mediaSettings.includeCover;
  return mediaSettingsSchema.parse({
    ...mediaSettings,
    fullIllustrations,
    includeCover,
    // Only restate the source when the request actually spoke about the cover:
    // "no cover" means a free designed one, but a replan that never mentioned it
    // must not promote an operator's explicit "none" back into a cover.
    ...(settings.includeCover === undefined ? {} : { coverArtSource: includeCover ? "ai" : "design" }),
    illustrationCadence: fullIllustrations ? mediaSettings.illustrationCadence : "manual",
    ...(mediaSettings.mobile === undefined
      ? {}
      : {
          mobile: {
            ...jsonRecord(mediaSettings.mobile),
            imagesEnabled: fullIllustrations || includeCover,
            ...(settings.targetPages === undefined
              ? {}
              : {
                  targetPages: settings.targetPages,
                  lengthPreset: "custom",
                  pageCountMode: "custom",
                  pageCountSource: "chat"
                })
          }
        })
  });
}

/**
 * Fields the live project row owns outright: written by free presentation
 * edits (`applyPresentationPreference`) and read from the row at compile time,
 * never legitimately changed by a plan revision. `chapterHeadingStyle` and
 * `chapterHeadingLabel` are not even fields of `mediaSettingsSchema`, so any
 * snapshot that passed through it has already silently dropped them.
 */
const ROW_OWNED_MEDIA_SETTINGS = ["includeSources", "chapterHeadingStyle", "chapterHeadingLabel"] as const;

/**
 * The mediaSettings a plan revision or replan may write back to the project
 * row.
 *
 * A plan version's snapshot is both stale (taken when the version was created)
 * and schema-stripped (parsed through `mediaSettingsSchema`, which drops
 * unknown keys), so replacing the row with it reverted free presentation
 * preferences set after the snapshot. The generation settings the revision
 * legitimately changed win; everything the row owns survives — unknown keys
 * generically, so future row-only fields are safe by default, and the named
 * row-owned fields only when the row actually has them, so a stale snapshot
 * value can never resurrect a preference the row no longer holds.
 */
export function mediaSettingsRowWriteback(
  liveRow: unknown,
  snapshot: Record<string, unknown>
): Record<string, unknown> {
  const row = jsonRecord(liveRow);
  const merged: Record<string, unknown> = { ...snapshot };
  const schemaKeys = new Set(Object.keys(mediaSettingsSchema.shape));
  for (const [key, value] of Object.entries(row)) {
    if (!schemaKeys.has(key)) {
      merged[key] = value;
    }
  }
  for (const key of ROW_OWNED_MEDIA_SETTINGS) {
    delete merged[key];
    if (key in row) {
      merged[key] = row[key];
    }
  }
  // `mobile` merges per key: the revision's values win where it spoke, but
  // row-only markers survive — a replan copy's provenance
  // (`revisionOfProjectId` and friends) lives here, not at the top level.
  if (row.mobile !== undefined || snapshot.mobile !== undefined) {
    merged.mobile = { ...jsonRecord(row.mobile), ...jsonRecord(snapshot.mobile) };
  }
  return merged;
}

/** The same settings applied to the input the planner and the cost estimate read. */
export function inputWithReplanSettings(
  input: CreateProjectInput,
  settings: ReplanSettings | null | undefined
): CreateProjectInput {
  if (isEmptyReplanSettings(settings) || !settings) {
    return input;
  }
  return {
    ...input,
    ...(settings.targetPages === undefined ? {} : { targetPages: settings.targetPages }),
    mediaSettings: mediaSettingsWithReplanSettings(input.mediaSettings, settings)
  };
}

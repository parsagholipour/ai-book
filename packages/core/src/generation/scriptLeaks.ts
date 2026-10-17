import { knownBookScript, type BookScript } from "../prompting/script.js";

/**
 * Words in a script the book is not written in.
 *
 * E1c (2026-10-16): gpt-6-luna put three Armenian words into a Persian
 * chapter ("نوه‌اش یک քայլ جلو آمد، բայց پیرمرد") and Gemini put a Russian
 * stem inside a Persian word ("покрыیده"); the production draft of the same
 * chapter had carried "չէم". The line edit used to clean these up, and since it
 * was removed nothing between the compose call and the PDF looked.
 *
 * A letter belongs to a book when it is in the book's own script, in Latin
 * (names, units, URLs and code are Latin in every language), or in no script
 * at all (digits, punctuation, combining marks). Two shapes of anything else
 * are a leak, and both were measured on every stored page before they shipped
 * (18,059 pages, `scriptLeaks.test.ts` holds the real hits):
 *
 * - **fused** — a run of another script inside one word with the book's own
 *   letters or Latin ones: "покрыیده", "չէم", "Ribاط", "commander傅作义". No
 *   language writes a word that way; a quoted foreign word stands apart from
 *   its neighbours. Any book whose script is known.
 * - **inline** — in a book not written in Latin, a word of two or more letters
 *   of another script standing bare between two of the book's own words on one
 *   line, nothing but a space or a comma either side: "یک քայլ جلو". A word a
 *   writer means to quote is set off by quotes, brackets or emphasis. A
 *   Latin-script book is not held to this: an English history quotes 元朝秘史
 *   bare in its sentence, which is why the Latin rule in `chapterIntegrity.ts`
 *   asks for a run of forty.
 *
 * Neither is a leak: a Greek run of up to three letters (φ(N), αˣ, the γ that
 * transliterates Mongolian *ulaγa*), the Arabic honorific ligatures (ﷺ, written
 * after the Prophet's name in English too), anything in fenced or inline code,
 * math or a URL, and any script the book's brief is written in or names the
 * language of — a name the reader typed in Armenian, a Persian primer of
 * Russian. Those exemptions are every non-leak the 18,059 stored pages hold.
 */
export type ScriptLeak = {
  kind: "fused" | "inline";
  /** The Unicode script the leaked letters are in ("Cyrillic", "Armenian"), or "another script". */
  script: string;
  /** The leaked letters alone. */
  letters: string;
  /** The whole word they were found in, as written. */
  word: string;
};

/** Languages written in Latin that the script profiles do not list by name. */
export const LATIN_SCRIPT_LANGUAGES = new Set([
  "en", "fr", "de", "es", "it", "pt", "nl", "sv", "da", "no", "nb", "nn", "fi", "pl", "cs", "sk", "hu", "ro",
  "hr", "sl", "tr", "id", "ms", "vi", "et", "lv", "lt", "ca", "gl", "eu", "af", "sw", "tl", "is"
]);

/** The Unicode scripts of a book's own letters, beyond Latin. */
const BOOK_LETTER_SCRIPTS: Record<BookScript, readonly string[]> = {
  latin: [],
  cyrillic: ["Cyrillic"],
  greek: ["Greek"],
  arabic: ["Arabic"],
  hebrew: ["Hebrew"],
  devanagari: ["Devanagari"],
  thai: ["Thai"],
  "han-simplified": ["Han", "Bopomofo"],
  japanese: ["Han", "Hiragana", "Katakana"],
  // Hanja still appears in Korean prose.
  korean: ["Hangul", "Han"]
};

/** Scripts a finding names; a letter of any other is "another script". */
const NAMED_SCRIPTS = [
  "Cyrillic", "Greek", "Armenian", "Georgian", "Arabic", "Hebrew", "Syriac", "Thaana", "Devanagari", "Bengali",
  "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala", "Thai", "Lao", "Tibetan",
  "Myanmar", "Khmer", "Ethiopic", "Han", "Hiragana", "Katakana", "Hangul", "Bopomofo", "Mongolian"
].map((name) => [name, new RegExp(`\\p{Script=${name}}`, "u")] as const);

const MARK = /[\p{M}‍]/u;
const LATIN_LETTER = /\p{Script=Latin}/u;
const SCRIPTLESS_LETTER = /[\p{Script=Common}\p{Script=Inherited}]/u;
/** ﷰ–﷿: ligatures such as ﷺ and ﷻ, set after a name as a symbol. */
const HONORIFIC_LIGATURE = /[ﷰ-﷿]/u;
/** Letters and the marks that combine with them. ZWNJ is left out: it is where Persian sets a suffix apart. */
const WORD = /[\p{L}\p{M}‍]+/gu;
/** A Greek run this short is a symbol: a variable, an angle, a transliteration letter. */
const GREEK_SYMBOL_LETTERS = 3;
/** What may stand between an inline word and its neighbours. Quotes, brackets and emphasis set a word off; a ZWNJ is a Persian suffix joined on. */
const BARE_GAP = /^[\s,،;؛\u200C]+$/u;

/**
 * A brief that names a language expects its script: a Persian primer of
 * Russian ("آموزش زبان روسی"), an English history of Greek thought. Names in
 * English, the endonym, and the languages the books are written in (Persian,
 * Arabic, Russian), matched as whole words.
 */
const LANGUAGE_NAMES_BY_SCRIPT: Record<string, readonly string[]> = {
  Cyrillic: ["russian", "ukrainian", "bulgarian", "serbian", "macedonian", "belarusian", "kazakh", "kyrgyz", "tajik", "mongolian", "cyrillic", "русский", "روسی", "اوکراینی", "الروسية"],
  Greek: ["greek", "koine", "ελληνικά", "یونانی", "اليونانية", "греческий"],
  Armenian: ["armenian", "հայերեն", "ارمنی", "الأرمنية", "армянский"],
  Georgian: ["georgian", "ქართული", "گرجی", "грузинский"],
  Hebrew: ["hebrew", "yiddish", "עברית", "عبری", "العبرية", "иврит"],
  Arabic: ["arabic", "persian", "farsi", "urdu", "pashto", "quranic", "العربية", "عربی", "فارسی", "арабский", "персидский"],
  Devanagari: ["hindi", "sanskrit", "marathi", "nepali", "devanagari", "हिन्दी", "हिंदी", "هندی", "سانسکریت", "хинди", "санскрит"],
  Thai: ["thai", "ไทย", "تایلندی", "тайский"],
  Han: ["chinese", "mandarin", "cantonese", "japanese", "kanji", "hanzi", "hanja", "中文", "汉语", "日本語", "چینی", "ژاپنی", "الصينية", "اليابانية", "китайский", "японский"],
  Hiragana: ["japanese", "hiragana", "kana", "日本語", "ژاپنی", "اليابانية", "японский"],
  Katakana: ["japanese", "katakana", "kana", "日本語", "ژاپنی", "اليابانية", "японский"],
  Hangul: ["korean", "hangul", "한국어", "کره‌ای", "الكورية", "корейский"]
};

const LANGUAGE_NAME_PATTERNS = Object.entries(LANGUAGE_NAMES_BY_SCRIPT).map(([script, names]) =>
  [script, new RegExp(`(?<![\\p{L}\\p{M}])(?:${names.join("|")})(?![\\p{L}\\p{M}])`, "iu")] as const);

type RunKind = "book" | "latin" | "scriptless" | "foreign";
type Run = { kind: RunKind; script: string; text: string; letters: number };
type Word = { text: string; start: number; end: number; runs: Run[] };

const ownLetterPatterns = new Map<string, RegExp | null>();

function ownLetterPattern(scripts: readonly string[]): RegExp | null {
  const key = scripts.join(",");
  let pattern = ownLetterPatterns.get(key);
  if (pattern === undefined) {
    pattern = scripts.length ? new RegExp(`[${scripts.map((script) => `\\p{Script=${script}}`).join("")}]`, "u") : null;
    ownLetterPatterns.set(key, pattern);
  }
  return pattern;
}

/**
 * The scripts a book in `language` is written in beyond Latin, or undefined
 * when the language's script is not known — such a book is not checked.
 */
export function bookLetterScripts(language: string | null | undefined): readonly string[] | undefined {
  const base = (language ?? "en").trim().toLowerCase().split(/[-_\s]/)[0] ?? "";
  const script = knownBookScript(language) ?? (LATIN_SCRIPT_LANGUAGES.has(base) ? "latin" : undefined);
  return script ? BOOK_LETTER_SCRIPTS[script] : undefined;
}

function scriptName(letter: string): string {
  return NAMED_SCRIPTS.find(([, pattern]) => pattern.test(letter))?.[0] ?? "another script";
}

function letterRun(letter: string, own: RegExp | null): Omit<Run, "text" | "letters"> {
  if (own?.test(letter)) return { kind: "book", script: "" };
  if (LATIN_LETTER.test(letter)) return { kind: own ? "latin" : "book", script: "" };
  if (SCRIPTLESS_LETTER.test(letter) || HONORIFIC_LIGATURE.test(letter)) return { kind: "scriptless", script: "" };
  return { kind: "foreign", script: scriptName(letter) };
}

function wordRuns(word: string, own: RegExp | null): Run[] {
  const runs: Run[] = [];
  for (const char of word) {
    const last = runs.at(-1);
    if (MARK.test(char)) {
      if (last) last.text += char;
      else runs.push({ kind: "scriptless", script: "", text: char, letters: 0 });
      continue;
    }
    const run = letterRun(char, own);
    if (last && last.kind === run.kind && last.script === run.script) {
      last.text += char;
      last.letters += 1;
    } else {
      runs.push({ ...run, text: char, letters: 1 });
    }
  }
  for (const run of runs) {
    if (run.kind === "foreign" && run.script === "Greek" && run.letters <= GREEK_SYMBOL_LETTERS) run.kind = "scriptless";
  }
  return runs;
}

/** Code, math and links are not the book's prose; each becomes a space, so a line keeps its words apart. */
function proseOutsideCodeAndMath(markdown: string): string {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      lines.push("");
    } else if (marker) {
      fence = marker;
      lines.push("");
    } else {
      lines.push(line);
    }
  }
  return lines.join("\n")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, " ")
    .replace(/\$[^$\n]+\$/g, " ")
    .replace(/\b(?:https?:\/\/|www\.)\S+/g, " ");
}

function lineWords(line: string, own: RegExp | null): Word[] {
  return [...line.matchAll(WORD)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
    runs: wordRuns(match[0], own)
  }));
}

/**
 * Scripts the brief asks for: one it is itself written in (a name the reader
 * typed is theirs to print) and one whose language it names.
 */
function briefScripts(brief: string | undefined, own: RegExp | null): Set<string> {
  const scripts = new Set<string>();
  if (!brief) return scripts;
  for (const word of brief.match(WORD) ?? []) {
    for (const run of wordRuns(word, own)) if (run.kind === "foreign") scripts.add(run.script);
  }
  for (const [script, pattern] of LANGUAGE_NAME_PATTERNS) if (pattern.test(brief)) scripts.add(script);
  return scripts;
}

/**
 * Every leaked word in `markdown`, in order; empty when the book's script is
 * unknown. A figure block is not stripped here — callers pass prose.
 */
export function findScriptLeaks(
  markdown: string,
  options: { language: string | null | undefined; brief?: string | undefined }
): ScriptLeak[] {
  const scripts = bookLetterScripts(options.language);
  if (!scripts) return [];
  const own = ownLetterPattern(scripts);
  // Fast path: a page with no letter outside its own script, Latin and the scriptless has nothing to find.
  const outside = own
    ? new RegExp(`(?![\\p{Script=Latin}\\p{Script=Common}\\p{Script=Inherited}${scripts.map((script) => `\\p{Script=${script}}`).join("")}])\\p{L}`, "u")
    : /(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])\p{L}/u;
  if (!outside.test(markdown)) return [];
  const allowed = briefScripts(options.brief, own);
  const leaks: ScriptLeak[] = [];
  for (const line of proseOutsideCodeAndMath(markdown).split("\n")) {
    if (!outside.test(line)) continue;
    const words = lineWords(line, own);
    words.forEach((word, index) => {
      const foreign = word.runs.filter((run) => run.kind === "foreign" && !allowed.has(run.script));
      if (foreign.length === 0) return;
      const letters = foreign.map((run) => run.text).join("");
      const script = foreign[0]!.script;
      if (word.runs.some((run) => run.kind === "book" || run.kind === "latin")) {
        leaks.push({ kind: "fused", script, letters, word: word.text });
        return;
      }
      // Latin-script books quote foreign words bare; only a book in another script is held to the inline shape.
      if (!own || foreign.reduce((sum, run) => sum + run.letters, 0) < 2) return;
      const before = words[index - 1];
      const after = words[index + 1];
      const native = (neighbour: Word | undefined) =>
        Boolean(neighbour && neighbour.runs.some((run) => run.kind === "book") && neighbour.runs.every((run) => run.kind !== "foreign"));
      if (native(before) && native(after) && BARE_GAP.test(line.slice(before!.end, word.start)) && BARE_GAP.test(line.slice(word.end, after!.start))) {
        leaks.push({ kind: "inline", script, letters, word: word.text });
      }
    });
  }
  return leaks;
}

/** A short, quotable list for a finding: up to `limit` distinct words, each with its script. */
export function describeScriptLeaks(leaks: readonly ScriptLeak[], limit = 3): string {
  const seen = new Map<string, string>();
  for (const leak of leaks) if (!seen.has(leak.word)) seen.set(leak.word, leak.script);
  const listed = [...seen].slice(0, limit).map(([word, script]) => `"${word}" (${script})`);
  return seen.size > limit ? `${listed.join(", ")} and ${seen.size - limit} more` : listed.join(", ");
}

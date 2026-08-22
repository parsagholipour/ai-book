/**
 * How much prose a page is, where its sentences end, and which of it is the
 * book's own voice rather than a character's.
 *
 * Every local-QA gate that counts something reads the page through here, and so
 * does every gate that must not hear a line of dialogue as the narrator: the
 * measurement is script-aware in one place instead of in each check. Counting
 * `\p{L}` runs is what made these gates wrong in half the languages this
 * product ships books in — a Chinese sentence or a Thai clause is one run — so
 * the rules for that live here and are stated once.
 *
 * Split out of `pagesLocalQa.ts`, which keeps the checks themselves and their
 * pattern tables. `manuscriptQuality.ts` carries deliberate counterparts of the
 * word count and the sentence boundary, summed per page rather than per run,
 * and says so where they are defined. Every character class here that names an
 * apostrophe names both spellings, for the reason `normalizeTitle` gives in
 * `pagesLocalQa.ts`: providers write the typographic U+2019 far more often than
 * the ASCII one.
 */

/**
 * Space-separated scripts count one word per run, but CJK and the unsegmented
 * Southeast Asian scripts have no spaces to split on: a whole Thai clause or a
 * Chinese sentence between punctuation marks is a single `\p{L}` run, so
 * counting runs made every normal-length page "too short to show meaningful
 * progression" and burned its whole revision budget on a false failure. Those
 * scripts are estimated from character counts instead — ~2 chars per word for
 * CJK, ~4 for Thai-like scripts — which is rough in both directions but keeps
 * the min/max gates meaningful rather than always-firing. The estimate counts
 * code points, never UTF-16 units (a supplementary-plane Han character is one
 * character, not a leftover extra word), classifies by Script_Extensions so a
 * shared character like the katakana prolonged sound mark ー stays part of the
 * word it lengthens, and folds combining marks into the letter they modify —
 * a Thai tone mark neither splits the run it sits in nor feeds the divisor.
 */
export function countReadableWords(text: string): number {
  const tokens = text.match(/[\p{L}\p{N}\p{M}]+(?:['’-][\p{L}\p{N}\p{M}]+)*/gu) ?? [];
  let count = 0;
  for (const token of tokens) {
    let cjkChars = 0;
    let unsegmentedChars = 0;
    let spacedChars = 0;
    for (const character of token) {
      if (COMBINING_MARK_PATTERN.test(character)) {
        continue;
      }
      if (CJK_CHARACTER_PATTERN.test(character)) {
        cjkChars += 1;
      } else if (UNSEGMENTED_CHARACTER_PATTERN.test(character)) {
        unsegmentedChars += 1;
      } else {
        spacedChars += 1;
      }
    }
    count += Math.ceil(cjkChars / 2) + Math.ceil(unsegmentedChars / 4);
    if (spacedChars > 0) {
      count += 1;
    }
  }
  return count;
}

// No Hangul here: Korean is space-separated, so the run count is already right.
const CJK_CHARACTER_PATTERN = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u;
const UNSEGMENTED_CHARACTER_PATTERN = /[\p{Script_Extensions=Thai}\p{Script_Extensions=Lao}\p{Script_Extensions=Khmer}\p{Script_Extensions=Myanmar}]/u;
const COMBINING_MARK_PATTERN = /\p{M}/u;

export function sentenceLengthStats(text: string): { average: number; max: number } {
  const sentenceWordCounts = splitSentences(text).map(countReadableWords).filter((count) => count > 0);
  if (sentenceWordCounts.length === 0) {
    return { average: 0, max: 0 };
  }
  const total = sentenceWordCounts.reduce((sum, count) => sum + count, 0);
  return {
    average: total / sentenceWordCounts.length,
    max: Math.max(...sentenceWordCounts)
  };
}

/**
 * The page with everything a character or a source said removed from it.
 * A whole line is quoted when it is a markdown blockquote, or when it opens
 * with an em/en dash — the French, Spanish and Russian dialogue convention,
 * the same one `countStyleDashes` already reads a line for. Inside a line,
 * spans are removed by quotation marks, and there is no single convention to
 * key off: this ships Persian and Arabic books, where the guillemets are the
 * quotation marks, and CJK books, which quote with corner brackets, so the
 * table below is keyed by opener and lists every closer that opener takes.
 */
export function narrationOutsideQuotedSpeech(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (BLOCKQUOTE_LINE_PATTERN.test(line)) {
        return "";
      }
      const firstContentIndex = line.search(/\S/);
      if (firstContentIndex >= 0 && isDash(line[firstContentIndex])) {
        return "";
      }
      return stripQuotedSpans(line);
    })
    .join("\n");
}

/**
 * An unterminated opener takes the rest of its line: English opens every
 * paragraph of a continued speech and closes only the last, and a hard-wrapped
 * quote breaks the same way. Reading too much of a page as dialogue only ever
 * misses a scaffold sentence; reading too little fails a page that was right,
 * and that failure costs the page its revisions.
 */
function stripQuotedSpans(line: string): string {
  let narration = "";
  let index = 0;
  while (index < line.length) {
    const character = line[index]!;
    const closers = DIALOGUE_QUOTE_CLOSERS.get(character);
    if (closers === undefined) {
      narration += character;
      index += 1;
      continue;
    }

    let closeIndex = -1;
    for (let scan = index + 1; scan < line.length; scan += 1) {
      if (closers.includes(line[scan]!)) {
        closeIndex = scan;
        break;
      }
    }
    if (closeIndex < 0) {
      return `${narration} `;
    }

    narration += " ";
    index = closeIndex + 1;
  }
  return narration;
}

const BLOCKQUOTE_LINE_PATTERN = /^\s{0,3}>/;

/**
 * Openers to the closers they take. The straight apostrophe is deliberately
 * absent: `it's` would open a quote on every page written with one.
 */
const DIALOGUE_QUOTE_CLOSERS = new Map<string, string>([
  ['"', '"'],
  ["“", "”"], // “ … ”
  ["„", "“”"], // „ … “ and „ … ”
  ["‘", "’"], // ‘ … ’
  ["«", "»"], // « … » — Persian, Arabic, French, Russian
  ["»", "«"], // » … « — German, Danish
  ["「", "」"], // 「 … 」
  ["『", "』"] // 『 … 』
]);

export function hasExcessiveDashUse(text: string): boolean {
  const dashCount = countStyleDashes(text);
  if (dashCount < 4) {
    return false;
  }
  const wordCount = Math.max(1, countReadableWords(text));
  const sentenceCount = Math.max(1, splitSentences(text).length);
  return dashCount / wordCount >= 0.018 || dashCount / sentenceCount >= 0.35;
}

function countStyleDashes(text: string): number {
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const dashIndexes = [...line.matchAll(/[—–]/g)].map((match) => match.index ?? 0);
    if (dashIndexes.length === 0) {
      continue;
    }

    const ignored = new Set<number>();
    const firstContentIndex = line.search(/\S/);
    if (firstContentIndex >= 0 && isDash(line[firstContentIndex])) {
      ignored.add(firstContentIndex);
      const attributionDashIndex = dashIndexes.find(
        (index) => index !== firstContentIndex && isDialogueAttributionDash(line, index)
      );
      if (attributionDashIndex !== undefined) {
        ignored.add(attributionDashIndex);
      }
    }

    count += dashIndexes.filter((index) => !ignored.has(index)).length;
  }
  return count;
}

function isDash(value: string | undefined): boolean {
  return value === "—" || value === "–";
}

function isDialogueAttributionDash(line: string, index: number): boolean {
  return /\s$/.test(line.slice(0, index)) && /^\s*\p{L}/u.test(line.slice(index + 1));
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(SENTENCE_BOUNDARY_PATTERN)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * Where one sentence ends and the next begins, in three script shapes: a
 * spaced terminator (Latin and Arabic-script punctuation, with any closing
 * quotes riding along), a full-width CJK terminator that takes no space after
 * it — its closing quotes/brackets ride along too — and, in the unsegmented
 * Southeast Asian scripts, the space itself, which is those scripts' sentence
 * mark. Splitting only on spaced ASCII terminators left a zh/ja page as one
 * "sentence" whose word count was the whole page, so the kids sentence-length
 * gate fired on every page and no rewrite could satisfy it. Kept consistent
 * with the scripts countReadableWords estimates above.
 */
const SENTENCE_BOUNDARY_PATTERN =
  /(?<=[。！？។။][」』】〉》）'’"”]*)(?![」』】〉》）'’"”])|(?<=[.!?؟۔…]['’"”»)\]]*)\s+|(?<=[\p{Script_Extensions=Thai}\p{Script_Extensions=Lao}\p{Script_Extensions=Khmer}\p{Script_Extensions=Myanmar}])\s+/u;

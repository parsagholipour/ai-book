/**
 * Approximating a token count from text, counted per script rather than per
 * character.
 *
 * `chars / 4` is the rule everyone reaches for, and it is really `bytes / 4`
 * wearing a Latin costume: ASCII is one byte per character, so the two agree
 * exactly in English and nowhere else. Persian, Arabic and Hebrew are two UTF-8
 * bytes per character; Devanagari, Thai and CJK are three. The same rule
 * therefore divides by four a string that carries three to four times the bytes
 * it was calibrated on, and every book this product ships in those scripts is
 * counted at roughly a quarter of its real size.
 *
 * Two classes, because that is as much as a character-level rule can honestly
 * carry. Everything outside Latin and the characters shared with it counts as
 * dense; Greek and Cyrillic are nearer two characters per token than one and
 * are over-counted by that, which is the cheap direction and keeps the rule one
 * sentence long. The same split, for the same reason, is what
 * `countReadableWords` (`generation/proseShape.ts`) makes for word counts.
 *
 * **Both classes are approximations, and this module does not pretend
 * otherwise.** A real BPE tokenizer is not `chars / 2` either: coverage of a
 * script decides its rate, so the same Persian sentence costs materially
 * different numbers of tokens under `cl100k_base` and `o200k_base`, and a
 * script the vocabulary barely covers falls back to byte pairs and can exceed
 * one token per character. What the two-class rule buys is being wrong by
 * something near a factor of two instead of a factor of four, in a place where
 * no tokenizer is available to be right.
 *
 * The weights are deliberately *not* fixed here. Sizing an output budget and
 * estimating what a finished call cost want different answers from the same
 * count — a budget that is too generous costs nothing while a budget that is
 * too small truncates a reply, and a cost estimate wants the central value in
 * both directions. Each caller states its own weights next to its own reason.
 */

/**
 * Characters per token, per script class. Both must be greater than zero.
 *
 * A larger number means a *cheaper* script: `latinCharsPerToken: 4` says four
 * Latin characters buy one token.
 */
export type ScriptTokenWeights = {
  /**
   * Latin letters, and every character shared between scripts rather than
   * owned by one — ASCII, the digits, the whitespace, and the typographic
   * punctuation an English page is actually printed with.
   */
  latinCharsPerToken: number;
  /** Everything else: Persian, Arabic, Hebrew, Devanagari, Thai, Han, Kana, Hangul — and pictographs. */
  denseCharsPerToken: number;
};

/**
 * Approximate tokens in `text` under `weights`.
 *
 * The two classes are rounded up separately rather than summed and rounded
 * once, so a mixed string is never charged less than either half of it alone.
 * Counts code points, not UTF-16 units, so a supplementary-plane Han character
 * is one dense character rather than two.
 *
 * **This runs synchronously on the whole prompt before every live text call**
 * (`estimateTextRequestTokens`, `apps/worker/src/providers/usageAccounting.ts`),
 * and the finish-book chapter review builds prompts of four hundred thousand
 * characters — twelve chapters of pages clipped at 2,200 each. Written as
 * `for (const character of text)` with {@link LATIN_TEXT_PATTERN} asked about
 * every code point, that was ~13 ms of uninterruptible work per call on a 400 KB
 * prompt, in a worker whose timers, BullMQ heartbeat and other jobs' I/O
 * callbacks all wait behind it. So this walks **UTF-16 units** rather than code
 * points, and the answer it produces is unchanged in every case:
 *
 * - ASCII is settled without allocating anything and without touching the
 *   pattern at all. Every one of the 128 ASCII code points is Latin under the
 *   pattern, pictographs included — the lowest `Extended_Pictographic` code
 *   point is U+00A9 — which is the invariant the pattern's own `\p{ASCII}` term
 *   states and the "no ASCII character is a pictograph" case in the tests pins.
 * - A high surrogate followed by a low one is one supplementary code point, so
 *   both units are taken together and the index skips the pair. A *lone*
 *   surrogate falls through to the same single-unit path the string iterator
 *   would have given it, and is dense there exactly as it was before.
 * - Everything else is one BMP code point, classified through
 *   {@link bmpScriptClass} so the pattern is consulted once per *distinct*
 *   character rather than once per character.
 *
 * The memo is what carries the dense scripts. An ASCII fast path on its own is
 * a 2.4x saving on English and no saving whatever on Persian or Chinese, which
 * are both the slowest corpora and the whole reason this module exists; with
 * the memo, 400 KB of Persian went from 12.95 ms to 1.39 ms and the same of
 * Chinese from 13.65 ms to 1.62 ms.
 */
export function estimateTokensByScript(text: string, weights: ScriptTokenWeights): number {
  let latinChars = 0;
  let denseChars = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    let latin: boolean;
    if (unit < 0x80) {
      latin = true;
    } else if (isLeadSurrogate(unit) && isTrailSurrogate(text.charCodeAt(index + 1))) {
      // Supplementary planes are emoji and rare ideographs: too sparse in prose
      // to be worth a memo, and the pair has to be tested as one string anyway.
      latin = LATIN_TEXT_PATTERN.test(text.slice(index, index + 2));
      index += 1;
    } else {
      latin = bmpScriptClass(unit) === LATIN_CLASS;
    }
    if (latin) {
      latinChars += 1;
    } else {
      denseChars += 1;
    }
  }
  return Math.ceil(latinChars / weights.latinCharsPerToken) + Math.ceil(denseChars / weights.denseCharsPerToken);
}

function isLeadSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/** `charCodeAt` past the end is `NaN`, which every comparison here refuses. */
function isTrailSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

const UNCLASSIFIED = 0;
const LATIN_CLASS = 1;
const DENSE_CLASS = 2;

/**
 * Which class one BMP code unit belongs to, remembered after the first ask.
 *
 * {@link LATIN_TEXT_PATTERN} stays the only thing that decides — this is a
 * cache of its answers, not a second rule that could drift from it. The answer
 * is a pure function of the code point and of the Unicode tables the engine was
 * built with, so it cannot change within a process and the table needs no
 * invalidation. 64 KB, allocated once; a page of Persian has a few hundred
 * distinct characters in it, so this turns four hundred thousand regex tests
 * into a few hundred.
 */
const bmpScriptClasses = new Uint8Array(0x10000);

function bmpScriptClass(unit: number): number {
  const cached = bmpScriptClasses[unit] ?? UNCLASSIFIED;
  if (cached !== UNCLASSIFIED) {
    return cached;
  }
  const decided = LATIN_TEXT_PATTERN.test(String.fromCharCode(unit)) ? LATIN_CLASS : DENSE_CLASS;
  bmpScriptClasses[unit] = decided;
  return decided;
}

/**
 * Which characters are *not* evidence of a dense script. Matches exactly one
 * code point, which is what the loop above feeds it.
 *
 * The dense class exists because a script the tokenizer barely covers costs
 * more tokens per character than Latin does. A character shared between scripts
 * is evidence of neither, and this pattern used to read `[\p{ASCII}\p{Script=Latin}]`
 * — which quietly made "not ASCII" the test for "dense". Every curly quote, em
 * dash, ellipsis, en dash, bullet, non-breaking space and arrow in an English
 * page is `Script=Common` and sat in neither arm, so it was billed at one token
 * per character: four times its Latin rate, on the punctuation the book
 * generator emits by default. An English dialogue line reported 17 tokens where
 * `chars / 4` reported 13, and nothing caught it because every test in this
 * repo was written with straight ASCII quotes.
 *
 * **`Script_Extensions`, not `Script`, is what tells the two apart.** A
 * character whose only script is Common (`—`, `“`, `’`, `…`, `«`, `€`, `→`,
 * NBSP) belongs to no script and joins the cheap class. A character Unicode has
 * *narrowed* to a script keeps that script's rate even though `Script` still
 * says Common: `。`, `、` and `「」` are `scx=Han`, `؟` and `،` are `scx=Arabic`,
 * ZWNJ — the joiner Persian compounds are written with — is `scx` a list that
 * does not include Common, and all of them stay dense. The same property is
 * what puts a combining acute (`scx=Latin`) with the Latin letter it sits on
 * and an Arabic fatḥatān (`scx=Arabic`) with the Arabic one.
 *
 * Deliberately included with Latin, because none is evidence of a dense script
 * and each is a single well-covered token: the ASCII and Western digits, every
 * kind of space, the maths and currency symbols, and the general punctuation.
 * Deliberately left dense: **pictographs**. An emoji is genuinely several
 * tokens, and `\p{Extended_Pictographic}` is the Unicode name for the whole set
 * — which is why `©`, `®` and `™` are dense too. They are not English
 * punctuation, they each cost about a token of their own, and over-counting is
 * the safe direction here as it is for Greek.
 *
 * The two shared characters this over-counts by keeping them cheap are the
 * fullwidth comma and colon (`scx=Common`, but only ever seen in CJK). At
 * roughly one character in twenty of Chinese prose that is under four percent
 * of a page, inside the factor-of-two error bar the module already declares —
 * whereas the same charity applied to `。` and `「」` would not be, which is
 * why `Script_Extensions` is doing the work rather than a hand-kept list.
 *
 * `\p{ASCII}` is redundant against the two `Script_Extensions` classes and is
 * kept anyway: it is the half of the rule callers state an invariant about, it
 * should be readable here rather than derivable, and
 * {@link estimateTokensByScript} now settles every ASCII character on it
 * without running this pattern at all.
 *
 * Asked once per *distinct* code point rather than once per character (see
 * {@link bmpScriptClass}), so the anchors still matter: this is a test that one
 * whole code point is Latin, never a search inside a longer string.
 */
const LATIN_TEXT_PATTERN =
  /^(?!\p{Extended_Pictographic})[\p{ASCII}\p{Script_Extensions=Latin}\p{Script_Extensions=Common}]$/u;

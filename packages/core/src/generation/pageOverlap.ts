/**
 * What "overlaps" means for two page texts: a shared tokenizer, the two sets
 * both halves of the rule score, and the ratio they are scored with.
 *
 * Two callers must agree, or a collision the plan-time beat dedup
 * (`pageBeatDedup.ts`) waves through is exactly the one the page-time
 * repetition check (`pagesLocalQa.ts`) then rejects on every rewrite. Split
 * out of `pagesLocalQa.ts` for the same reason `promptLeak.ts` was: the
 * measurement lived with one caller while the other imported it, so the
 * definition of a token was a local-QA helper that the planner-side sweep
 * happened to reach. Thresholds stay with each caller because summaries and
 * beats are different lengths; this module is the measurement, not the bar.
 *
 * **The rule is spelled over sets and never over a pair of raw strings, because
 * every caller scores one text against many.** The dedup sweep pairs every page
 * with every earlier one and the repetition gate pairs a draft with its last
 * five predecessors, so a string-level entry point re-tokenizes the same text
 * once per pair — a synchronous stall on the worker's own thread rather than a
 * wasted allocation, and quadratic in the sweep. A string-level shorthand
 * beside these is what the repetition gate called until it was hoisted, which
 * put a full page body through the tokenizer five times per draft candidate and
 * its summary ten; it is deliberately not here to be reached for again.
 * Tokenize at the top of the loop and hand the sets down.
 *
 * The string-taking pair below exists for a text scored on only one half. Both
 * halves of the rule read the same tokens, which that pair cannot share because
 * each of them tokenizes for itself — `overlapTokens` is exported with the
 * derivers and only useful with them. A deriver taking a `string[]` with no
 * exported way to produce one leaves an outside caller writing a second
 * tokenizer, forking the rule this file exists to share.
 */

/** The trigram set the shingle half of the rule scores, tokenized once. */
export function overlapShingles(text: string): Set<string> {
  return shinglesFromTokens(overlapTokens(text));
}

/** The keyword set the lexical half of the rule scores, tokenized once. */
export function overlapKeywords(text: string): Set<string> {
  return keywordsFromTokens(overlapTokens(text));
}

/**
 * The same two sets over tokens the caller already holds — how a text *both*
 * halves of the rule read is tokenized once instead of twice.
 */
export function shinglesFromTokens(tokens: string[]): Set<string> {
  const trigrams = new Set<string>();
  for (let index = 0; index <= tokens.length - 3; index += 1) {
    trigrams.add(tokens.slice(index, index + 3).join(" "));
  }
  return trigrams;
}

export function keywordsFromTokens(tokens: string[]): Set<string> {
  return new Set(tokens.filter((token) => !SUMMARY_STOP_WORDS.has(token)));
}

/** How many members of the smaller set the larger one also holds, 0 when either is empty. */
export function sharedRatio(first: Set<string>, second: Set<string>): number {
  if (first.size === 0 || second.size === 0) {
    return 0;
  }
  const [smaller, larger] = first.size <= second.size ? [first, second] : [second, first];
  let shared = 0;
  for (const member of smaller) {
    if (larger.has(member)) {
      shared += 1;
    }
  }
  return shared / smaller.size;
}

export function overlapTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'’]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

const SUMMARY_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "before",
  "between",
  "into",
  "through",
  "with",
  "without",
  "from",
  "that",
  "this",
  "what",
  "when",
  "where",
  "while",
  "they",
  "them",
  "their",
  "page",
  "jack",
  "chapter",
  "story"
]);

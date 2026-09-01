import { isEnglishLanguage } from "../prompting/language.js";
import { WORD_TOKEN_PATTERN } from "./manuscriptPageCache.js";

const ENGLISH_FUNCTION_WORDS = [
  "the", "and", "of", "to", "that", "this", "with", "from", "for", "was",
  "a", "in", "on", "is", "are", "be", "as", "by", "or", "not", "it", "an"
] as const;

export function englishPhraseDetectorsEnabled(
  language: string | undefined,
  plains: readonly string[]
): boolean {
  if (language !== undefined) {
    return isEnglishLanguage(language);
  }
  return proseLooksEnglish(plains);
}

export function proseLooksEnglish(plains: readonly string[]): boolean {
  const sample = plains.slice(0, 12).join(" ");
  const letters = sample.match(/\p{L}/gu) ?? [];
  if (letters.length < 40) {
    return false;
  }
  const latin = letters.filter((letter) => /\p{Script=Latin}/u.test(letter)).length;
  if (latin / letters.length < 0.85) {
    return false;
  }
  const tokens = new Set((sample.toLowerCase().match(WORD_TOKEN_PATTERN) ?? []).map((token) => token));
  let hits = 0;
  for (const cue of ENGLISH_FUNCTION_WORDS) {
    if (tokens.has(cue)) {
      hits += 1;
    }
  }
  return hits >= 3;
}

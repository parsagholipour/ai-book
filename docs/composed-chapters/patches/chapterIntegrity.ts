import { countReadableWords } from "./proseShape.js";

/**
 * Whether a composed chapter is prose at all. The fast tier's writer
 * (qwen3.7-flash, composed-13) returned 12,005 words of a rotating
 * three-subject verb-chain — "The codex plate polished these tables, shining
 * them with oils and creams" — with stray CJK tokens, and nothing between the
 * compose call and the printed PDF noticed: the short-draft retry fires only
 * under 0.7× the minimum, the line edit paraphrased the loop, the page rules
 * passed every page, and the book published as COMPLETE at 2.8/10.
 *
 * Three measures, each calibrated on the 231 chapters of every composed run to
 * that date: the share of sentences opening on the same three words (0.58 on
 * the broken chapter, 0.26 on a DeepSeek chapter built on a deliberate
 * anaphora, 0.00 on every other), words against the chapter's own maximum
 * (2.8× there, never past ~1.3× elsewhere), and characters from a script the
 * book is not written in (4 there, 0 elsewhere). The script check runs only
 * for Latin-script target languages, where any such character is an error.
 */
export type ChapterDegeneracy = {
  degenerate: boolean;
  reasons: string[];
  words: number;
  templateShare: number;
  foreignCharacters: number;
};

const TEMPLATE_SHARE_CEILING = 0.4;
const TEMPLATE_MIN_SENTENCES = 40;
const TEMPLATE_MIN_REPEATS = 6;
const RUNAWAY_LENGTH_FACTOR = 1.8;
const FOREIGN_CHARACTER_CEILING = 2;

const LATIN_SCRIPT_LANGUAGES = new Set([
  "en", "fr", "de", "es", "it", "pt", "nl", "sv", "da", "no", "nb", "nn", "fi", "pl", "cs", "sk", "hu", "ro",
  "hr", "sl", "tr", "id", "ms", "vi", "et", "lv", "lt", "ca", "gl", "eu", "af", "sw", "tl", "is"
]);

const NON_LATIN_SCRIPT = /[一-鿿぀-ヿ가-힯؀-ۿ֐-׿Ѐ-ӿ฀-๿ऀ-ॿ]/g;

function sentenceOpenings(markdown: string): string[] {
  return markdown
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.split(/\s+/).length >= 4)
    .map((sentence) => sentence.toLowerCase().split(/\s+/).slice(0, 3).join(" "));
}

export function chapterDegeneracy(
  markdown: string,
  options: { maxWords: number; language?: string | undefined }
): ChapterDegeneracy {
  const reasons: string[] = [];
  const words = countReadableWords(markdown);
  const openings = sentenceOpenings(markdown);
  const counts = new Map<string, number>();
  for (const opening of openings) {
    counts.set(opening, (counts.get(opening) ?? 0) + 1);
  }
  let repeated = 0;
  for (const count of counts.values()) {
    if (count >= TEMPLATE_MIN_REPEATS) repeated += count;
  }
  const templateShare = openings.length > 0 ? repeated / openings.length : 0;
  if (openings.length >= TEMPLATE_MIN_SENTENCES && templateShare >= TEMPLATE_SHARE_CEILING) {
    reasons.push(`${Math.round(templateShare * 100)}% of sentences open on a repeated three-word template`);
  }
  if (options.maxWords > 0 && words > options.maxWords * RUNAWAY_LENGTH_FACTOR) {
    reasons.push(`${words} words against a maximum of ${options.maxWords}`);
  }
  const language = (options.language ?? "en").toLowerCase().split(/[-_]/)[0] ?? "en";
  const foreignCharacters = LATIN_SCRIPT_LANGUAGES.has(language) ? (markdown.match(NON_LATIN_SCRIPT) ?? []).length : 0;
  if (foreignCharacters > FOREIGN_CHARACTER_CEILING) {
    reasons.push(`${foreignCharacters} characters from a script the book is not written in`);
  }
  return { degenerate: reasons.length > 0, reasons, words, templateShare, foreignCharacters };
}

import type { CreateProjectInput } from "../schemas/book.js";
import { kidsReadingGuidanceForInput } from "../prompting/readingLevel.js";
import { figureFreeProse } from "./figures/figureBlocks.js";
import { countReadableWords, sentenceLengthStats, splitSentences } from "./proseShape.js";

/** Use the same prose and counters as local QA; never count titles or figure JSON. */
export function pictureBookPageMeasurements(markdown: string) {
  const prose = figureFreeProse(markdown).trim();
  const sentences = sentenceLengthStats(prose);
  return { words: countReadableWords(prose), average: sentences.average, longest: sentences.max };
}

export function pictureBookMeasurementPayload(input: CreateProjectInput, pages: readonly { index: number; markdown: string }[]) {
  const guidance = kidsReadingGuidanceForInput(input);
  return {
    columns: ["pageIndex", "words", "averageSentenceWords", "longestSentenceWords"],
    pages: pages.map(page => {
      const measured = pictureBookPageMeasurements(page.markdown);
      return [page.index, measured.words, Number(measured.average.toFixed(1)), measured.longest];
    }),
    ...(guidance ? { readingLimits: { minWords: guidance.targetWordsPerPage.min,
      maxWords: guidance.maxWordsPerPageWithTolerance, maxAverageSentenceWords: guidance.maxAverageSentenceWords,
      maxSentenceWords: guidance.maxSentenceWords } } : {})
  };
}

type Metric = keyof ReturnType<typeof pictureBookPageMeasurements>;
type Claim = { metric: Metric; value: string; tail: string };
const page = "(?:(?:this|the)\\s+)?(?:(?:resulting|revised|candidate|current)\\s+)?page";
const numericValue = "(\\d+(?:\\.\\d+)?)";
// Recognize explicit candidate measurements, not every mention of words/length.
// Anchoring at a diagnostic sentence start excludes quoted story dialogue and
// comparisons with the ORIGINAL prose. Unknown editorial language stays intact.
const patterns: { metric: Metric; pattern: RegExp }[] = [
  { metric: "words", pattern: new RegExp(`^${page}\\s+(?:has|contains|is|totals)\\s+(?:(?:only|just|about|approximately)\\s+)?${numericValue}\\s+words\\b(.*)$`, "iu") },
  { metric: "words", pattern: new RegExp(`^${page}['’]s\\s+word count\\s*(?:is|:|=)\\s*${numericValue}\\b(.*)$`, "iu") },
  { metric: "words", pattern: new RegExp(`^At\\s+${numericValue}\\s+words,\\s+${page}\\b(.*)$`, "iu") },
  { metric: "average", pattern: new RegExp(`^(?:(?:the|its)\\s+)?average sentence length\\s*(?:is|of|:|=)?\\s*${numericValue}\\s+words\\b(.*)$`, "iu") },
  { metric: "average", pattern: new RegExp(`^${page}\\s+averages\\s+${numericValue}\\s+words per sentence\\b(.*)$`, "iu") },
  { metric: "longest", pattern: new RegExp(`^(?:(?:the|its)\\s+)?longest sentence\\s+(?:has|contains|is|uses)\\s+${numericValue}\\s+words\\b(.*)$`, "iu") }
];

function claims(text: string): Claim[] {
  return splitSentences(text).flatMap(sentence => {
    for (const { metric, pattern } of patterns) {
      const match = pattern.exec(sentence);
      if (match) {
        // A count qualified as "of dialogue", "excluding titles", etc. is a
        // different scope. Do not compare it with the whole current prose.
        const tail = match[2]!;
        if (/^\s*(?:,\s*)?(?:of|in|outside|excluding|including|without|before|after|shorter|longer|more|less|fewer)\b/iu.test(tail)) return [];
        return [{ metric, value: match[1]!, tail }];
      }
    }
    // The canonical local-QA sentence diagnostic is sometimes copied with
    // invented numbers. Do not interpret its target limits as observed counts.
    const local = /^Sentences are too long for ages [246]-[468] \(average ([\d.]+) words, longest (\d+); target average <= \d+, longest <= \d+\)\.$/u.exec(sentence);
    return local ? [{ metric: "average" as const, value: local[1]!, tail: "" },
      { metric: "longest" as const, value: local[2]!, tail: "" }] : [];
  });
}

/** An invalid measurement requests a bounded re-assessment, never an automatic
 * approval, dropped semantic finding, or prose rewrite. A model's negative
 * repair verdict cannot safely be flipped just because its arithmetic is wrong.
 */
export function pictureBookMeasurementErrors(markdown: string, diagnostics: readonly string[]): string[] {
  const actual = pictureBookPageMeasurements(markdown);
  const errors = new Set<string>();
  for (const text of diagnostics) for (const claim of claims(text)) {
    const measured = actual[claim.metric];
    const decimals = claim.value.split(".")[1]?.length ?? 0;
    const rounded = Number(measured.toFixed(Math.min(decimals, 10)));
    if (Number(claim.value) !== rounded) {
      errors.add(`Invalid prose measurement: ${claim.metric} is ${Number(measured.toFixed(1))}, not ${claim.value}.`);
      continue;
    }
    // Also reject arithmetic such as "38 words, below the 35-word minimum".
    // This checks the stated comparison, not whether the brief authorizes a limit.
    const comparison = /^[,\s]*(below|under|above|over)\s+(?:(?:the|requested|required|target|of)\s+)*(\d+)(?:[–-](\d+))?(?:[- ]words?\b|\b)/iu.exec(claim.tail);
    if (!comparison) continue;
    const below = /below|under/iu.test(comparison[1]!);
    const limit = Number(!below && comparison[3] ? comparison[3] : comparison[2]);
    if (below ? measured >= limit : measured <= limit)
      errors.add(`Invalid prose measurement comparison: ${claim.metric} is ${Number(measured.toFixed(1))}, not ${below ? "below" : "above"} ${limit}.`);
  }
  return [...errors].map(error => `${error} Use the supplied code measurements; reassess the affected finding and repair verdict against the unchanged prose. Preserve supported grammar, meaning and story findings. Do not request padding or a prose change to correct reviewer arithmetic.`);
}

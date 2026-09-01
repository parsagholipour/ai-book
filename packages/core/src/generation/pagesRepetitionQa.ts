import { keywordsFromTokens, overlapShingles, overlapTokens, sharedRatio, shinglesFromTokens } from "./pageOverlap.js";
import type { PriorPageContext } from "./pagesShared.js";

/**
 * The page-time repetition gate: the one rule in `pagesLocalQa.ts` that reads
 * a draft against the pages behind it. It is the near-verbatim gate — trigram
 * and keyword overlap against the last five pages, thresholds high enough that
 * only a page restaging another's prose fails it. Measured over 1,200 shipped
 * pages it fired on none of them.
 *
 * A second, *treatment* gate used to live beside it: the same subject argued
 * from the same evidence to the same closing claim in different words, scored
 * with the manuscript audit's `scoreTreatmentPair`. Its subject test was
 * named-entity overlap, and the entity extractor took every sentence-initial
 * capitalised word as an entity, so two pages of one chapter that both began
 * sentences with "Their" and "Such" and both used "because" and "therefore"
 * were "the same treatment". Over the same 1,200 pages it rejected 295 the
 * model reviewer had approved, so the gate, the compile-time audit and the
 * bulk-pass polish guidance built on that scorer were all removed on
 * 2026-09-02. A deterministic rule that vetoes the reviewer has to be measured
 * against shipped pages before it ships; see `packages/core/src/generation/CLAUDE.md`.
 */

/**
 * Below this many distinct keywords a text is too short for the ratio to mean
 * anything: the denominator is the shorter side, so a four-keyword text that
 * happens to share three of them with a paragraph scores 0.75 without the two
 * saying remotely the same thing.
 */
const MIN_OVERLAP_KEYWORDS = 4;

/**
 * {@link sharedRatio} under that floor — the lexical half of the near-verbatim
 * rule, kept apart from the shingle half because only it has one. Thresholds
 * stay with each caller (`pageOverlap.ts` is the measurement):
 * `pageBeatDedupDetect.ts` spells its own floors instead, because a beat is
 * one or two sentences where a summary is a paragraph, so it needs a higher
 * bar than this to mean the same thing.
 */
function sharedKeywordRatio(first: Set<string>, second: Set<string>): number {
  if (first.size < MIN_OVERLAP_KEYWORDS || second.size < MIN_OVERLAP_KEYWORDS) {
    return 0;
  }
  return sharedRatio(first, second);
}

/**
 * The near-verbatim gate: the recent page whose body or summary this draft
 * restages, if any. The draft is one text scored against several, so its sets
 * are built once here and the loop only tokenizes each predecessor.
 */
export function repeatedRecentPage(
  recentPages: readonly PriorPageContext[],
  currentBody: string,
  currentSummary: string
): PriorPageContext | undefined {
  if (recentPages.length === 0) {
    return undefined;
  }
  const draftBodyShingles = overlapShingles(currentBody);
  const draftSummaryTokens = overlapTokens(currentSummary);
  const draftSummaryShingles = shinglesFromTokens(draftSummaryTokens);
  const draftSummaryKeywords = keywordsFromTokens(draftSummaryTokens);
  return recentPages.find((page) => {
    const summaryTokens = overlapTokens(page.summary);
    const bodySimilarity = sharedRatio(draftBodyShingles, overlapShingles(page.markdown));
    const summarySimilarity = sharedRatio(draftSummaryShingles, shinglesFromTokens(summaryTokens));
    const lexicalOverlap = sharedKeywordRatio(draftSummaryKeywords, keywordsFromTokens(summaryTokens));
    return bodySimilarity >= 0.82 || summarySimilarity >= 0.72 || lexicalOverlap >= 0.78;
  });
}

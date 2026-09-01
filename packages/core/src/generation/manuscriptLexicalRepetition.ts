import type { ManuscriptIntegrityPage, ManuscriptQualityIssue } from "./manuscriptQualityIssue.js";
import { manuscriptError, manuscriptWarning } from "./manuscriptQualityIssue.js";
import {
  candidateShingleHashes,
  firstSentence,
  forEachDistinctShingle,
  repetitionLane,
  tokenizePage,
  type PageTokens,
  type RepetitionLane
} from "./manuscriptPageCache.js";

const REPEATED_PHRASE_SHINGLE_WORDS = 4;
const REPEATED_PHRASE_MIN_LENGTH = 18;
const REPEATED_PHRASE_ISSUE_CAP = 3;
const REPEATED_PHRASE_MIN_PAGES_FLOOR = 6;
const REPEATED_OPENING_WORDS = 4;
const REPEATED_OPENING_MIN_LENGTH = 12;
const REPEATED_OPENING_ISSUE_CAP = 3;
const REPEATED_OPENING_MIN_PAGES_FLOOR = 3;
export const REPETITION_MIN_PAGE_WORDS = 80;
const REPETITION_MIN_PAGE_FRACTION = 0.15;
const NEAR_DUPLICATE_MIN_WORDS = 80;
const NEAR_DUPLICATE_JACCARD = 0.9;

export function repetitionMinPages(pageCount: number, floor: number): number {
  return Math.max(floor, Math.ceil(pageCount * REPETITION_MIN_PAGE_FRACTION));
}

export function distinctWords(tokens: PageTokens): Set<string> | undefined {
  return tokens.wordCount < NEAR_DUPLICATE_MIN_WORDS ? undefined : new Set(tokens.values);
}

export function nearDuplicateIssues(
  pages: ManuscriptIntegrityPage[],
  pageTokens: PageTokens[]
): ManuscriptQualityIssue[] {
  const wordSets = pageTokens.map((tokens) => distinctWords(tokens));
  const issues: ManuscriptQualityIssue[] = [];
  for (let left = 0; left < pages.length; left += 1) {
    for (let right = left + 1; right < pages.length; right += 1) {
      if (nearDuplicateWordSets(wordSets[left], wordSets[right])) {
        issues.push(
          manuscriptError(
            "NEAR_DUPLICATE_PAGES",
            `Pages ${pages[left]!.index} and ${pages[right]!.index} are nearly identical.`,
            "Regenerate one of these pages with its distinct page brief.",
            [pages[left]!.index, pages[right]!.index]
          )
        );
      }
    }
  }
  return issues;
}

function nearDuplicateWordSets(left: Set<string> | undefined, right: Set<string> | undefined): boolean {
  if (!left || !right) return false;
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  if (larger.size === 0 || smaller.size / larger.size < NEAR_DUPLICATE_JACCARD) return false;
  let intersection = 0;
  for (const word of smaller) {
    if (larger.has(word)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union > 0 && intersection / union >= NEAR_DUPLICATE_JACCARD;
}

export function repeatedPhraseIssues(
  pages: ManuscriptIntegrityPage[],
  pageTexts: string[],
  pageTokens: PageTokens[]
): ManuscriptQualityIssue[] {
  const minPages = repetitionMinPages(pages.length, REPEATED_PHRASE_MIN_PAGES_FLOOR);
  const laneFor = (pageIndex: number): RepetitionLane | null => {
    const tokens = pageTokens[pageIndex]!;
    return tokens.wordCount < REPETITION_MIN_PAGE_WORDS
      ? null
      : repetitionLane(pageTexts[pageIndex]!, tokens, {
          words: REPEATED_PHRASE_SHINGLE_WORDS,
          minKeyLength: REPEATED_PHRASE_MIN_LENGTH
        });
  };
  const candidates = candidateShingleHashes(pages.length, laneFor, minPages);
  if (candidates.size === 0) {
    return [];
  }

  const pagesByShingle = new Map<string, { owners: Set<number>; quote: string }>();
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const lane = laneFor(pageIndex);
    if (!lane) {
      continue;
    }
    forEachDistinctShingle(lane, (hash, start) => {
      if (!candidates.has(hash)) {
        return;
      }
      const key = lane.keyAt(start);
      const entry = pagesByShingle.get(key) ?? { owners: new Set<number>(), quote: lane.quoteAt(start) };
      entry.owners.add(pages[pageIndex]!.index);
      pagesByShingle.set(key, entry);
    });
  }

  const flagged = [...pagesByShingle.values()]
    .filter((entry) => entry.owners.size >= minPages)
    .sort((left, right) => right.owners.size - left.owners.size);
  const issues: ManuscriptQualityIssue[] = [];
  const reportedPageSets = new Set<string>();
  for (const entry of flagged) {
    const affected = [...entry.owners].sort((a, b) => a - b);
    const pageSetKey = affected.join(",");
    if (reportedPageSets.has(pageSetKey)) {
      continue;
    }
    reportedPageSets.add(pageSetKey);
    issues.push(
      manuscriptWarning(
        "REPEATED_PHRASE",
        `The phrase "${entry.quote}" recurs on ${affected.length} pages.`,
        "Vary the wording on most of these pages, or keep it only where the repetition is deliberate.",
        affected
      )
    );
    if (issues.length >= REPEATED_PHRASE_ISSUE_CAP) {
      break;
    }
  }
  return issues;
}

export function repeatedOpeningIssues(
  pages: ManuscriptIntegrityPage[],
  pageTexts: string[],
  pageTokens: PageTokens[]
): ManuscriptQualityIssue[] {
  const minPages = repetitionMinPages(pages.length, REPEATED_OPENING_MIN_PAGES_FLOOR);
  const pagesByOpening = new Map<string, { owners: number[]; quote: string }>();
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const tokens = pageTokens[pageIndex]!;
    if (tokens.wordCount < REPETITION_MIN_PAGE_WORDS) {
      continue;
    }
    const sentence = firstSentence(pageTexts[pageIndex]!);
    const lane = repetitionLane(
      sentence,
      { ...tokenizePage(sentence), script: tokens.script },
      { words: REPEATED_OPENING_WORDS, minKeyLength: REPEATED_OPENING_MIN_LENGTH }
    );
    if (lane.count === 0 || lane.hashAt(0) === null) {
      continue;
    }
    const key = lane.keyAt(0);
    const entry = pagesByOpening.get(key) ?? { owners: [], quote: lane.quoteAt(0) };
    entry.owners.push(pages[pageIndex]!.index);
    pagesByOpening.set(key, entry);
  }

  return [...pagesByOpening.values()]
    .filter((entry) => entry.owners.length >= minPages)
    .sort((left, right) => right.owners.length - left.owners.length)
    .slice(0, REPEATED_OPENING_ISSUE_CAP)
    .map((entry) =>
      manuscriptWarning(
        "REPEATED_OPENING",
        `${entry.owners.length} pages open with the same move ("${entry.quote}…").`,
        "Rework most of these openings so consecutive pages do not start the same way.",
        [...entry.owners].sort((a, b) => a - b)
      )
    );
}

import {
  evidenceForPages,
  manuscriptWarning,
  ratio,
  type ManuscriptQualityIssue
} from "./manuscriptQualityIssue.js";
import { REPETITION_MIN_PAGE_WORDS } from "./manuscriptLexicalRepetition.js";
import {
  chaptersSpannedBy,
  pagesShareChapter,
  setOverlap,
  sharedTerms,
  type CachedManuscriptPage
} from "./manuscriptSignatures.js";

const TREATMENT_ISSUE_CAP = 3;
const RECAP_ISSUE_CAP = 3;

type ScoredPair = {
  left: number;
  right: number;
};

export function sameChapterTreatmentIssues(cached: readonly CachedManuscriptPage[]): ManuscriptQualityIssue[] {
  const pairs = scoreSameChapterPairs(cached);
  const clusters = clusterIndexes(pairs.map((pair) => [pair.left, pair.right] as const), cached.length);
  return clusters
    .filter((cluster) => cluster.length >= 2)
    .sort((left, right) => right.length - left.length)
    .slice(0, TREATMENT_ISSUE_CAP)
    .map((cluster) => {
      const affected = cluster.map((index) => cached[index]!.page.index).sort((a, b) => a - b);
      return manuscriptWarning(
        "SAME_CHAPTER_TREATMENT_REPETITION",
        `${affected.length} pages in the same chapter repeat the same subject, evidence, and conclusion.`,
        "Keep the strongest treatment and make the other pages advance, challenge, or apply it with new evidence.",
        affected,
        {
          metrics: {
            occurrences: affected.length,
            affectedPageRatio: ratio(affected.length, cached.length),
            clusterCount: 1,
            chaptersSpanned: chaptersSpannedBy(cached, affected)
          },
          evidence: evidenceForPages(cached.map((page) => ({ index: page.page.index, plain: page.plain })), affected)
        }
      );
    });
}

export function recapBacktrackingIssues(
  cached: readonly CachedManuscriptPage[],
  options: { englishPhraseDetectors: boolean }
): ManuscriptQualityIssue[] {
  const pairs: Array<readonly [number, number]> = [];
  for (let later = 1; later < cached.length; later += 1) {
    for (let earlier = 0; earlier < later; earlier += 1) {
      if (isRecap(cached[earlier]!, cached[later]!, options.englishPhraseDetectors)) {
        pairs.push([earlier, later]);
      }
    }
  }
  const clusters = clusterIndexes(pairs, cached.length);
  return clusters
    .filter((cluster) => cluster.length >= 2)
    .sort((left, right) => right.length - left.length)
    .slice(0, RECAP_ISSUE_CAP)
    .map((cluster) => {
      const affected = cluster.map((index) => cached[index]!.page.index).sort((a, b) => a - b);
      return manuscriptWarning(
        "RECAP_BACKTRACKING",
        `${affected.length} pages reintroduce an established concept, example, or conclusion without advancing it.`,
        "Keep the first establishment and let later pages apply, qualify, or challenge it instead of restating the setup.",
        affected,
        {
          metrics: {
            occurrences: affected.length,
            affectedPageRatio: ratio(affected.length, cached.length),
            clusterCount: 1,
            chaptersSpanned: chaptersSpannedBy(cached, affected)
          },
          evidence: evidenceForPages(cached.map((page) => ({ index: page.page.index, plain: page.plain })), affected)
        }
      );
    });
}

function scoreSameChapterPairs(cached: readonly CachedManuscriptPage[]): ScoredPair[] {
  const pairs: ScoredPair[] = [];
  for (let left = 0; left < cached.length; left += 1) {
    for (let right = left + 1; right < cached.length; right += 1) {
      const first = cached[left]!;
      const second = cached[right]!;
      if (!pagesShareChapter(first.page, second.page)) {
        continue;
      }
      const scored = scoreTreatmentPair(first, second);
      if (scored !== null) {
        pairs.push({ left, right });
      }
    }
  }
  return pairs;
}

/**
 * What two pages of one chapter share when they are the same treatment: the
 * subject they both name, and which of evidence, causal chain and closing claim
 * repeated, with the terms that repeated so a rewrite can be told what to leave
 * behind.
 */
export type TreatmentMatch = {
  score: number;
  evidenceRepeat: boolean;
  causalRepeat: boolean;
  conclusionRepeat: boolean;
  sharedEntities: string[];
  sharedEvidence: string[];
  sharedCausal: string[];
  sharedConclusion: string[];
};

/**
 * Whether two pages of one chapter are the same treatment — a shared subject
 * (named entities) plus repeated evidence, causal chain, or closing claim.
 *
 * Exported because the page-time gate (`pagesTreatmentQa.ts`) scores a draft
 * against its finished chapter siblings with this exact function, so what the
 * page loop rewrites and what this audit later reports cannot disagree. The
 * thresholds live here and nowhere else; the shared terms are named only once
 * a pair has cleared them.
 */
export function scoreTreatmentPair(left: CachedManuscriptPage, right: CachedManuscriptPage): TreatmentMatch | null {
  if (left.tokens.wordCount < REPETITION_MIN_PAGE_WORDS || right.tokens.wordCount < REPETITION_MIN_PAGE_WORDS) {
    return null;
  }
  const subject = setOverlap(left.namedEntitySet, right.namedEntitySet);
  const subjectStrong = subject.intersection >= 2 || (subject.jaccard >= 0.4 && subject.intersection >= 1);
  if (!subjectStrong) {
    return null;
  }
  const evidence = setOverlap(left.evidenceTerms, right.evidenceTerms);
  const causal = setOverlap(left.causalTerms, right.causalTerms);
  const conclusion = setOverlap(left.conclusionTerms, right.conclusionTerms);
  const evidenceRepeat = evidence.intersection >= 4 && evidence.jaccard >= 0.28;
  const causalRepeat = causal.intersection >= 2 && causal.jaccard >= 0.35;
  const conclusionRepeat = conclusion.intersection >= 2 && conclusion.jaccard >= 0.35;
  if (!(evidenceRepeat || causalRepeat || conclusionRepeat)) {
    return null;
  }
  const distance = Math.abs(left.page.index - right.page.index);
  const adjacency = distance <= 1 ? 1 : distance <= 2 ? 0.9 : distance <= 4 ? 0.75 : 0.55;
  const nounBoost = subject.intersection >= 3 ? 1.15 : 1;
  return {
    score: (evidence.jaccard + causal.jaccard + conclusion.jaccard) * adjacency * nounBoost,
    evidenceRepeat,
    causalRepeat,
    conclusionRepeat,
    sharedEntities: sharedTerms(left.namedEntitySet, right.namedEntitySet),
    sharedEvidence: sharedTerms(left.evidenceTerms, right.evidenceTerms),
    sharedCausal: sharedTerms(left.causalTerms, right.causalTerms),
    sharedConclusion: sharedTerms(left.conclusionTerms, right.conclusionTerms)
  };
}

function isRecap(earlier: CachedManuscriptPage, later: CachedManuscriptPage, english: boolean): boolean {
  if (earlier.tokens.wordCount < REPETITION_MIN_PAGE_WORDS || later.tokens.wordCount < REPETITION_MIN_PAGE_WORDS) {
    return false;
  }
  const subject = setOverlap(earlier.namedEntitySet, later.namedEntitySet);
  const subjectStrong = subject.intersection >= 1;
  if (!subjectStrong) {
    return false;
  }
  const sharedDefinitions = setOverlap(earlier.definitionHeads, later.definitionHeads);
  const evidence = setOverlap(earlier.evidenceTerms, later.evidenceTerms);
  const conclusion = setOverlap(earlier.conclusionTerms, later.conclusionTerms);
  let newUncommon = 0;
  for (const term of later.uncommonTerms) {
    if (!earlier.uncommonTerms.has(term)) {
      newUncommon += 1;
    }
  }
  const restatedEvidence =
    later.evidenceTerms.size >= 4 && evidence.containment >= 0.7 && newUncommon <= 4 && conclusion.jaccard >= 0.3;
  const restatedDefinition = sharedDefinitions.intersection >= 1 && (later.recapCue || newUncommon <= 6);
  const englishRecap = english && later.recapCue && subject.intersection >= 1 && evidence.intersection >= 2;
  return restatedEvidence || restatedDefinition || englishRecap;
}

function clusterIndexes(pairs: readonly (readonly [number, number])[], size: number): number[][] {
  const parent = Array.from({ length: size }, (_, index) => index);
  const find = (index: number): number => {
    let cursor = index;
    while (parent[cursor] !== cursor) {
      parent[cursor] = parent[parent[cursor]!]!;
      cursor = parent[cursor]!;
    }
    return cursor;
  };
  for (const [left, right] of pairs) {
    const a = find(left);
    const b = find(right);
    if (a !== b) {
      parent[b] = a;
    }
  }
  const groups = new Map<number, number[]>();
  for (let index = 0; index < size; index += 1) {
    const root = find(index);
    const members = groups.get(root) ?? [];
    members.push(index);
    groups.set(root, members);
  }
  return [...groups.values()].filter((members) => members.length >= 2);
}

import {
  evidenceForPages,
  manuscriptWarning,
  ratio,
  type ManuscriptQualityIssue
} from "./manuscriptQualityIssue.js";
import { REPETITION_MIN_PAGE_WORDS } from "./manuscriptLexicalRepetition.js";
import { chaptersSpannedBy, setOverlap, type CachedManuscriptPage } from "./manuscriptSignatures.js";

/**
 * The recap-and-backtracking audit: pages that reintroduce an established
 * concept, example or conclusion without advancing it. It is the survivor of
 * a file that also held `SAME_CHAPTER_TREATMENT_REPETITION` and its
 * `scoreTreatmentPair`. That scorer's subject test was named-entity overlap
 * over an extractor that took every sentence-initial capitalised word as an
 * entity, and its "causal chain" was two shared cue words such as "because"
 * and "therefore"; run over 1,200 shipped pages it clustered whole chapters of
 * distinct pages in every book, so it was removed on 2026-09-02 together with
 * the page-time gate and the bulk-pass guidance built on it. `isRecap` below
 * survived the same measurement without a single false hit, because each of
 * its arms demands an explicit recap cue, a restated definition, or a page
 * whose evidence is almost entirely contained in the earlier one.
 */

const RECAP_ISSUE_CAP = 3;

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

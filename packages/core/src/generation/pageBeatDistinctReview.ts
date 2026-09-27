import { z } from "zod";
import type { ChapterBrief, PageProductionBeat } from "../schemas/book.js";
import { fingerprint } from "./pageBeatDedupDetect.js";

export type BeatPair = { pageIndex: number; duplicateOfPageIndex: number };

const distinctPairSchema = z.object({
  pageIndex: z.number().int().positive(),
  duplicateOfPageIndex: z.number().int().positive(),
  reason: z.string().min(20),
  evidence: z.array(z.object({ pageIndex: z.number().int().positive(), quote: z.string().min(12) })).min(2).max(6)
});

export const beatRewritePatchSchema = z.object({
  beatPatches: z.array(z.object({
    pageIndex: z.number().int().positive(), purpose: z.string().min(1), beat: z.string().min(1),
    endingPressure: z.string().min(1), requiredContinuity: z.array(z.string().min(1)).optional(),
    imageMoment: z.string().min(1).optional(), claim: z.string().min(1).optional(),
    evidenceAnchors: z.array(z.string().min(1)).optional()
  })).default([]),
  distinctPairs: z.array(distinctPairSchema).default([])
});

export type BeatRewritePatch = z.infer<typeof beatRewritePatchSchema>["beatPatches"][number];
type DistinctPairDecision = z.infer<typeof distinctPairSchema>;
/** Created locally from a grounded review, never accepted as a model-supplied exemption. */
export type ReviewedDistinctBeatPair = DistinctPairDecision & { contextSnapshot: string };

export const DISTINCT_BEAT_REVIEW_GUIDANCE = [
  "For pairs in reviewablePairs, the lexical match is only a candidate: first judge whether the same completed event actually repeats using storyContext, including intervening state changes.",
  "An initial setup and a later payoff, or an object restored after displacement, can share wording while doing different story work. Keep valid causal actions unchanged; do not paraphrase them just to lower word overlap.",
  "For each reviewable pair, either return a beatPatches rewrite for a real duplicate, or a distinctPairs decision retaining the original: {pageIndex, duplicateOfPageIndex, reason, evidence:[{pageIndex,quote}]}. Never return both for one page.",
  "A distinctPairs reason must explain the different event or consequence, supported by short exact quotes (at least 12 characters) from BOTH pages and any intervening change the explanation relies on. Cite only pages in the interval between the pair, inclusive. Two to six quotes suffice.",
  "Unchanged state followed by the same completed action is a duplicate. Exact copies and pairs absent from reviewablePairs cannot be dismissed. The rewrite-field requirements below apply only when returning a rewrite."
].join(" ");

export function beatPairKey(pair: BeatPair): string {
  return `${pair.duplicateOfPageIndex}:${pair.pageIndex}`;
}

/** One compact context, shared by all candidates in the bounded call. */
export function beatReviewStoryContext(briefs: ChapterBrief[], pairs: readonly BeatPair[]) {
  return briefs.flatMap(brief => brief.pages)
    .filter(page => pairs.some(pair => page.pageIndex >= pair.duplicateOfPageIndex && page.pageIndex <= pair.pageIndex))
    .sort((a, b) => a.pageIndex - b.pageIndex)
    .map(page => ({ pageIndex: page.pageIndex, beat: page.beat, requiredContinuity: page.requiredContinuity }));
}

export function groundedDistinctBeatPairs(options: {
  briefs: ChapterBrief[];
  candidates: readonly BeatPair[];
  decisions: DistinctPairDecision[];
  patchedPageIndexes: number[];
}): ReviewedDistinctBeatPair[] {
  const allowed = new Set(options.candidates.map(beatPairKey));
  const patched = new Set(options.patchedPageIndexes);
  const pages = options.briefs.flatMap(brief => brief.pages);
  return options.decisions.flatMap(decision => {
    const key = beatPairKey(decision);
    if (!allowed.has(key) || patched.has(decision.pageIndex) ||
      options.decisions.filter(other => beatPairKey(other) === key).length !== 1) return [];
    const interval = pairInterval(pages, decision);
    if (!interval || !groundedEvidence(interval, decision)) return [];
    return [{ ...decision, contextSnapshot: JSON.stringify(interval) }];
  });
}

/** Check before matching, so dismissing the strongest pair cannot hide a second collision. */
export function currentDistinctBeatPairKeys(
  briefs: ChapterBrief[], decisions: readonly ReviewedDistinctBeatPair[]
): Set<string> {
  const pages = briefs.flatMap(brief => brief.pages);
  return new Set(decisions.flatMap(decision => {
    const interval = pairInterval(pages, decision);
    return interval && JSON.stringify(interval) === decision.contextSnapshot && groundedEvidence(interval, decision)
      ? [beatPairKey(decision)] : [];
  }));
}

function pairInterval(pages: PageProductionBeat[], pair: BeatPair): PageProductionBeat[] | undefined {
  if (pair.duplicateOfPageIndex >= pair.pageIndex) return undefined;
  const interval = pages.filter(page => page.pageIndex >= pair.duplicateOfPageIndex && page.pageIndex <= pair.pageIndex)
    .sort((a, b) => a.pageIndex - b.pageIndex);
  if (interval.length !== pair.pageIndex - pair.duplicateOfPageIndex + 1 ||
    interval.some((page, i) => page.pageIndex !== pair.duplicateOfPageIndex + i)) return undefined;
  const first = interval[0]!, last = interval.at(-1)!;
  // Semantic judgment may excuse shared vocabulary, never an exact assignment or beat.
  if (fingerprint(first).normalized === fingerprint(last).normalized ||
    fingerprint({ purpose: "", beat: first.beat }).normalized === fingerprint({ purpose: "", beat: last.beat }).normalized)
    return undefined;
  return interval;
}

function groundedEvidence(pages: PageProductionBeat[], decision: DistinctPairDecision): boolean {
  const cited = new Set(decision.evidence.map(item => item.pageIndex));
  return cited.has(decision.pageIndex) && cited.has(decision.duplicateOfPageIndex) &&
    decision.evidence.every(item => {
      const page = pages.find(candidate => candidate.pageIndex === item.pageIndex);
      return page !== undefined && [page.purpose, page.beat, ...page.requiredContinuity, page.endingPressure]
        .some(text => text.includes(item.quote));
    });
}

import type { ChapterBrief } from "../schemas/book.js";
import { keywordsFromTokens, overlapTokens, sharedRatio, shinglesFromTokens } from "./pageOverlap.js";

/**
 * The free half of the planner-side beat dedup: the deterministic sweep that
 * finds near-duplicate page beats across the whole map, the overlap
 * measurement they are scored with (`pageOverlap.ts`), and the fingerprints
 * both halves score against. The paid
 * half — the one bounded model call that rewrites what this flags — is
 * `pageBeatDedup.ts`, which is also the module the whole pass is exported
 * through, so nothing outside imports this one directly. Why the pass exists at
 * all is stated there.
 *
 * **Free means it spends nothing, not that it costs nothing.** The sweep is
 * quadratic in a book's pages and runs on every book, so it is `async` and
 * pauses on a pair budget rather than holding the worker's thread for its whole
 * run — `findDuplicatePageBeats` carries that measurement and what it is
 * bounded by.
 *
 * The overlap measurement is `pageOverlap.ts`, shared with the page-time
 * repetition check (`pagesLocalQa.ts`), so what this pass waves through is
 * measured the same way the reviewer will measure the drafted prose.
 * Thresholds are this module's own: beats are one or two sentences where
 * summaries are a paragraph, and same-chapter beats legitimately share the
 * chapter's vocabulary, so both bars sit where a pair reads as the same
 * assignment rather than the same topic.
 *
 * **A beat too short to measure is waved through, not flagged.** Both metrics
 * divide by the shorter side, so a terse assignment — "Name the cost | The
 * cost is real." — shares most of its handful of tokens with any longer beat
 * that touches the same noun and scores past both bars against a page it has
 * nothing to do with. The shared tokenizer keeps every token over two
 * characters and its stop list is about summaries, so "the" is one of those
 * tokens; on a four-keyword beat that is a quarter of the score for free.
 * The floors below are what buy the thresholds their meaning, and they are
 * this module's because a paragraph-length summary always clears them.
 *
 * The later page of a pair is always the one rewritten, and page 1 is dropped
 * outright even if a malformed map manages to sort it there — so the
 * first-page brief contract (`pageBriefContract.ts`) is never this module's to
 * state. The book's *last* page has no such luck: it is the later half of
 * every pair it appears in and is therefore the likeliest page here, so its
 * ending pressure is held to `LAST_PAGE_ENDING_PRESSURE` rather than left to a
 * prompt that says nothing about endings.
 *
 * **No finding names a page the same sweep is about to rewrite.** Each page's
 * strongest earlier match used to be picked over every earlier page, flagged
 * ones included, so a finding could pin page 4 to page 3 while page 3's own
 * beat was being replaced by the same model call: page 4's distinctness note
 * then quoted, through `earlierText`, an assignment page 3 no longer had, and
 * nothing kept page 4 clear of page 3's *fresh* beat. Detection never runs
 * again, so the exclusion has to happen inside the one sweep. Page 1 is never
 * flagged, so it stays a legitimate target for every page behind it. **What is
 * excluded is the rewrite set, not the finding set**: a page whose finding lost
 * the capped draw keeps the beat detection flagged, so quoting it is accurate and
 * refusing to quote it would cost a later page its own note over a rewrite that
 * is never going to happen. That distinction is decidable mid-sweep only because
 * the slots go to the earliest findings — `findingsForRewrite` says why.
 *
 * **A refused match is held rather than dropped, because the rewrite it defers
 * to may never arrive.** A match naming a page being rewritten got nothing
 * written down for that pair, and that was justified as "the collision cannot
 * survive this pass". It survives whenever the rewrite does not: the model
 * answers for another page, or the answer is dropped for colliding, for saying
 * nothing about the page's continuity, or for saying nothing about its picture —
 * and then both pages keep the beats detection matched, with no rewrite and no
 * note, which is the one outcome this pass may not produce. Nothing measures the
 * map again. So each refused match rides the finding of the page that refused
 * it, as `suppressedMatches`, and `beatDedupPatch` writes the note from it for
 * every one of those pages that ends up keeping its beat.
 *
 * **They are held whether or not something standing also matched, and draining
 * them only when nothing did lost the stronger half of the pair.** Page X
 * colliding with P — its strongest match, and a page that won a rewrite slot —
 * and also with a weaker standing Q produced a finding naming Q, so the branch
 * that drained `refused` never ran and the X↔P match was discarded where it was
 * scored. Drop P's rewrite — for colliding, or for either of the two questions
 * it has to answer for — and P keeps exactly the beat X was flagged against: X
 * ships with a note about Q, P's note names its own duplicate, and the pair
 * nothing will ever measure again reaches drafting undescribed. A standing match
 * is no substitute for a refused one; they name different pages, and only one of
 * those pages is about to be reassigned.
 *
 * **What is held is every refused match that outranked the standing one, and
 * that filter is what makes the guarantee exact rather than merely generous.** A
 * page named as a `duplicateOfPageIndex` is never rewritten — the slots go to
 * the earliest findings, and a finding's target is by construction not one of
 * the pages holding them — so a page's standing best is guaranteed to still say
 * what it says when this pass is over. A refused match weaker than it can
 * therefore never be the strongest collision that page still has, whatever
 * becomes of the rewrite, and holding it would only offer `beatDedupPatch` a
 * note it must not take. **So the guarantee is about which collision the note
 * names, not merely that there is one: a page's note names the strongest match
 * it still has, and a page is left with nothing only when every page it collided
 * with was actually reassigned.** Each of those rewrites was scored against what
 * this page ended up with — `withoutCollidingRewrites` settles that rather than
 * assuming it. A match is held under *every* flagged page it names, since which
 * of them keep their beats is not knowable here, and `beatDedupPatch` still
 * writes one note per page.
 */

/** Half the shorter beat's trigrams appearing verbatim in the other. */
export const BEAT_SHINGLE_SIMILARITY_THRESHOLD = 0.55;
/** Seven of the shorter beat's ten keywords appearing in the other. */
export const BEAT_KEYWORD_OVERLAP_THRESHOLD = 0.7;
/** Distinct keywords a beat needs before the keyword bar means anything. */
export const MIN_BEAT_KEYWORDS = 8;
/** Trigrams a beat needs before the phrasing bar means anything (~8 tokens). */
export const MIN_BEAT_SHINGLES = 6;
/**
 * How many findings the **rewrite call** may carry. Each one costs prompt space
 * and a full patch of response, and a map that trips more than this is a plan no
 * model should be asked to repair pair by pair — the first collisions are the
 * ones worth spending a call on.
 *
 * It is a bound on that call and on nothing else. Applied to the sweep below —
 * where it lived, as its loop condition — it terminated detection: a 200-page
 * map whose first twelve collisions clustered in chapters 1-3 was never scanned
 * past page ~40, so eight more in chapters 9-12 got no rewrite, which this cap
 * is entitled to refuse, and no `distinctnessLine` either, which costs nothing
 * and is the half of this pass that is guaranteed rather than attempted. Each of
 * those pages then spent its whole page-QA rewrite budget failing the reviewer
 * on repetition — the exact cost the pass exists to avoid, on the maps dense
 * enough to need it most.
 */
export const MAX_BEAT_DEDUP_FINDINGS = 12;

export type DuplicateBeatFinding = {
  /** The later page — the one whose beat gets rewritten. */
  pageIndex: number;
  /** The earlier page whose beat it near-duplicates; never rewritten. */
  duplicateOfPageIndex: number;
  /** The earlier page's assignment, for the distinctness note and the prompt. */
  earlierText: string;
  reason: string;
  /**
   * Findings for later pages whose strongest match was *this* page, held back
   * because this page's beat is being replaced and a note quoting it would
   * quote an assignment that is gone. `beatDedupPatch` writes their notes if no
   * rewrite arrives — see the module docstring, which is also why nothing
   * weaker than the refusing page's own standing match is kept here.
   */
  suppressedMatches?: DuplicateBeatFinding[];
};

/**
 * The two halves of an assignment this module measures. Widened past
 * `PageProductionBeat` so a model's rewrite — which carries the same two fields
 * and nothing else — is scored by the same code that flagged the page.
 */
export type BeatAssignment = { purpose: string; beat: string };

function beatText(beat: BeatAssignment): string {
  return `${beat.purpose} ${beat.beat}`.trim();
}

/** One page's precomputed halves of the shared overlap rule. */
export type BeatFingerprint = {
  text: string;
  /** Case, punctuation and spacing folded away — what the batch rule falls back to. */
  normalized: string;
  shingles: Set<string>;
  keywords: Set<string>;
};

export function fingerprint(beat: BeatAssignment): BeatFingerprint {
  const text = beatText(beat);
  // Both halves of the shared rule read the same tokens, so the text is
  // tokenized once here rather than twice by `overlapShingles` and
  // `overlapKeywords`, each of which owns its own pass. The tokenizer is
  // *imported* for it rather than restated: a second copy here would be a
  // second definition of what a token is, and the whole claim this module makes
  // is that it waves a beat through by the same measurement the page reviewer
  // will hold the drafted prose to. It is why the deriver pair is worth reaching
  // for at all — the saving itself is invisible, being the O(n) term under the
  // sweep's O(n²) one, which tokenizes nothing and is what the timings above
  // measure.
  const tokens = overlapTokens(text);
  return {
    text,
    normalized: text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(),
    shingles: shinglesFromTokens(tokens),
    keywords: keywordsFromTokens(tokens)
  };
}

/** What `scorePair` answers with when a pair clears one of the two bars. */
type ScoredPair = { score: number; reason: (pageIndex: number) => string };

/**
 * How many scored pairs one uninterrupted slice of the sweep may cost before it
 * hands the event loop back. A pair scores in ~1.3 us, so 2000 of them is ~3 ms,
 * and a page's row is charged whole rather than split — the slice may therefore
 * overrun by up to one page's worth of pairs, 600 of them at the `targetPages`
 * ceiling. Longest gap measured at that ceiling: 3.6 ms.
 *
 * It bounds a *pause interval*, never the sweep: every pair is still scored and
 * every collision is still found, which is the distinction
 * `MAX_BEAT_DEDUP_FINDINGS` records the incident for. A budget used as a loop
 * condition would be that mistake a second time, with a worse excuse — a page
 * map silently half-swept because the box was slow.
 */
export const BEAT_SWEEP_PAIRS_PER_SLICE = 2000;

/**
 * Hands the event loop back for one turn. **`setImmediate`, never
 * `await Promise.resolve()`** — a microtask checkpoint reads like a yield and is
 * not one: the queue it joins is drained to empty before the loop reaches the
 * poll phase, so a sweep paused that way still blocks every socket read,
 * provider stream chunk and timer for its whole run and merely looks
 * interruptible. `setImmediate` lands in the check phase, which is *after* poll,
 * so each pause is a turn in which the siblings' I/O callbacks actually run.
 * `setTimeout(…, 0)` would also do it and is the wrong instrument here: it is
 * clamped to 1 ms, which at 600 pages is ~90 pauses and so ~90 ms of pure
 * waiting added to a 290 ms sweep.
 */
function pauseForEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Deterministic sweep over every pair of pages in the map, earliest pairs
 * first. Each later page is reported at most once, against its strongest
 * earlier match, and **every** page in the map is scanned: what
 * `MAX_BEAT_DEDUP_FINDINGS` bounds is the rewrite call, not this.
 *
 * Pure and cheap enough to run on every book, and the whole-map cost is one
 * already being paid: a map with no collisions never tripped the cap either, so
 * the quadratic sweep is what every clean book has always cost, and uncapping it
 * only levels the colliding ones up to that. Fingerprints are tokenized once per
 * page rather than once per pair, which is the difference between tens of
 * milliseconds and a third of a second of worker event loop. Measured
 * on a map of distinct beats: ~19.9k pairs and ~40 ms at 200 pages, ~180k pairs
 * and ~290 ms at 600, which is `targetPages`' own ceiling
 * (`schemas/mediaSettings.ts`) and therefore the bound on this loop — once per
 * book, against a drafting run of one model call per page. That measurement is
 * the worst case rather than the clean case: a distinct map scores every pair
 * to the end, which is what a colliding one now does too, because a flagged
 * page's pairs are still scored so the matches it refuses can be recorded.
 *
 * **That total was one uninterrupted block, which is what makes it async.** The
 * cost is right and the *shape* was not: a 1 ms timer standing in for a sibling
 * job's callback did not fire once inside the sweep, because there was no point
 * at which it could. This runs inside `GENERATE_BOOK` in a process carrying up
 * to `MAX_PARALLEL_PAGE_JOBS` other jobs, so for that whole window every one of
 * their socket reads, provider stream chunks and BullMQ lock renewals waited on
 * a pass that spends nothing and is only advisory. So the sweep pauses every
 * `BEAT_SWEEP_PAIRS_PER_SLICE` scored pairs. Both sides measured back to back on
 * one box at 600 pages: before, the probe's longest gap was the whole sweep —
 * 236 ms with no tick inside it; after, 87 ticks inside it, a longest gap of
 * 3.6 ms, and the same 236 ms end to end. The findings came back identical on
 * every map either side was run over. A book too small to fill one slice —
 * every map in this suite's fixtures, and any book of 63 pages or fewer — pauses
 * not once and is exactly as synchronous as it was.
 *
 * **A pause is not a stop check and cannot become one here.** `bestEffortPass`
 * (`apps/worker/src/generation/bookState.ts`) rethrows `StopRequestedError` out
 * of this call, but nothing inside the sweep can raise one: `packages/core` is
 * the leaf of the dependency graph and cannot see the worker's stop signal. A
 * reader's stop is therefore observed exactly where it was before, at the
 * caller's next `updateJobProgress`, and a paused sweep runs to the end like an
 * unpaused one. What the pauses change is how fast that signal *arrives* — the
 * read that discovers it is no longer queued behind a quarter of a second of
 * scoring.
 *
 * **What a pause does introduce is time, so what is read across those turns is
 * worth being exact about.** The page list, its order and every page's printed
 * index are taken before the first pause, which is what keeps a finding's page
 * numbers and the order they were compared in the same reading of the map. A
 * page's *text* is read once, by the fingerprint taken at its own iteration, and
 * every comparison after that scores the fingerprint rather than the brief — so
 * a brief mutated mid-sweep cannot make one page read two ways, and cannot
 * reach a pair already scored. Nothing mutates them today; a sweep spanning
 * turns is what makes it worth reading each page exactly once anyway.
 *
 * **A cheaper inner loop was the other candidate and there is no sound one.**
 * Both bars divide by the *shorter* side (`sharedRatio`), so a short beat wholly
 * contained in a long one scores 1.00: no band on length, token count or set
 * size can rule a pair out without changing the answer, which is the one thing a
 * pre-filter has to promise. An inverted index over shared tokens is sound and
 * buys nothing where it is needed — the worst case is the map with *no*
 * collisions, whose pages still share the commonest tokens, "the" among them
 * (the shared tokenizer keeps everything over two characters). Narrowing what is
 * compared is therefore either unsound or inert; how long the loop holds the
 * thread is what was actually wrong.
 */
export async function findDuplicatePageBeats(briefs: ChapterBrief[]): Promise<DuplicateBeatFinding[]> {
  // `flatMap` already answers with an array of its own, so this sorts a copy
  // without making a second one.
  const pages = briefs.flatMap((brief) => brief.pages).sort((first, second) => first.pageIndex - second.pageIndex);
  /** Each page's printed index, read once — see the docstring on pinning. */
  const pageIndexes = pages.map((page) => page.pageIndex);
  const prints: BeatFingerprint[] = [];
  const findings: DuplicateBeatFinding[] = [];
  // Positions this sweep has flagged *and* put in for a rewrite, held by array
  // position rather than page index so a map carrying the same index twice
  // cannot excuse one of them, and mapped to their own findings so a match one
  // of them refuses can be hung on the finding whose rewrite is the reason for
  // the refusal. Every one of these pages is about to have its beat replaced by
  // the rewrite call, so none of them may be named as a later page's
  // `duplicateOfPageIndex` — and a finding past the cap therefore never enters
  // here, because nothing is going to replace that page's beat.
  const rewriting = new Map<number, DuplicateBeatFinding>();
  /** Pairs scored since the last pause; `BEAT_SWEEP_PAIRS_PER_SLICE` is its ceiling. */
  let scoredSincePause = 0;
  for (let later = 0; later < pages.length; later += 1) {
    // Fingerprinted at the top of its own iteration rather than in one pass up
    // front, which is the same one-tokenization-per-page it always was and
    // spreads the O(n) term across the slices instead of leaving it as a 10-16 ms
    // block of its own in front of them. Every position this iteration reads is
    // behind it, so the print it needs is always the one just pushed or one
    // pushed earlier. Position 0 falls straight through: its inner loop is empty.
    prints.push(fingerprint(pages[later]!));
    // Page 1's assignment is written under a contract this pass does not
    // state, so it is never rewritten here — not even by a map that sorted a
    // second page 1 into a later slot.
    if (pageIndexes[later]! <= 1) {
      continue;
    }
    const matchOn = (earlier: number, scored: ScoredPair): DuplicateBeatFinding => ({
      pageIndex: pageIndexes[later]!,
      duplicateOfPageIndex: pageIndexes[earlier]!,
      earlierText: prints[earlier]!.text,
      reason: scored.reason(pageIndexes[earlier]!)
    });
    let best: DuplicateBeatFinding | undefined;
    let bestScore = 0;
    /**
     * Matches refused for naming a page being rewritten: the refusing page's
     * position, and the score the pair cleared its bar by — which is what the
     * drain below weighs against this page's standing best.
     */
    const refused: { position: number; score: number; match: DuplicateBeatFinding }[] = [];
    for (let earlier = 0; earlier < later; earlier += 1) {
      const scored = scorePair(prints[later]!, prints[earlier]!);
      if (!scored) {
        continue;
      }
      if (rewriting.has(earlier)) {
        refused.push({ position: earlier, score: scored.score, match: matchOn(earlier, scored) });
        continue;
      }
      if (scored.score <= bestScore) {
        continue;
      }
      bestScore = scored.score;
      best = matchOn(earlier, scored);
    }
    if (best) {
      // Whether this finding wins one of the rewrite call's slots is knowable
      // here, and only because the slots go to the earliest findings — see
      // `findingsForRewrite`. A page that wins one is about to have its beat
      // replaced and so may not be named by anything behind it; a page that
      // loses one keeps exactly the assignment quoted here, which makes it as
      // legitimate a target as a page nothing flagged.
      const winsRewriteSlot = findings.length < MAX_BEAT_DEDUP_FINDINGS;
      findings.push(best);
      if (winsRewriteSlot) {
        rewriting.set(later, best);
      }
    }
    // A refused match is one this sweep may not write down — the note would
    // quote an assignment that is about to be gone — and not one it may forget
    // either, because the rewrite it defers to is attempted rather than
    // guaranteed. It rides the refusing page's finding instead, and is written
    // from there only if that page keeps its beat, at which point quoting it is
    // accurate again.
    //
    // Draining this only when *nothing* standing matched — as an `else` on the
    // branch above — is what silently discarded the strongest half of a page's
    // collisions, and the docstring names the pair it costs. The `bestScore`
    // test is the whole of what may be dropped here and is sound because the
    // standing best is a page nothing will rewrite: anything under it can never
    // be the strongest collision this page still has. With no standing match
    // `bestScore` is 0 and every refusal clears it, which is exactly what the
    // `else` used to do.
    for (const { position, score, match } of refused) {
      if (score <= bestScore) {
        continue;
      }
      const refuser = rewriting.get(position)!;
      refuser.suppressedMatches = [...(refuser.suppressedMatches ?? []), match];
    }
    // The inner loop above scored exactly `later` pairs — it breaks nowhere — so
    // the slice is charged from the loop bound rather than counted inside it,
    // and how many pauses a given map takes is as deterministic as its findings.
    scoredSincePause += later;
    if (scoredSincePause >= BEAT_SWEEP_PAIRS_PER_SLICE) {
      scoredSincePause = 0;
      await pauseForEventLoop();
    }
  }
  return findings;
}

/**
 * The two bars sit at different heights, so the raw metrics are not comparable
 * and ranking them with a bare `Math.max` let a phrasing match that barely
 * cleared 0.55 lose to a keyword match that barely cleared 0.70. Each is
 * scored against its own threshold instead, so "strongest earlier match" means
 * the pair that cleared its bar by the most — which is the page the rewrite is
 * told to stay clear of.
 */
export function scorePair(later: BeatFingerprint, earlier: BeatFingerprint): ScoredPair | undefined {
  const measurableShingles = later.shingles.size >= MIN_BEAT_SHINGLES && earlier.shingles.size >= MIN_BEAT_SHINGLES;
  const measurableKeywords = later.keywords.size >= MIN_BEAT_KEYWORDS && earlier.keywords.size >= MIN_BEAT_KEYWORDS;
  const similarity = measurableShingles ? sharedRatio(later.shingles, earlier.shingles) : 0;
  const overlap = measurableKeywords ? sharedRatio(later.keywords, earlier.keywords) : 0;
  const similarityScore = similarity / BEAT_SHINGLE_SIMILARITY_THRESHOLD;
  const overlapScore = overlap / BEAT_KEYWORD_OVERLAP_THRESHOLD;
  if (similarityScore < 1 && overlapScore < 1) {
    return undefined;
  }
  return similarityScore >= overlapScore
    ? {
        score: similarityScore,
        reason: (pageIndex) => `phrasing overlaps page ${pageIndex}'s beat (${Math.round(similarity * 100)}%)`
      }
    : {
        score: overlapScore,
        reason: (pageIndex) => `keywords overlap page ${pageIndex}'s beat (${Math.round(overlap * 100)}%)`
      };
}

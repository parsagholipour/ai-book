import { REPETITION_MIN_PAGE_WORDS } from "./manuscriptLexicalRepetition.js";
import { plainMarkdown, tokenizePage } from "./manuscriptPageCache.js";
import {
  SAME_CHAPTER_FALLBACK_DISTANCE,
  cacheManuscriptPages,
  type CachedManuscriptPage
} from "./manuscriptSignatures.js";
import { scoreTreatmentPair, type TreatmentMatch } from "./manuscriptTreatmentAudit.js";
import { keywordsFromTokens, overlapShingles, overlapTokens, sharedRatio, shinglesFromTokens } from "./pageOverlap.js";
import type { PriorPageContext } from "./pagesShared.js";

/**
 * The page-time half of the repetition rules: the two gates in
 * `pagesLocalQa.ts` that read a draft against the pages behind it, and the
 * guidance a bulk pass hands its polish step from the same measurement.
 *
 * Two different things are measured here, and they are kept apart on purpose.
 * `repeatedRecentPage` is the near-verbatim gate — trigram and keyword overlap
 * against the last five pages, thresholds high enough that only a page
 * restaging another's prose fails it. `sameChapterTreatmentMatch` is the
 * *treatment* gate: the same subject argued from the same evidence to the same
 * closing claim in different words, which is what the manuscript audit reports
 * as `SAME_CHAPTER_TREATMENT_REPETITION` after the book is finished. It scores
 * with `scoreTreatmentPair` from `manuscriptTreatmentAudit.ts` — the compile
 * detector's own function and thresholds — so a draft this gate passes is one
 * the audit will pass, and a draft it fails is rewritten now, inside the page's
 * rewrite budget, instead of being reported once every page is durable.
 *
 * **The gate reads the chapter, not the recency window.** Treatment repetition
 * is a chapter-scoped fault: three pages on adjacent facets of one subject reach
 * for the same canonical cases. So the candidates are the finished pages of the
 * *same chapter* — by the chapter range the caller was handed, or, for a
 * caller with none, by the audit's own `SAME_CHAPTER_FALLBACK_DISTANCE` — and
 * not the five pages before this one whatever chapter they sit in.
 *
 * **The message names the earlier page only after the word `from`.** A
 * final-QA message is prefixed `Page N:` and the compile's repair pass
 * harvests every `page <digits>` in it as a page to redraft, except a lone
 * reference that follows "from" (`finalQaPageTargets.ts`). Spelled any other
 * way, the page that *established* the treatment would be redrafted beside the
 * page that repeated it. The listed terms are filtered for the edge words the
 * same pass reads as a complaint about the book's ends.
 *
 * Signatures of finished pages are memoized by object identity: every pass
 * that pushes into `previousPages` pushes the object it saved once, and the
 * local checks run for every draft candidate of every page. The draft's own
 * signature is built once per call and only when there is something to score
 * it against — the hoisting lesson `pagesLocalQa.ts` states beside the
 * near-verbatim gate.
 */

export type TreatmentPage = Pick<PriorPageContext, "index" | "title" | "markdown">;

export type SameChapterTreatmentMatch = {
  page: TreatmentPage;
  match: TreatmentMatch;
};

/** What the treatment gate reads off a review; `ReviewPageOptions` satisfies it. */
export type TreatmentGateSource = {
  pageIndex: number;
  chapterPageStart?: number | undefined;
  chapterPageEnd?: number | undefined;
  draft: { title: string; markdown: string };
  previousPages: readonly PriorPageContext[];
};

export type TreatmentGuidanceRange = { startPage: number; endPage: number };

/** Finished same-chapter pages a draft is scored against, newest last. */
const TREATMENT_PREDECESSOR_WINDOW = 12;
/** Shared terms a message or guidance line names per clause. */
const ISSUE_TERM_LIMIT = 4;

/**
 * Words the final-QA repair reads as a complaint about the book's opening or
 * ending (`OPENING_ISSUE_PATTERN` / `ENDING_ISSUE_PATTERN` in
 * `finalQaPageTargets.ts`), plus the page words its reference pattern starts
 * on. A shared conclusion cue is routinely one of these, so they are dropped
 * from the listed terms rather than trusted to the `Page N:` prefix.
 */
const EDGE_WORDS = new Set(["conclusion", "ending", "resolution", "opening", "final", "first", "page", "pages"]);

type MemoizedSignature = { markdown: string; signature: CachedManuscriptPage };

const priorSignatures = new WeakMap<TreatmentPage, MemoizedSignature>();

function signatureFor(page: TreatmentPage): CachedManuscriptPage {
  const plain = plainMarkdown(page.markdown);
  return cacheManuscriptPages([
    { page: { index: page.index, title: page.title, markdown: page.markdown }, plain, tokens: tokenizePage(plain) }
  ])[0]!;
}

function priorSignature(page: TreatmentPage): CachedManuscriptPage {
  const memoized = priorSignatures.get(page);
  if (memoized && memoized.markdown === page.markdown) {
    return memoized.signature;
  }
  const signature = signatureFor(page);
  priorSignatures.set(page, { markdown: page.markdown, signature });
  return signature;
}

/**
 * The finished pages a draft may be repeating: earlier pages of its own
 * chapter, bounded to the newest few.
 */
export function sameChapterPredecessors(source: TreatmentGateSource): PriorPageContext[] {
  const { pageIndex, chapterPageStart, chapterPageEnd } = source;
  const inChapter =
    chapterPageStart === undefined
      ? (index: number) => pageIndex - index < SAME_CHAPTER_FALLBACK_DISTANCE
      : (index: number) => index >= chapterPageStart && (chapterPageEnd === undefined || index <= chapterPageEnd);
  return source.previousPages
    .filter((page) => page.index < pageIndex && inChapter(page.index))
    .slice(-TREATMENT_PREDECESSOR_WINDOW);
}

/**
 * The same-chapter page this draft re-treats, if any — the strongest match
 * when several do.
 */
export function sameChapterTreatmentMatch(source: TreatmentGateSource): SameChapterTreatmentMatch | undefined {
  const candidates = sameChapterPredecessors(source);
  if (candidates.length === 0) {
    return undefined;
  }
  const draft = signatureFor({ index: source.pageIndex, title: source.draft.title, markdown: source.draft.markdown });
  if (draft.tokens.wordCount < REPETITION_MIN_PAGE_WORDS) {
    return undefined;
  }
  return strongestTreatmentMatch(draft, candidates);
}

function strongestTreatmentMatch(
  draft: CachedManuscriptPage,
  candidates: readonly TreatmentPage[]
): SameChapterTreatmentMatch | undefined {
  let best: SameChapterTreatmentMatch | undefined;
  for (const page of candidates) {
    const match = scoreTreatmentPair(priorSignature(page), draft);
    if (match && (best === undefined || match.score > best.match.score)) {
      best = { page, match };
    }
  }
  return best;
}

function listTerms(terms: readonly string[]): string {
  return terms
    .filter((term) => !EDGE_WORDS.has(term))
    .slice(0, ISSUE_TERM_LIMIT)
    .join(", ");
}

function withTerms(label: string, terms: readonly string[]): string {
  const listed = listTerms(terms);
  return listed ? `${label} (${listed})` : label;
}

function joinClauses(clauses: readonly string[]): string {
  if (clauses.length <= 1) {
    return clauses[0] ?? "";
  }
  return `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;
}

function repeatedClauses(match: TreatmentMatch): string {
  return joinClauses([
    ...(match.evidenceRepeat ? [withTerms("the same evidence", match.sharedEvidence)] : []),
    ...(match.causalRepeat ? [withTerms("the same causal chain", match.sharedCausal)] : []),
    ...(match.conclusionRepeat ? [withTerms("the same closing claim", match.sharedConclusion)] : [])
  ]);
}

function subjectPhrase(match: TreatmentMatch): string {
  const listed = listTerms(match.sharedEntities);
  return listed ? `re-treats ${listed}` : "re-treats its subject";
}

/** The local-QA issue for a draft that repeats a same-chapter treatment. */
export function treatmentRepetitionIssue(found: SameChapterTreatmentMatch): string {
  return (
    `Page ${subjectPhrase(found.match)} with ${repeatedClauses(found.match)} as an earlier page of this chapter ` +
    `(from page ${found.page.index}); advance, challenge, or apply that treatment with different evidence.`
  );
}

/**
 * Distinctness lines for a bulk draft's polish step: for every chapter, each
 * later page whose treatment an earlier page of the same draft already made.
 *
 * Scored while every page of the chapter is in hand — which the sequential
 * polish never is — so the first polish differentiates the page instead of the
 * QA loop paying a rewrite to find out. Keyed by page index; a page with no
 * entry needs nothing.
 */
export function treatmentGuidanceForDraft(
  pages: readonly TreatmentPage[],
  chapterRanges: readonly TreatmentGuidanceRange[]
): Map<number, string[]> {
  const guidance = new Map<number, string[]>();
  const ordered = [...pages].sort((left, right) => left.index - right.index);
  for (const range of chapterRanges) {
    const chapterPages = ordered.filter((page) => page.index >= range.startPage && page.index <= range.endPage);
    for (let later = 1; later < chapterPages.length; later += 1) {
      const laterPage = chapterPages[later]!;
      const draft = priorSignature(laterPage);
      if (draft.tokens.wordCount < REPETITION_MIN_PAGE_WORDS) {
        continue;
      }
      const found = strongestTreatmentMatch(draft, chapterPages.slice(0, later));
      if (found) {
        guidance.set(laterPage.index, [treatmentGuidanceLine(found)]);
      }
    }
  }
  return guidance;
}

function treatmentGuidanceLine(found: SameChapterTreatmentMatch): string {
  return (
    `An earlier page of this chapter (page ${found.page.index}) already ${subjectPhrase(found.match)} with ` +
    `${repeatedClauses(found.match)}. Rewrite this page so it advances, challenges, or applies that treatment: ` +
    "build on different evidence, reach a different closing claim, and do not restate its argument."
  );
}

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

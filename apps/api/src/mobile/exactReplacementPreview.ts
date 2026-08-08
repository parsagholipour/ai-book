import {
  applyExactReplacement,
  countExactMatches,
  exactReplacementLineDiff,
  hasExactMatch,
  type ExactReplacement
} from "@book-maker/core";
import { prisma } from "@book-maker/db";

/**
 * Works out, before anything is charged, exactly what a literal find/replace
 * would do.
 *
 * The worker has always had a model-free path for these edits
 * (`locallyPatchedPage`), but the decision to take it was made per page at
 * apply time and never fed back into pricing: a `local_patch` was billed per
 * page whether it ran the free string replacement or fell through to two model
 * calls per page. Computing the result here instead makes the cheap path
 * something we can *promise* — a real diff to approve, and no charge, because
 * no provider call will happen.
 *
 * A page that does not contain the literal text is dropped rather than left in
 * scope. Candidates come from a case-insensitive database match, so a page can
 * match the search and still not contain the string the replacement needs.
 * Leaving it in is what used to send it silently down the expensive path.
 */

/** Enough to see the shape of the change without turning the card into the book. */
const MAX_SAMPLES = 5;
/** Long enough for a sentence; a full paragraph line would swamp the card. */
const MAX_SAMPLE_LENGTH = 160;

export type ExactReplacementPlan = {
  replacement: ExactReplacement;
  /** Pages that really contain `from`, in order. Always non-empty. */
  pageIndexes: number[];
  matchCount: number;
  samples: Array<{ pageIndex: number; before: string; after: string }>;
};

export async function planExactReplacement(
  projectId: string,
  requested: ExactReplacement | null,
  candidatePageIndexes: number[]
): Promise<ExactReplacementPlan | null> {
  if (!requested?.from || candidatePageIndexes.length === 0) {
    return null;
  }
  // Only the pages already in scope, so this stays bounded by the edit rather
  // than by the size of the book.
  const pages = await prisma.page.findMany({
    where: { projectId, index: { in: candidatePageIndexes } },
    orderBy: { index: "asc" },
    select: { index: true, title: true, markdown: true }
  });

  // Prefer the literal swap; fall back to case-preserving only when the exact
  // text appears nowhere. Someone who types "replace rabbit with fly" about a
  // book that writes "Rabbit" means that book — and the alternative is not a
  // literal edit, it is a per-page regeneration they did not ask for.
  const replacement = pages.some(
    (page) => hasExactMatch(page.markdown, requested) || hasExactMatch(page.title, requested)
  )
    ? requested
    : { ...requested, preserveCase: true };

  const pageIndexes: number[] = [];
  const samples: ExactReplacementPlan["samples"] = [];
  let matchCount = 0;

  for (const page of pages) {
    const matches = countExactMatches(page.markdown, replacement) + countExactMatches(page.title, replacement);
    if (matches === 0) {
      continue;
    }
    pageIndexes.push(page.index);
    matchCount += matches;
    for (const line of exactReplacementLineDiff(page.markdown, replacement, MAX_SAMPLES - samples.length)) {
      samples.push({
        pageIndex: page.index,
        before: truncate(line.before),
        after: truncate(line.after)
      });
    }
    // A title-only change still has to be visible, or a rename that touches
    // just the heading would show an empty preview.
    if (samples.length < MAX_SAMPLES && hasExactMatch(page.title, replacement)) {
      samples.push({
        pageIndex: page.index,
        before: truncate(page.title),
        after: truncate(applyExactReplacement(page.title, replacement))
      });
    }
  }

  if (pageIndexes.length === 0) {
    return null;
  }
  return { replacement, pageIndexes, matchCount, samples };
}

/** The card payload the app renders. Kept flat so `sanitizePublicChatMetadata` can pass it through. */
export function exactReplacementPreviewCard(plan: ExactReplacementPlan): Record<string, unknown> {
  return {
    kind: "exact_replace",
    from: plan.replacement.from,
    to: plan.replacement.to,
    matchCount: plan.matchCount,
    samples: plan.samples
  };
}

function truncate(line: string): string {
  const clean = line.trim();
  return clean.length > MAX_SAMPLE_LENGTH ? `${clean.slice(0, MAX_SAMPLE_LENGTH - 1)}…` : clean;
}

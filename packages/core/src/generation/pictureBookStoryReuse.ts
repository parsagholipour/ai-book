import type { PriorPageContext } from "./pagesShared.js";
import type { PictureBookPageReview } from "./pictureBookReviewValidation.js";
import type { StoryExtractResult } from "./storyState.js";

/** Callers must first verify the prior review's input/plan/check fingerprint.
 * Chronological deltas depend on the entire prefix: after the first edit even
 * byte-identical pages need fresh extraction. Full-prose/style review still runs everywhere.
 */
export function unchangedPrefixStoryExtracts(previous: readonly PriorPageContext[], candidate: readonly PriorPageContext[],
  reviews: readonly PictureBookPageReview[]): ReadonlyMap<number, StoryExtractResult> {
  const reused = new Map<number, StoryExtractResult>();
  for (let position = 0; position < candidate.length; position++) {
    const page = candidate[position]!;
    const before = previous[position];
    if (page.index !== position + 1 || before?.index !== page.index || before.title !== page.title || before.markdown !== page.markdown) break;
    const matches = reviews.filter((review) => review.pageIndex === page.index);
    const review = matches.length === 1 ? matches[0] : undefined;
    if (review?.completedChecks.storyExtractAudit && review.storyExtract && review.draftMarkdown === page.markdown &&
      (review.storyExtract.contradictionEvidence ?? []).every((evidence) => evidence.priorPageIndex < page.index)) reused.set(page.index, review.storyExtract);
  }
  return reused;
}

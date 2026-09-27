import type { PageQualityReport, PageStyleAudit, PriorPageContext, StoryExtractResult } from "@book-maker/core";
import type { QualityGateContext } from "./qualityEnrichment.js";

/** A manuscript review applies only to the exact prose and context it read. */
export type PrecomputedPageReview = {
  draftMarkdown: string;
  report: PageQualityReport;
  storyExtract: StoryExtractResult | null;
  styleAudit: PageStyleAudit | null;
  completedChecks: { pageModelReview: boolean; storyExtractAudit: boolean; styleAuditor: boolean };
  manuscriptPages: PriorPageContext[];
  /** The grouped review exhausted its allowance; preserve prose without claiming approval. */
  reviewUnavailable?: true;
};

export function matchingPrecomputedReview(options: {
  precomputed?: PrecomputedPageReview | undefined;
  draft: { index: number; title: string; markdown: string };
  previousPages: PriorPageContext[];
  nextPages?: PriorPageContext[] | undefined;
  quality: QualityGateContext;
}): PrecomputedPageReview | undefined {
  const review = options.precomputed;
  if (!review || review.draftMarkdown !== options.draft.markdown) return undefined;
  const needsStory = options.quality.enabled("storyExtractAudit");
  const needsStyle = options.quality.enabled("styleAuditor") && options.quality.enabled("styleExcerpts");
  if (review.reviewUnavailable && review.report.approved) return undefined;
  if (!review.reviewUnavailable && ((options.quality.enabled("pageModelReview") && !review.completedChecks.pageModelReview) ||
    (needsStory && (!review.completedChecks.storyExtractAudit || !review.storyExtract)) ||
    (needsStyle && (!review.completedChecks.styleAuditor || !review.styleAudit)))) return undefined;
  const supplied = [options.draft, ...options.previousPages, ...(options.nextPages ?? [])];
  if (supplied.some((page) => !review.manuscriptPages.some((source) =>
    source.index === page.index && source.title === page.title && source.markdown === page.markdown))) return undefined;
  return review;
}

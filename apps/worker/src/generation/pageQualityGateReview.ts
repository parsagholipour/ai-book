import type { QualityGateContext } from "./qualityEnrichment.js";
import {
  reviewPageDraftLocally,
  reviewRequiredPageQualityChecks,
  type BookGenerationStrategy,
  type PageQualityReport,
  type ReviewPageOptions
} from "@book-maker/core";

export type PageReviewPasses = {
  localEnabled: boolean;
  modelEnabled: boolean;
  anyConfiguredPassEnabled: boolean;
};

/** The single worker-side policy for which configurable page-review passes run. */
export function pageReviewPassesFor(options: {
  quality: QualityGateContext;
  allowModelReview?: boolean | undefined;
}): PageReviewPasses {
  const localEnabled = options.quality.enabled("pageLocalQa");
  const modelEnabled =
    options.allowModelReview !== false && options.quality.enabled("pageModelReview");
  return {
    localEnabled,
    modelEnabled,
    anyConfiguredPassEnabled: localEnabled || modelEnabled
  };
}

/** Execute configured page-review passes without bypassing required invariants. */
export async function reviewPageWithQualityGates(options: {
  strategy: BookGenerationStrategy;
  quality: QualityGateContext;
  reviewOptions: ReviewPageOptions;
  /** Whole-book mode deliberately keeps its established local-only review. */
  allowModelReview?: boolean | undefined;
}): Promise<PageQualityReport> {
  const { localEnabled, modelEnabled } = pageReviewPassesFor(options);
  if (!localEnabled && !modelEnabled) {
    return reviewRequiredPageQualityChecks(options.reviewOptions);
  }
  if (!modelEnabled) {
    return reviewPageDraftLocally(options.reviewOptions);
  }
  return options.strategy.reviewPageDraft({
    ...options.reviewOptions,
    skipLocalChecks: !localEnabled
  });
}

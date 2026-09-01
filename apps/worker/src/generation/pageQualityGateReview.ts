import type { QualityGateContext } from "./qualityEnrichment.js";
import {
  reviewPageDraftLocally,
  reviewPageDraftForSmartUnslop,
  reviewRequiredPageQualityChecks,
  type BookGenerationStrategy,
  type PageReviewPromptMode,
  type PageQualityReport,
  type ReviewPageOptions
} from "@book-maker/core";

export type PageReviewPasses = {
  localEnabled: boolean;
  smartUnslopEnabled: boolean;
  modelEnabled: boolean;
  anyConfiguredPassEnabled: boolean;
};

/** The single worker-side policy for which configurable page-review passes run. */
export function pageReviewPassesFor(options: {
  quality: QualityGateContext;
  allowModelReview?: boolean | undefined;
  allowSmartUnslop?: boolean | undefined;
}): PageReviewPasses {
  const localEnabled = options.quality.enabled("pageLocalQa");
  const smartUnslopEnabled =
    options.allowSmartUnslop !== false && options.quality.enabled("smartUnslop");
  const modelEnabled =
    options.allowModelReview !== false && options.quality.enabled("pageModelReview");
  return {
    localEnabled,
    smartUnslopEnabled,
    modelEnabled,
    anyConfiguredPassEnabled: localEnabled || smartUnslopEnabled || modelEnabled
  };
}

/** Execute configured page-review passes without bypassing required invariants. */
export async function reviewPageWithQualityGates(options: {
  strategy: BookGenerationStrategy;
  quality: QualityGateContext;
  reviewOptions: ReviewPageOptions;
  /** Whole-book mode deliberately keeps its established local-only review. */
  allowModelReview?: boolean | undefined;
  /** A candidate-triggered rewrite has already spent this one-shot scan. */
  allowSmartUnslop?: boolean | undefined;
}): Promise<PageQualityReport> {
  const { localEnabled, smartUnslopEnabled, modelEnabled } = pageReviewPassesFor(options);
  const unslopReport = smartUnslopEnabled
    ? reviewPageDraftForSmartUnslop(options.reviewOptions)
    : undefined;
  if (unslopReport && !unslopReport.approved) {
    // Scanner candidates buy one conditional rewrite before the model review.
    // Local deterministic defects still join that briefing; the rewritten (or
    // deliberately unchanged) candidate then receives the ordinary review.
    const requiredReport = localEnabled
      ? reviewPageDraftLocally(options.reviewOptions)
      : reviewRequiredPageQualityChecks(options.reviewOptions);
    return requiredReport.approved
      ? unslopReport
      : mergePageQualityReports(requiredReport, unslopReport);
  }

  const baseReport =
    !localEnabled && !modelEnabled
      ? reviewRequiredPageQualityChecks(options.reviewOptions)
      : !modelEnabled
        ? reviewPageDraftLocally(options.reviewOptions)
        : await options.strategy.reviewPageDraft({
            ...options.reviewOptions,
            pageReviewPromptMode:
              (options.quality as QualityGateContext & {
                pageReviewPromptMode?: PageReviewPromptMode | undefined;
              }).pageReviewPromptMode ?? "normal",
            skipLocalChecks: !localEnabled
          });

  return baseReport;
}

function mergePageQualityReports(
  primary: PageQualityReport,
  additional: PageQualityReport
): PageQualityReport {
  return {
    approved: primary.approved && additional.approved,
    score: Math.min(primary.score, additional.score),
    issues: unique([...primary.issues, ...additional.issues]),
    requiredRevisions: unique([...primary.requiredRevisions, ...additional.requiredRevisions]),
    notes: unique([primary.notes, additional.notes].filter(Boolean)).join(" "),
    groundedOk: primary.groundedOk && additional.groundedOk,
    unsupportedClaims: unique([...primary.unsupportedClaims, ...additional.unsupportedClaims]),
    checks: {
      placeholderFree: primary.checks.placeholderFree && additional.checks.placeholderFree,
      promptLeakFree: primary.checks.promptLeakFree && additional.checks.promptLeakFree,
      titleClean: primary.checks.titleClean && additional.checks.titleClean,
      repetitionOk: primary.checks.repetitionOk && additional.checks.repetitionOk,
      progressionOk: primary.checks.progressionOk && additional.checks.progressionOk,
      styleNatural: primary.checks.styleNatural && additional.checks.styleNatural
    }
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

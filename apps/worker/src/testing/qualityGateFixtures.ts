import type { QualityFeatureId } from "@book-maker/core/qualityGates";

const pageQaFeatureIds = [
  "pageLocalQa",
  "smartUnslop",
  "pageModelReview",
  "pageQaRewrite"
] as const satisfies readonly QualityFeatureId[];
const pagePipelineQaFeatureIds = [
  ...pageQaFeatureIds,
  "finalBookQa"
] as const satisfies readonly QualityFeatureId[];

/** Canonical page-review gates used by worker tests. */
export const PAGE_QA_FEATURE_IDS: ReadonlySet<QualityFeatureId> = new Set(pageQaFeatureIds);

/** Page-review gates plus the final whole-book verdict gate. */
export const PAGE_PIPELINE_QA_FEATURE_IDS: ReadonlySet<QualityFeatureId> = new Set(pagePipelineQaFeatureIds);

export type TestQualityGatePredicate = (feature: string) => boolean;

export interface TestQualityGateOptions {
  additionalFeatures?: readonly string[];
  defaultFeatureEnabled?: TestQualityGatePredicate;
  otherFeatureEnabled?: TestQualityGatePredicate;
}

export interface TestQualityGates {
  enabled: TestQualityGatePredicate;
}

export function isPageQaFeature(feature: string): boolean {
  return PAGE_QA_FEATURE_IDS.has(feature as QualityFeatureId);
}

export function isPagePipelineQaFeature(feature: string): boolean {
  return PAGE_PIPELINE_QA_FEATURE_IDS.has(feature as QualityFeatureId);
}

function qualityGates(
  isDefaultFeature: TestQualityGatePredicate,
  options: TestQualityGateOptions = {}
): TestQualityGates {
  const additionalFeatures = new Set(options.additionalFeatures ?? []);
  return {
    enabled: (feature: string): boolean => {
      if (isDefaultFeature(feature)) {
        return options.defaultFeatureEnabled?.(feature) ?? true;
      }
      return additionalFeatures.has(feature) || options.otherFeatureEnabled?.(feature) === true;
    }
  };
}

export function pageQaQualityGates(options: TestQualityGateOptions = {}): TestQualityGates {
  return qualityGates(isPageQaFeature, options);
}

export function pagePipelineQualityGates(options: TestQualityGateOptions = {}): TestQualityGates {
  return qualityGates(isPagePipelineQaFeature, options);
}

function balancedQualityContext(gates: TestQualityGates) {
  return { settings: {}, tier: "balanced" as const, enabled: gates.enabled };
}

export function balancedPageQaQualityContext(options: TestQualityGateOptions = {}) {
  return balancedQualityContext(pageQaQualityGates(options));
}

export function balancedPagePipelineQualityContext(options: TestQualityGateOptions = {}) {
  return balancedQualityContext(pagePipelineQualityGates(options));
}

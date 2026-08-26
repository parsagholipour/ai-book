import { describe, expect, it } from "vitest";
import {
  QUALITY_FEATURE_DEFAULTS,
  QUALITY_FEATURE_IDS,
  QUALITY_FEATURES,
  parseQualityFeatureSettings,
  qualityFeatureEnabled
} from "./qualityGates.js";

describe("qualityFeatureEnabled", () => {
  it("uses compiled defaults when there are no rows", () => {
    for (const feature of ["pageLocalQa", "pageModelReview", "pageQaRewrite", "finalBookQa"] as const) {
      for (const tier of ["ultra", "premium", "balanced", "fast"] as const) {
        expect(qualityFeatureEnabled(undefined, feature, tier)).toBe(true);
      }
    }
    expect(qualityFeatureEnabled(undefined, "storyExtractAudit", "fast")).toBe(true);
    expect(qualityFeatureEnabled(undefined, "styleAuditor", "fast")).toBe(false);
    expect(qualityFeatureEnabled(undefined, "styleAuditor", "premium")).toBe(true);
    expect(qualityFeatureEnabled(undefined, "styleAuditor", "ultra")).toBe(true);
    expect(qualityFeatureEnabled(undefined, "writerTools", "premium")).toBe(false);
    expect(qualityFeatureEnabled(undefined, "writerTools", "ultra")).toBe(true);
    expect(qualityFeatureEnabled(undefined, "bestOfPolish", "balanced")).toBe(false);
    expect(qualityFeatureEnabled(undefined, "pageMapCritic", "balanced")).toBe(false);
    expect(qualityFeatureEnabled(undefined, "pageMapCritic", "premium")).toBe(true);
    expect(qualityFeatureEnabled(undefined, "planThinkingBoost", "premium")).toBe(true);
    expect(qualityFeatureEnabled(undefined, "claimRetrieve", "ultra")).toBe(true);
  });

  it("treats an empty array as disabled", () => {
    const settings = parseQualityFeatureSettings({
      finalBookQa: [],
      storyExtractAudit: [],
      styleAuditor: ["fast"]
    });
    expect(qualityFeatureEnabled(settings, "finalBookQa", "balanced")).toBe(false);
    expect(qualityFeatureEnabled(settings, "storyExtractAudit", "ultra")).toBe(false);
    expect(qualityFeatureEnabled(settings, "storyExtractAudit", "fast")).toBe(false);
    expect(qualityFeatureEnabled(settings, "styleAuditor", "fast")).toBe(true);
    expect(qualityFeatureEnabled(settings, "styleAuditor", "premium")).toBe(false);
  });

  it("falls back to the compiled default for a missing key", () => {
    const settings = parseQualityFeatureSettings({ planCritic: ["ultra"], finalBookQa: [] });
    expect(settings.planCritic).toEqual(["ultra"]);
    expect(settings.pageLocalQa).toEqual([...QUALITY_FEATURE_DEFAULTS.pageLocalQa]);
    expect(qualityFeatureEnabled(settings, "pageLocalQa", "balanced")).toBe(true);
    expect(settings.finalBookQa).toEqual([]);
    expect(settings.styleAuditor).toEqual([...QUALITY_FEATURE_DEFAULTS.styleAuditor]);
    expect(qualityFeatureEnabled(settings, "styleAuditor", "premium")).toBe(true);
  });

  it("ignores unknown feature ids and unknown tier labels", () => {
    const settings = parseQualityFeatureSettings({
      notARealFeature: ["ultra"],
      writerTools: ["ultra", "nope", "premium"]
    });
    expect(settings).not.toHaveProperty("notARealFeature");
    expect(settings.writerTools).toEqual(["ultra", "premium"]);
    expect(qualityFeatureEnabled(settings, "writerTools", "premium")).toBe(true);
  });

  it("keeps feature metadata in the canonical id order", () => {
    expect(QUALITY_FEATURES.map((feature) => feature.id)).toEqual(QUALITY_FEATURE_IDS);
  });
});

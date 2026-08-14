import { describe, expect, it } from "vitest";
import {
  QUALITY_FEATURE_DEFAULTS,
  parseQualityFeatureSettings,
  qualityFeatureEnabled
} from "./qualityGates.js";

describe("qualityFeatureEnabled", () => {
  it("uses compiled defaults when there are no rows", () => {
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
      storyExtractAudit: [],
      styleAuditor: ["fast"]
    });
    expect(qualityFeatureEnabled(settings, "storyExtractAudit", "ultra")).toBe(false);
    expect(qualityFeatureEnabled(settings, "storyExtractAudit", "fast")).toBe(false);
    expect(qualityFeatureEnabled(settings, "styleAuditor", "fast")).toBe(true);
    expect(qualityFeatureEnabled(settings, "styleAuditor", "premium")).toBe(false);
  });

  it("falls back to the compiled default for a missing key", () => {
    const settings = parseQualityFeatureSettings({ planCritic: ["ultra"] });
    expect(settings.planCritic).toEqual(["ultra"]);
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
});

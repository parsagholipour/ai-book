import { describe, expect, it } from "vitest";
import {
  MANDATORY_INTEGRITY_CHECKS,
  QUALITY_FEATURE_DEFAULTS,
  QUALITY_FEATURE_IDS,
  QUALITY_FEATURES,
  parseQualityFeatureSettings,
  qualityFeatureEnabled
} from "./qualityGates.js";

describe("qualityFeatureEnabled", () => {
  it("uses compiled defaults when there are no rows", () => {
    for (const feature of ["pageLocalQa", "smartUnslop", "pageModelReview", "pageQaRewrite", "finalBookQa"] as const) {
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
    expect(qualityFeatureEnabled(undefined, "compactPageDraftContext", "fast")).toBe(true);
    expect(qualityFeatureEnabled(undefined, "compactPageDraftContext", "balanced")).toBe(true);
    expect(qualityFeatureEnabled(undefined, "compactPageDraftContext", "premium")).toBe(false);
    expect(qualityFeatureEnabled(undefined, "compactPageDraftContext", "ultra")).toBe(false);
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
    expect(settings.compactPageDraftContext).toEqual(["balanced", "fast"]);
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
    expect(QUALITY_FEATURES.find((feature) => feature.id === "smartUnslop")).toEqual({
      id: "smartUnslop",
      label: "Smart unslop",
      summary: "Finds significant deterministic slop candidates and, when Page QA rewrites is on, asks for a contextual minimal rewrite or an unchanged page."
    });
    expect(QUALITY_FEATURES.find((feature) => feature.id === "compactPageDraftContext")).toEqual({
      id: "compactPageDraftContext",
      label: "Compact page-draft context",
      summary: "Drafts from indexed summaries plus one bounded nearest-page handoff instead of five page excerpts."
    });
    expect(QUALITY_FEATURES.find((feature) => feature.id === "beatDedup")).toEqual({
      id: "beatDedup",
      label: "Page-beat rewrite (optional polish)",
      summary: "One cheap rewrite call when a beat collision is found. Map integrity (coverage, generics, collisions) always runs and is not this checkbox."
    });
  });

  it("lists mandatory integrity separately from disableable polish ids", () => {
    expect(MANDATORY_INTEGRITY_CHECKS.map((check) => check.id)).toEqual([
      "generated-response-schema",
      "page-map-coverage",
      "generic-assignment-rejection",
      "full-map-collision",
      "deterministic-page-integrity",
      "deterministic-manuscript-audit",
      "publication-state-grading"
    ]);
    const polishIds = new Set<string>(QUALITY_FEATURE_IDS);
    expect(MANDATORY_INTEGRITY_CHECKS.every((check) => !polishIds.has(check.id))).toBe(true);
    expect(qualityFeatureEnabled(parseQualityFeatureSettings({
      pageLocalQa: [],
      smartUnslop: [],
      pageModelReview: [],
      pageQaRewrite: [],
      finalBookQa: [],
      storyExtractAudit: [],
      planCritic: [],
      claimVerifier: [],
      compactPageDraftContext: [],
      styleExcerpts: [],
      styleAuditor: [],
      pageMapCritic: [],
      beatDedup: [],
      writerTools: [],
      bestOfPolish: [],
      planThinkingBoost: [],
      claimRetrieve: []
    }), "beatDedup", "ultra")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  MANDATORY_INTEGRITY_CHECKS,
  QUALITY_FEATURE_DEFAULTS,
  QUALITY_FEATURE_IDS,
  QUALITY_FEATURES,
  REMOVED_QUALITY_FEATURE_IDS,
  parseQualityFeatureSettings,
  qualityFeatureEnabled
} from "./qualityGates.js";

describe("qualityFeatureEnabled", () => {
  it("retires the four gates the E4 review audit removed: a stored revision that lists one parses, and it controls nothing", () => {
    // Every dev revision before 2026-10-16 lists them (E4, `.scratch/eval-data/reports/e4-review-audit.md`).
    const stored = parseQualityFeatureSettings({ planCritic: ["ultra", "premium", "balanced"], bestOfPolish: ["ultra"],
      formPlanRepair: ["ultra", "premium", "balanced"], proseArithmeticCheck: ["ultra", "premium", "balanced", "fast"], finalBookQa: [] });
    for (const id of ["planCritic", "bestOfPolish", "formPlanRepair", "proseArithmeticCheck"]) {
      expect(REMOVED_QUALITY_FEATURE_IDS).toContain(id);
      expect(stored).not.toHaveProperty(id);
    }
    expect(stored.finalBookQa).toEqual([]);
    expect(qualityFeatureEnabled(undefined, "finalBookQa", "fast")).toBe(true);
  });
  it("enables chapter semantic acceptance by default above Quick Draft and supports per-tier opt-out and opt-in", () => {
    for (const tier of ["ultra", "premium", "balanced", "fast"] as const) {
      // Quick Draft trades the review for speed (2026-09-30).
      expect(qualityFeatureEnabled(undefined, "chapterEditAcceptance", tier)).toBe(tier !== "fast");
      expect(qualityFeatureEnabled(parseQualityFeatureSettings({ chapterEditorPass: [] }), "chapterEditAcceptance", tier)).toBe(tier !== "fast");
      expect(qualityFeatureEnabled(parseQualityFeatureSettings({ chapterEditAcceptance: [] }), "chapterEditAcceptance", tier)).toBe(false);
      expect(qualityFeatureEnabled(parseQualityFeatureSettings({ chapterEditAcceptance: ["balanced"] }), "chapterEditAcceptance", tier)).toBe(tier === "balanced");
    }
    expect(QUALITY_FEATURES.find((feature) => feature.id === "chapterEditAcceptance")).toMatchObject({ pipelines: ["composed"], stage: "Chapter repairs" });
  });
  it("retires the composed line edit: a stored revision that lists it parses, and it runs nowhere", () => {
    // Revisions 73–75 on dev list it on every tier (2026-10-16).
    const stored = parseQualityFeatureSettings({ chapterEditorPass: ["ultra", "premium", "balanced", "fast"], chapterEditAcceptance: ["balanced"] });
    expect(stored.chapterEditorPass).toEqual(["ultra", "premium", "balanced", "fast"]);
    for (const tier of ["ultra", "premium", "balanced", "fast"] as const) {
      expect(qualityFeatureEnabled(stored, "chapterEditorPass", tier)).toBe(false);
      expect(qualityFeatureEnabled(undefined, "chapterEditorPass", tier)).toBe(false);
    }
    // The acceptance gate keeps its readers: the repairs' corrections and the read's cuts.
    expect(qualityFeatureEnabled(stored, "chapterEditAcceptance", "balanced")).toBe(true);
    const editor = QUALITY_FEATURES.find((feature) => feature.id === "chapterEditorPass")!;
    expect(editor).toMatchObject({ retired: true, pipelines: [] });
    expect(editor.summary).toMatch(/Removed 2026-10-16/);
  });
  it("parses a stored revision that still carries a removed gate, and the gate controls nothing", () => {
    // Revision 73 on dev stored the deleted couplet rewrite on balanced and up.
    // Revision 77 still stores the page-map critic (E5) on every tier.
    const settings = parseQualityFeatureSettings({ coupletRewrite: ["balanced", "fast", "premium", "ultra"], pageMapCritic: ["ultra", "premium", "fast", "balanced"], styleAuditor: ["ultra"] });
    expect(settings).not.toHaveProperty("coupletRewrite");
    expect(settings).not.toHaveProperty("pageMapCritic");
    expect(settings.styleAuditor).toEqual(["ultra"]);
    expect(settings.figures).toEqual(QUALITY_FEATURE_DEFAULTS.figures);
    for (const id of REMOVED_QUALITY_FEATURE_IDS) {
      expect(QUALITY_FEATURE_IDS).not.toContain(id);
      expect(QUALITY_FEATURES.map((feature) => feature.id)).not.toContain(id);
    }
  });
  it("shelves the gates measured off on every tier, and a revision can still opt one in for an experiment", () => {
    const shelved = QUALITY_FEATURES.filter((feature) => feature.shelved).map((feature) => feature.id);
    expect(shelved.sort()).toEqual(["bookDevelopment", "caseEvidence", "changedCandidateGrounding", "chapterFocus", "developmentalEdit"]);
    for (const id of shelved) {
      expect(QUALITY_FEATURE_DEFAULTS[id]).toEqual([]);
      expect(qualityFeatureEnabled(parseQualityFeatureSettings({ [id]: ["balanced"] }), id, "balanced")).toBe(true);
    }
  });
  it("cannot reactivate tier reasoning boosts from an older revision", () => {
    const settings = parseQualityFeatureSettings({ planThinkingBoost: ["ultra", "premium", "balanced", "fast"] });
    for (const tier of ["ultra", "premium", "balanced", "fast"] as const) {
      expect(qualityFeatureEnabled(settings, "planThinkingBoost", tier)).toBe(false);
    }
  });
  it("uses compiled defaults when there are no rows", () => {
    for (const feature of ["pageLocalQa", "smartUnslop", "pageModelReview", "pageQaRewrite", "finalBookQa"] as const) {
      for (const tier of ["ultra", "premium", "balanced", "fast"] as const) {
        expect(qualityFeatureEnabled(undefined, feature, tier)).toBe(true);
      }
    }
    expect(qualityFeatureEnabled(undefined, "styleAuditor", "fast")).toBe(false);
    expect(qualityFeatureEnabled(undefined, "styleAuditor", "premium")).toBe(true);
    expect(qualityFeatureEnabled(undefined, "styleAuditor", "ultra")).toBe(true);
    expect(qualityFeatureEnabled(undefined, "writerTools", "premium")).toBe(false);
    expect(qualityFeatureEnabled(undefined, "writerTools", "ultra")).toBe(true);
    expect(qualityFeatureEnabled(undefined, "planThinkingBoost", "premium")).toBe(false);
    expect(qualityFeatureEnabled(undefined, "compactPageDraftContext", "fast")).toBe(true);
    expect(qualityFeatureEnabled(undefined, "compactPageDraftContext", "balanced")).toBe(true);
    expect(qualityFeatureEnabled(undefined, "compactPageDraftContext", "premium")).toBe(false);
    expect(qualityFeatureEnabled(undefined, "compactPageDraftContext", "ultra")).toBe(false);
  });

  it("keeps the development pipeline off on every tier unless a row opts in", () => {
    const features = ["bookDevelopment", "caseEvidence", "developmentalEdit"] as const;
    const tiers = ["ultra", "premium", "balanced", "fast"] as const;
    // No revision row at all: compiled defaults.
    for (const feature of features) {
      expect(QUALITY_FEATURE_DEFAULTS[feature]).toEqual([]);
      for (const tier of tiers) {
        expect(qualityFeatureEnabled(undefined, feature, tier)).toBe(false);
      }
    }
    // A row written before these ids existed carries none of the keys, so the
    // merge must fall back to the empty default rather than turning them on.
    const olderRow = parseQualityFeatureSettings({
      pageLocalQa: ["ultra", "premium", "balanced", "fast"],
      chapterEditorPass: ["ultra", "premium", "balanced", "fast"],
      manuscriptReadPass: ["ultra", "premium", "balanced", "fast"]
    });
    for (const feature of features) {
      expect(olderRow[feature]).toEqual([]);
      for (const tier of tiers) {
        expect(qualityFeatureEnabled(olderRow, feature, tier)).toBe(false);
      }
    }
    expect(qualityFeatureEnabled(olderRow, "manuscriptReadPass", "balanced")).toBe(true);
    // An explicit opt-in enables each feature for the named tier only.
    for (const feature of features) {
      const optedIn = parseQualityFeatureSettings({ [feature]: ["balanced"] });
      expect(optedIn[feature]).toEqual(["balanced"]);
      expect(qualityFeatureEnabled(optedIn, feature, "balanced")).toBe(true);
      expect(qualityFeatureEnabled(optedIn, feature, "fast")).toBe(false);
      expect(qualityFeatureEnabled(optedIn, feature, "premium")).toBe(false);
      expect(qualityFeatureEnabled(optedIn, feature, "ultra")).toBe(false);
      for (const other of features) {
        if (other === feature) continue;
        expect(qualityFeatureEnabled(optedIn, other, "balanced")).toBe(false);
      }
    }
  });

  it("ships the rung-5 composition path and the read's cut off on every tier", () => {
    for (const feature of ["chapterFocus", "manuscriptReadCuts"] as const) {
      expect(QUALITY_FEATURE_DEFAULTS[feature]).toEqual([]);
      for (const tier of ["ultra", "premium", "balanced", "fast"] as const) {
        expect(qualityFeatureEnabled(undefined, feature, tier)).toBe(false);
      }
      // A revision written before these ids existed carries neither key.
      expect(parseQualityFeatureSettings({ chapterEditorPass: ["balanced"] })[feature]).toEqual([]);
      const optedIn = parseQualityFeatureSettings({ [feature]: ["balanced"] });
      expect(qualityFeatureEnabled(optedIn, feature, "balanced")).toBe(true);
      expect(qualityFeatureEnabled(optedIn, feature, "ultra")).toBe(false);
    }
    const composed = QUALITY_FEATURES.filter((feature) => feature.id === "chapterFocus" || feature.id === "manuscriptReadCuts");
    expect(composed.map((feature) => feature.stage)).toEqual(["Compose chapter", "Manuscript read"]);
    expect(composed.every((feature) => feature.pipelines.length === 1 && feature.pipelines[0] === "composed")).toBe(true);
  });

  it("treats an empty array as disabled", () => {
    const settings = parseQualityFeatureSettings({
      finalBookQa: [],
      pageModelReview: [],
      styleAuditor: ["fast"]
    });
    expect(qualityFeatureEnabled(settings, "finalBookQa", "balanced")).toBe(false);
    expect(qualityFeatureEnabled(settings, "pageModelReview", "ultra")).toBe(false);
    expect(qualityFeatureEnabled(settings, "pageModelReview", "fast")).toBe(false);
    expect(qualityFeatureEnabled(settings, "styleAuditor", "fast")).toBe(true);
    expect(qualityFeatureEnabled(settings, "styleAuditor", "premium")).toBe(false);
  });

  it("falls back to the compiled default for a missing key", () => {
    const settings = parseQualityFeatureSettings({ writerTools: ["premium"], finalBookQa: [] });
    expect(settings.writerTools).toEqual(["premium"]);
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
      summary: "A reader's chat page rewrite only: finds significant deterministic slop candidates and, when Page QA rewrites is on, asks for a contextual minimal rewrite or an unchanged page. No generated page is rewritten for slop since 2026-10-16.",
      pipelines: ["per-page", "composed"],
      stage: "Chat page rewrite"
    });
    expect(QUALITY_FEATURES.find((feature) => feature.id === "compactPageDraftContext")).toEqual({
      id: "compactPageDraftContext",
      label: "Compact page-draft context",
      summary: "Drafts from indexed summaries plus one bounded nearest-page handoff instead of five page excerpts.",
      pipelines: ["per-page"],
      stage: "Page draft"
    });
    // Story memory and its scheduling gate went with E6 (2026-10-16): no row, and a stored revision naming them parses.
    for (const removed of ["storyExtractAudit", "storyNotesTogether"]) {
      expect(QUALITY_FEATURES.some((feature) => (feature.id as string) === removed)).toBe(false);
      expect(REMOVED_QUALITY_FEATURE_IDS).toContain(removed);
    }
    expect(qualityFeatureEnabled(parseQualityFeatureSettings({ storyExtractAudit: ["ultra"], storyNotesTogether: ["fast"] }), "finalBookQa", "ultra")).toBe(true);
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
      compactPageDraftContext: [],
      styleExcerpts: [],
      styleAuditor: [],
      writerTools: [],
      planThinkingBoost: []
    }), "styleAuditor", "ultra")).toBe(false);
  });
});


it("switches changed-candidate grounding from a stored revision, off by default", () => {
  expect(qualityFeatureEnabled(undefined, "changedCandidateGrounding", "balanced")).toBe(false);
  const on = parseQualityFeatureSettings({ changedCandidateGrounding: ["balanced"], claimVerifier: [] });
  expect(qualityFeatureEnabled(on, "changedCandidateGrounding", "balanced")).toBe(true);
  expect(on).not.toHaveProperty("claimVerifier");
});

it("gives Quick Draft its speed defaults: no edit review, no manuscript read, no brief-coverage read; notes and sources together", () => {
  const quick = (feature: Parameters<typeof qualityFeatureEnabled>[1]) => qualityFeatureEnabled(undefined, feature, "fast");
  const balanced = (feature: Parameters<typeof qualityFeatureEnabled>[1]) => qualityFeatureEnabled(undefined, feature, "balanced");
  for (const feature of ["chapterEditAcceptance"] as const) {
    expect([quick(feature), balanced(feature)]).toEqual([false, true]);
  }
  // The manuscript read and its cuts moved a Balanced book by 0.75% of its words (E3, 2026-10-16), and the
  // compile's brief-coverage read only filed console diagnostics, real 27% and 40% of the time. Both are
  // under the owner's 5–10% bar, so no tier runs them by default — Premium and Ultra included: a critic that
  // does not help one writer is not kept for another in case.
  for (const tier of ["fast", "balanced", "premium", "ultra"] as const) {
    expect(qualityFeatureEnabled(undefined, "manuscriptReadPass", tier)).toBe(false);
    expect(qualityFeatureEnabled(undefined, "manuscriptReadCuts", tier)).toBe(false);
    expect(qualityFeatureEnabled(undefined, "briefCoverageReview", tier)).toBe(false);
  }
  expect([quick("wideSourceGathering"), balanced("wideSourceGathering")]).toEqual([true, false]);
  expect(QUALITY_FEATURES.find((entry) => entry.id === "wideSourceGathering")).toMatchObject({ pipelines: ["composed"] });
  // A saved revision that never named the new gates takes their defaults.
  expect(qualityFeatureEnabled(parseQualityFeatureSettings({ chapterEditorPass: ["fast"] }), "wideSourceGathering", "fast")).toBe(true);
  expect(qualityFeatureEnabled(parseQualityFeatureSettings({ chapterEditorPass: ["fast"] }), "briefCoverageReview", "fast")).toBe(false);
});
